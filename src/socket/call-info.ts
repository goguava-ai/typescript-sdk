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
  custom_payload: z.record(z.string(), z.unknown()).default({}),
});
export type WebRTCCallInfo = z.infer<typeof WebRTCCallInfo>;

const SIPCallInfoSchema = z
  .object({
    call_type: z.literal("sip"),
    from_aor: z
      .string()
      .describe(
        'Despite the name, this field contains the entire SIP from-spec value, not just the AOR. Example: `"Display Name" <sip:user@example.com:5060>;tag=abc123`.',
      ),
    sip_code: z.string().optional(),
    sip_headers: z.record(z.string(), z.string()).default({}),
  })
  .transform((data) => new SIPCallInfo(data.from_aor, data.sip_code, data.sip_headers));

export class SIPCallInfo {
  readonly call_type = "sip" as const;

  constructor(
    readonly from_aor: string,
    readonly sip_code?: string,
    readonly sip_headers: Record<string, string> = {},
  ) {}

  /** The from URI. */
  get fromUri(): string {
    const value = this.from_aor.trim();

    // Skip a quoted display name, which may contain '<', '>' or escaped quotes.
    let i = 0;
    if (value.startsWith('"')) {
      i = 1;
      while (i < value.length && value[i] !== '"') {
        i += value[i] === "\\" ? 2 : 1;
      }
      i += 1;
    }

    // A '<' after the first ';' is inside a header param, not the URI's bracket.
    const start = value.indexOf("<", i);
    const semi = value.indexOf(";", i);
    if (start !== -1 && (semi === -1 || start < semi)) {
      const end = value.indexOf(">", start);
      if (end !== -1) {
        return value.slice(start + 1, end).trim();
      }
    }

    return value.split(";", 1)[0].trim();
  }
}

export const CallInfo = z.discriminatedUnion("call_type", [
  PSTNCallInfo,
  WebRTCCallInfo,
  SIPCallInfoSchema,
]);
export type CallInfo = z.infer<typeof CallInfo>;
