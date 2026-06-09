import type { Client } from "../client.ts";
import { fetchOrThrow } from "../utils.ts";

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
  });

  return ((await response.json()) as { text: string }).text;
}
