import type WebSocket from "ws";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import { type BotTTS, type InjectASR, TestingEvent } from "./protocol.ts";
import type { Client } from "../client.ts";
import { _generate } from "../helpers/llm.ts";

type SessionEvent = InjectASR | BotTTS;

export const _evalResponseSchema = z.object({
  results: z.array(
    z.object({
      passed: z.boolean(),
      reasoning: z.string().optional(),
    }),
  ),
});

export class TestSession {
  private readonly _ws: WebSocket;
  private readonly _client: Client;
  private _sessionEvents: SessionEvent[] = [];
  private _recvBuffer: TestingEvent[] = [];
  private _recvWaiters: Array<{
    resolve: (v: TestingEvent) => void;
    reject: (e: Error) => void;
  }> = [];
  private _closed = false;

  executedActions: string[] = [];
  terminationReason: string | null = null;
  readonly id: string;

  /** @internal */
  get _events(): ReadonlyArray<InjectASR | BotTTS> {
    return this._sessionEvents;
  }

  constructor(ws: WebSocket, client: Client, id: string) {
    this._ws = ws;
    this._client = client;
    this.id = id;

    ws.on("message", (data) => {
      let event: TestingEvent;
      try {
        event = TestingEvent.parse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      const waiter = this._recvWaiters.shift();
      if (waiter) {
        waiter.resolve(event);
      } else {
        this._recvBuffer.push(event);
      }
    });

    const onClose = () => {
      this._closed = true;
      const err = new Error("Test session WebSocket closed");
      for (const waiter of this._recvWaiters) {
        waiter.reject(err);
      }
      this._recvWaiters = [];
    };

    ws.once("close", onClose);
    ws.once("error", onClose);
  }

  private _rawSend(msg: object): void {
    this._ws.send(JSON.stringify(msg));
  }

  say(utterance: string): void {
    const msg: InjectASR = { message_type: "inject-asr", utterance };
    this._sessionEvents.push(msg);
    this._rawSend(msg);
  }

  async recv(): Promise<TestingEvent> {
    while (true) {
      let event: TestingEvent;

      const buffered = this._recvBuffer.shift();
      if (buffered !== undefined) {
        event = buffered;
      } else {
        event = await new Promise<TestingEvent>((resolve, reject) => {
          if (this._closed) {
            reject(new Error("Test session WebSocket closed"));
            return;
          }
          this._recvWaiters.push({ resolve, reject });
        });
      }

      if (event.message_type === "ping") {
        this._rawSend({ message_type: "pong" });
        continue;
      }

      if (event.message_type === "bot-tts") {
        this._sessionEvents.push(event);
      }

      return event;
    }
  }

  getTranscript(): string {
    const lines: string[] = [];
    for (const event of this._sessionEvents) {
      if (event.message_type === "inject-asr") {
        lines.push(`[caller]: ${event.utterance}`);
      } else {
        lines.push(`[agent]: ${event.transcript}`);
      }
    }
    return lines.join("\n");
  }

  async waitForTurn(): Promise<void> {
    const requestId = randomBytes(8).toString("hex");
    this._rawSend({ message_type: "wait-for-caller-turn", request_id: requestId });
    while (true) {
      const event = await this.recv();
      if (event.message_type === "caller-turn-started" && event.request_id === requestId) {
        return;
      }
    }
  }

  async waitForEnd(): Promise<void> {
    try {
      while (true) {
        await this.recv();
      }
    } catch {
      // Connection closed — session has ended.
    }
  }

  async evaluate({
    passCriteria = [],
    failCriteria = [],
  }: {
    passCriteria?: string[];
    failCriteria?: string[];
  } = {}): Promise<void> {
    const allCriteria = [
      ...passCriteria.map((c) => ({ kind: "pass" as const, criterion: c })),
      ...failCriteria.map((c) => ({ kind: "fail" as const, criterion: c })),
    ];

    if (allCriteria.length === 0) return;

    const transcript = this.getTranscript();
    const criteriaList = allCriteria.map((c, i) => `${i + 1}. ${c.criterion}`).join("\n");

    const prompt = `Evaluate whether the following criteria are met based on the conversation transcript below.
Return one result object per criterion in the same order as listed.

Transcript:
${transcript || "(empty — no conversation occurred)"}

Criteria:
${criteriaList}`;

    const evalResponse = _evalResponseSchema.parse(
      JSON.parse(await _generate(this._client, prompt, z.toJSONSchema(_evalResponseSchema))),
    );

    if (evalResponse.results.length !== allCriteria.length) {
      throw new Error(
        `Evaluation returned ${evalResponse.results.length} results for ${allCriteria.length} criteria.`,
      );
    }

    const failures: string[] = [];
    for (let i = 0; i < allCriteria.length; i++) {
      const { kind, criterion } = allCriteria[i]!;
      const result = evalResponse.results[i]!;
      if (kind === "pass" && !result.passed) {
        let msg = `Pass criterion not met: ${JSON.stringify(criterion)}`;
        if (result.reasoning) msg += ` — ${result.reasoning}`;
        failures.push(msg);
      } else if (kind === "fail" && result.passed) {
        let msg = `Fail criterion triggered: ${JSON.stringify(criterion)}`;
        if (result.reasoning) msg += ` — ${result.reasoning}`;
        failures.push(msg);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Session evaluation failed:\n${failures.map((f) => `  • ${f}`).join("\n")}`);
    }
  }
}
