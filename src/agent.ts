import WebSocket from "ws";
import {
  ActionSuggestionCommand,
  AnswerQuestionCommand,
  ChoiceResultCommand,
  type Command,
  RegisteredHooksCommand,
} from "./commands.ts";
import {
  type AgentSpeechEvent,
  type BotSessionEnded,
  type CallerSpeechEvent,
  type DTMFPressedEvent,
  type EscalateEvent,
  type GuavaEvent,
  decodeEventDict,
} from "./events.ts";
import {
  type ClientMessage as DialerClientMessage,
  type ServerMessage as DialerServerMessage,
  decodeServerMessage as decodeDialerServerMessage,
} from "./guavadialer-events.ts";
import { HealthContext, getHealthServer } from "./health.ts";
import { _generate } from "./helpers/llm.ts";
import { Call, Client } from "./index.ts";
import { type Logger, getDefaultLogger } from "./logging.ts";
import type { CallInfo } from "./socket/call-info.ts";
import { GuavaSocket, GuavaSocketClosedError } from "./socket/client.ts";
import * as ListenInbound from "./socket/listen-inbound.ts";
import { telemetryClient } from "./telemetry.ts";
import { runChat } from "./testing/chat.ts";
import { SessionStarted } from "./testing/protocol.ts";
import { TestSession } from "./testing/session.ts";
import * as z from "zod";
import { fetchOrThrow, getBaseUrl } from "./utils.ts";
import { runWebrtcHelper } from "./webrtc-helper.ts";

export const _roleplayActionSchema = z.object({
  action: z.enum(["speak", "hangup"]),
  utterance: z.string().optional(),
});

export type { CallInfo } from "./socket/call-info.ts";

export type IncomingCallAction = { action: "accept" } | { action: "decline" };

export interface SuggestedAction {
  key: string;
  description?: string;
}

export type InboundConnection =
  | { agent_number: string }
  | { webrtc_code: string }
  | { sip_code: string };

@telemetryClient.trackClass()
export class Agent {
  private _name?: string;
  private _organization?: string;
  private _purpose?: string;
  private _voice?: string;
  private _acceptDtmfForNumbers: boolean;
  private _logger: Logger;

  _client: Client = new Client();

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
  ) => Promise<SuggestedAction | SuggestedAction[] | null | undefined>;
  private _onActionGeneric?: (call: Call, actionKey: string) => Promise<void>;
  private _onActionHandlers: Record<string, (call: Call) => Promise<void>> = {};
  private _onValidateHandlers: Record<
    string,
    (call: Call, value: unknown) => Promise<true | [false, string]>
  > = {};
  private _onSessionEnd?: (call: Call, event: BotSessionEnded) => Promise<void>;
  private _onEscalate?: (call: Call, event: EscalateEvent) => Promise<void>;
  private _onDtmf?: (call: Call, event: DTMFPressedEvent) => Promise<void>;

  constructor(args?: {
    name?: string;
    organization?: string;
    purpose?: string;
    voice?: string;
    acceptDtmf?: boolean;
  }) {
    this._name = args?.name;
    this._organization = args?.organization;
    this._purpose = args?.purpose;
    this._voice = args?.voice;
    this._acceptDtmfForNumbers = args?.acceptDtmf ?? true;
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

  onValidate(
    fieldKey: string,
    callback: (call: Call, value: unknown) => Promise<true | [false, string]>,
  ): void {
    this._onValidateHandlers[fieldKey] = callback;
  }

  onSearchQuery(
    fieldKey: string,
    callback: (call: Call, query: string) => Promise<[string[], string[]]>,
  ): void {
    this._searchQueryHandlers[fieldKey] = callback;
  }

  onActionRequest(
    callback: (
      call: Call,
      intentSummary: string,
    ) => Promise<SuggestedAction | SuggestedAction[] | null | undefined>,
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

  onEscalate(callback: (call: Call, event: EscalateEvent) => Promise<void>): void {
    this._onEscalate = callback;
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
    const healthCtx = new HealthContext();
    await using _server = await getHealthServer(healthCtx);
    return this._listenInbound(healthCtx, { agent_number: phoneNumber });
  }

  async listenWebrtc(webrtcCode?: string): Promise<void> {
    if (!webrtcCode) {
      this._logger.info("No WebRTC code provided. Creating a temporary one.");
      webrtcCode = await this._client.createWebrtcAgent(3600);
    }
    const healthCtx = new HealthContext();
    await using _server = await getHealthServer(healthCtx);
    return this._listenInbound(healthCtx, { webrtc_code: webrtcCode });
  }

  async listenSip(sipCode: string): Promise<void> {
    const healthCtx = new HealthContext();
    await using _server = await getHealthServer(healthCtx);
    return this._listenInbound(healthCtx, { sip_code: sipCode });
  }

  async callLocal(): Promise<void> {
    const webrtcCode = await this._client.createWebrtcAgent(300);
    // No health-server for call_local.
    this._listenInbound(new HealthContext(), { webrtc_code: webrtcCode }).catch((err) => {
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
      const errors: string[] = [];
      for (const fieldKey of call._fieldKeysByTaskId[event.task_id] ?? []) {
        const handler = this._onValidateHandlers[fieldKey];
        if (handler) {
          const result = await handler(call, await call.getField(fieldKey));
          if (result !== true) {
            const [, error] = result;
            errors.push(error);
          }
        }
      }

      if (errors.length > 0) {
        await call.retryTask(errors.join(" "));
      } else {
        this._logger.info(`Task ${event.task_id} completed.`);
        if (this._onTaskCompleteGeneric !== undefined) {
          await this._onTaskCompleteGeneric(call, event.task_id);
        } else if (event.task_id in this._onTaskCompleteHandlers) {
          await this._onTaskCompleteHandlers[event.task_id](call);
        } else {
          this._logger.warn(`No handler registered for completion of task '${event.task_id}'`);
        }
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
      let suggestions: SuggestedAction[] = [];
      if (this._onActionRequested !== undefined) {
        const result = await this._onActionRequested(call, event.intent_summary);
        if (Array.isArray(result)) {
          suggestions = result;
        } else if (result !== null && result !== undefined) {
          suggestions = [result];
        }
      }
      await call.sendCommand(ActionSuggestionCommand, {
        command_type: "action-suggestion",
        intent_id: event.intent_id,
        actions: suggestions.map((s) => ({ key: s.key, description: s.description ?? "" })),
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
    } else if (event.event_type === "escalate") {
      if (this._onEscalate !== undefined) {
        await this._onEscalate(call, event);
      } else if (event.requested_by === "agent") {
        await call.sendInstruction(
          "No escalation target set. Apologize for not being able to help, ask them to try calling another time, and hang up the call immediately.",
        );
      } else {
        await call.sendInstruction(
          "Let them know there are no representatives available to take their call. Ask them if they would prefer to continue or to call another time.",
        );
      }
    } else if (event.event_type === "error") {
      this._logger.error(`The Guava agent reported an error: ${event.content}`);
    } else if (event.event_type === "warning") {
      this._logger.warn(`The Guava agent reported a warning: ${event.content}`);
    }
  }

  async _initCall(
    callId: string,
    callInfo: CallInfo,
    variables: Record<string, any> = {},
  ): Promise<Call> {
    const call = new Call(callId, callInfo, variables);
    await call.setPersona({
      agentName: this._name,
      agentPurpose: this._purpose,
      organizationName: this._organization,
      voice: this._voice,
    });
    await call.sendCommand(RegisteredHooksCommand, {
      command_type: "registered-hooks",
      has_on_question: this._onQuestion !== undefined,
      has_on_intent: false,
      has_on_action_requested: this._onActionRequested !== undefined,
      has_on_escalate: this._onEscalate !== undefined,
      accept_dtmf_for_numbers: this._acceptDtmfForNumbers,
    });
    if (this._onCallStart !== undefined) {
      await this._onCallStart(call);
    }
    return call;
  }

  async _attachToCall(
    callId: string,
    callInfo: CallInfo,
    initialVariables: Record<string, any> = {},
    testSession?: TestSession,
    route: string = "v2/connect-call",
  ): Promise<void> {
    const call = await this._initCall(callId, callInfo, initialVariables);

    const url = new URL(`${route}/${callId}`, this._client.getWebsocketBase());
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

  async _listenInbound(healthCtx: HealthContext, conn: InboundConnection): Promise<void> {
    const url = new URL("v2/listen-inbound", this._client.getWebsocketBase());
    if ("agent_number" in conn) {
      url.searchParams.set("phone_number", conn.agent_number);
    } else if ("webrtc_code" in conn) {
      url.searchParams.set("webrtc_code", conn.webrtc_code);
    } else {
      url.searchParams.set("sip_code", conn.sip_code);
    }

    try {
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
              healthCtx.ready();
              if ("agent_number" in conn) {
                this._logger.info(
                  "Listening on %s (%d other listeners).",
                  conn.agent_number,
                  msg.other_listeners,
                );
              } else if ("webrtc_code" in conn) {
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
              } else {
                this._logger.info(
                  "Listening on SIP code %s (%d other listeners).",
                  conn.sip_code,
                  msg.other_listeners,
                );
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
    } finally {
      healthCtx.stopped();
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
      await this._attachToCall(callId, callInfo, initialVariables);
    }
  }

  /**
   * @description use the Guava API to call out to a number
   */
  async callPhone(
    fromNumber: string,
    toNumber: string,
    variables: Record<string, any> = {},
  ): Promise<void> {
    const url = new URL("v2/create-outbound", this._client.getHttpBase());
    url.searchParams.set("from_number", fromNumber);
    url.searchParams.set("to_number", toNumber);

    const response = await fetchOrThrow(url, {
      method: "POST",
      headers: await this._client.headers(),
    });
    const { call_id } = (await response.json()) as { call_id: string };

    this._logger.info("Outbound call created with session ID: %s", call_id);
    const callInfo: CallInfo = {
      call_type: "pstn",
      from_number: fromNumber ?? null,
      to_number: toNumber,
      caller_id: null,
    };
    await this._attachToCall(call_id, callInfo, variables);
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

    const testCallInfo: CallInfo = {
      call_type: "pstn",
      from_number: null,
      to_number: "+15555555555",
      caller_id: null,
    };
    const attachPromise = this._attachToCall(
      sessionStarted.session_id,
      testCallInfo,
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
   * const session = await agent.roleplay(
   *   "You are a caller trying to buy a new table.",
   * );
   * assert(session.executedActions.includes("sales"));
   */
  async roleplay(
    roleplayPrompt: string,
    variables: Record<string, any> = {},
  ): Promise<TestSession> {
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

          const raw = await _generate(this._client, prompt, z.toJSONSchema(_roleplayActionSchema));
          const action = _roleplayActionSchema.parse(JSON.parse(raw));

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

  /** @deprecated Use {@link roleplay} instead. */
  async testRoleplay(
    roleplayPrompt: string,
    variables: Record<string, any> = {},
  ): Promise<TestSession> {
    return this.roleplay(roleplayPrompt, variables);
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
      voice: this._voice,
      acceptDtmf: this._acceptDtmfForNumbers,
    });
    cloned._onCallReceived = this._onCallReceived;
    cloned._onCallStart = this._onCallStart;
    cloned._onCallerSpeech = this._onCallerSpeech;
    cloned._onAgentSpeech = this._onAgentSpeech;
    cloned._onQuestion = this._onQuestion;
    cloned._onTaskCompleteGeneric = this._onTaskCompleteGeneric;
    cloned._onTaskCompleteHandlers = { ...this._onTaskCompleteHandlers };
    cloned._searchQueryHandlers = { ...this._searchQueryHandlers };
    cloned._onValidateHandlers = { ...this._onValidateHandlers };
    cloned._onActionRequested = this._onActionRequested;
    cloned._onActionGeneric = this._onActionGeneric;
    cloned._onActionHandlers = { ...this._onActionHandlers };
    cloned._onSessionEnd = this._onSessionEnd;
    cloned._onEscalate = this._onEscalate;
    cloned._onDtmf = this._onDtmf;
    return cloned;
  }

  async _serveCampaign(healthCtx: HealthContext, campaignCode: string): Promise<void> {
    try {
      const campaignUrl = new URL(`v1/campaigns/${campaignCode}`, this._client.getHttpBase());
      const campaignResponse = await fetchOrThrow(campaignUrl, {
        headers: await this._client.headers(),
      });
      const campaign = (await campaignResponse.json()) as { id: string; name: string };

      const wsUrl = new URL(`v1/serve-campaign/${campaign.id}`, this._client.getWebsocketBase());
      this._logger.info("Connecting to campaign '%s' (id: %s).", campaign.name, campaign.id);

      await using socket = await new GuavaSocket<DialerClientMessage, DialerServerMessage>(
        "serve-campaign",
        wsUrl.toString(),
        this._client,
        (msg) => msg as unknown as Record<string, unknown>,
        decodeDialerServerMessage,
      ).connect();

      const activeCalls: Promise<void>[] = [];

      try {
        for await (const msg of socket) {
          switch (msg.message_type) {
            case "listen-started":
              this._logger.info("Listening for calls on campaign '%s'. Ready.", campaign.name);
              healthCtx.ready();
              break;
            case "initiate-and-assign-call": {
              const { call_id, contact_data } = msg;
              const data = contact_data as Record<string, unknown> | null;
              const logPhone = (data?.phone_number as string | undefined) ?? "?";
              this._logger.info(
                "Ready to make call, id %s — initiating call setup and dispatch for contact %s.",
                call_id,
                logPhone,
              );
              activeCalls.push(
                (async () => {
                  socket.send({ message_type: "controller-ready", call_id });
                  const variables = (data?.data as Record<string, unknown>) ?? {};
                  const campaignCallInfo: CallInfo = {
                    call_type: "pstn",
                    from_number: null,
                    to_number: (data?.phone_number as string) ?? "",
                    caller_id: null,
                  };
                  await this._attachToCall(
                    call_id,
                    campaignCallInfo,
                    variables,
                    undefined,
                    "v2/connect-campaign-call",
                  );
                })(),
              );
              break;
            }
          }
        }
      } catch (e) {
        if (!(e instanceof GuavaSocketClosedError)) throw e;
        this._logger.info("Campaign '%s' disconnected.", campaign.name);
      }

      await Promise.all(activeCalls);
    } finally {
      healthCtx.stopped();
    }
  }

  /**
   * Attach this agent to an active Guava campaign and handle outbound calls.
   *
   * Blocks until the campaign connection is closed.
   *
   * @param campaignCode - The campaign code (e.g. `gcmp-...`). Create a campaign
   *   and upload contacts via the Guava dashboard or CLI before calling this.
   *
   * @example
   * await agent.attachCampaign("gcmp-abc123");
   */
  async attachCampaign(campaignCode: string): Promise<void> {
    const healthCtx = new HealthContext();
    await using _server = await getHealthServer(healthCtx);
    return this._serveCampaign(healthCtx, campaignCode);
  }

  /* ===== Aliases to be removed at some point. ===== */
  /** @deprecated Use {@link listenPhone} instead. */
  async inboundPhone(phoneNumber: string): Promise<void> {
    return this.listenPhone(phoneNumber);
  }

  /** @deprecated Use {@link callPhone} instead. */
  async outboundPhone(fromNumber: string, toNumber: string, variables: Record<string, any> = {}) {
    return this.callPhone(fromNumber, toNumber, variables);
  }
}
