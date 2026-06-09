import { getDefaultLogger, type Logger } from "./logging.ts";
import { fetchOrThrow } from "./utils.ts";
import type { Client } from "./client.ts";

const QUEUE_MAX_SIZE = 100;
const UPLOAD_INTERVAL_MS = 10_000;

const debugEnabled = ["yes", "true"].includes(
  (process.env.GUAVA_DEBUG_TELEMETRY ?? "false").toLowerCase().trim(),
);
const logger: Logger = debugEnabled
  ? getDefaultLogger()
  : { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export const TelemetryEvent = {
  METHOD_CALL: "method-call",
  EXCEPTION_RAISED: "exception-raised",
} as const;

export type TelemetryEvent = (typeof TelemetryEvent)[keyof typeof TelemetryEvent];

interface QueuedEvent {
  timestamp_ms: number;
  event_type: TelemetryEvent;
  data: Record<string, unknown>;
}

export abstract class BaseTelemetryClient {
  protected _sdkClient: Client | null = null;

  abstract sendEvent(event: TelemetryEvent, data?: Record<string, unknown>): void;

  setSdkClient(client: Client) {
    this._sdkClient = client;
  }

  trackClass(onlyExceptions = new Set<string>()) {
    const client = this;
    return <T extends abstract new (...args: unknown[]) => object>(
      target: T,
      _context: ClassDecoratorContext<T>,
    ): T => {
      // TODO: Wrap public methods.

      // Wrap the constructor
      const trackConstructorCalls = !onlyExceptions.has("constructor");
      class Wrapped extends (target as unknown as new (...args: unknown[]) => object) {
        constructor(...args: unknown[]) {
          try {
            if (trackConstructorCalls) {
              client.sendEvent(TelemetryEvent.METHOD_CALL, {
                function_name: `${target.name}.constructor`,
              });
            }
            super(...args);
          } catch (e) {
            client.sendEvent(TelemetryEvent.EXCEPTION_RAISED, {
              function_name: `${target.name}.constructor`,
              exception: String(e),
            });
            throw e;
          }
        }
      }
      Object.defineProperty(Wrapped, "name", { value: target.name });
      return Wrapped as unknown as T;
    };
  }
}

export class TelemetryClient extends BaseTelemetryClient {
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.timer = setInterval(() => {
      void this.uploadEvents();
    }, UPLOAD_INTERVAL_MS);
    // Don't prevent the process from exiting naturally
    this.timer.unref();

    // Trigger an immediate upload on uncaught exception.
    process.on("uncaughtExceptionMonitor", async () => {
      await this.uploadEvents();
    });
  }

  sendEvent(event: TelemetryEvent, data: Record<string, unknown> = {}) {
    logger.debug(`Sending telemetry event ${event}, ${JSON.stringify(data)}`);
    if (this.queue.length >= QUEUE_MAX_SIZE) return;
    this.queue.push({ timestamp_ms: Date.now(), event_type: event, data });
  }

  private async uploadEvents() {
    if (!this._sdkClient) {
      logger.debug("No SDK client. Cannot upload telemetry events.");
      return;
    }
    const payload = this.queue.splice(0);
    if (!payload.length) {
      logger.debug("No events to upload.");
      return;
    }
    logger.debug(`Uploading ${payload.length} telemetry events.`);
    try {
      const url = new URL("v1/upload-telemetry", this._sdkClient.getHttpBase());
      await fetchOrThrow(url, {
        method: "POST",
        headers: { ...(await this._sdkClient.headers()), "Content-Type": "application/json" },
        body: JSON.stringify({ events: payload }),
      });
    } catch (e) {
      logger.error(`Telemetry upload failed: ${String(e)}`);
    }
  }
}

export class NoOpTelemetryClient extends BaseTelemetryClient {
  sendEvent(_event: TelemetryEvent, _data?: Record<string, unknown>) {}
}

const isDisabled = ["yes", "true"].includes(
  (process.env.GUAVA_DISABLE_TELEMETRY ?? "false").toLowerCase().trim(),
);
export const telemetryClient: BaseTelemetryClient = isDisabled
  ? new NoOpTelemetryClient()
  : new TelemetryClient();
