import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ReasoningLookup } from "./anthropicOpenAITranslator.js";

interface ReasoningPayload {
  entries: Array<{
    signature: string;
    items: unknown[];
    updatedAt: number;
  }>;
}

interface EncryptedReasoningFile {
  version: 2;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

const MAX_ENTRIES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class EncryptedReasoningStore implements ReasoningLookup {
  private readonly entries = new Map<
    string,
    { items: readonly unknown[]; updatedAt: number }
  >();
  private readonly encryptionKey: Buffer;
  private persistChain = Promise.resolve();

  public constructor(
    private readonly storagePath: string,
    secret: string,
  ) {
    this.encryptionKey = createHash("sha256").update(secret).digest();
  }

  public async load(): Promise<void> {
    try {
      const stored = JSON.parse(
        await readFile(this.storagePath, "utf8"),
      ) as unknown;
      if (
        !isRecord(stored) ||
        stored.version !== 2 ||
        stored.algorithm !== "aes-256-gcm" ||
        typeof stored.iv !== "string" ||
        typeof stored.tag !== "string" ||
        typeof stored.ciphertext !== "string"
      ) {
        return;
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        Buffer.from(stored.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]);
      const payload = JSON.parse(plaintext.toString("utf8")) as ReasoningPayload;
      if (!Array.isArray(payload.entries)) {
        return;
      }
      for (const entry of payload.entries) {
        if (
          typeof entry.signature === "string" &&
          Array.isArray(entry.items) &&
          typeof entry.updatedAt === "number"
        ) {
          this.entries.set(entry.signature, {
            items: entry.items,
            updatedAt: entry.updatedAt,
          });
        }
      }
      this.trim();
    } catch {
      // Missing, legacy plaintext, corrupt, or differently keyed state is ignored.
    }
  }

  public get(signature: string): readonly unknown[] | undefined {
    return this.entries.get(signature)?.items;
  }

  public set(signature: string, items: readonly unknown[]): void {
    this.entries.set(signature, {
      items: [...items],
      updatedAt: Date.now(),
    });
    this.trim();
    this.persistChain = this.persistChain.then(
      () => this.persist(),
      () => this.persist(),
    );
  }

  public flush(): Promise<void> {
    return this.persistChain;
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) {
      return;
    }
    const oldest = [...this.entries.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(0, this.entries.size - MAX_ENTRIES);
    for (const [key] of oldest) {
      this.entries.delete(key);
    }
  }

  private async persist(): Promise<void> {
    const payload: ReasoningPayload = {
      entries: [...this.entries.entries()].map(
        ([signature, entry]) => ({
          signature,
          items: [...entry.items],
          updatedAt: entry.updatedAt,
        }),
      ),
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const stored: EncryptedReasoningFile = {
      version: 2,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const temporaryPath = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(stored), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.storagePath);
    } catch {
      // Reasoning continuity is an optimization, never a request blocker.
    }
  }
}
