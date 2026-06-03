import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_BASE_URL = "https://app.goguava.ai/";

export function getPlatformConfigDir(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (!appdata) throw new Error("Could not determine config directory: APPDATA is not set");
    return appdata;
  }
  const home = os.homedir();
  if (!home) throw new Error("Could not determine config directory: home directory is unknown");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
}

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
