import WebSocket from "ws";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { Client } from "../client.ts";
import type { Logger } from "../logging.ts";
import { getDefaultLogger } from "../logging.ts";
import { EventCounter } from "./utils.ts";
import { telemetryClient } from "../telemetry.ts";
import {
  type CloseReason,
  type GuavaClientMessage,
  GuavaClose,
  GuavaOpenAck,
  GuavaServerMessage,
} from "./protocol.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reconnectDelay(attempt: number): number {
  if (attempt <= 3) return 1000 + (Math.random() - 0.5) * 1000;
  if (attempt <= 5) return 5000 + (Math.random() - 0.5) * 4000;
  return 10_000 + (Math.random() - 0.5) * 10_000;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_CONNECTIONS_PER_MINUTE = 15;
const PING_INTERVAL_MS = 10_000;
const SOCKET_DEAD_TIMEOUT_MS = 30_000;

export class GuavaSocketClosedError extends Error {
  readonly reason: CloseReason;
  readonly description: string;

  constructor(reason?: CloseReason, description?: string) {
    const r = reason ?? "unknown";
    const d = description ?? "No description provided.";
    super(`Guava socket closed. Reason: ${r}. Description: ${d}`);
    this.reason = r;
    this.description = d;
  }
}

export class GuavaSocketConnectionFailed extends Error {
  constructor() {
    super("Couldn't connect to the Guava server after multiple attempts.");
  }
}

/** Raised when the server rejects the websocket handshake with an HTTP response. */
class UnexpectedResponseError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly body: string,
  ) {
    super(`Unexpected server response: ${statusCode ?? "unknown"}. Body: ${body || "<empty>"}`);
  }
}

const HandshakeResponse = z.union([GuavaOpenAck, GuavaClose]);

function _sendMessage(ws: WebSocket, message: GuavaClientMessage): void {
  ws.send(JSON.stringify(message));
}

@telemetryClient.trackClass()
export class GuavaSocket<SendT, RecvT> {
  private readonly _socketCreateTime = Date.now();
  private readonly _connectionId = randomBytes(10).toString("hex");
  private readonly _openCounter = new EventCounter(60);
  private readonly _logger: Logger;

  private _lastSeenSequence = 0;
  private _lastSentSequence = 0;
  private _rtxBuffer: Array<[number, Record<string, unknown>]> = [];

  private _state: "never-opened" | "open" | "closed" = "never-opened";
  private _ws?: WebSocket;
  private _shouldClose = false;

  private _closeReason?: CloseReason;
  private _closeDescription?: string;

  // Async recv queue: buffered payloads waiting to be consumed, and waiters blocked on _recv()
  private _recvBuffer: Array<Record<string, unknown>> = [];
  private _recvWaiters: Array<{
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];

  private _readyResolve?: () => void;
  private _readyReject?: (e: Error) => void;
  private _reconnectLoopPromise?: Promise<void>;

  constructor(
    private readonly _name: string,
    private readonly _connectionUrl: string,
    private readonly _client: Client,
    private readonly _serializer: (msg: SendT) => Record<string, unknown>,
    private readonly _deserializer: (payload: Record<string, unknown>) => RecvT,
    private readonly _maxAgeSeconds?: number,
    logger?: Logger,
  ) {
    this._logger = logger ?? getDefaultLogger();
  }

  isOpen(): boolean {
    return this._state === "open";
  }

  private _setCloseReason(reason: CloseReason, description: string): void {
    if (this._closeReason === undefined) {
      this._closeReason = reason;
      this._closeDescription = description;
    }
  }

  private _pruneRtxBuffer(peerLastSeenSequence: number): void {
    while (this._rtxBuffer.length > 0 && this._rtxBuffer[0]![0] <= peerLastSeenSequence) {
      this._rtxBuffer.shift();
    }
  }

  private _pushPayload(payload: Record<string, unknown>): void {
    const waiter = this._recvWaiters.shift();
    if (waiter) {
      waiter.resolve(payload);
    } else {
      this._recvBuffer.push(payload);
    }
  }

  private _rejectAllWaiters(): void {
    const err = new GuavaSocketClosedError(this._closeReason, this._closeDescription);
    for (const waiter of this._recvWaiters) {
      waiter.reject(err);
    }
    this._recvWaiters = [];
  }

  private async _establishSocket(isReopen: boolean): Promise<WebSocket> {
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      const headers = await this._client.headers();

      try {
        this._logger.debug(
          "Connecting to %s (attempt %d/%d)...",
          this._connectionUrl,
          attempt,
          MAX_RECONNECT_ATTEMPTS,
        );
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(this._connectionUrl, { headers });
          let settled = false;

          const settle = (fn: () => void) => {
            if (!settled) {
              settled = true;
              socket.removeAllListeners();
              fn();
            }
          };

          socket.once("error", (err) => settle(() => reject(err)));
          socket.once("unexpected-response", (_req, res: IncomingMessage) => {
            let body = "";
            res.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on("end", () => {
              settle(() => reject(new UnexpectedResponseError(res.statusCode, body)));
            });
          });
          socket.once("close", () =>
            settle(() => reject(new Error("Connection closed before open-ack"))),
          );

          socket.once("open", () => {
            _sendMessage(socket, {
              message_type: "open",
              name: this._name,
              connection_id: this._connectionId,
              is_reopen: isReopen,
              last_seen_sequence: this._lastSeenSequence,
            });

            const ackTimeout = setTimeout(() => {
              settle(() => {
                socket.close();
                reject(new Error("Timed out waiting for open-ack"));
              });
            }, 10_000);

            socket.once("message", (data) => {
              clearTimeout(ackTimeout);
              try {
                const msg = HandshakeResponse.parse(JSON.parse(data.toString()));

                if (msg.message_type === "close") {
                  this._setCloseReason(msg.reason, msg.description);
                  settle(() => {
                    socket.close();
                    reject(new GuavaSocketClosedError(msg.reason, msg.description));
                  });
                } else {
                  // Retransmit any messages the server hasn't seen
                  for (const [seq, payload] of this._rtxBuffer) {
                    if (seq > msg.last_seen_sequence) {
                      _sendMessage(socket, { message_type: "message", sequence: seq, payload });
                    }
                  }
                  this._pruneRtxBuffer(msg.last_seen_sequence);
                  settle(() => resolve(socket));
                }
              } catch (e) {
                settle(() => {
                  socket.close();
                  reject(e);
                });
              }
            });
          });
        });

        return ws;
      } catch (e) {
        if (e instanceof GuavaSocketClosedError) throw e;

        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          this._logger.error("Couldn't connect to server after %d attempts.", attempt);
          this._setCloseReason(
            "reconnection-failed",
            `Couldn't connect after ${attempt} attempts.`,
          );
          throw new GuavaSocketConnectionFailed();
        }

        if (e instanceof UnexpectedResponseError) {
          const interpretation =
            e.statusCode === 401 || e.statusCode === 403 ? "Authentication Failure" : "HTTP error";
          this._logger.error(
            "Failed to connect to websocket endpoint %s due to %s. HTTP %s, Body: %s. Retrying in a few seconds...",
            this._connectionUrl,
            interpretation,
            e.statusCode ?? "unknown",
            e.body || "No response body.",
          );
        } else {
          this._logger.error(
            "Failed to connect to %s (attempt %d/%d). Retrying in a few seconds...\n",
            this._connectionUrl,
            attempt,
            MAX_RECONNECT_ATTEMPTS,
            e,
          );
        }
        await sleep(reconnectDelay(attempt));
      }
    }

    throw new GuavaSocketConnectionFailed();
  }

  private _runConnection(ws: WebSocket): Promise<boolean> {
    // Resolves true if we should reconnect, false if we should stop.
    return new Promise<boolean>((resolve) => {
      let pingTimer: ReturnType<typeof setTimeout>;
      let deadTimer: ReturnType<typeof setTimeout>;

      const resetPingTimer = () => {
        clearTimeout(pingTimer);
        pingTimer = setTimeout(() => {
          this._logger.debug("Haven't seen any messages in a while. Sending a ping...");
          _sendMessage(ws, { message_type: "ping", ping_timestamp: Date.now() });
          resetPingTimer();
        }, PING_INTERVAL_MS);
      };

      const resetDeadTimer = () => {
        clearTimeout(deadTimer);
        deadTimer = setTimeout(() => {
          this._logger.warn(
            "No messages received from server in %dms. Assuming socket is dead, reconnecting...",
            SOCKET_DEAD_TIMEOUT_MS,
          );
          ws.terminate();
        }, SOCKET_DEAD_TIMEOUT_MS);
      };

      resetPingTimer();
      resetDeadTimer();

      ws.on("message", (data) => {
        resetPingTimer();
        resetDeadTimer();

        let msg: z.infer<typeof GuavaServerMessage>;
        try {
          msg = GuavaServerMessage.parse(JSON.parse(data.toString()));
        } catch {
          this._logger.warn("Received unparseable message from server.");
          return;
        }

        switch (msg.message_type) {
          case "ping":
            _sendMessage(ws, {
              message_type: "pong",
              ping_timestamp: msg.ping_timestamp,
              pong_timestamp: Date.now(),
            });
            break;
          case "pong":
            break;
          case "close":
            this._setCloseReason(msg.reason, msg.description);
            this._shouldClose = true;
            ws.close();
            break;
          case "message":
            if (msg.sequence > this._lastSeenSequence) {
              this._lastSeenSequence = msg.sequence;
              this._pushPayload(msg.payload as Record<string, unknown>);
            }
            _sendMessage(ws, { message_type: "ack", last_seen_sequence: this._lastSeenSequence });
            break;
          case "ack":
            this._pruneRtxBuffer(msg.last_seen_sequence);
            break;
        }
      });

      ws.once("close", () => {
        this._logger.debug("Closing websocket connection...");
        clearTimeout(pingTimer);
        clearTimeout(deadTimer);
        ws.removeAllListeners();
        resolve(!this._shouldClose);
      });

      ws.once("error", (err) => {
        this._logger.debug("Websocket connection error...", err);
        clearTimeout(pingTimer);
        clearTimeout(deadTimer);
        ws.removeAllListeners();
        resolve(!this._shouldClose);
      });
    });
  }

  private async _reconnectLoop(): Promise<void> {
    let isFirstConnect = true;

    try {
      while (!this._shouldClose) {
        let ws: WebSocket;
        try {
          ws = await this._establishSocket(!isFirstConnect);
        } catch (e) {
          this._readyReject?.(e as Error);
          return;
        }

        this._ws = ws;
        this._openCounter.addEvent();
        this._state = "open";
        this._logger.debug("GuavaSocket connection established.");

        if (isFirstConnect) {
          this._readyResolve?.();
          isFirstConnect = false;
        }

        if (this._openCounter.count() >= MAX_CONNECTIONS_PER_MINUTE) {
          this._setCloseReason(
            "server-error",
            "Too many connections in the last minute. The server is probably in a bad state.",
          );
          ws.close();
          return;
        }

        const shouldReconnect = await this._runConnection(ws);
        if (!shouldReconnect) return;

        if (
          this._maxAgeSeconds !== undefined &&
          Date.now() > this._socketCreateTime + this._maxAgeSeconds * 1000
        ) {
          this._setCloseReason("other", "The socket hit its max age limit.");
          return;
        }

        await sleep(reconnectDelay(1));
      }
    } finally {
      this._state = "closed";
      this._ws?.close();
      this._ws = undefined;
      this._rejectAllWaiters();
      this._logger.debug("GuavaSocket closed.");
    }
  }

  async connect(): Promise<this> {
    if (this._state !== "never-opened") throw new Error("connect() already called");

    const readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    this._reconnectLoopPromise = this._reconnectLoop();
    await readyPromise;
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (!this._reconnectLoopPromise) throw new Error("connect() has not been called");
    this._setCloseReason("done", "The socket was closed by the client.");
    this._shouldClose = true;
    this._ws?.close();
    await this._reconnectLoopPromise;
  }

  send(message: SendT): void {
    if (this._state === "never-opened") throw new Error("connect() has not been called");
    if (this._state === "closed")
      throw new GuavaSocketClosedError(this._closeReason, this._closeDescription);

    const payload = this._serializer(message);
    this._lastSentSequence++;
    this._rtxBuffer.push([this._lastSentSequence, payload]);

    try {
      if (this._ws) {
        _sendMessage(this._ws, {
          message_type: "message",
          sequence: this._lastSentSequence,
          payload,
        });
      }
    } catch {
      // Connection is down; the reconnect loop will retransmit from the RTX buffer.
    }
  }

  async _recv(): Promise<RecvT> {
    if (this._state === "never-opened") throw new Error("connect() has not been called");
    if (this._state === "closed")
      throw new GuavaSocketClosedError(this._closeReason, this._closeDescription);

    const buffered = this._recvBuffer.shift();
    if (buffered !== undefined) return this._deserializer(buffered);

    const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this._recvWaiters.push({ resolve, reject });
    });
    return this._deserializer(payload);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RecvT> {
    while (true) {
      yield await this._recv();
    }
  }
}
