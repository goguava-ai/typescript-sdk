import * as z from "zod";
import type { SuggestedAction } from "../agent.ts";
import { Client } from "../client.ts";
import { telemetryClient } from "../telemetry.ts";
import { fetchOrThrow } from "../utils.ts";
import { ServerRAG } from "./server-rag.ts";

export async function _generate(
  client: Client,
  prompt: string,
  jsonSchema?: object,
): Promise<string> {
  const url = new URL("v1/llm/generate", client.getHttpBase());
  const body: Record<string, unknown> = { prompt };
  if (jsonSchema !== undefined) body.json_schema = jsonSchema;

  const response = await fetchOrThrow(url, {
    method: "POST",
    headers: { ...(await client.headers()), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  return ((await response.json()) as { text: string }).text;
}

@telemetryClient.trackClass()
export class DocumentQA {
  private readonly _rag: ServerRAG;
  private readonly _instructions: string | undefined;
  private readonly _initialized: Promise<void>;

  constructor({
    documents,
    ids,
    instructions,
    namespace,
  }: {
    documents?: string | string[];
    ids?: string[];
    instructions?: string;
    namespace?: string;
  } = {}) {
    this._rag = new ServerRAG(new Client(), { namespace });
    this._instructions = instructions;

    if (documents !== undefined) {
      const docs = typeof documents === "string" ? [documents] : documents;
      this._initialized = this._rag.reconcile(docs, ids);
    } else {
      this._initialized = Promise.resolve();
    }
  }

  async upsertDocument(key: string, text: string): Promise<void> {
    await this._initialized;
    await this._rag.upsertDocument(key, text);
  }

  async addDocument(text: string): Promise<void> {
    await this._initialized;
    await this._rag.addDocument(text);
  }

  async deleteDocument(key: string): Promise<void> {
    await this._initialized;
    await this._rag.removeDocument(key);
  }

  async clear(): Promise<void> {
    await this._initialized;
    await this._rag.clear();
  }

  async ask(question: string): Promise<string> {
    await this._initialized;
    const trackedKeys = this._rag.trackedKeys;
    return this._rag.ask(question, {
      documentKeys: trackedKeys.size > 0 ? [...trackedKeys] : undefined,
      instructions: this._instructions,
    });
  }
}

export const _filterSchema = z.object({
  matching_appointments: z.array(z.string()),
  other_appointments: z.array(z.string()),
});

@telemetryClient.trackClass()
export class DatetimeFilter {
  private readonly _client: Client;
  private readonly _slotsStr: string;

  constructor(sourceList: string[]) {
    this._client = new Client();
    this._slotsStr = sourceList.join("\n");
  }

  async filter(
    query: string,
    { maxResults = 5 }: { maxResults?: number } = {},
  ): Promise<[string[], string[]]> {
    const today = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const prompt = `Return datetime slots from the list that match the query.
If none match, return close alternatives in other_appointments instead.
Never return datetimes that are not in the list.

Query: <query>${query}</query>
Today's Date: ${today}
Available slots:
${this._slotsStr}

Return at most ${maxResults} items per list.`;

    const text = await _generate(this._client, prompt, z.toJSONSchema(_filterSchema));
    const result = _filterSchema.parse(JSON.parse(text));
    return [
      result.matching_appointments.slice(0, maxResults),
      result.other_appointments.slice(0, maxResults),
    ];
  }
}

export function _makeIntentSchema(choiceList: [string, ...string[]]) {
  return z
    .object({
      possible_matches: z
        .array(z.enum(choiceList))
        .describe(
          "Choices that could match the caller's intent, ordered by likelihood. Include all plausible matches.",
        ),
    })
    .meta({ title: "ChoiceModel" });
}

@telemetryClient.trackClass()
export class IntentRecognizer {
  private readonly _client: Client;
  private readonly _intentChoices: string[] | Record<string, string>;
  private readonly _schema: ReturnType<typeof _makeIntentSchema>;

  constructor(intentChoices: string[] | Record<string, string>) {
    this._client = new Client();
    this._intentChoices = intentChoices;
    const choiceList = Array.isArray(intentChoices) ? intentChoices : Object.keys(intentChoices);
    this._schema = _makeIntentSchema(choiceList as [string, ...string[]]);
  }

  async classify(intent: string): Promise<SuggestedAction[] | null> {
    const choiceList = Array.isArray(this._intentChoices)
      ? this._intentChoices
      : Object.keys(this._intentChoices);

    let prompt = `Classify the intent below into the most appropriate choice(s) from the list.

Intent: <intent>${intent}</intent>
Available Choices: ${JSON.stringify(choiceList)}

Rules:
- Default to returning a single choice — the one that best matches the intent.
- Only return additional choices when the intent is genuinely ambiguous: a reasonable person reading it would be unable to decide which category it belongs to. Thematic overlap or partial relevance is NOT enough — do not include weakly or tangentially related choices.
- Order matches by likelihood (most likely first).
- If no choice plausibly matches, return an empty list.`;

    if (!Array.isArray(this._intentChoices)) {
      const descriptionString = Object.entries(this._intentChoices)
        .map(([key, val]) => `${key}: ${val}`)
        .join("\n  ");
      prompt += `\n\nDetailed descriptions of each choice:\n  ${descriptionString}`;
    }

    const text = await _generate(this._client, prompt, z.toJSONSchema(this._schema));
    const { possible_matches: keys } = this._schema.parse(JSON.parse(text));

    if (!keys.length) return null;

    if (!Array.isArray(this._intentChoices)) {
      const choices = this._intentChoices;
      return keys.map((k) => ({ key: k, description: choices[k] }));
    }
    return keys.map((k) => ({ key: k }));
  }
}
