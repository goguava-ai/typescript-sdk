export const DEFAULT_BASE_URL = "https://app.goguava.ai/";

export function getBaseUrl(): string {
  return process.env.GUAVA_BASE_URL ?? DEFAULT_BASE_URL;
}

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly response: Response,
  ) {
    super(`HTTP ${status} ${statusText}${body ? ` — ${body}` : ""}`);
    this.name = "HttpStatusError";
  }
}

export async function fetchOrThrow(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // biome-ignore lint: The wrapper must call fetch.
  const res = await fetch(input, init);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpStatusError(res.status, res.statusText, body, res);
  }

  return res;
}
