import * as z from "zod";

export const PSTNCallInfo = z.object({
  call_type: z.literal("pstn"),
  from_number: z.string().nullable(),
  to_number: z.string(),
  caller_id: z.string().nullable(),
});
export type PSTNCallInfo = z.infer<typeof PSTNCallInfo>;

export const WebRTCCallInfo = z.object({
  call_type: z.literal("webrtc"),
  webrtc_code: z.string(),
});
export type WebRTCCallInfo = z.infer<typeof WebRTCCallInfo>;

export const SIPCallInfo = z.object({
  call_type: z.literal("sip"),
  from_aor: z.string(),
  sip_code: z.string().optional(),
  sip_headers: z.record(z.string(), z.string()).default({}),
});
export type SIPCallInfo = z.infer<typeof SIPCallInfo>;

export const CallInfo = z.discriminatedUnion("call_type", [
  PSTNCallInfo,
  WebRTCCallInfo,
  SIPCallInfo,
]);
export type CallInfo = z.infer<typeof CallInfo>;
