import { type Server, createServer } from "node:http";
import { getDefaultLogger, type Logger } from "./logging.ts";

export type HealthState = "starting" | "running" | "draining" | "stopped";

export class HealthContext {
  private _state: HealthState = "starting";

  setState(newState: HealthState): void {
    this._state = newState;
  }

  ready(): void {
    this.setState("running");
  }

  draining(): void {
    this.setState("draining");
  }

  stopped(): void {
    this.setState("stopped");
  }

  isLive(): boolean {
    return this._state !== "stopped";
  }

  isReady(): boolean {
    return this._state === "running";
  }
}

export class MultiHealthContext {
  private _ctxs: HealthContext[] = [];

  createCtx(): HealthContext {
    const ctx = new HealthContext();
    this._ctxs.push(ctx);
    return ctx;
  }

  isLive(): boolean {
    return this._ctxs.length > 0 && this._ctxs.every((ctx) => ctx.isLive());
  }

  isReady(): boolean {
    return this._ctxs.length > 0 && this._ctxs.every((ctx) => ctx.isReady());
  }
}

export interface HealthServerOptions {
  host?: string;
  port?: number;
  logger?: Logger;
}

export class HealthServer implements AsyncDisposable {
  private readonly _server: Server;
  private readonly _logger: Logger;
  private _stopping: Promise<void> | null = null;

  private constructor(server: Server, logger: Logger) {
    this._server = server;
    this._logger = logger;
  }

  static async start(
    healthCtx: HealthContext | MultiHealthContext,
    options: HealthServerOptions = {},
  ): Promise<HealthServer> {
    const host = options.host ?? "0.0.0.0";
    const port = options.port ?? 4828;
    const logger = options.logger ?? getDefaultLogger();

    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/live") {
        res.statusCode = healthCtx.isLive() ? 200 : 503;
      } else if (req.method === "GET" && req.url === "/ready") {
        res.statusCode = healthCtx.isReady() ? 200 : 503;
      } else {
        res.statusCode = 404;
      }
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    logger.info("Health check server listening on http://%s:%d/live", host, port);
    return new HealthServer(server, logger);
  }

  stop(): Promise<void> {
    if (this._stopping) return this._stopping;
    this._logger.info("Health check server shutting down.");
    this._stopping = new Promise<void>((resolve, reject) => {
      this._server.closeAllConnections();
      this._server.close((err) => (err ? reject(err) : resolve()));
    });
    return this._stopping;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}

const NOOP_DISPOSABLE: AsyncDisposable = {
  async [Symbol.asyncDispose]() {},
};

function isEnabled(): boolean {
  const value = (process.env.GUAVA_HEALTH_SERVER ?? "false").toLowerCase().trim();
  return value === "yes" || value === "true" || value === "on";
}

/**
 * Returns an AsyncDisposable that, when the GUAVA_HEALTH_SERVER env var is
 * truthy ("yes", "true", "on"), starts an HTTP health check server exposing
 * `/live` on port 4828. Otherwise returns a no-op disposable. Intended for use
 * with `await using`.
 */
export async function getHealthServer(
  healthCtx: HealthContext | MultiHealthContext,
): Promise<AsyncDisposable> {
  if (!isEnabled()) return NOOP_DISPOSABLE;
  return HealthServer.start(healthCtx);
}
