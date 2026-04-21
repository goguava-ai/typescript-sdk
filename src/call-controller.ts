import { type Logger, getDefaultLogger } from "./logging.ts";
import {
  AcceptInboundCallCommand,
  type Command,
  SetPersona,
  SetTaskCommand,
  AnswerQuestionCommand,
  SendInstructionCommand,
  ReadScriptCommand,
  RejectInboundCallCommand,
  TransferCommand,
  ChoiceResultCommand,
} from "./commands.ts";
import type * as z from "zod";
import type { GuavaEvent, CallerSpeechEvent, AgentSpeechEvent } from "./events.ts";
import {
  type ActionItem,
  type ChoiceGenerator,
  type FieldItem,
  type SayItem,
  type SerializableFieldItem,
  Say,
  type TodoItem,
} from "./action-item.ts";
import { telemetryClient } from "./telemetry.ts";

export type TaskObjective =
  | { objective: string }
  | { objective?: string; checklist: (FieldItem | SayItem | string)[] };

export type ReachPersonOutcome = {
  key: string;
  onOutcome: () => void;
  description?: string;
  nextActionPreview?: string;
};

type ReachPersonOptions =
  | { onSuccess: () => void; onFailure: () => void; greeting?: string }
  | { outcomes: ReachPersonOutcome[]; greeting?: string };

/**
 * Interface between Guava services and user-supplied code
 */
@telemetryClient.trackClass()
export class CallController {
  private _commandQueue: Command[] = [];
  private _on_complete_current_task?: () => void;
  // private _field_values: Record<string, any>;
  private _current_task_id?: string;
  /**
   * @protected
   * @description logger used to emit diagnostics
   */
  protected logger: Logger;
  // drain functions are expected to cleanup
  // the part of the queue that is successfully sent from its
  // input (mutating it) (i.e. _drain should use Array.splice)
  private _drain?: (_: Command[]) => Promise<void>;
  private _fieldValues: Record<string, unknown> = {};
  private _searchFunctionsByKey: Record<string, ChoiceGenerator> = {};

  constructor(logger: Logger = getDefaultLogger()) {
    // Set up the default logger.
    this.logger = logger;
  }

  /**
   * @description Supply a function used to consume commands from the internal command queue.
   *
   * The function is expected to remove from the argument array commands that it has handled (iterating
   * through the result of `Array.splice(0)` is sufficient)
   */
  setDrain(newDrain: (_: Command[]) => Promise<void>) {
    this._drain = newDrain;
    this.flush();
  }

  /**
   * @description [inbound] receive a call, and process further.
   */
  protected async acceptCall() {
    await this.sendCommand(AcceptInboundCallCommand, {
      command_type: "accept-inbound",
    });
  }

  /**
   * @description read a span of text verbatim
   */
  protected async readScript(script: string) {
    await this.sendCommand(ReadScriptCommand, {
      command_type: "read-script",
      script: script,
    });
  }

  /**
   * @description [inbound] reject a call
   */
  protected async rejectCall() {
    await this.sendCommand(RejectInboundCallCommand, {
      command_type: "reject-inbound",
    });
  }

  protected async addInfo(_info: string) {
    throw new Error("not implemeneted");
  }

  /**
   * @description read a span of text non-verbatim
   */
  protected async sendInstruction(instruction: string) {
    await this.sendCommand(SendInstructionCommand, {
      command_type: "send-instruction",
      instruction: instruction,
    });
  }

  /**
   * @description provide identifiers the agent will use to identify the virtual agent
   */
  protected async setPersona(args: {
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
   * @param goal {} an objective string and/or a checklist of information to collect
   * @param on_complete {} a callback to call once the information is available from the agent
   * @param args {} arguments to pass through to the `on_complete` callback
   */
  protected setTask(
    goal: TaskObjective,
    on_complete: (...c: any[]) => void = () => {},
    ...args: any[]
  ) {
    this._current_task_id = Math.random().toString(16).substring(2, 8);
    this._on_complete_current_task = on_complete.bind(this, ...args);
    if (!("checklist" in goal)) {
      this.sendCommand(SetTaskCommand, {
        command_type: "set-task",
        task_id: this._current_task_id,
        objective: goal.objective,
        action_items: [],
      });
    } else {
      const action_items = goal.checklist.map((item): ActionItem => {
        if (typeof item === "string") {
          return { item_type: "todo", description: item } satisfies TodoItem;
        }
        if (item.item_type === "field" && item.choiceGenerator) {
          this._searchFunctionsByKey[item.key] = item.choiceGenerator;
          const { choiceGenerator: _, ...fieldData } = item;
          return {
            ...fieldData,
            is_search_field: true,
          } satisfies SerializableFieldItem;
        }
        return item;
      });
      this.sendCommand(SetTaskCommand, {
        command_type: "set-task",
        task_id: this._current_task_id,
        objective: goal.objective ?? "",
        action_items,
      });
    }
  }

  /**
   * @description direct the agent to collect information, continuing execution once the agent has collected the information
   * @param goal {} an objective string and/or a checklist of information to collect
   */
  protected async awaitTask(goal: TaskObjective): Promise<void> {
    return new Promise((resolve) => {
      this.setTask(goal, (_args) => {
        resolve();
      });
    });
  }

  /**
   * @description retrieve a piece of information that the agent has collected
   * @param key {string} key of the field checklist item
   */
  protected getField(key: string) {
    if (key in this._fieldValues) {
      return this._fieldValues[key];
    } else {
      return null;
    }
  }

  /**
   * @description [inbound] hang up an accepted call
   */
  protected async hangup(final_instructions: string = "") {
    let instructions: string;
    if (final_instructions) {
      instructions = `Start ending the conversation. Here are your final instructions: ${final_instructions} Once you've completed the final instructions, naturally end the conversation and hang up the call.`;
    } else {
      instructions = "Naturally end the conversation and hang up the call.";
    }

    this.sendInstruction(instructions);
  }

  /**
   * @description helper for reaching a specific contact on an outbound call and recording their availability.
   */
  protected reachPerson(contactFullName: string, options: ReachPersonOptions) {
    let outcomes: ReachPersonOutcome[];
    if ("outcomes" in options) {
      outcomes = options.outcomes;
    } else {
      outcomes = [
        {
          key: "contact_available",
          onOutcome: options.onSuccess,
          description: "The contact is available to speak.",
        },
        {
          key: "contact_unavailable",
          onOutcome: options.onFailure,
          description:
            "The contact is not available to speak. This includes reaching a wrong number.",
        },
      ];
    }

    const outcomeHandlers = Object.fromEntries(outcomes.map((o) => [o.key, o.onOutcome]));

    const initialGreeting: FieldItem | SayItem | string =
      options.greeting !== undefined
        ? Say(options.greeting)
        : `Greet the person who answered the phone. Notify them who you are calling on behalf of and the purpose of the call. Ask to speak with ${contactFullName}`;

    const availabilityDescription =
      `The availability of ${contactFullName}` +
      (outcomes.some((o) => o.description)
        ? "\nDetailed descriptions of each choice:\n" +
          outcomes
            .filter((o) => o.description)
            .map((o) => ` - ${o.key}: ${o.description}`)
            .join("\n")
        : "");

    const nextActionLines = outcomes
      .filter((o) => o.nextActionPreview)
      .map((o) => `- ${o.key} → ${o.nextActionPreview}`);
    const checklist: (FieldItem | SayItem | string)[] = [
      initialGreeting,
      {
        item_type: "field",
        key: "contact_availability",
        field_type: "multiple_choice",
        description: availabilityDescription,
        choices: outcomes.map((o) => o.key),
      },
    ];
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

    this.setTask({ objective, checklist }, () => {
      const availability = this.getField("contact_availability") as string;
      const handler = outcomeHandlers[availability];
      if (!handler) {
        this.logger.error(`Unhandled contact_availability value: ${availability}`);
        return;
      }
      this.logger.info(`Contact availability recorded: ${availability}`);
      handler();
    });
  }

  /**
   * @description transfer an accepted call
   */
  protected transfer(to_number: string, transfer_message?: string) {
    const message = transfer_message ?? "I'm transferring you now";
    this.sendCommand(TransferCommand, {
      command_type: "transfer-call",
      transfer_message: message,
      to_number: to_number,
    });
  }

  private async sendCommand<C extends Command, Schema extends z.ZodType<C>>(
    schema: Schema,
    data: z.input<Schema>,
  ) {
    const command = schema.parse(data);
    this._commandQueue.push(command);
    await this.flush();
  }

  private async flush() {
    await this._drain?.call(this, this._commandQueue);
  }

  async onEvent(event: GuavaEvent) {
    this.logger.debug(`Event received: ${JSON.stringify(event)}`);
    if (event.event_type === "caller-speech") {
      this.onCallerSpeech(event);
    } else if (event.event_type === "agent-speech") {
      this.onAgentSpeech(event);
    } else if (event.event_type === "agent-question") {
      try {
        this.logger.info(`Received question from bot: ${event.question}`);
        const answer = await this.onQuestion(event.question);
        await this.sendCommand(AnswerQuestionCommand, {
          command_type: "answer-question",
          question_id: event.question_id,
          answer: answer,
        });
      } catch (e) {
        this.logger.error("Error occured while answering question.");
        await this.sendCommand(AnswerQuestionCommand, {
          command_type: "answer-question",
          question_id: event.question_id,
          answer: "An error occured and the question could not be answered.",
        });
      }
    } else if (event.event_type === "intent") {
      this.logger.info(`Received intent ${event.intent_id} from bot: ${event.intent_summary}`);
      const intent_response = await this.onIntent(event.intent_summary);
      if (intent_response) {
        const response_str = `Responding to intent ${event.intent_id}: ${intent_response}`;
        this.logger.info(response_str);
        this.sendInstruction(intent_response);
      }
    } else if (event.event_type === "task-done") {
      // ignore obsolete task_completed events
      if (event.task_id === this._current_task_id) {
        // assertion is implied
        const on_complete = this._on_complete_current_task;
        this._on_complete_current_task = undefined;
        if (on_complete) {
          on_complete();
        }
      }
    } else if (event.event_type === "choice-query") {
      this.logger.info(`Received choice query for field ${event.field_key}: ${event.query}`);
      const choiceGenerator = this._searchFunctionsByKey[event.field_key];
      if (!choiceGenerator) {
        this.logger.warn(
          `Choice query for field '${event.field_key}' arrived but has no choice generator attached.`,
        );
      } else {
        const [matchedChoices, otherChoices] = await choiceGenerator(event.query);
        await this.sendCommand(ChoiceResultCommand, {
          command_type: "choice-query-result",
          field_key: event.field_key,
          query_id: event.query_id,
          matched_choices: matchedChoices,
          other_choices: otherChoices,
        });
      }
    } else if (event.event_type === "action-item-done") {
      this._fieldValues[event.key] = event.payload;
      if (event.key && event.payload) {
        this.logger.info(`Field ${event.key} updated with value: ${event.payload}`);
      }
    } else if (event.event_type === "inbound-call") {
      this.onIncomingCall(event.caller_number);
    } else if (event.event_type === "bot-session-ended") {
      this.onSessionDone();
    } else if (event.event_type === "outbound-call-connected") {
      // no-op, don't warn
    } else if (event.event_type === "error") {
      this.logger.error(`The Guava agent reported an error: ${event.content}`);
    } else {
      this.logger.warn(`Unhandled event: ${JSON.stringify(event)}`);
    }
  }

  // callbacks

  /**
   * @description called when an inbound call is received. The overriding function must start
   * with `await super.onIncomingCall(from_number)`
   */
  async onIncomingCall(from_number?: string) {
    await this.onCallStart();
  }

  /**
   * @description called when a call is connected by the API, whether inbound or outbound
   */
  async onCallStart(): Promise<void> {}

  /**
   * @description called when the caller speaks to the agent.
   */
  async onCallerSpeech(event: CallerSpeechEvent) {}
  /**
   * @description called when the agent speaks to the caller.
   */
  async onAgentSpeech(event: AgentSpeechEvent) {}
  /**
   * @description called when the caller expresses a task they wish to execute
   */
  async onIntent(intent: string): Promise<string | null> {
    return "Unfortunately I'm not able to help with that.";
  }
  /**
   * @description called when the agent needs to respond to a question that it doesn't know
   * the answer to.
   */
  async onQuestion(question: string): Promise<string> {
    return "I don't have an answer to that question.";
  }

  /**
   * @description called when the bot session has ended.
   */
  onSessionDone(): void {}
}
