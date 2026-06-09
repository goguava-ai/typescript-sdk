import * as z from "zod";
import { CallInfo } from "./call-info.ts";
export { CallInfo } from "./call-info.ts";

// -------- SERVER MESSAGES --------

export const ListenStarted = z.object({
  message_type: z.literal("listen-started"),
  other_listeners: z.number().int(),
});
export type ListenStarted = z.infer<typeof ListenStarted>;

export const IncomingCall = z.object({
  message_type: z.literal("incoming-call"),
  call_id: z.string(),
});
export type IncomingCall = z.infer<typeof IncomingCall>;

export const AssignCall = z.object({
  message_type: z.literal("assign-call"),
  call_id: z.string(),
  call_info: CallInfo,
});
export type AssignCall = z.infer<typeof AssignCall>;

export const ServerMessage = z.discriminatedUnion("message_type", [
  ListenStarted,
  IncomingCall,
  AssignCall,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// -------- CLIENT MESSAGES --------

export const ClaimCall = z.object({
  message_type: z.literal("claim-call"),
  call_id: z.string(),
});
export type ClaimCall = z.infer<typeof ClaimCall>;

export const AnswerCall = z.object({
  message_type: z.literal("answer-call"),
  call_id: z.string(),
});
export type AnswerCall = z.infer<typeof AnswerCall>;

export const DeclineCall = z.object({
  message_type: z.literal("decline-call"),
  call_id: z.string(),
});
export type DeclineCall = z.infer<typeof DeclineCall>;

export const ClientMessage = z.discriminatedUnion("message_type", [
  ClaimCall,
  AnswerCall,
  DeclineCall,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export function decodeServerMessage(payload: Record<string, unknown>): ServerMessage {
  return ServerMessage.parse(payload);
}
