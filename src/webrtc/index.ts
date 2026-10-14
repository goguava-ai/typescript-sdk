import { type ConnectingTone, JingleTone, LeavingTone, type Tone } from "./tones.ts";

export { type ConnectingTone, JingleTone, RingbackTone, LeavingTone, type Tone } from "./tones.ts";

export type CallState =
  | "not-started" // start() hasn't been called yet.
  | "starting" // Starting the call. Do not play a Ringback yet.
  | "waiting-for-permission" // We're waiting for the Microphone permission prompt. You may show a reminder UI here.
  | "connecting" // The call is now connection to the remote. This is where you can play a ringback or other connecting tone.
  | "connected" // The call is now connected and the audio channel is established.
  | "ended"; // The call has ended.

export type CallErrorCode =
  | "MICROPHONE_ACCESS_FAILED"
  | "CONNECTION_FAILED"
  | "AUTHENTICATION_FAILED"
  | "PROTOCOL_ERROR" // The server sent an unexpected message.
  | "SERVER_ERROR" // The server sent an error message.
  | "REMOTE_HANGUP" // The remote hung up before the call connected.
  | "CONNECTION_TIMEOUT"; // The call didn't connect within connectionTimeoutMs.

export class CallError extends Error {
  readonly code: CallErrorCode;

  constructor(code: CallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CallError";
    this.code = code;
  }
}

// Used if the server doesn't send ICE servers with the auth reply.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.sipgate.net:10000"] },
];

const SOCKET_PROTOCOLS: Record<string, string> = {
  "http:": "ws:",
  "https:": "wss:",
  "ws:": "ws:",
  "wss:": "wss:",
};

// Messages received on the signaling socket. See junkswitch/junkswitch/webrtcsocket.py.
type SignalingMessage =
  | {
      type: "auth";
      body: "OK" | "FAIL";
      reason?: string;
      ice_servers?: RTCIceServer[];
    }
  | { type: "desc"; body: RTCSessionDescriptionInit }
  | { type: "candidate"; body: RTCIceCandidateInit }
  | { type: "hangup" }
  | { type: "error"; body?: string }
  | { type: "transfer" };

export class Call {
  private _state: CallState = "not-started";
  private _error?: CallError;
  private readonly _stateHandlers = new Set<(state: CallState) => void>();
  private readonly _remoteStreamHandlers = new Set<(stream: MediaStream) => void>();
  private readonly _messageHandlers = new Set<(payload: Record<string, unknown>) => void>();
  private readonly _webrtcCode: string;
  private readonly _sockUrl: URL;

  private readonly _remoteAudio: HTMLAudioElement;
  private readonly _connectingTone?: ConnectingTone;
  private readonly _leavingTone?: Tone;
  private readonly _connectionTimeoutMs?: number;
  private readonly _customPayload: Record<string, unknown>;
  private _connectionTimer?: ReturnType<typeof setTimeout>;
  private _sock?: WebSocket;

  private readonly _chatSockUrl: URL;
  // Links the chat socket to this call's session on the server.
  private readonly _chatSessionId = crypto.randomUUID();
  private _chatSock?: WebSocket;
  private _chatReady = false;
  // Messages sent before the chat socket is ready.
  private _pendingChatMessages: string[] = [];

  private _localStream?: MediaStream;
  private _peerConnection?: RTCPeerConnection;
  private _remoteStream?: MediaStream;
  private _iceServers?: RTCIceServer[];
  // Settles the promise returned by start().
  private _pendingStart?: { resolve: () => void; reject: (error: CallError) => void };

  constructor({
    webrtcCode,
    baseUrl = "https://app.goguava.ai/",
    connectingTone = new JingleTone(),
    leavingTone = new LeavingTone(),
    connectionTimeoutMs = 30_000,
    customPayload = {},
  }: {
    /** Code used to authenticate with the signaling server. */
    webrtcCode: string;
    /** Base URL of the Guava server. Defaults to `https://app.goguava.ai/`. */
    baseUrl?: string;
    /** Played while the call is in the "connecting" state. Defaults to {@link JingleTone}. */
    connectingTone?: ConnectingTone | "disabled";
    /** Played when the call ends. Defaults to {@link LeavingTone}. */
    leavingTone?: Tone | "disabled";
    /** Max time in the "connecting" state before the call fails with CONNECTION_TIMEOUT. Defaults to 30 seconds. */
    connectionTimeoutMs?: number | "disabled";
    /** A custom payload that is forwarded to the agent at the start of the call. */
    customPayload?: Record<string, unknown>;
  }) {
    this._webrtcCode = webrtcCode;
    this._customPayload = customPayload;
    if (connectingTone !== "disabled") {
      this._connectingTone = connectingTone;
    }
    if (leavingTone !== "disabled") {
      this._leavingTone = leavingTone;
    }
    if (connectionTimeoutMs !== "disabled") {
      this._connectionTimeoutMs = connectionTimeoutMs;
    }

    this._sockUrl = new URL("/webrtc/", baseUrl);
    const sockProtocol = SOCKET_PROTOCOLS[this._sockUrl.protocol];
    if (sockProtocol === undefined) {
      throw new Error(`Unsupported baseUrl protocol: ${this._sockUrl.protocol}`);
    }
    this._sockUrl.protocol = sockProtocol;
    this._chatSockUrl = new URL("/webrtc-chat/", this._sockUrl);

    this._remoteAudio = document.createElement("audio");
    this._remoteAudio.autoplay = true;
  }

  get state(): CallState {
    return this._state;
  }

  // Set if the call ended due to a failure.
  get error(): CallError | undefined {
    return this._error;
  }

  // Set once the remote audio track arrives, which happens before the call reaches "connected".
  get remoteStream(): MediaStream | undefined {
    return this._remoteStream;
  }

  // Returns a function that unregisters the handler.
  onStateChange(handler: (state: CallState) => void): () => void {
    this._stateHandlers.add(handler);
    return () => {
      this._stateHandlers.delete(handler);
    };
  }

  // Fires whenever the remote stream is replaced, including the first time it arrives.
  // Returns a function that unregisters the handler.
  onRemoteStream(handler: (stream: MediaStream) => void): () => void {
    this._remoteStreamHandlers.add(handler);
    return () => {
      this._remoteStreamHandlers.delete(handler);
    };
  }

  /**
   * Registers a handler for messages the agent sends with `call.send_webrtc_message()`.
   * @param handler - Called with each message's payload.
   * @returns A function that unregisters the handler.
   */
  onMessage(handler: (payload: Record<string, unknown>) => void): () => void {
    this._messageHandlers.add(handler);
    return () => {
      this._messageHandlers.delete(handler);
    };
  }

  private _setState(state: CallState) {
    if (state === this._state) {
      return;
    }

    if (state === "ended") {
      this._leavingTone?.play();
    }

    this._state = state;
    if (state === "connecting") {
      this._connectingTone?.start();
      if (this._connectionTimeoutMs !== undefined) {
        this._connectionTimer = setTimeout(() => {
          this._send({ type: "hangup" });
          this._end(new CallError("CONNECTION_TIMEOUT", "Timed out connecting the call."));
        }, this._connectionTimeoutMs);
      }
    } else {
      this._connectingTone?.stop();
      clearTimeout(this._connectionTimer);
      this._connectionTimer = undefined;
    }
    for (const handler of this._stateHandlers) {
      handler(state);
    }
  }

  async start() {
    if (this._state !== "not-started") {
      throw new Error(`start() was already called.`);
    }
    this._setState("starting");

    // Add the audio element.
    document.body.appendChild(this._remoteAudio);

    // We start by requesting device permissions first. The idea is that, after permission has been granted,
    // it makes sence to play a ringback, but it doesn't make sense to do so during the permission prompt.

    const permissionTimer = setTimeout(() => {
      this._setState("waiting-for-permission");
    }, 500);

    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      const callError = new CallError("MICROPHONE_ACCESS_FAILED", "Failed to access microphone.", {
        cause: error,
      });
      this._end(callError);
      throw callError;
    } finally {
      clearTimeout(permissionTimer);
    }

    // hangup() was called during the permission prompt.
    if (this.state === "ended") {
      this._teardown();
      return;
    }

    // Now open and authenticate the signaling socket.
    this._setState("connecting"); // UI can start playing rinback tones here.
    const started = new Promise<void>((resolve, reject) => {
      this._pendingStart = { resolve, reject };
    });

    this._sock = new WebSocket(this._sockUrl);
    this._sock.onopen = () => {
      this._send({
        type: "auth",
        body: JSON.stringify({
          webrtc_code: this._webrtcCode,
          chat_session_id: this._chatSessionId,
        }),
      });
    };
    this._sock.onmessage = (event) => {
      this._onMessage(JSON.parse(event.data) as SignalingMessage);
    };
    this._sock.onclose = () => {
      this._end(new CallError("CONNECTION_FAILED", "Signaling connection closed."));
    };

    await started;
  }

  /**
   * Sends a message to the agent, delivered to its `on_webrtc_message` handler.
   * Messages sent before the message channel is ready are queued.
   * @param payload - A JSON-serializable object.
   */
  sendMessage(payload: Record<string, unknown>) {
    if (this._state === "not-started" || this._state === "ended") {
      throw new Error(`sendMessage() called while the call is ${this._state}.`);
    }
    const message = JSON.stringify({ type: "webrtc-message", payload });
    if (this._chatReady && this._chatSock !== undefined) {
      this._chatSock.send(message);
    } else {
      this._pendingChatMessages.push(message);
    }
  }

  private _openChatSocket() {
    this._chatSock = new WebSocket(this._chatSockUrl);
    this._chatSock.onopen = () => {
      this._chatSock?.send(
        JSON.stringify({ webrtc_code: this._webrtcCode, chat_session_id: this._chatSessionId }),
      );
    };
    this._chatSock.onmessage = (event) => {
      const message = JSON.parse(event.data) as {
        type?: string;
        command_type?: string;
        payload?: Record<string, unknown>;
      };
      // The server sends "ready" once the call session is found.
      if (message.type === "ready" && !this._chatReady) {
        this._chatReady = true;
        for (const pending of this._pendingChatMessages) {
          this._chatSock?.send(pending);
        }
        this._pendingChatMessages = [];
      } else if (message.command_type === "send-webrtc-message") {
        for (const handler of this._messageHandlers) {
          handler(message.payload ?? {});
        }
      }
    };
  }

  async hangup() {
    if (this._state === "not-started") {
      throw new Error(`hangup() called before start().`);
    }
    if (this._state === "ended") {
      return;
    }
    this._send({ type: "hangup" });
    this._end();
  }

  private _send(message: { type: string; body?: unknown }) {
    if (this._sock !== undefined && this._sock.readyState === WebSocket.OPEN) {
      this._sock.send(JSON.stringify(message));
    }
  }

  private _onMessage(message: SignalingMessage) {
    switch (message.type) {
      case "auth":
        if (message.body !== "OK") {
          this._end(
            new CallError("AUTHENTICATION_FAILED", message.reason || "Authentication failed."),
          );
          return;
        }
        this._iceServers = message.ice_servers;
        this._openChatSocket();
        this._send({ type: "connect", body: { custom_payload: this._customPayload } });
        void this._connectPeer();
        break;
      case "desc":
        if (!this._peerConnection) {
          this._end(
            new CallError(
              "PROTOCOL_ERROR",
              "Received desc before the peer connection was created.",
            ),
          );
          return;
        }
        this._peerConnection.setRemoteDescription(message.body).catch((error) => {
          this._end(
            new CallError("CONNECTION_FAILED", "Failed to set remote description.", {
              cause: error,
            }),
          );
        });
        break;
      case "candidate":
        if (!this._peerConnection) {
          this._end(
            new CallError(
              "PROTOCOL_ERROR",
              "Received candidate before the peer connection was created.",
            ),
          );
          return;
        }
        this._peerConnection.addIceCandidate(message.body).catch((error) => {
          console.warn("Failed to add ICE candidate:", error);
        });
        break;
      case "hangup":
        if (this._state === "connected") {
          this._end();
        } else {
          this._end(
            new CallError("REMOTE_HANGUP", "The remote hung up before the call connected."),
          );
        }
        break;
      case "error":
        this._end(new CallError("SERVER_ERROR", message.body || "Unknown server error."));
        break;
      case "transfer":
        this._end(new CallError("PROTOCOL_ERROR", "Transfers are not supported."));
        break;
      default:
        console.warn("Unknown signaling message:", message);
    }
  }

  private async _connectPeer() {
    if (!this._localStream) {
      return;
    }
    this._peerConnection = new RTCPeerConnection({
      iceServers: this._iceServers ?? DEFAULT_ICE_SERVERS,
    });
    this._peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this._send({ type: "candidate", body: event.candidate });
      }
    };
    this._peerConnection.ontrack = (event) => {
      this._remoteStream = new MediaStream([event.track]);
      this._remoteAudio.srcObject = this._remoteStream;
      for (const handler of this._remoteStreamHandlers) {
        handler(this._remoteStream);
      }
    };
    this._peerConnection.onconnectionstatechange = () => {
      if (this._peerConnection === undefined) {
        return;
      }
      // "disconnected" is often transient, so wait for "failed" before ending the call.
      if (this._peerConnection.connectionState === "connected") {
        this._setState("connected");
        if (this._pendingStart !== undefined) {
          this._pendingStart.resolve();
          this._pendingStart = undefined;
        }
      } else if (this._peerConnection.connectionState === "failed") {
        this._end(new CallError("CONNECTION_FAILED", "Peer connection failed."));
      }
    };
    for (const track of this._localStream.getAudioTracks()) {
      this._peerConnection.addTrack(track);
    }

    try {
      await this._peerConnection.setLocalDescription();
    } catch (error) {
      this._end(new CallError("CONNECTION_FAILED", "Failed to create offer.", { cause: error }));
      return;
    }

    // The call may have ended while creating the offer.
    if (this.state === "ended") {
      return;
    }
    this._send({ type: "desc", body: this._peerConnection.localDescription });
  }

  private _end(error?: CallError) {
    if (this._state === "ended") {
      return;
    }
    this._error = error;
    this._teardown();
    this._setState("ended");

    // If start() is still pending, it rejects on failure and resolves on hangup().
    if (this._pendingStart !== undefined) {
      if (error) {
        this._pendingStart.reject(error);
      } else {
        this._pendingStart.resolve();
      }
      this._pendingStart = undefined;
    }
  }

  private _teardown() {
    // Close the signaling socket.
    if (this._sock) {
      // Don't fire close handlers for a socket we closed ourselves.
      this._sock.onclose = null;
      this._sock.close();
      this._sock = undefined;
    }

    // Close the chat socket.
    if (this._chatSock) {
      this._chatSock.close();
      this._chatSock = undefined;
    }
    this._chatReady = false;
    this._pendingChatMessages = [];

    // Close the peer connection.
    if (this._peerConnection !== undefined) {
      this._peerConnection.close();
      this._peerConnection = undefined;
    }
    for (const track of this._localStream?.getTracks() ?? []) {
      track.stop();
    }
    this._localStream = undefined;
    this._remoteStream = undefined;

    // Remove the audio element.
    this._remoteAudio.srcObject = null;
    this._remoteAudio.remove();
  }
}
