import WebSocket from "ws";
import { type Logger, getDefaultLogger } from "./logging.ts";
import {
  StartOutboundCallCommand,
  ListenInboundCommand,
  InboundTunnelCommand,
} from "./commands.ts";
import * as z from "zod";
import { ErrorEvent, SessionStartedEvent, decodeEvent, InboundTunnelEvent } from "./events.ts";
import { SDK_VERSION } from "./version.ts";
import os from "node:os";
import { getBaseUrl, fetchOrThrow } from "./utils.ts";
import { telemetryClient } from "./telemetry.ts";
import type { CallController } from "./call-controller.ts";
export { CallController, type TaskObjective } from "./call-controller.ts";
export { Say, Field } from "./action_item.ts";
export { Logger, getConsoleLogger } from "./logging.ts";

const SDK_NAME = "typescript-sdk";

let firstClient = false;

/**
 * @description convenience function for stringifying data according to a schema
 */
function stringifyZod<Schema extends z.ZodType>(schema: Schema, data: z.input<Schema>): string {
  return JSON.stringify(schema.parse(data));
}

export type InboundConnection = { agent_number: string } | { webrtc_code: string };

const http_start = /^http:\/\//;
const https_start = /^https:\/\//;

@telemetryClient.trackClass()
export class Client {
  private _apiKey: string;
  private _baseUrl: string;
  private _logger: Logger;
  private _ws?: WebSocket;
  private _controller?: CallController;
  private messageHandler?: (_: WebSocket.MessageEvent) => void;

  constructor(apiKey?: string, baseUrl?: string, logger?: Logger, captureWarnings: boolean = true) {
    // Set up the default logger.
    if (logger) {
      this._logger = logger;
    } else {
      this._logger = getDefaultLogger();
    }

    // Resolve the API base URL.
    if (baseUrl) {
      this._baseUrl = baseUrl;
    } else {
      this._baseUrl = getBaseUrl();
    }

    // Resolve the API key.
    if (apiKey) {
      this._apiKey = apiKey;
    } else if (process.env.GUAVA_API_KEY) {
      this._apiKey = process.env.GUAVA_API_KEY;
    } else {
      throw new Error(
        "Guava API key must be provided either as argument to client constructor, or in environment variable GUAVA_API_KEY.",
      );
    }

    if (!firstClient) {
      firstClient = true;

      if (captureWarnings) {
        process.on("warning", (warning) => {
          this._logger.warn(warning.toString());
        });
      }

      telemetryClient.setSdkHeaders(this.headers());
      this._checkSdkDeprecation();
    }
  }

  private getWebsocketBase() {
    if (http_start.test(this._baseUrl)) {
      return `ws://${this._baseUrl.substring("ws://".length)}`;
    } else if (https_start.test(this._baseUrl)) {
      return `wss://${this._baseUrl.substring("wss://".length)}`;
    } else {
      throw new Error(`Invalid base URL: ${this._baseUrl}}`);
    }
  }

  private getHttpBase() {
    return this._baseUrl;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      "x-guava-platform": os.platform(),
      "x-guava-runtime": process.release.name,
      "x-guava-runtime-version": process.version,
      "x-guava-sdk": SDK_NAME,
      "x-guava-sdk-version": SDK_VERSION,
    };
  }

  private async _checkSdkDeprecation() {
    this._logger.debug(`Checking deprecation for SDK ${SDK_NAME}, ${SDK_VERSION}.`);
    try {
      const url = new URL("v1/check-sdk-deprecation", this.getHttpBase());
      url.searchParams.set("sdk_name", SDK_NAME);
      url.searchParams.set("sdk_version", SDK_VERSION);
      const response = await fetchOrThrow(url, {
        method: "POST",
        headers: this.headers(),
      });
      const body = (await response.json()) as { deprecation_status: string };
      if (body.deprecation_status === "supported") {
        this._logger.info("SDK version still supported.");
      } else if (body.deprecation_status === "deprecated") {
        process.emitWarning(
          "This SDK version is deprecated. Please update to a newer version of the SDK.",
        );
      } else {
        this._logger.warn("SDK deprecation status unknown.");
      }
    } catch (e) {
      this._logger.error("Encountered issue while checking for deprecation.");
    }
  }

  /**
   * @description use the Guava API to call out to a number
   */
  createOutbound(fromNumber: string | undefined, toNumber: string, callController: CallController) {
    const url = new URL("v1/create-outbound", this.getWebsocketBase());
    const ws = new WebSocket(url, {
      headers: this.headers(),
    });

    ws.addEventListener("open", async (_ev) => {
      ws.send(
        stringifyZod(StartOutboundCallCommand, {
          command_type: "start-outbound",
          to_number: toNumber,
          from_number: fromNumber,
        }),
      );

      // set the callController drain function to send all commands
      // through the now open websocket
      callController.setDrain(async (commands) => {
        for (const command of commands.splice(0)) {
          this._logger.debug(`Sending command ${JSON.stringify(command)}`);
          ws.send(JSON.stringify(command));
        }
      });

      await callController.onCallStart();
    });

    ws.addEventListener("close", (_ev) => {
      // we are closing the socket, so don't trigger any other listeners
      ws.removeAllListeners();
      this._ws = undefined;
      this._controller = undefined;
    });

    this._ws = ws;
    this._controller = callController;
    this.replaceHandler(this.uninitializedOutbound.bind(this));
  }

  private replaceHandler(newHandler?: (_: WebSocket.MessageEvent) => void) {
    if (this.messageHandler) {
      this._ws?.removeEventListener("message", this.messageHandler);
    }
    if (newHandler) {
      this._ws?.addEventListener("message", newHandler);
    }
    this.messageHandler = newHandler;
  }

  // eventlistener handlers for server events
  // (a state machine in functions)
  private uninitializedOutbound(ev: WebSocket.MessageEvent) {
    // for correctness (and type correctness)
    if (!this._ws) {
      throw new Error("[internal] Uninitialized WebSocket");
    }

    const session_started = z
      .union([SessionStartedEvent, ErrorEvent])
      .parse(JSON.parse(ev.data.toString("utf8")));
    if (session_started.event_type === "error") {
      throw new Error(`Outbound call failed: ${session_started.content}`);
    } else {
      this._logger.info(`Started session with ID: ${session_started.session_id}`);
      // move to next state
      this.replaceHandler(this.initializedOutbound.bind(this));
    }
  }

  private async initializedOutbound(ev: WebSocket.MessageEvent) {
    // for correctness (and type correctness)
    if (!this._ws) {
      throw new Error("[internal] Uninitialized WebSocket");
    }

    // handle the received event
    const event = decodeEvent(ev.data);
    if (event) {
      if (this._controller) {
        await this._controller.onEvent(event);
      }
      if (event.event_type === "outbound-call-failed" || event.event_type === "bot-session-ended") {
        // shutdown the websocket
        this._ws.close();
      }
    }
  }

  /**
   * @description use the Guava API to receive calls at a given number
   */
  listenInbound<U extends CallController>(
    conn: InboundConnection,
    controllerClassFactory: (logger: Logger) => U,
  ) {
    const callControllers: Record<string, U> = {};

    // return a way to *stop* listening
    const url = new URL("v1/listen-inbound", this.getWebsocketBase());
    const ws = new WebSocket(url, {
      headers: this.headers(),
    });
    let agent_number: string | undefined;
    let webrtc_code: string | undefined;
    if ("agent_number" in conn) {
      agent_number = conn.agent_number;
    } else {
      webrtc_code = conn.webrtc_code;
    }

    this._logger.info(`Listening for calls to ${agent_number ?? webrtc_code}`);

    if (webrtc_code) {
      const debugurl = new URL(`debug-webrtc?webrtc_code=${webrtc_code}`, this.getHttpBase());
      this._logger.debug(`WebRTC DebugURL: ${debugurl}`);
    }

    ws.addEventListener("open", (_ev) => {
      ws.send(
        stringifyZod(ListenInboundCommand, {
          command_type: "listen-inbound",
          agent_number: agent_number,
          webrtc_code: webrtc_code,
        }),
      );
    });

    ws.addEventListener("close", (_ev) => {
      ws.removeAllListeners();
    });

    ws.addEventListener("message", (ev) => {
      const tunnel_event = InboundTunnelEvent.parse(JSON.parse(ev.data.toString("utf8")));
      if (!(tunnel_event.call_id in callControllers)) {
        this._logger.info(
          `Received tunnel event for new call ID: ${tunnel_event.call_id}. Creating call controller.`,
        );

        const newController = controllerClassFactory(this._logger);
        newController.setDrain(async (commands) => {
          for (const command of commands.splice(0)) {
            this._logger.debug(
              `Sending command: ${JSON.stringify(command)} for call ID: ${tunnel_event.call_id}`,
            );
            ws.send(
              stringifyZod(InboundTunnelCommand, {
                call_id: tunnel_event.call_id,
                command,
              }),
            );
          }
        });
        callControllers[tunnel_event.call_id] = newController;
        newController.onEvent(tunnel_event.event);
      } else {
        // no threading, so manually forward to onEvent!
        callControllers[tunnel_event.call_id].onEvent(tunnel_event.event);
      }
    });

    return new InboundListener(ws);
  }
}

class InboundListener {
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  close() {
    this.ws.close();
  }
}
