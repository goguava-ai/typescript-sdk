import { createHash } from "node:crypto";
import type { Client } from "../client.ts";
import { fetchOrThrow } from "../utils.ts";

export function _contentKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function _prefixedKey(namespace: string | undefined, key: string): string {
  return namespace ? `${namespace}.${key}` : key;
}

export class ServerRAG {
  private readonly _client: Client;
  private readonly _namespace: string | undefined;
  readonly trackedKeys = new Set<string>();

  constructor(client: Client, { namespace }: { namespace?: string } = {}) {
    this._client = client;
    this._namespace = namespace;
  }

  async uploadDocument(key: string, text: string): Promise<void> {
    const url = new URL("v1/rag/documents", this._client.getHttpBase());
    await fetchOrThrow(url, {
      method: "POST",
      headers: { ...(await this._client.headers()), "Content-Type": "application/json" },
      body: JSON.stringify({ key, text }),
      signal: AbortSignal.timeout(60_000),
    });
  }

  async deleteDocument(key: string): Promise<void> {
    const url = new URL(`v1/rag/documents/${key}`, this._client.getHttpBase());
    await fetchOrThrow(url, {
      method: "DELETE",
      headers: await this._client.headers(),
      signal: AbortSignal.timeout(30_000),
    });
  }

  async listDocuments(): Promise<{ key: string }[]> {
    const url = new URL("v1/rag/documents", this._client.getHttpBase());
    const response = await fetchOrThrow(url, {
      headers: await this._client.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    return (await response.json()) as { key: string }[];
  }

  async ask(
    question: string,
    { documentKeys, instructions }: { documentKeys?: string[]; instructions?: string } = {},
  ): Promise<string> {
    const url = new URL("v1/rag/ask", this._client.getHttpBase());
    const payload: Record<string, unknown> = { question };
    if (documentKeys !== undefined) payload.document_keys = documentKeys;
    if (instructions !== undefined) payload.instructions = instructions;

    const response = await fetchOrThrow(url, {
      method: "POST",
      headers: { ...(await this._client.headers()), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    const result = (await response.json()) as { answer: string; warning?: string };
    if (result.warning) console.warn(`Guava RAG: ${result.warning}`);
    return result.answer;
  }

  async reconcile(documents: string[], ids?: string[]): Promise<void> {
    if (ids !== undefined && ids.length !== documents.length) {
      throw new Error(
        `ids length (${ids.length}) must match documents length (${documents.length})`,
      );
    }

    const desired = new Map<string, string>();
    if (ids !== undefined) {
      for (let i = 0; i < documents.length; i++) {
        desired.set(_prefixedKey(this._namespace, ids[i]!), documents[i]!);
      }
    } else {
      for (const doc of documents) {
        desired.set(_prefixedKey(this._namespace, _contentKey(doc)), doc);
      }
    }

    const existing = await this.listDocuments();
    const existingKeys = new Set(existing.map((d) => d.key));
    const scopedKeys = this._namespace
      ? new Set([...existingKeys].filter((k) => k.startsWith(`${this._namespace}.`)))
      : existingKeys;

    for (const [key, doc] of desired) {
      if (ids !== undefined || !existingKeys.has(key)) {
        await this.uploadDocument(key, doc);
      }
      this.trackedKeys.add(key);
    }

    const stale = [...scopedKeys].filter((k) => !desired.has(k));
    for (const key of stale) {
      await this.deleteDocument(key);
    }
  }

  async upsertDocument(key: string, text: string): Promise<void> {
    const fullKey = _prefixedKey(this._namespace, key);
    await this.uploadDocument(fullKey, text);
    this.trackedKeys.add(fullKey);
  }

  async addDocument(text: string): Promise<void> {
    const fullKey = _prefixedKey(this._namespace, _contentKey(text));
    await this.uploadDocument(fullKey, text);
    this.trackedKeys.add(fullKey);
  }

  async removeDocument(key: string): Promise<void> {
    const fullKey = _prefixedKey(this._namespace, key);
    await this.deleteDocument(fullKey);
    this.trackedKeys.delete(fullKey);
  }

  async clear(): Promise<void> {
    for (const key of this.trackedKeys) {
      await this.deleteDocument(key);
    }
    this.trackedKeys.clear();
  }
}
