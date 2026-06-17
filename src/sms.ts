import * as z from "zod";

/**
 * An inbound SMS message received on one of your Guava numbers.
 *
 * Field names mirror the wire format returned by `GET /v1/messages`.
 */
export const SmsMessage = z.object({
  id: z.string(),
  from_number: z.string(),
  to_number: z.string(),
  content: z.string(),
  received_at: z.string(),
  modality: z.literal("sms"),
  direction: z.enum(["inbound", "outbound"]),
});
export type SmsMessage = z.infer<typeof SmsMessage>;
