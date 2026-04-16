import * as z from "zod";
import { ActionItem } from "./action_item.ts";

export const StartOutboundCallCommand = z.strictObject({
  command_type: z.literal("start-outbound"),

  from_number: z.e164().optional(),
  to_number: z.e164(),
});
export type StartOutboundCallCommand = z.input<typeof StartOutboundCallCommand>;

export const ListenInboundCommand = z
  .strictObject({
    command_type: z.literal("listen-inbound"),

    agent_number: z.e164().nullish().default(null),
    webrtc_code: z.string().nullish().default(null),
  })
  .refine(
    (obj) => {
      return typeof obj.agent_number === "string" || typeof obj.webrtc_code === "string";
    },
    { error: "one of ['agent_number', 'webrtc_code'] must be set" },
  );
export type ListenInboundCommand = z.input<typeof ListenInboundCommand>;

export const RejectInboundCallCommand = z.strictObject({
  command_type: z.literal("reject-inbound"),
});
export type RejectInboundCallCommand = z.input<typeof RejectInboundCallCommand>;

export const AcceptInboundCallCommand = z.strictObject({
  command_type: z.literal("accept-inbound"),
});
export type AcceptInboundCallCommand = z.input<typeof AcceptInboundCallCommand>;

export const SetTaskCommand = z.strictObject({
  command_type: z.literal("set-task"),
  task_id: z.string(),
  objective: z.string(),
  action_items: z.array(ActionItem),
});
export type SetTaskCommand = z.input<typeof SetTaskCommand>;

export const ReadScriptCommand = z.strictObject({
  command_type: z.literal("read-script"),
  script: z.string(),
});
export type ReadScriptCommand = z.input<typeof ReadScriptCommand>;

export const AnswerQuestionCommand = z.strictObject({
  command_type: z.literal("answer-question"),
  question_id: z.string(),
  answer: z.string(),
});
export type AnswerQuestionCommand = z.input<typeof AnswerQuestionCommand>;

export const SetPersona = z.strictObject({
  command_type: z.literal("set-persona"),
  agent_name: z.string().optional(),
  organization_name: z.string().optional(),
  agent_purpose: z.string().optional(),
  voice: z.string().optional(),
});
export type SetPersona = z.input<typeof SetPersona>;

export const SendInstructionCommand = z.strictObject({
  command_type: z.literal("send-instruction"),
  instruction: z.string(),
});
export type SendInstructionCommand = z.input<typeof SendInstructionCommand>;

export const TransferCommand = z.strictObject({
  command_type: z.literal("transfer-call"),
  transfer_message: z.string(),
  to_number: z.string(),
});
export type TransferCommand = z.input<typeof TransferCommand>;

export const RegisteredHooksCommand = z.strictObject({
  command_type: z.literal("registered-hooks"),
  has_on_question: z.boolean(),
  has_on_intent: z.boolean(),
});
export type RegisteredHooksCommand = z.input<typeof RegisteredHooksCommand>;

export const ChoiceResultCommand = z.strictObject({
  command_type: z.literal("choice-query-result"),
  field_key: z.string(),
  query_id: z.string(),
  matched_choices: z.array(z.string()),
  other_choices: z.array(z.string()),
});
export type ChoiceResultCommand = z.input<typeof ChoiceResultCommand>;

export const AnyCommand = z.union([
  StartOutboundCallCommand,
  ListenInboundCommand,
  RejectInboundCallCommand,
  AcceptInboundCallCommand,
  SetTaskCommand,
  ReadScriptCommand,
  AnswerQuestionCommand,
  SetPersona,
  SendInstructionCommand,
  TransferCommand,
  RegisteredHooksCommand,
  ChoiceResultCommand,
]);
export type Command = z.input<typeof AnyCommand>;

export const InboundTunnelCommand = z.strictObject({
  call_id: z.string(),
  command: AnyCommand,
});
export type InboundTunnelCommand = z.input<typeof InboundTunnelCommand>;
