import { Call } from "../call.ts";
import type { Command } from "../commands.ts";

export class MockCall extends Call {
  get commands(): Command[] {
    return this._commandQueue;
  }

  setField(fieldName: string, fieldValue: unknown): void {
    this._fieldValues[fieldName] = fieldValue;
  }
}
