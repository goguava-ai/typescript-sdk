import { inspect } from "node:util";
import * as z from "zod";
import { fetchOrThrow } from "./utils.ts";
import { telemetryClient } from "./telemetry.ts";
import type { Client } from "./client.ts";

/**
 * Modality used for campaign agentic outreach.
 *
 * Currently only SMS is available.
 */
export const OutreachModality = z.enum(["sms"]);
export type OutreachModality = z.infer<typeof OutreachModality>;

/**
 * A contact to upload to a campaign.
 */
export const Contact = z.object({
  /** The contact's phone number in E.164 format (e.g. `"+14155550123"`). */
  phoneNumber: z.e164(),
  /**
   * Arbitrary per-contact data. This is delivered to the agent when the call is
   * initiated and can be read during the call (e.g. via `call.getVariable`).
   */
  data: z.record(z.string(), z.unknown()).default({}),
  /**
   * Modalities used to reach this contact. When omitted, falls back to the
   * `outreachModalities` passed to {@link Campaign.uploadContacts}.
   */
  outreachModalities: z.array(OutreachModality).optional(),
});
export type Contact = z.input<typeof Contact>;

/** Result of uploading contacts to a campaign. */
export interface UploadContactsResult {
  /** The number of contacts that were inserted. */
  created: number;
}

/** Status of a campaign. */
export interface CampaignStatus {
  /**
   * Mapping of contact status (e.g. `"trying"`, `"failed"`, `"completed"`,
   * `"partially_completed"`, `"do_not_call"`) to the number of contacts in that
   * status. Only statuses with at least one contact are included.
   */
  statusCounts: Record<string, number>;
}

/** Options for {@link Campaign.uploadContacts}. */
export interface UploadContactsOptions {
  /** Whether to insert contacts whose phone number is already in the campaign. */
  allowDuplicates?: boolean;
  /** Confirms you have consent to contact these numbers. Required by the server. */
  acceptedTermsOfService?: boolean;
  /** Default modalities applied to any contact that doesn't specify its own. */
  outreachModalities?: OutreachModality[];
}

// Wire-format schemas for parsing responses (snake_case, as returned by the API).
const UploadContactsResultWire = z.object({ created: z.number().int() });
const CampaignStatusWire = z.object({
  status_counts: z.record(z.string(), z.number()).default({}),
});

/**
 * A handle to an existing Guava campaign.
 *
 * Obtain instances via {@link Client.getCampaign} or {@link Client.listCampaigns};
 * do not construct directly. Campaigns are created via the Guava dashboard or CLI.
 */
@telemetryClient.trackClass()
export class Campaign {
  private _client: Client;
  private _id: string;
  private _code: string;
  // Snapshot of the name at the time this handle was fetched. Used for
  // display/logging only; identity is keyed off id/code, never name.
  private _name: string;

  constructor(client: Client, id: string, code: string, name: string) {
    this._client = client;
    this._id = id;
    this._code = code;
    this._name = name;
  }

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this._name;
  }

  /**
   * Upload contacts to this campaign.
   *
   * @param contacts - The contacts to upload.
   * @param options.allowDuplicates - Insert contacts whose number already
   *   exists in the campaign. Defaults to `false`.
   * @param options.acceptedTermsOfService - Confirms you have consent to
   *   contact these numbers. Defaults to `false`.
   * @param options.outreachModalities - Default modalities for any contact that
   *   doesn't set its own {@link Contact.outreachModalities}.
   * @returns The number of contacts that were inserted.
   */
  async uploadContacts(
    contacts: Contact[],
    options: UploadContactsOptions = {},
  ): Promise<UploadContactsResult> {
    const { allowDuplicates = false, acceptedTermsOfService = false, outreachModalities } = options;

    const wireContacts = contacts.map((contact) => {
      const parsed = Contact.parse(contact);
      return {
        phone_number: parsed.phoneNumber,
        data: parsed.data,
        // Per-contact modalities take precedence; fall back to the method-level
        // default, otherwise leave unset (server applies the campaign default).
        outreach_modalities: parsed.outreachModalities ?? outreachModalities ?? null,
      };
    });

    const url = new URL(`v2/campaigns/${this._code}/contacts`, this._client.getHttpBase());
    url.searchParams.set("allow_duplicates", String(allowDuplicates));
    url.searchParams.set("accepted_terms_of_service", String(acceptedTermsOfService));

    const response = await fetchOrThrow(url, {
      method: "POST",
      headers: { ...(await this._client.headers()), "Content-Type": "application/json" },
      body: JSON.stringify({ contacts: wireContacts }),
    });

    const { created } = UploadContactsResultWire.parse(await response.json());
    return { created };
  }

  /** Fetch the current status of this campaign. */
  async getStatus(): Promise<CampaignStatus> {
    const url = new URL(`v2/campaigns/${this._code}/status`, this._client.getHttpBase());
    const response = await fetchOrThrow(url, { headers: await this._client.headers() });
    const { status_counts } = CampaignStatusWire.parse(await response.json());
    return { statusCounts: status_counts };
  }

  /** Permanently delete this campaign. */
  async delete(): Promise<void> {
    const url = new URL(`v2/campaigns/${this._code}`, this._client.getHttpBase());
    await fetchOrThrow(url, { method: "DELETE", headers: await this._client.headers() });
  }

  [inspect.custom](): string {
    return `Campaign { name: '${this._name}', code: '${this._code}' }`;
  }
}
