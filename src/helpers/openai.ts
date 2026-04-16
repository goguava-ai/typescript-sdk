import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { type Logger, getDefaultLogger } from "../logging.ts";
import * as z from "zod";
import { telemetryClient } from "../telemetry.ts";
import { getBaseUrl } from "../utils.ts";

// from beta.py
// TODO: Remove after beta
function beta_create_openai_client(logger: Logger) {
  const baseUrl = getBaseUrl();
  // to get it working with OpenAI TS/JS client
  const basedUrl = new URL("openai/v1/", baseUrl);
  logger.info(`Creating beta OpenAI client`);
  return new OpenAI({
    baseURL: basedUrl.toString(),
    apiKey: process.env.GUAVA_API_KEY,
  });
}

@telemetryClient.trackClass()
export class IntentRecognizer<Choices extends readonly string[]> {
  private client: OpenAI;
  private intentChoices: Choices;
  private choiceModel: z.ZodType<Choices[number]>;
  constructor(choices: Choices, logger: Logger, client?: OpenAI) {
    this.intentChoices = choices;
    this.client = client ?? beta_create_openai_client(logger);
    this.choiceModel = z.union(choices.map((s) => z.literal(s)));
  }

  async classify(intent: string): Promise<Choices[number]> {
    const response = await this.client.responses.parse({
      model: "gpt-5-mini",
      input: `
Pick the choice in the list of choices that best reflects the given intent.
Intent: "${intent}".
Possible Choices: ${this.intentChoices}.
      `.trim(),
      reasoning: {
        effort: "low",
      },
    });
    const parsed_output = this.choiceModel.parse(response.output_text);
    return parsed_output;
  }
}

@telemetryClient.trackClass()
export class DocumentQA {
  private client: OpenAI;
  private vector_store: Promise<OpenAI.VectorStore>;
  private logger: Logger;

  constructor(
    vector_store_name: string,
    document: string,
    logger: Logger = getDefaultLogger(),
    client?: OpenAI,
  ) {
    this.client = client ?? beta_create_openai_client(logger);
    this.vector_store = this.getOrCreateVectorStore(vector_store_name, document);
    this.logger = logger;
  }

  async getOrCreateVectorStore(vector_store_name: string, document: string) {
    const encoder = new TextEncoder();
    const document_buffer = encoder.encode(document);
    const document_hash_buffer = await crypto.subtle.digest("SHA-256", document_buffer);
    const u8view = new Uint8Array(document_hash_buffer);
    const document_hash: string = Array.from(u8view)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    for await (const vs of this.client.vectorStores.list()) {
      if (
        vs.name === vector_store_name &&
        vs.metadata &&
        vs.metadata.document_hash === document_hash
      ) {
        this.logger.info("Re-using existing vector store...");
        return vs;
      }
    }

    this.logger.info("Creating vector store...");

    const vector_store = await this.client.vectorStores.create({
      name: vector_store_name,
      expires_after: {
        anchor: "last_active_at",
        days: 7,
      },
    });

    this.logger.info("Uploading file...");
    await this.client.vectorStores.files.uploadAndPoll(
      vector_store.id,
      await toFile(new Blob([document], { type: "text/plain" }), "document.txt"),
    );

    this.logger.info("Updating vector store metadata...");
    await this.client.vectorStores.update(vector_store.id, {
      metadata: {
        document_hash,
      },
    });

    return vector_store;
  }

  async ask(question: string): Promise<string> {
    const response = await this.client.responses.create({
      model: "gpt-5-mini",
      instructions:
        "You are a virtual contact center agent. Your task is to answer questions using the provided supporting document. Just answer the question - do not offer any follow-ups.",
      input: question,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [(await this.vector_store).id],
        },
      ],
      reasoning: {
        effort: "low",
      },
    });
    return response.output_text;
  }
}

const filterSchema = z.object({
  matchingAppointments: z.array(z.string()).describe("List of datetimes matching the query."),
  otherAppointments: z
    .array(z.string())
    .describe("If no datetimes match the query, list of datetimes to suggest."),
});

@telemetryClient.trackClass()
export class DatetimeFilter {
  private client: OpenAI;
  private sourceList: string[];

  constructor(
    { sourceList, client }: { sourceList: string[]; client?: OpenAI },
    logger: Logger = getDefaultLogger(),
  ) {
    this.sourceList = sourceList;
    this.client = client ?? beta_create_openai_client(logger);
  }

  async filter(
    query: string,
    { maxResults = 5 }: { maxResults?: number } = {},
  ): Promise<[string[], string[]]> {
    const appointmentTimesStr = this.sourceList.join("\n");
    const today = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const prompt = `\
Return a few datetimes in the list matching the query. If no datetimes match the query, return a few other datetimes from the list that can be used as close suggestions.
NEVER HALLUCINATE DATETIMES THAT ARE NOT IN THE LIST.
Query: ${query}
Today's Date: ${today}
Appointment Times:
${appointmentTimesStr}
==================
You must return at most ${maxResults} options per list.`;

    const response = await this.client.responses.parse({
      model: "gpt-5-mini",
      input: [{ role: "system", content: prompt }],
      text: { format: zodTextFormat(filterSchema, "filter") },
      reasoning: { effort: "medium" },
    });

    const output = response.output_parsed;

    if (!output) {
      throw new Error("Failed to produce parseable output.");
    }

    return [
      output.matchingAppointments.slice(0, maxResults),
      output.otherAppointments.slice(0, maxResults),
    ];
  }
}
