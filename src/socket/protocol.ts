import { z } from "zod";

export const CloseReason = z.enum([
  "authentication-failure",
  "state-lost",
  "done",
  "other",
  "server-error",
  "reconnection-failed",
  "unknown",
]);
export type CloseReason = z.infer<typeof CloseReason>;

// -------- CLIENT-ONLY MESSAGES ------------

export const GuavaOpen = z.object({
  message_type: z.literal("open"),
  name: z.string(),
  connection_id: z.string(),
  is_reopen: z.boolean(),
  last_seen_sequence: z.number().int(),
});
export type GuavaOpen = z.infer<typeof GuavaOpen>;

// -------- SERVER-ONLY MESSAGES ------------

export const GuavaOpenAck = z.object({
  message_type: z.literal("open-ack"),
  is_reopen: z.boolean(),
  last_seen_sequence: z.number().int(),
});
export type GuavaOpenAck = z.infer<typeof GuavaOpenAck>;

// -------- BIDIRECTIONAL MESSAGES ------------

export const GuavaClose = z.object({
  message_type: z.literal("close"),
  reason: CloseReason,
  description: z.string(),
});
export type GuavaClose = z.infer<typeof GuavaClose>;

export const GuavaMessage = z.object({
  message_type: z.literal("message"),
  sequence: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
});
export type GuavaMessage = z.infer<typeof GuavaMessage>;

export const GuavaPing = z.object({
  message_type: z.literal("ping"),
  ping_timestamp: z.number().int(),
});
export type GuavaPing = z.infer<typeof GuavaPing>;

export const GuavaPong = z.object({
  message_type: z.literal("pong"),
  ping_timestamp: z.number().int(),
  pong_timestamp: z.number().int(),
});
export type GuavaPong = z.infer<typeof GuavaPong>;

export const GuavaAck = z.object({
  message_type: z.literal("ack"),
  last_seen_sequence: z.number().int(),
});
export type GuavaAck = z.infer<typeof GuavaAck>;

// -------- UNION TYPES ------------

export const GuavaClientMessage = z.discriminatedUnion("message_type", [
  GuavaOpen,
  GuavaClose,
  GuavaMessage,
  GuavaPing,
  GuavaPong,
  GuavaAck,
]);
export type GuavaClientMessage = z.infer<typeof GuavaClientMessage>;

export const GuavaServerMessage = z.discriminatedUnion("message_type", [
  GuavaOpenAck,
  GuavaClose,
  GuavaMessage,
  GuavaPing,
  GuavaPong,
  GuavaAck,
]);
export type GuavaServerMessage = z.infer<typeof GuavaServerMessage>;
