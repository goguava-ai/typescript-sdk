import * as fs from "node:fs";
import { getCliConfigPath, getBaseUrl, fetchOrThrow } from "./utils.ts";
import { getDefaultLogger } from "./logging.ts";

const logger = getDefaultLogger();

export interface AuthStrategy {
  getHeaders(): Promise<Record<string, string>>;
}

export class APIKeyAuth implements AuthStrategy {
  constructor(private readonly _apiKey: string) {}

  async getHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${this._apiKey}` };
  }
}

export const GUAVA_DEPLOY_TOKEN_PATH = "/var/run/secrets/guava/token";
const _GUAVA_DEPLOY_TOKEN_PREFIX = "gva-deploy2-";

export class GuavaDeploy implements AuthStrategy {
  constructor(private readonly _tokenPath: string = GUAVA_DEPLOY_TOKEN_PATH) {}

  async getHeaders(): Promise<Record<string, string>> {
    const token = fs.readFileSync(this._tokenPath, "utf8").trim();
    return { Authorization: `Bearer ${_GUAVA_DEPLOY_TOKEN_PREFIX}${token}` };
  }
}

const TOKEN_REFRESH_BUFFER_MS = 60_000;

interface CliConfig {
  access_token: string;
  expires_at: number;
  refresh_token: string;
  org_id: string;
  base_url?: string;
}

export class CLIAuth implements AuthStrategy {
  static exists(): boolean {
    const configPath = getCliConfigPath();
    if (!fs.existsSync(configPath)) return false;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return "refresh_token" in config;
  }

  private _accessToken: string;
  private _expiresAt: number; // ms since epoch
  private _refreshToken: string;
  private _orgId: string;
  private _baseUrl: string;
  private _pendingRefresh: Promise<void> | null = null;

  constructor() {
    const config = JSON.parse(fs.readFileSync(getCliConfigPath(), "utf8")) as CliConfig;
    this._accessToken = config.access_token;
    this._expiresAt = config.expires_at * 1000;
    this._refreshToken = config.refresh_token;
    this._orgId = config.org_id;
    this._baseUrl = config.base_url ?? getBaseUrl();
  }

  private async _doRefresh(): Promise<void> {
    logger.debug("Refreshing access token...");
    const response = await fetchOrThrow(new URL("/oauth/token", this._baseUrl), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this._refreshToken,
      }),
    });
    const token = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    this._accessToken = token.access_token;
    this._expiresAt = Date.now() + token.expires_in * 1000;
    if (token.refresh_token) {
      logger.warn("Unexpected refresh token in response.");
    }
  }

  async getHeaders(): Promise<Record<string, string>> {
    if (Date.now() >= this._expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      if (!this._pendingRefresh) {
        this._pendingRefresh = this._doRefresh().finally(() => {
          this._pendingRefresh = null;
        });
      }
      await this._pendingRefresh;
    }
    return {
      Authorization: `Bearer ${this._accessToken}`,
      "x-guava-org-id": this._orgId,
    };
  }
}

let _cliAuthInstance: CLIAuth | null = null;

export function getCLIAuth(): CLIAuth {
  if (!_cliAuthInstance) {
    _cliAuthInstance = new CLIAuth();
  }
  return _cliAuthInstance;
}
