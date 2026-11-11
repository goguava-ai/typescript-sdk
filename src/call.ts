import { type Logger, getDefaultLogger } from "./logging.ts";
import {
  type Command,
  SetPersona,
  type SpeedPreset,
  SetLanguageModeCommand,
  type Language,
  SetTaskCommand,
  SendInstructionCommand,
  TransferCommand,
  HangupCommand,
  ReadScriptCommand,
  RetryTaskCommand,
  SetAgentDTMFCommand,
  SendAgentDTMFCommand,
  SetVariableCommand,
  SendWebRTCMessageCommand,
} from "./commands.ts";
import { DTMF_DIGITS, type DTMFDigit } from "./events.ts";
import * as z from "zod";
import type {
  ActionItem,
  FieldItem,
  SayItem,
  SerializableFieldItem,
  TodoItem,
} from "./action-item.ts";
import { Say } from "./action-item.ts";
import { telemetryClient } from "./telemetry.ts";
import type { CallInfo } from "./socket/call-info.ts";
import type { SipUri } from "./sip.ts";
import { Client } from "./client.ts";
import { idempotentPost } from "./utils.ts";

export type TaskObjective =
  | { objective: string }
  | { objective?: string; checklist: (FieldItem | SayItem | string)[] };

export type ReachPersonOutcome = {
  key: string;
  description?: string;
  nextActionPreview?: string;
};

export const DEFAULT_REACH_PERSON_OUTCOMES: ReachPersonOutcome[] = [
  { key: "available", description: "The intended contact is confirmed on the line." },
  {
    key: "unavailable",
    description:
      "The contact could not be reached. A third party, gatekeeper, or IVR was unable to transfer the call to the contact.",
  },
  { key: "voicemail", description: "An answering machine or voicemail system was reached." },
  { key: "wrong_number", description: "The number does not reach the intended contact." },
  {
    key: "do_not_contact",
    description: "The person on the line has indicated this number should not be called.",
  },
];

function voicemailHangupInstruction(): string {
  return "DO NOT leave a message. REMAIN SILENT AND HANG UP WITHOUT RESPONDING.";
}

function voicemailMessageInstruction(message: string): string {
  return `Say this message VERBATIM: "${message}" Then hang up.`;
}

/** Call-control methods shared by {@link Call} and {@link RemoteCall}. */
export abstract class BaseCall {
  /** Validate a command against its schema and send it to the call. */
  async sendCommand<C extends Command, Schema extends z.ZodType<C>>(
    schema: Schema,
    data: z.input<Schema>,
  ) {
    await this._sendCommand(schema.parse(data));
  }

  protected abstract _sendCommand(command: Command): Promise<void>;

  async setLanguageMode(args: { primary?: Language; secondary?: Language[] }) {
    await this.sendCommand(SetLanguageModeCommand, {
      command_type: "set-language-mode",
      primary: args.primary ?? "english",
      secondary: args.secondary ?? [],
    });
  }

  /**
   * @description provide identifiers the agent will use to identify the virtual agent
   */
  async setPersona(args: {
    organizationName?: string;
    agentName?: string;
    agentPurpose?: string;
    voice?: string;
    speechSpeed?: SpeedPreset;
    pronunciations?: Record<string, string>;
  }) {
    await this.sendCommand(SetPersona, {
      command_type: "set-persona",
      organization_name: args.organizationName,
      agent_name: args.agentName,
      agent_purpose: args.agentPurpose,
      voice: args.voice,
      tts_speed: args.speechSpeed,
      tts_replacements: args.pronunciations,
    });
  }

  /**
   * Transfer the call to another destination.
   *
   * This method does not interfere with turn-taking — use this when
   * you want the agent to naturally transfer the call.
   *
   * @param destination - The phone number, SIP address, or SipUri to transfer the call to.
   * @param instructions - Optional guidance for how the agent should handle the transfer.
   */
  async transfer(destination: string | SipUri, instructions?: string) {
    await this.sendCommand(TransferCommand, {
      command_type: "transfer-call",
      to_number: destination.toString(),
      transfer_message:
        instructions ?? "Notify the caller that you will be transferring them, and then transfer.",
      soft_transfer: true,
    });
  }

  /**
   * Transfer the call immediately.
   *
   * Unlike transfer(), this does not respect turn-taking. The agent immediately
   * initiates the transfer, saying the script (if provided).
   *
   * @param destination - The phone number, SIP address, or SipUri to transfer the call to.
   * @param finalScript - Optional message for the agent to deliver immediately
   *   before transferring. Defaults to no message.
   */
  async immediateTransfer(destination: string | SipUri, finalScript?: string) {
    await this.sendCommand(TransferCommand, {
      command_type: "transfer-call",
      to_number: destination.toString(),
      transfer_message: finalScript ?? "",
      soft_transfer: false,
    });
  }

  /**
   * Hang up the call immediately.
   *
   * Unlike hangup(), this does not respect turn-taking. Any speech the agent
   * has already queued finishes, then the agent says the script (if provided)
   * and the call ends. The caller cannot interrupt once this has been sent.
   *
   * @param finalScript - Optional message for the agent to deliver word-for-word
   *   immediately before hanging up. Defaults to no message.
   */
  async immediateHangup(finalScript?: string) {
    await this.sendCommand(HangupCommand, {
      command_type: "hangup-call",
      final_script: finalScript ?? null,
    });
  }

  async addInfo(label: string, info: unknown) {
    await this.sendInstruction(
      `Here is some information about the following topic ${label}:\n${JSON.stringify(info, null, 2)}`,
    );
  }

  async retryTask(reason: string) {
    await this.sendCommand(RetryTaskCommand, {
      command_type: "retry-task",
      reason,
    });
  }

  async readScript(script: string | Partial<Record<Language, string>>) {
    await this.sendCommand(ReadScriptCommand, {
      command_type: "read-script",
      script,
    });
  }

  async sendInstruction(instruction: string) {
    await this.sendCommand(SendInstructionCommand, {
      command_type: "send-instruction",
      instruction: instruction,
    });
  }

  /**
   * @description hang up an accepted call
   */
  async hangup(final_instructions: string = "") {
    let instructions: string;
    if (final_instructions) {
      instructions = `Start ending the conversation. Here are your final instructions: ${final_instructions} Once you've completed the final instructions, naturally end the conversation and hang up the call.`;
    } else {
      instructions = "Naturally end the conversation and hang up the call.";
    }

    await this.sendInstruction(instructions);
  }
}

/**
 * Controls a call from outside the process handling it, e.g. to transfer a
 * call that another agent is handling.
 */
@telemetryClient.trackClass()
export class RemoteCall extends BaseCall {
  private _callId: string;
  private _client: Client;

  /**
   * @param callId - The ID of the call to control.
   * @param client - Client used to send commands. Defaults to a new {@link Client}.
   */
  constructor(callId: string, client: Client = new Client()) {
    super();
    this._callId = callId;
    this._client = client;
  }

  get id(): string {
    return this._callId;
  }

  protected async _sendCommand(command: Command): Promise<void> {
    const url = new URL(`v1/call/${this._callId}/send-commands`, this._client.getHttpBase());
    await idempotentPost(url, {
      headers: { ...(await this._client.headers()), "Content-Type": "application/json" },
      body: JSON.stringify([command]),
    });
  }
}

@telemetryClient.trackClass()
export class Call extends BaseCall {
  private _callId: string;
  private _callInfo: CallInfo;
  protected _commandQueue: Command[] = [];
  private _variables: Record<string, any> = {};
  protected logger: Logger;

  // drain functions are expected to cleanup
  // the part of the queue that is successfully sent from its
  // input (mutating it) (i.e. _drain should use Array.splice)
  private _drain?: (_: Command[]) => Promise<void>;
  _fieldValues: Record<string, unknown> = {};
  _fieldKeysByTaskId: Record<string, string[]> = {};

  constructor(
    callId: string,
    callInfo: CallInfo,
    variables: Record<string, any> = {},
    logger: Logger = getDefaultLogger(),
  ) {
    super();
    this._callId = callId;
    this._callInfo = callInfo;

    // Set initial variables.
    this._variables = { ...variables };

    // Set up the default logger.
    this.logger = logger;
  }

  get id(): string {
    return this._callId;
  }

  get callInfo(): CallInfo {
    return this._callInfo;
  }

  /**
   * @description Supply a function used to consume commands from the internal command queue.
   *
   * The function is expected to remove from the argument array commands that it has handled (iterating
   * through the result of `Array.splice(0)` is sufficient)
   */
  async setDrain(newDrain: (_: Command[]) => Promise<void>) {
    this._drain = newDrain;
    await this.flush();
  }

  private async flush() {
    await this._drain?.call(this, this._commandQueue);
  }

  async getField(key: string) {
    // Async since the implementation is likely to become async in teh future.
    if (key in this._fieldValues) {
      return this._fieldValues[key];
    } else {
      return null;
    }
  }

  hasField(key: string): boolean {
    return key in this._fieldValues;
  }

  protected async _sendCommand(command: Command): Promise<void> {
    this._commandQueue.push(command);
    await this.flush();
  }

  async setAgentDtmf(enabled: boolean) {
    if (this._callInfo.call_type === "webrtc") {
      throw new Error("WebRTC calls do not support sending DTMF.");
    }
    await this.sendCommand(SetAgentDTMFCommand, {
      command_type: "set-agent-dtmf",
      enabled,
    });
  }

  async sendDtmf(digits: DTMFDigit[] | string) {
    if (this._callInfo.call_type === "webrtc") {
      throw new Error("WebRTC calls do not support sending DTMF.");
    }

    const digitsList = (typeof digits === "string" ? [...digits] : digits) as DTMFDigit[];

    const validSet = new Set<string>(DTMF_DIGITS);
    if (!digitsList.every((d) => validSet.has(d))) {
      throw new Error(
        `Please input a valid set of DTMF digits. The valid DTMF digits are: ${JSON.stringify(DTMF_DIGITS)}.`,
      );
    }

    await this.sendCommand(SendAgentDTMFCommand, {
      command_type: "send-agent-dtmf",
      digits: digitsList,
    });
  }

  /**
   * Send a message to a connected WebRTC client.
   *
   * @param payload - A JSON-serializable object delivered to the client.
   * @throws If this is not a WebRTC call, or `payload` is not JSON-serializable.
   */
  async sendWebrtcMessage(payload: Record<string, unknown>) {
    if (this._callInfo.call_type !== "webrtc") {
      throw new Error("Only WebRTC calls support sending WebRTC messages.");
    }
    if (!z.record(z.string(), z.json()).safeParse(payload).success) {
      throw new Error("WebRTC message payload must be JSON-serializable.");
    }
    await this.sendCommand(SendWebRTCMessageCommand, {
      command_type: "send-webrtc-message",
      payload: payload as Record<string, z.core.util.JSONType>,
    });
  }

  /**
   * @description direct the agent to collect information
   * @param taskArgs.task_id unique identifier for this task
   * @param taskArgs.objective high-level goal for the agent
   * @param taskArgs.checklist ordered list of fields, statements, or instructions to collect
   */
  async setTask(taskArgs: {
    taskId: string;
    objective?: string;
    checklist?: (FieldItem | SayItem | string)[];
    completionCriteria?: string;
  }) {
    const { taskId, objective = "", checklist = [], completionCriteria } = taskArgs;

    if (!objective && checklist.length === 0) {
      throw new Error("At least one of ['objective', 'checklist'] must be provided.");
    }

    const fieldKeys: string[] = [];
    const action_items = checklist.map((item): ActionItem => {
      if (typeof item === "string") {
        return { item_type: "todo", description: item } satisfies TodoItem;
      }
      if (item.item_type === "field") {
        if (item.choiceGenerator) {
          throw new Error(
            "choiceGenerator is not compatible with the Agent / Call API. Use searchable=true and register a handler.",
          );
        }
        fieldKeys.push(item.key);
        const { choiceGenerator: _, ...fieldData } = item;
        return { ...fieldData, is_search_field: item.searchable } satisfies SerializableFieldItem;
      }
      return item;
    });

    this._fieldKeysByTaskId[taskId] = fieldKeys;

    await this.sendCommand(SetTaskCommand, {
      command_type: "set-task",
      task_id: taskId,
      objective,
      action_items,
      completion_criteria: completionCriteria,
    });
  }

  async reachPerson(
    contactFullName: string,
    options: {
      outcomes?: ReachPersonOutcome[];
      greeting?: string;
      voicemailMessage?: string;
      voicemailHangup?: boolean;
    } = {},
  ) {
    if ((await this.getVariable("_voicemail_handler")) === "set_voicemail_action") {
      throw new Error(
        "Cannot call reachPerson() after setVoicemailAction(). " +
          "Use the voicemailMessage or voicemailHangup parameters on reachPerson() instead.",
      );
    }
    await this.setVariable("_voicemail_handler", "reach_person");

    if (options.voicemailMessage && options.voicemailHangup) {
      throw new Error("Cannot specify both 'voicemailMessage' and 'voicemailHangup'.");
    }

    const outcomes = options.outcomes ?? DEFAULT_REACH_PERSON_OUTCOMES;

    let voicemailRule: string;
    if (options.voicemailHangup) {
      voicemailRule = voicemailHangupInstruction();
    } else if (options.voicemailMessage) {
      voicemailRule = voicemailMessageInstruction(options.voicemailMessage);
    } else {
      voicemailRule = "Leave an appropriate voicemail message.";
    }

    const availabilityDescription =
      `The availability of ${contactFullName}.` +
      (outcomes.some((o) => o.description)
        ? "\nDetailed descriptions of each choice:\n" +
          outcomes
            .filter((o) => o.description)
            .map((o) => ` - ${o.key}: ${o.description}`)
            .join("\n")
        : "");

    const checklist: (FieldItem | SayItem | string)[] = [
      options.greeting !== undefined
        ? Say(options.greeting)
        : `Greet the person, IVR, or system who answered the phone. Notify them who you are calling on behalf of and the purpose of the call. Ask to speak with ${contactFullName}. Do not greet if you detect an answering machine or voicemail system.`,
      {
        item_type: "field",
        key: "contact_availability",
        field_type: "multiple_choice",
        description: availabilityDescription,
        choices: outcomes.map((o) => o.key),
      } satisfies FieldItem,
    ];

    const nextActionLines = outcomes
      .filter((o) => o.nextActionPreview)
      .map((o) => `- ${o.key} → ${o.nextActionPreview}`);
    if (nextActionLines.length > 0) {
      checklist.push(
        "If a next action is defined below for the recorded value of `contact_availability`, briefly let the contact know while you perform it.\n" +
          nextActionLines.join("\n"),
      );
    }

    const objective = `\
OBJECTIVE:
Your goal is to reach ${contactFullName} and confirm they are on the line.

RULES:
1. If someone other than ${contactFullName} answers - including a person or IVR:
   - Politely ask to speak with ${contactFullName}, or navigate menus and prompts to reach them.
   - Wait to be transferred or for ${contactFullName} to come to the phone.
   - If ${contactFullName} cannot be reached, record \`contact_availability\` appropriately.
2. Once ${contactFullName} is confirmed on the line:
   - Briefly restate who you are and the purpose of your call
   - Record their availability as available, or equivalent, in \`contact_availability\`.
3. If it is clearly a wrong number or you have been asked not to call, politely end the call and hang up.
4. If you reach an answering machine or voicemail: ${voicemailRule}
`;

    const completionCriteria = `\
TASK COMPLETION REQUIREMENTS:
- The availability of ${contactFullName} must be recorded in \`contact_availability\`.
`;

    await this.setTask({ taskId: "reach_person", objective, checklist, completionCriteria });
  }

  async setVoicemailAction(action: { hangup: true } | { message: string }) {
    if ((await this.getVariable("_voicemail_handler")) === "reach_person") {
      throw new Error(
        "Cannot call setVoicemailAction() after reachPerson(). " +
          "Use the voicemailMessage or voicemailHangup parameters on reachPerson() instead.",
      );
    }
    await this.setVariable("_voicemail_handler", "set_voicemail_action");

    if ("hangup" in action) {
      await this.sendInstruction(
        `If you encounter an answering machine, ${voicemailHangupInstruction()} You should only do this when it's clear you are unable to reach the person.`,
      );
    } else {
      await this.sendInstruction(
        `If you encounter an answering machine, ${voicemailMessageInstruction(action.message)} You should only do this when it's clear you are unable to reach the person.`,
      );
    }
  }

  /**
   * Set a variable on the call, both locally and on the server.
   *
   * @throws If `variableValue` is not JSON-serializable.
   */
  async setVariable(variableName: string, variableValue: any) {
    if (!z.json().safeParse(variableValue).success) {
      throw new Error(`Variable value for key '${variableName}' must be JSON-serializable.`);
    }
    this._variables[variableName] = variableValue;
    await this.sendCommand(SetVariableCommand, {
      command_type: "set-variable",
      key: variableName,
      value: variableValue,
    });
  }

  async getVariable(variableName: string) {
    return this._variables[variableName] ?? null;
  }

  // Aliases for setVariable / getVariable, matching the Python SDK.
  async setVar(variableName: string, variableValue: any) {
    return this.setVariable(variableName, variableValue);
  }

  async getVar(variableName: string) {
    return this.getVariable(variableName);
  }
}
