import WebSocket from "ws";
import { Call, Client } from "./index.ts";
import { getDefaultLogger, type Logger } from "./logging.ts";
import { getBaseUrl, fetchOrThrow } from "./utils.ts";
import { runWebrtcHelper } from "./webrtc-helper.ts";
import {
  AnswerQuestionCommand,
  ChoiceResultCommand,
  RegisteredHooksCommand,
  ActionSuggestionCommand,
  type Command,
} from "./commands.ts";
import {
  type GuavaEvent,
  type CallerSpeechEvent,
  type AgentSpeechEvent,
  type BotSessionEnded,
  type DTMFPressedEvent,
  decodeEventDict,
} from "./events.ts";
import { telemetryClient } from "./telemetry.ts";
import { GuavaSocket, GuavaSocketClosedError } from "./socket/client.ts";
import * as ListenInbound from "./socket/listen-inbound.ts";
import type { CallInfo } from "./socket/call-info.ts";
import { TestSession } from "./testing/session.ts";
import { SessionStarted } from "./testing/protocol.ts";
import { runChat } from "./testing/chat.ts";
import { _generate } from "./helpers/llm.ts";

export type { CallInfo } from "./socket/call-info.ts";

export type IncomingCallAction = { action: "accept" } | { action: "decline" };

export interface SuggestedAction {
  key: string;
  description?: string;
}

export type InboundConnection = { agent_number: string } | { webrtc_code: string };

@telemetryClient.trackClass()
export class Agent {
  private _name?: string;
  private _organization?: string;
  private _purpose?: string;
  private _logger: Logger;

  private _client: Client = new Client();

  private _onCallReceived: (callInfo: CallInfo) => Promise<IncomingCallAction> = async () => ({
    action: "accept",
  });
  private _onCallStart?: (call: Call) => Promise<void>;
  private _onCallerSpeech?: (call: Call, event: CallerSpeechEvent) => Promise<void>;
  private _onAgentSpeech?: (call: Call, event: AgentSpeechEvent) => Promise<void>;
  private _onQuestion?: (call: Call, question: string) => Promise<string>;
  private _onTaskCompleteGeneric?: (call: Call, taskId: string) => Promise<void>;
  private _onTaskCompleteHandlers: Record<string, (call: Call) => Promise<void>> = {};
  private _searchQueryHandlers: Record<
    string,
    (call: Call, query: string) => Promise<[string[], string[]]>
  > = {};
  private _onActionRequested?: (
    call: Call,
    intentSummary: string,
  ) => Promise<SuggestedAction | undefined>;
  private _onActionGeneric?: (call: Call, actionKey: string) => Promise<void>;
  private _onActionHandlers: Record<string, (call: Call) => Promise<void>> = {};
  private _onSessionEnd?: (call: Call, event: BotSessionEnded) => Promise<void>;
  private _onDtmf?: (call: Call, event: DTMFPressedEvent) => Promise<void>;

  constructor(args?: { name?: string; organization?: string; purpose?: string }) {
    this._name = args?.name;
    this._organization = args?.organization;
    this._purpose = args?.purpose;
    this._logger = getDefaultLogger();
  }

  onCallReceived(callback: (callInfo: CallInfo) => Promise<IncomingCallAction>): void {
    this._onCallReceived = callback;
  }

  onCallStart(callback: (call: Call) => Promise<void>): void {
    this._onCallStart = callback;
  }

  onCallerSpeech(callback: (call: Call, event: CallerSpeechEvent) => Promise<void>): void {
    this._onCallerSpeech = callback;
  }

  onAgentSpeech(callback: (call: Call, event: AgentSpeechEvent) => Promise<void>): void {
    this._onAgentSpeech = callback;
  }

  onQuestion(callback: (call: Call, question: string) => Promise<string>): void {
    this._onQuestion = callback;
  }

  onTaskComplete(callback: (call: Call, taskId: string) => Promise<void>): void;
  onTaskComplete(taskName: string, callback: (call: Call) => Promise<void>): void;
  onTaskComplete(
    callbackOrTaskName: ((call: Call, taskId: string) => Promise<void>) | string,
    callback?: (call: Call) => Promise<void>,
  ): void {
    const mixErr = "Cannot mix a generic onTaskComplete handler with per-task handlers.";
    if (typeof callbackOrTaskName === "string") {
      if (this._onTaskCompleteGeneric !== undefined) throw new Error(mixErr);
      this._onTaskCompleteHandlers[callbackOrTaskName] = callback!;
    } else {
      if (Object.keys(this._onTaskCompleteHandlers).length > 0) throw new Error(mixErr);
      this._onTaskCompleteGeneric = callbackOrTaskName;
    }
  }

  onSearchQuery(
    fieldKey: string,
    callback: (call: Call, query: string) => Promise<[string[], string[]]>,
  ): void {
    this._searchQueryHandlers[fieldKey] = callback;
  }

  onActionRequest(
    callback: (call: Call, intentSummary: string) => Promise<SuggestedAction | undefined>,
  ): void {
    this._onActionRequested = callback;
  }

  onAction(callback: (call: Call, actionKey: string) => Promise<void>): void;
  onAction(actionKey: string, callback: (call: Call) => Promise<void>): void;
  onAction(
    callbackOrActionKey: ((call: Call, actionKey: string) => Promise<void>) | string,
    callback?: (call: Call) => Promise<void>,
  ): void {
    const mixErr = "Cannot mix a generic onAction handler with per-action handlers.";
    if (typeof callbackOrActionKey === "string") {
      if (this._onActionGeneric !== undefined) throw new Error(mixErr);
      this._onActionHandlers[callbackOrActionKey] = callback!;
    } else {
      if (Object.keys(this._onActionHandlers).length > 0) throw new Error(mixErr);
      this._onActionGeneric = callbackOrActionKey;
    }
  }

  onSessionEnd(callback: (call: Call, event: BotSessionEnded) => Promise<void>): void {
    this._onSessionEnd = callback;
  }

  onDtmf(callback: (call: Call, event: DTMFPressedEvent) => Promise<void>): void {
    this._onDtmf = callback;
  }

  get handlers() {
    return {
      onCallReceived: (callInfo: CallInfo) => this._onCallReceived(callInfo),
      onCallStart: (call: Call) => {
        if (!this._onCallStart) throw new Error("No onCallStart handler registered.");
        return this._onCallStart(call);
      },
      onCallerSpeech: (call: Call, event: CallerSpeechEvent) => {
        if (!this._onCallerSpeech) throw new Error("No onCallerSpeech handler registered.");
        return this._onCallerSpeech(call, event);
      },
      onAgentSpeech: (call: Call, event: AgentSpeechEvent) => {
        if (!this._onAgentSpeech) throw new Error("No onAgentSpeech handler registered.");
        return this._onAgentSpeech(call, event);
      },
      onQuestion: (call: Call, question: string) => {
        if (!this._onQuestion) throw new Error("No onQuestion handler registered.");
        return this._onQuestion(call, question);
      },
      onTaskComplete: (taskId: string, call: Call) => {
        if (this._onTaskCompleteGeneric) return this._onTaskCompleteGeneric(call, taskId);
        if (taskId in this._onTaskCompleteHandlers)
          return this._onTaskCompleteHandlers[taskId](call);
        throw new Error(`No onTaskComplete handler registered for task '${taskId}'.`);
      },
      onSearchQuery: (fieldKey: string, call: Call, query: string) => {
        if (!(fieldKey in this._searchQueryHandlers))
          throw new Error(`No onSearchQuery handler registered for field '${fieldKey}'.`);
        return this._searchQueryHandlers[fieldKey](call, query);
      },
      onActionRequest: (call: Call, intentSummary: string) => {
        if (!this._onActionRequested) throw new Error("No onActionRequest handler registered.");
        return this._onActionRequested(call, intentSummary);
      },
      onAction: (actionKey: string, call: Call) => {
        if (this._onActionGeneric) return this._onActionGeneric(call, actionKey);
        if (actionKey in this._onActionHandlers) return this._onActionHandlers[actionKey](call);
        throw new Error(`No onAction handler registered for action '${actionKey}'.`);
      },
      onSessionEnd: (call: Call, event: BotSessionEnded) => {
        if (!this._onSessionEnd) throw new Error("No onSessionEnd handler registered.");
        return this._onSessionEnd(call, event);
      },
    };
  }

  onReachPerson(callback: (call: Call, availability: string) => Promise<void>): void {
    this.onTaskComplete("reach_person", async (call) => {
      const availability = (await call.getField("contact_availability")) as string;
      await callback(call, availability);
    });
  }

  async listenPhone(phoneNumber: string): Promise<void> {
    return this._listenInbound({ agent_number: phoneNumber });
  }

  async listenWebrtc(webrtcCode?: string): Promise<void> {
    if (!webrtcCode) {
      this._logger.info("No WebRTC code provided. Creating a temporary one.");
      webrtcCode = await this._client.createWebrtcAgent(3600);
    }
    return this._listenInbound({ webrtc_code: webrtcCode });
  }

  async callLocal(): Promise<void> {
    const webrtcCode = await this._client.createWebrtcAgent(300);
    this._listenInbound({ webrtc_code: webrtcCode }).catch((err) => {
      this._logger.error("Listen loop error: %s", err);
    });
    await runWebrtcHelper(webrtcCode, getBaseUrl());
  }

  private async _dispatchEvent(call: Call, event: GuavaEvent, testSession?: TestSession) {
    if (event.event_type === "caller-speech") {
      if (this._onCallerSpeech !== undefined) {
        await this._onCallerSpeech(call, event);
      }
    } else if (event.event_type === "agent-speech") {
      if (this._onAgentSpeech !== undefined) {
        await this._onAgentSpeech(call, event);
      }
    } else if (event.event_type === "task-done") {
      this._logger.info(`Task ${event.task_id} completed.`);
      if (this._onTaskCompleteGeneric !== undefined) {
        await this._onTaskCompleteGeneric(call, event.task_id);
      } else if (event.task_id in this._onTaskCompleteHandlers) {
        await this._onTaskCompleteHandlers[event.task_id](call);
      } else {
        this._logger.warn(`No handler registered for completion of task '${event.task_id}'`);
      }
    } else if (event.event_type === "agent-question") {
      if (this._onQuestion !== undefined) {
        this._logger.info(`Received question from bot: ${event.question}`);
        let answer: string;
        try {
          answer = await this._onQuestion(call, event.question);
        } catch (err) {
          this._logger.error(`Error occurred while answering question: ${err}`);
          answer = "An error occurred and the question could not be answered.";
        }
        await call.sendCommand(AnswerQuestionCommand, {
          command_type: "answer-question",
          question_id: event.question_id,
          answer,
        });
      } else {
        this._logger.warn(
          `Received question but no onQuestion handler is registered: ${event.question}`,
        );
        await call.sendCommand(AnswerQuestionCommand, {
          command_type: "answer-question",
          question_id: event.question_id,
          answer: "I don't have an answer to that question.",
        });
      }
    } else if (event.event_type === "action-item-done") {
      call._fieldValues[event.key] = event.payload;
    } else if (event.event_type === "choice-query") {
      this._logger.info(`Received search query for field '${event.field_key}': ${event.query}`);
      const handler = this._searchQueryHandlers[event.field_key];
      if (handler === undefined) {
        this._logger.warn(
          `Search query arrived for field '${event.field_key}' with no handler attached.`,
        );
      } else {
        const [matchedChoices, otherChoices] = await handler(call, event.query);
        await call.sendCommand(ChoiceResultCommand, {
          command_type: "choice-query-result",
          field_key: event.field_key,
          query_id: event.query_id,
          matched_choices: matchedChoices,
          other_choices: otherChoices,
        });
      }
    } else if (event.event_type === "action-request") {
      this._logger.info(`Received action request ${event.intent_id}: ${event.intent_summary}`);
      let suggestion: SuggestedAction | undefined;
      if (this._onActionRequested !== undefined) {
        suggestion = await this._onActionRequested(call, event.intent_summary);
      }
      await call.sendCommand(ActionSuggestionCommand, {
        command_type: "action-suggestion",
        intent_id: event.intent_id,
        action_key: suggestion?.key ?? null,
        action_description: suggestion?.description ?? "",
      });
    } else if (event.event_type === "execute-action") {
      this._logger.info(`Executing action '${event.action_key}'`);
      if (testSession) {
        testSession.executedActions.push(event.action_key);
      }
      let onActionFunc: (() => Promise<void>) | undefined;
      if (this._onActionGeneric !== undefined) {
        onActionFunc = () => this._onActionGeneric!(call, event.action_key);
      } else if (event.action_key in this._onActionHandlers) {
        onActionFunc = () => this._onActionHandlers[event.action_key](call);
      }
      if (onActionFunc !== undefined) {
        await onActionFunc();
      } else {
        this._logger.warn(`No handler registered for action '${event.action_key}'`);
      }
    } else if (event.event_type === "bot-session-ended") {
      this._logger.info(`Session ended: ${event.termination_reason}`);
      if (testSession) {
        testSession.terminationReason = event.termination_reason;
      }
      await this._onSessionEnd?.(call, event);
    } else if (event.event_type === "dtmf") {
      if (this._onDtmf !== undefined) {
        await this._onDtmf(call, event);
      }
    } else if (event.event_type === "error") {
      this._logger.error(`The Guava agent reported an error: ${event.content}`);
    } else if (event.event_type === "warning") {
      this._logger.warn(`The Guava agent reported a warning: ${event.content}`);
    }
  }

  async _initCall(variables: Record<string, any> = {}): Promise<Call> {
    const call = new Call(variables);
    await call.setPersona({
      agentName: this._name,
      agentPurpose: this._purpose,
      organizationName: this._organization,
    });
    await call.sendCommand(RegisteredHooksCommand, {
      command_type: "registered-hooks",
      has_on_question: this._onQuestion !== undefined,
      has_on_intent: false,
      has_on_action_requested: this._onActionRequested !== undefined,
    });
    if (this._onCallStart !== undefined) {
      await this._onCallStart(call);
    }
    return call;
  }

  async _attachToCall(
    callId: string,
    initialVariables: Record<string, any> = {},
    testSession?: TestSession,
  ): Promise<void> {
    const call = await this._initCall(initialVariables);

    const url = new URL(`v2/connect-call/${callId}`, this._client.getWebsocketBase());
    await using socket = await new GuavaSocket<Command, GuavaEvent | null>(
      `call-connection-${callId}`,
      url.toString(),
      this._client,
      (cmd) => cmd as unknown as Record<string, unknown>,
      (payload) => decodeEventDict(payload),
      18000,
    ).connect();

    await call.setDrain(async (commands) => {
      for (const command of commands.splice(0)) {
        socket.send(command);
      }
    });

    try {
      for await (const event of socket) {
        if (event === null) continue;
        await this._dispatchEvent(call, event, testSession);
        if (
          event.event_type === "bot-session-ended" ||
          event.event_type === "outbound-call-failed"
        ) {
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof GuavaSocketClosedError)) throw e;
    }
  }

  async _listenInbound(conn: InboundConnection): Promise<void> {
    const url = new URL("v2/listen-inbound", this._client.getWebsocketBase());
    if ("agent_number" in conn) {
      url.searchParams.set("phone_number", conn.agent_number);
    } else {
      url.searchParams.set("webrtc_code", conn.webrtc_code);
    }

    await using socket = await new GuavaSocket<
      ListenInbound.ClientMessage,
      ListenInbound.ServerMessage
    >(
      "listen-inbound",
      url.toString(),
      this._client,
      (msg) => msg as unknown as Record<string, unknown>,
      ListenInbound.decodeServerMessage,
    ).connect();

    try {
      for await (const msg of socket) {
        switch (msg.message_type) {
          case "listen-started":
            if ("agent_number" in conn) {
              this._logger.info(
                "Listening on %s (%d other listeners).",
                conn.agent_number,
                msg.other_listeners,
              );
            } else {
              this._logger.info(
                "Listening on WebRTC code %s (%d other listeners).",
                conn.webrtc_code,
                msg.other_listeners,
              );
              const debugUrl = new URL(
                `debug-webrtc?webrtc_code=${conn.webrtc_code}`,
                this._client.getHttpBase(),
              );
              this._logger.info("Call your agent at: %s", debugUrl);
            }
            break;
          case "incoming-call":
            socket.send({ message_type: "claim-call", call_id: msg.call_id });
            break;
          case "assign-call": {
            const { call_id, call_info } = msg;
            this._logger.info("Received call (session ID: %s)", call_id);
            this._handleAssignedCall(call_id, call_info, socket).catch((err) => {
              this._logger.error("Error handling assigned call %s: %s", call_id, err);
            });
            break;
          }
        }
      }
    } catch (e) {
      if (!(e instanceof GuavaSocketClosedError)) throw e;
    }
  }

  private async _handleAssignedCall(
    callId: string,
    callInfo: CallInfo,
    socket: GuavaSocket<ListenInbound.ClientMessage, ListenInbound.ServerMessage>,
    initialVariables: Record<string, any> = {},
  ): Promise<void> {
    const action = await this._onCallReceived(callInfo);
    if (action.action === "decline") {
      this._logger.info("Declining call %s.", callId);
      socket.send({ message_type: "decline-call", call_id: callId });
    } else {
      this._logger.info("Accepting call %s.", callId);
      socket.send({ message_type: "answer-call", call_id: callId });
      await this._attachToCall(callId, initialVariables);
    }
  }

  /**
   * @description use the Guava API to call out to a number
   */
  async callPhone(
    fromNumber: string | undefined,
    toNumber: string,
    variables: Record<string, any> = {},
  ): Promise<void> {
    const url = new URL("v2/create-outbound", this._client.getHttpBase());
    if (fromNumber) url.searchParams.set("from_number", fromNumber);
    url.searchParams.set("to_number", toNumber);

    const response = await fetchOrThrow(url, {
      method: "POST",
      headers: await this._client.headers(),
    });
    const { call_id } = (await response.json()) as { call_id: string };

    this._logger.info("Outbound call created with session ID: %s", call_id);
    await this._attachToCall(call_id, variables);
  }

  /**
   * Run the agent against a live test session.
   *
   * Connects to the Guava test endpoint, starts the agent's call handling, and
   * calls `callback` with a TestSession for driving the conversation
   * programmatically. Returns the completed TestSession after the callback and
   * call handler both finish.
   *
   * @example
   * const session = await agent.test(async (session) => {
   *   await session.waitForTurn();
   *   session.say("Hi, I'd like to make a purchase.");
   *   await session.waitForEnd();
   * });
   * assert(session.executedActions.includes("sales"));
   */
  async test(
    callback: (session: TestSession) => Promise<void>,
    variables: Record<string, any> = {},
  ): Promise<TestSession> {
    const url = new URL("v1/test-agent", this._client.getWebsocketBase());
    const headers = await this._client.headers();
    const ws = new WebSocket(url.toString(), { headers });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const rawFirst = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });

    const sessionStarted = SessionStarted.parse(JSON.parse(rawFirst));
    const testSession = new TestSession(ws, this._client);

    const attachPromise = this._attachToCall(
      sessionStarted.session_id,
      variables,
      testSession,
    ).catch((err: unknown) => {
      this._logger.error("Error in _attachToCall during test: %s", err);
    });

    try {
      await callback(testSession);
    } finally {
      ws.close();
      await attachPromise;
    }

    return testSession;
  }

  /**
   * Run an automated test conversation where an LLM plays the caller.
   *
   * Connects to the Guava test endpoint, starts the agent, then drives a
   * back-and-forth conversation by repeatedly asking the Guava LLM to decide
   * whether to speak or hang up based on the transcript so far.
   *
   * @param roleplayPrompt - Instructions for the simulated caller, e.g.
   *   `"You are a frustrated customer trying to cancel your subscription."`
   * @param variables - Optional initial call variables.
   * @returns The completed TestSession. Call `session.evaluate()` to assert
   *   pass/fail criteria, or `session.getTranscript()` to inspect the conversation.
   *
   * @example
   * const session = await agent.testRoleplay(
   *   "You are a caller trying to buy a new table.",
   * );
   * assert(session.executedActions.includes("sales"));
   */
  async testRoleplay(
    roleplayPrompt: string,
    variables: Record<string, any> = {},
  ): Promise<TestSession> {
    const roleplaySchema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["speak", "hangup"] },
        utterance: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    };

    return this.test(async (session) => {
      let snapshotLen = 0;
      try {
        while (true) {
          await session.waitForTurn();

          for (const event of session._events.slice(snapshotLen)) {
            if (event.message_type === "bot-tts") {
              this._logger.info("(Roleplay Session) [agent]: %s", event.transcript);
            }
          }
          snapshotLen = session._events.length;

          const transcript = session.getTranscript();
          const prompt = `${roleplayPrompt}

You are roleplaying as a caller on a phone call. Decide what to do next based on the conversation so far.

Conversation:
${transcript || "(The agent has not spoken yet)"}

Choose "speak" and provide your next utterance, or choose "hangup" if the conversation has naturally concluded.`;

          const raw = await _generate(this._client, prompt, roleplaySchema);
          const action = JSON.parse(raw) as { action: string; utterance?: string };

          if (action.action === "hangup") {
            this._logger.info("(Roleplay Session) [caller hangs up]");
            break;
          }

          if (action.action === "speak" && action.utterance) {
            this._logger.info("(Roleplay Session) [caller]: %s", action.utterance);
            session.say(action.utterance);
          }
        }
      } catch (err) {
        if ((err as Error).message === "Test session WebSocket closed") {
          this._logger.info("Roleplay session ended by server.");
        } else {
          throw err;
        }
      }

      for (const event of session._events.slice(snapshotLen)) {
        if (event.message_type === "bot-tts") {
          this._logger.info("(Roleplay Session) [agent]: %s", event.transcript);
        }
      }
    }, variables);
  }

  /**
   * Start an interactive terminal chat session with the agent.
   *
   * Opens a TUI with a scrolling conversation panel and an input line.
   * Agent responses appear in real time. Press Ctrl+C or let the agent
   * end the session to exit.
   *
   * @param variables - Optional initial call variables.
   *
   * @example
   * await agent.chat();
   * // or: await agent.chat({ patient_name: "Benjamin Buttons" });
   */
  async chat(variables: Record<string, any> = {}): Promise<void> {
    await this.test(async (session) => {
      await runChat(session);
    }, variables);
  }

  /**
   * Return a shallow copy of this agent with independently overridable
   * callbacks.
   *
   * Use in tests to register alternative handlers on the clone without
   * affecting the original agent.
   */
  patch(): Agent {
    const cloned = new Agent({
      name: this._name,
      organization: this._organization,
      purpose: this._purpose,
    });
    cloned._onCallReceived = this._onCallReceived;
    cloned._onCallStart = this._onCallStart;
    cloned._onCallerSpeech = this._onCallerSpeech;
    cloned._onAgentSpeech = this._onAgentSpeech;
    cloned._onQuestion = this._onQuestion;
    cloned._onTaskCompleteGeneric = this._onTaskCompleteGeneric;
    cloned._onTaskCompleteHandlers = { ...this._onTaskCompleteHandlers };
    cloned._searchQueryHandlers = { ...this._searchQueryHandlers };
    cloned._onActionRequested = this._onActionRequested;
    cloned._onActionGeneric = this._onActionGeneric;
    cloned._onActionHandlers = { ...this._onActionHandlers };
    cloned._onSessionEnd = this._onSessionEnd;
    cloned._onDtmf = this._onDtmf;
    return cloned;
  }

  /* ===== Aliases to be removed at some point. ===== */
  /** @deprecated Use {@link listenPhone} instead. */
  async inboundPhone(phoneNumber: string): Promise<void> {
    return this.listenPhone(phoneNumber);
  }

  /** @deprecated Use {@link callPhone} instead. */
  async outboundPhone(
    fromNumber: string | undefined,
    toNumber: string,
    variables: Record<string, any> = {},
  ) {
    return this.callPhone(fromNumber, toNumber, variables);
  }
}
