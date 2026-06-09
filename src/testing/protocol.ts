import * as z from "zod";

export const Ping = z.object({ message_type: z.literal("ping") });
export type Ping = z.infer<typeof Ping>;

export const Pong = z.object({ message_type: z.literal("pong") });
export type Pong = z.infer<typeof Pong>;

export const InjectASR = z.object({
  message_type: z.literal("inject-asr"),
  utterance: z.string(),
});
export type InjectASR = z.infer<typeof InjectASR>;

export const WaitForTurn = z.object({
  message_type: z.literal("wait-for-caller-turn"),
  request_id: z.string(),
});
export type WaitForTurn = z.infer<typeof WaitForTurn>;

export const BotTTS = z.object({
  message_type: z.literal("bot-tts"),
  transcript: z.string(),
});
export type BotTTS = z.infer<typeof BotTTS>;

export const TurnStarted = z.object({
  message_type: z.literal("caller-turn-started"),
  request_id: z.string(),
});
export type TurnStarted = z.infer<typeof TurnStarted>;

export const SessionStarted = z.object({
  message_type: z.literal("session-started"),
  session_id: z.string(),
});
export type SessionStarted = z.infer<typeof SessionStarted>;

export const TestingEvent = z.discriminatedUnion("message_type", [Ping, Pong, BotTTS, TurnStarted]);
export type TestingEvent = z.infer<typeof TestingEvent>;
