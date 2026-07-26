import { type Logger, getDefaultLogger } from "./logging.ts";
import {
  type Command,
  SetPersona,
  SetLanguageModeCommand,
  type Language,
  SetTaskCommand,
  SendInstructionCommand,
  TransferCommand,
  ReadScriptCommand,
  RetryTaskCommand,
  SetAgentDTMFCommand,
  SendAgentDTMFCommand,
} from "./commands.ts";
import { DTMF_DIGITS, type DTMFDigit } from "./events.ts";
import type * as z from "zod";
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

@telemetryClient.trackClass()
export class Call {
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

  async sendCommand<C extends Command, Schema extends z.ZodType<C>>(
    schema: Schema,
    data: z.input<Schema>,
  ) {
    const command = schema.parse(data);
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
  }) {
    await this.sendCommand(SetPersona, {
      command_type: "set-persona",
      organization_name: args.organizationName,
      agent_name: args.agentName,
      agent_purpose: args.agentPurpose,
      voice: args.voice,
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

  async transfer(destination: string, instructions?: string) {
    await this.sendCommand(TransferCommand, {
      command_type: "transfer-call",
      to_number: destination,
      transfer_message:
        instructions ?? "Notify the caller that you will be transferring them, and then transfer.",
      soft_transfer: true,
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

  async readScript(script: string) {
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

  async setVariable(variableName: string, variableValue: any) {
    this._variables[variableName] = variableValue;
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
