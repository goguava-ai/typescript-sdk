import * as z from "zod";

export const SessionStartedEvent = z.object({
  event_type: z.literal("session-started"),
  session_id: z.string(),
});
export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;

export const InboundCallEvent = z.object({
  event_type: z.literal("inbound-call"),
  caller_number: z.e164().nullable(),
  agent_number: z.e164().nullable(),
});
export type InboundCallEvent = z.infer<typeof InboundCallEvent>;

/**
 * @description The caller has said something. For utterances with the same id,
 * all but the latest is out of date.
 */
export const CallerSpeechEvent = z.object({
  event_type: z.literal("caller-speech"),

  utterance: z.string(),
  utterance_id: z.string().optional(),
});
export type CallerSpeechEvent = z.infer<typeof CallerSpeechEvent>;

/**
 * @description The agent has said something.
 */
export const AgentSpeechEvent = z.object({
  event_type: z.literal("agent-speech"),

  utterance: z.string(),
  interrupted: z.boolean().default(false),
});
export type AgentSpeechEvent = z.infer<typeof AgentSpeechEvent>;

export const ErrorEvent = z.object({
  event_type: z.literal("error"),
  content: z.string(),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

export const WarningEvent = z.object({
  event_type: z.literal("warning"),
  content: z.string(),
});
export type WarningEvent = z.infer<typeof WarningEvent>;

export const AgentQuestionEvent = z.object({
  event_type: z.literal("agent-question"),
  question_id: z.string(),
  question: z.string(),
});
export type AgentQuestionEvent = z.infer<typeof AgentQuestionEvent>;

export const IntentEvent = z.object({
  event_type: z.literal("intent"),
  intent_id: z.string(),
  intent_summary: z.string(),
});
export type IntentEvent = z.infer<typeof IntentEvent>;

export const ActionItemCompletedEvent = z.object({
  event_type: z.literal("action-item-done"),
  key: z.string(),
  payload: z.unknown(),
});
export type ActionItemCompletedEvent = z.infer<typeof ActionItemCompletedEvent>;

export const TaskCompletedEvent = z.object({
  event_type: z.literal("task-done"),

  task_id: z.string(),
});
export type TaskCompletedEvent = z.infer<typeof TaskCompletedEvent>;

export const OutboundCallConnected = z.object({
  event_type: z.literal("outbound-call-connected"),
});
export type OutboundCallConnected = z.infer<typeof OutboundCallConnected>;

export const OutboundCallFailed = z.object({
  event_type: z.literal("outbound-call-failed"),

  error_code: z.int(),
  error_reason: z.string(),
});
export type OutboundCallFailed = z.infer<typeof OutboundCallFailed>;

export const BotSessionEnded = z.object({
  event_type: z.literal("bot-session-ended"),
  termination_reason: z.enum([
    "user-hangup",
    "bot-hangup",
    "bot-failure",
    "bot-transfer",
    "voicemail",
  ]),
  dnc: z.boolean().default(false),
});
export type BotSessionEnded = z.infer<typeof BotSessionEnded>;

/** Why a bot session ended. */
export type TerminationReason = BotSessionEnded["termination_reason"];

export const ChoiceQueryEvent = z.object({
  event_type: z.literal("choice-query"),
  field_key: z.string(),
  query: z.string(),
  query_id: z.string(),
});
export type ChoiceQueryEvent = z.infer<typeof ChoiceQueryEvent>;

export const ActionRequestEvent = z.object({
  event_type: z.literal("action-request"),
  intent_id: z.string(),
  intent_summary: z.string(),
});
export type ActionRequestEvent = z.infer<typeof ActionRequestEvent>;

export const ExecuteActionEvent = z.object({
  event_type: z.literal("execute-action"),
  action_key: z.string(),
});
export type ExecuteActionEvent = z.infer<typeof ExecuteActionEvent>;

export type DTMFDigit =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "*"
  | "#"
  | "A"
  | "B"
  | "C"
  | "D";

export const DTMFPressedEvent = z.object({
  event_type: z.literal("dtmf"),
  digit: z.enum(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "A", "B", "C", "D"]),
  recent_digits: z.string().default(""),
});
export type DTMFPressedEvent = z.infer<typeof DTMFPressedEvent>;

export const EscalateEvent = z.object({
  event_type: z.literal("escalate"),
  requested_by: z.enum(["human", "agent"]).default("human"),
});
export type EscalateEvent = z.infer<typeof EscalateEvent>;

export const GuavaEvent = z.discriminatedUnion("event_type", [
  SessionStartedEvent,
  InboundCallEvent,
  CallerSpeechEvent,
  AgentSpeechEvent,
  ErrorEvent,
  WarningEvent,
  AgentQuestionEvent,
  IntentEvent,
  ActionItemCompletedEvent,
  TaskCompletedEvent,
  OutboundCallConnected,
  OutboundCallFailed,
  BotSessionEnded,
  ChoiceQueryEvent,
  ActionRequestEvent,
  ExecuteActionEvent,
  EscalateEvent,
  DTMFPressedEvent,
]);
export type GuavaEvent = z.infer<typeof GuavaEvent>;

const _KNOWN_EVENT_TYPES: Set<string> = new Set(
  GuavaEvent.options.map((schema) => schema.shape.event_type.value),
);

export function decodeEventDict(data: Record<string, unknown>): GuavaEvent | null {
  if (typeof data.event_type !== "string") {
    throw new Error(
      `Received event with non-string event_type: ${JSON.stringify(data.event_type)}`,
    );
  }
  if (!_KNOWN_EVENT_TYPES.has(data.event_type)) {
    process.emitWarning(
      `Received an unknown event type ${data.event_type}. Update to a newer version of this SDK.`,
    );
    return null;
  }
  return GuavaEvent.parse(data);
}

export function decodeEvent(
  serialized_event: string | ArrayBuffer | Buffer | Buffer[],
): GuavaEvent | null {
  let data: Record<string, any>;
  if (typeof serialized_event === "string") {
    data = JSON.parse(serialized_event);
  } else if (serialized_event instanceof ArrayBuffer) {
    data = JSON.parse(new TextDecoder().decode(serialized_event));
  } else if (Array.isArray(serialized_event)) {
    let decoded = "";
    for (const buf of serialized_event) {
      decoded += buf.toString("utf8");
    }
    data = JSON.parse(decoded);
  } else {
    data = JSON.parse(serialized_event.toString("utf8"));
  }
  return decodeEventDict(data);
}

export const InboundTunnelEvent = z.object({
  call_id: z.string(),
  event: GuavaEvent,
});
export type InboundTunnelEvent = z.infer<typeof InboundTunnelEvent>;
