import * as fs from "node:fs";
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

export function getCliConfigPath(): string {
  return path.join(getPlatformConfigDir(), "guava", "config.json");
}

export function getBaseUrl(): string {
  if (process.env.GUAVA_BASE_URL) return process.env.GUAVA_BASE_URL;

  // Try reading from the CLI config.
  const configPath = getCliConfigPath();
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { base_url?: string };
    if (config.base_url) return config.base_url;
  }

  return DEFAULT_BASE_URL;
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Whether `e` is a fetch network failure. Bad input (e.g. an invalid URL) is
 * also a TypeError, but with a different message. Avoids `instanceof`, since
 * fetch errors can come from another realm (e.g. under Jest).
 */
function isNetworkError(e: unknown): boolean {
  const { name, message } = (e ?? {}) as { name?: unknown; message?: unknown };
  return name === "TypeError" && message === "fetch failed";
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [0, 500, 1000, 2000, 5000];

/**
 * POST that retries network errors and retryable statuses, throwing on a final
 * error status. A single Idempotency-Key is sent with every attempt so the
 * server can drop duplicates.
 *
 * @param retries - Number of retries after the first attempt.
 */
export async function idempotentPost(
  input: string | URL,
  init: Omit<RequestInit, "method"> = {},
  retries = 3,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Idempotency-Key")) headers.set("Idempotency-Key", crypto.randomUUID());

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOrThrow(input, { ...init, method: "POST", headers });
    } catch (e) {
      const retryable =
        isNetworkError(e) || (e instanceof HttpStatusError && RETRYABLE_STATUS_CODES.has(e.status));
      if (attempt === retries || !retryable) throw e;
    }
    await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
  }
}

/** A Disposable whose disposal does nothing. Useful as a conditional no-op. */
export const nullDisposable: Disposable = { [Symbol.dispose]() {} };

/**
 * Run `listener` when `signal` aborts, or immediately if it already has.
 * Dispose to unregister.
 */
export function onAbort(signal: AbortSignal, listener: () => void): Disposable {
  if (signal.aborted) {
    listener();
    return nullDisposable;
  }
  signal.addEventListener("abort", listener, { once: true });

  return {
    [Symbol.dispose]() {
      signal.removeEventListener("abort", listener);
    },
  };
}

export function onSignal(handler: (signal: "SIGINT" | "SIGTERM") => void): Disposable {
  // Remove both handlers on the first signal so any second signal (of either
  // type) falls through to Node's default behavior and terminates the process.
  const remove = () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  };
  const sigint = () => {
    remove();
    handler("SIGINT");
  };
  const sigterm = () => {
    remove();
    handler("SIGTERM");
  };

  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  return {
    [Symbol.dispose]: remove,
  };
}
