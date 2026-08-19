import { type Logger, getDefaultLogger } from "./logging.ts";
import { SDK_VERSION } from "./version.ts";
import os from "node:os";
import * as fs from "node:fs";
import { getBaseUrl, fetchOrThrow, sleep } from "./utils.ts";
import { SmsMessage } from "./sms.ts";
import { Campaign } from "./campaigns.ts";
import { telemetryClient } from "./telemetry.ts";
import {
  type AuthStrategy,
  APIKeyAuth,
  GuavaDeploy,
  CLIAuth,
  getCLIAuth,
  GUAVA_DEPLOY_TOKEN_PATH,
} from "./auth.ts";

const SDK_NAME = "typescript-sdk";

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  logger?: Logger;
  captureWarnings?: boolean;
  checkDeprecation?: boolean;
}

let firstClient = false;

export type InboundConnection = { agent_number: string } | { webrtc_code: string };

const http_start = /^http:\/\//;
const https_start = /^https:\/\//;

@telemetryClient.trackClass()
export class Client {
  private _auth: AuthStrategy;
  private _baseUrl: string;
  private _logger: Logger;

  constructor({
    apiKey,
    baseUrl,
    logger,
    captureWarnings = true,
    checkDeprecation = true,
  }: ClientOptions = {}) {
    // Set up the default logger.
    if (logger) {
      this._logger = logger;
    } else {
      this._logger = getDefaultLogger();
    }

    // Resolve the API base URL.
    if (baseUrl) {
      this._baseUrl = baseUrl;
    } else {
      this._baseUrl = getBaseUrl();
    }

    // Resolve auth strategy.
    if (apiKey) {
      this._auth = new APIKeyAuth(apiKey);
    } else if (fs.existsSync(GUAVA_DEPLOY_TOKEN_PATH)) {
      this._auth = new GuavaDeploy();
    } else if (process.env.GUAVA_API_KEY) {
      this._auth = new APIKeyAuth(process.env.GUAVA_API_KEY);
    } else if (CLIAuth.exists()) {
      this._auth = getCLIAuth();
    } else {
      throw new Error(
        "Unable to authenticate to Guava. You must do one of the following:\n- Sign in using the Guava CLI.\n- Or, provide an API key using the GUAVA_API_KEY environment variable.\n- Or, provide the API key as an argument to the constructor.",
      );
    }

    if (!firstClient) {
      firstClient = true;

      if (captureWarnings) {
        process.on("warning", (warning) => {
          this._logger.warn(warning.toString());
        });
      }

      telemetryClient.setSdkClient(this);
      if (checkDeprecation) {
        this._checkSdkDeprecation();
      }
    }
  }

  getWebsocketBase() {
    if (http_start.test(this._baseUrl)) {
      return `ws://${this._baseUrl.substring("ws://".length)}`;
    } else if (https_start.test(this._baseUrl)) {
      return `wss://${this._baseUrl.substring("wss://".length)}`;
    } else {
      throw new Error(`Invalid base URL: ${this._baseUrl}}`);
    }
  }

  getHttpBase() {
    return this._baseUrl;
  }

  async headers(): Promise<Record<string, string>> {
    return {
      ...(await this._auth.getHeaders()),
      "x-guava-platform": os.platform(),
      "x-guava-runtime": process.release.name,
      "x-guava-runtime-version": process.version,
      "x-guava-sdk": SDK_NAME,
      "x-guava-sdk-version": SDK_VERSION,
    };
  }

  private async _checkSdkDeprecation() {
    this._logger.debug(`Checking deprecation for SDK ${SDK_NAME}, ${SDK_VERSION}.`);
    try {
      const url = new URL("v1/check-sdk-deprecation", this.getHttpBase());
      url.searchParams.set("sdk_name", SDK_NAME);
      url.searchParams.set("sdk_version", SDK_VERSION);
      const response = await fetchOrThrow(url, {
        method: "POST",
        headers: await this.headers(),
      });
      const body = (await response.json()) as { deprecation_status: string };
      if (body.deprecation_status === "supported") {
        this._logger.info("SDK version still supported.");
      } else if (body.deprecation_status === "deprecated") {
        process.emitWarning(
          "This SDK version is deprecated. Please update to a newer version of the SDK.",
        );
      } else {
        this._logger.warn("SDK deprecation status unknown.");
      }
    } catch (e) {
      this._logger.error("Encountered issue while checking for deprecation.");
    }
  }

  /**
   * Creates a WebRTC agent and returns its code, which can be used to receive inbound calls over WebRTC.
   * @param ttlSec - How long the agent code remains valid, in seconds. Defaults to no expiration.
   */
  async createWebrtcAgent(ttlSec?: number): Promise<string> {
    const url = new URL("v1/webrtc-agents", this.getHttpBase());
    if (ttlSec !== undefined) {
      url.searchParams.set("ttl_sec", ttlSec.toString());
    }
    const response = await fetchOrThrow(url, {
      method: "POST",
      headers: await this.headers(),
    });
    const body = (await response.json()) as { webrtc_code: string };
    return body.webrtc_code;
  }

  async createSipAgent(): Promise<string> {
    const url = new URL("v1/sip-agents", this.getHttpBase());
    const response = await fetchOrThrow(url, {
      method: "POST",
      headers: await this.headers(),
    });
    const body = (await response.json()) as { sip_code: string };
    return body.sip_code;
  }

  /**
   * Fetch an existing campaign by its code.
   *
   * @param campaignCode - The campaign code (e.g. `gcmp-...`).
   */
  async getCampaign(campaignCode: string): Promise<Campaign> {
    const url = new URL(`v2/campaigns/${campaignCode}`, this.getHttpBase());
    const response = await fetchOrThrow(url, { headers: await this.headers() });
    const body = (await response.json()) as { id: string; campaign_code: string; name: string };
    return new Campaign(this, body.id, body.campaign_code, body.name);
  }

  /** List all campaigns in your organization. */
  async listCampaigns(): Promise<Campaign[]> {
    const url = new URL("v2/campaigns", this.getHttpBase());
    const response = await fetchOrThrow(url, { headers: await this.headers() });
    const items = (await response.json()) as {
      id: string;
      campaign_code: string;
      name: string;
    }[];
    return items.map((c) => new Campaign(this, c.id, c.campaign_code, c.name));
  }

  async listNumbers(): Promise<{ phoneNumber: string }[]> {
    const url = new URL("v1/phone-numbers", this.getHttpBase());
    const response = await fetchOrThrow(url, { headers: await this.headers() });
    const items = (await response.json()) as { phone_number: string }[];
    return items.map((item) => ({ phoneNumber: item.phone_number }));
  }

  /**
   * Sends an SMS message from one of your Guava numbers.
   * @param fromNumber - One of your Guava numbers (E.164). Must have SMS configured.
   * @param toNumber - The recipient's number (E.164).
   * @param message - The message body to send.
   */
  async sendSms(fromNumber: string, toNumber: string, message: string): Promise<void> {
    const url = new URL("v1/send-sms", this.getHttpBase());
    await fetchOrThrow(url, {
      method: "POST",
      headers: { ...(await this.headers()), "Content-Type": "application/json" },
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: toNumber,
        message,
      }),
    });
  }

  /**
   * Waits for and returns the next inbound SMS sent from `fromNumber` to `toNumber`.
   *
   * Polls the inbox for messages received after this call begins, resolving once one
   * arrives or `timeoutMs` elapses. Note the direction: `fromNumber` is the external
   * number you're waiting to hear from, and `toNumber` is your Guava number — the
   * opposite of {@link sendSms}.
   *
   * @param fromNumber - The external number to wait for a message from (E.164).
   * @param toNumber - Your Guava number that will receive the message (E.164).
   * @param options.timeoutMs - Max time to wait before giving up. Defaults to 60000.
   * @param options.pollIntervalMs - Time between inbox checks. Defaults to 2000.
   * @returns The message, or `null` if `timeoutMs` elapses with no new message.
   */
  async nextSms(
    fromNumber: string,
    toNumber: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<SmsMessage | null> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
    const start = new Date().toISOString();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const url = new URL("v1/messages", this.getHttpBase());
      url.searchParams.set("to_number", toNumber);
      url.searchParams.set("from_number", fromNumber);
      url.searchParams.set("modality", "sms");
      url.searchParams.set("start", start);
      const response = await fetchOrThrow(url, {
        method: "GET",
        headers: await this.headers(),
      });
      // The endpoint returns matches oldest-first, so the earliest message after
      // `start` is always the first element — we only need one, so `has_more`
      // (which signals additional *later* messages) is irrelevant here.
      const body = (await response.json()) as { messages: unknown[] };
      if (body.messages?.length) {
        return SmsMessage.parse(body.messages[0]);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }
}
