import crypto from "node:crypto";
import { Call } from "../call.ts";
import type { CallInfo } from "../socket/call-info.ts";
import type { Command } from "../commands.ts";

export class MockCall extends Call {
  constructor(
    args: { callId?: string; callInfo?: CallInfo; variables?: Record<string, any> } = {},
  ) {
    super(
      args.callId ?? `mock-${crypto.randomBytes(6).toString("hex")}`,
      args.callInfo ?? {
        call_type: "pstn",
        from_number: null,
        to_number: "+15555555555",
        caller_id: null,
      },
      args.variables ?? {},
    );
  }

  get commands(): Command[] {
    return this._commandQueue;
  }

  setField(fieldName: string, fieldValue: unknown): void {
    this._fieldValues[fieldName] = fieldValue;
  }
}
