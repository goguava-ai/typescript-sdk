import WebSocket from "ws";
import { Call, Client } from "./index.ts";
import { getDefaultLogger, type Logger } from "./logging.ts";
import * as z from "zod";
import {
  ListenInboundCommand,
  InboundTunnelCommand,
  AnswerQuestionCommand,
  ChoiceResultCommand,
  RegisteredHooksCommand,
  AcceptInboundCallCommand,
  RejectInboundCallCommand,
  StartOutboundCallCommand,
  ActionSuggestionCommand,
} from "./commands.ts";
import {
  type GuavaEvent,
  type CallerSpeechEvent,
  type AgentSpeechEvent,
  InboundTunnelEvent,
  ErrorEvent,
  SessionStartedEvent,
  decodeEvent,
} from "./events.ts";
import { telemetryClient } from "./telemetry.ts";

export interface CallInfo {
  caller_number?: string;
  agent_number?: string;
}

export type IncomingCallAction = { action: "accept" } | { action: "decline" };

export interface SuggestedAction {
  key: string;
  description?: string;
}

/**
 * @description convenience function for stringifying data according to a schema
 */
function stringifyZod<Schema extends z.ZodType>(schema: Schema, data: z.input<Schema>): string {
  return JSON.stringify(schema.parse(data));
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
  private _onSessionEnd?: (call: Call) => Promise<void>;

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

  onSessionEnd(callback: (call: Call) => Promise<void>): void {
    this._onSessionEnd = callback;
  }

  onReachPerson(callback: (call: Call, availability: string) => Promise<void>): void {
    this.onTaskComplete("reach_person", async (call) => {
      const availability = (await call.getField("contact_availability")) as string;
      await callback(call, availability);
    });
  }

  inboundPhone(phoneNumber: string): InboundListener {
    return this._listenInbound({
      agent_number: phoneNumber,
    });
  }

  private async _dispatchEvent(call: Call, event: GuavaEvent) {
    if (event.event_type === "caller-speech") {
      if (this._onCallerSpeech !== undefined) {
        await this._onCallerSpeech(call, event);
      }
    } else if (event.event_type === "agent-speech") {
      if (this._onAgentSpeech !== undefined) {
        await this._onAgentSpeech(call, event);
      }
    } else if (event.event_type === "inbound-call") {
      this._logger.info(`Received inbound call from ${event.caller_number ?? "unknown"}`);
      const action = await this._onCallReceived({
        caller_number: event.caller_number,
        agent_number: event.agent_number,
      });
      if (action.action === "accept") {
        call.sendCommand(AcceptInboundCallCommand, { command_type: "accept-inbound" });
      } else {
        call.sendCommand(RejectInboundCallCommand, { command_type: "reject-inbound" });
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
        call.sendCommand(AnswerQuestionCommand, {
          command_type: "answer-question",
          question_id: event.question_id,
          answer,
        });
      } else {
        this._logger.warn(
          `Received question but no onQuestion handler is registered: ${event.question}`,
        );
        call.sendCommand(AnswerQuestionCommand, {
          command_type: "answer-question",
          question_id: event.question_id,
          answer: "I don't have an answer to that question.",
        });
      }
    } else if (event.event_type === "action-item-done") {
      this._logger.info(`Action item '${event.key}' completed.`);
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
        call.sendCommand(ChoiceResultCommand, {
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
      call.sendCommand(ActionSuggestionCommand, {
        command_type: "action-suggestion",
        intent_id: event.intent_id,
        action_key: suggestion?.key ?? null,
        action_description: suggestion?.description ?? "",
      });
    } else if (event.event_type === "execute-action") {
      this._logger.info(`Executing action '${event.action_key}'`);
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
      this._logger.info("Session ended.");
      if (this._onSessionEnd !== undefined) {
        await this._onSessionEnd(call);
      }
    } else if (event.event_type === "error") {
      this._logger.error(`The Guava agent reported an error: ${event.content}`);
    } else if (event.event_type === "warning") {
      this._logger.warn(`The Guava agent reported a warning: ${event.content}`);
    }
  }

  async _startCall(variables: Record<string, any> = {}): Promise<Call> {
    const call = new Call(variables);
    call.setPersona({
      agentName: this._name,
      agentPurpose: this._purpose,
      organizationName: this._organization,
    });
    call.sendCommand(RegisteredHooksCommand, {
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

  _listenInbound(conn: InboundConnection): InboundListener {
    const calls: Record<string, Call> = {};

    // return a way to *stop* listening
    const url = new URL("v1/listen-inbound", this._client.getWebsocketBase());
    const ws = new WebSocket(url, {
      headers: this._client.headers(),
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
      const debugurl = new URL(
        `debug-webrtc?webrtc_code=${webrtc_code}`,
        this._client.getHttpBase(),
      );
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

    ws.addEventListener("message", async (ev) => {
      const tunnel_event = InboundTunnelEvent.parse(JSON.parse(ev.data.toString("utf8")));
      if (!(tunnel_event.call_id in calls)) {
        this._logger.info(
          `Received tunnel event for new call ID: ${tunnel_event.call_id}. Creating call object.`,
        );

        const call = await this._startCall();
        await call.setDrain(async (commands) => {
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
        calls[tunnel_event.call_id] = call;
      }

      this._dispatchEvent(calls[tunnel_event.call_id], tunnel_event.event);
    });

    return new InboundListener(ws);
  }

  /**
   * @description use the Guava API to call out to a number
   */
  async outboundPhone(
    fromNumber: string | undefined,
    toNumber: string,
    variables: Record<string, any> = {},
  ) {
    const url = new URL("v1/create-outbound", this._client.getWebsocketBase());
    const ws = new WebSocket(url, {
      headers: this._client.headers(),
    });

    const call = await this._startCall(variables);
    let socketInitialized = false;

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
      call.setDrain(async (commands) => {
        for (const command of commands.splice(0)) {
          this._logger.debug(`Sending command ${JSON.stringify(command)}`);
          ws.send(JSON.stringify(command));
        }
      });
    });

    ws.addEventListener("message", (ev) => {
      if (socketInitialized) {
        const session_started = z
          .union([SessionStartedEvent, ErrorEvent])
          .parse(JSON.parse(ev.data.toString("utf8")));

        if (session_started.event_type === "error") {
          throw new Error(`Outbound call failed: ${session_started.content}`);
        } else {
          this._logger.info(`Started session with ID: ${session_started.session_id}`);
          socketInitialized = true;
        }
      } else {
        // handle the received event
        const event = decodeEvent(ev.data);
        if (event) {
          this._dispatchEvent(call, event);
        }
      }
    });

    ws.addEventListener("close", (_ev) => {
      // we are closing the socket, so don't trigger any other listeners
      ws.removeAllListeners();
    });
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
