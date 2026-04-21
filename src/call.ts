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
} from "./commands.ts";
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

export type TaskObjective =
  | { objective: string }
  | { objective?: string; checklist: (FieldItem | SayItem | string)[] };

export type ReachPersonOutcome = {
  key: string;
  description?: string;
  nextActionPreview?: string;
};

@telemetryClient.trackClass()
export class Call {
  private _commandQueue: Command[] = [];
  private _variables: Record<string, any> = {};
  protected logger: Logger;

  // drain functions are expected to cleanup
  // the part of the queue that is successfully sent from its
  // input (mutating it) (i.e. _drain should use Array.splice)
  private _drain?: (_: Command[]) => Promise<void>;
  _fieldValues: Record<string, unknown> = {};

  constructor(variables: Record<string, any> = {}, logger: Logger = getDefaultLogger()) {
    // Set initial variables.
    this._variables = { ...variables };

    // Set up the default logger.
    this.logger = logger;
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

  async sendCommand<C extends Command, Schema extends z.ZodType<C>>(
    schema: Schema,
    data: z.input<Schema>,
  ) {
    const command = schema.parse(data);
    this._commandQueue.push(command);
    await this.flush();
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
        const { choiceGenerator: _, ...fieldData } = item;
        return { ...fieldData, is_search_field: item.searchable } satisfies SerializableFieldItem;
      }
      return item;
    });

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
    options: { outcomes?: ReachPersonOutcome[]; greeting?: string } = {},
  ) {
    const outcomes = options.outcomes ?? [
      { key: "available", description: "The contact is available to speak." },
      {
        key: "unavailable",
        description:
          "The contact is not available to speak. This includes reaching a wrong number.",
      },
    ];

    const availabilityDescription =
      `The availability of ${contactFullName}` +
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
        : `Greet the person who answered the phone. Notify them who you are calling on behalf of and the purpose of the call. Ask to speak with ${contactFullName}`,
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
        "If a next action is defined below for the value of `contact_availability`, briefly ask the contact to wait just a second while you perform it.\n" +
          nextActionLines.join("\n"),
      );
    }

    const objective = `\
OBJECTIVE:
Your goal is to reach ${contactFullName} and determine their availability to proceed with this call.

RULES:
1. If the initial respondent is NOT ${contactFullName}:
   - Politely ask to speak with ${contactFullName}
   - Wait to be transferred or for ${contactFullName} to come to the phone
2. Once you have ${contactFullName} on the line:
   - Briefly restate who you are and the purpose of your call
   - Determine and record their current availability status
3. DO NOT hang up the call under any circumstances, unless it's a wrong number.

TASK COMPLETION REQUIREMENTS:
- The availability of ${contactFullName} must be recorded in \`contact_availability\`.`;

    await this.setTask({ taskId: "reach_person", objective, checklist });
  }

  async setVariable(variableName: string, variableValue: any) {
    this._variables[variableName] = variableValue;
  }

  async getVariable(variableName: string) {
    return this._variables[variableName] ?? null;
  }
}
