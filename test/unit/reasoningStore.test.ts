import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedReasoningStore } from "../../src/bridge/reasoningStore.js";

describe("EncryptedReasoningStore", () => {
  it("persists reasoning continuity encrypted at rest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "modelhop-reasoning-"));
    try {
      const storagePath = path.join(root, "reasoning.json");
      const first = new EncryptedReasoningStore(storagePath, "bridge-secret");
      first.set("visible-signature", [
        { type: "reasoning", encrypted_content: "upstream-secret" },
      ]);
      await first.flush();

      const stored = await readFile(storagePath, "utf8");
      expect(stored).not.toContain("visible-signature");
      expect(stored).not.toContain("upstream-secret");
      expect(JSON.parse(stored)).toMatchObject({
        version: 2,
        algorithm: "aes-256-gcm",
      });

      const second = new EncryptedReasoningStore(
        storagePath,
        "bridge-secret",
      );
      await second.load();
      expect(second.get("visible-signature")).toEqual([
        { type: "reasoning", encrypted_content: "upstream-secret" },
      ]);

      const wrongKey = new EncryptedReasoningStore(
        storagePath,
        "different-secret",
      );
      await wrongKey.load();
      expect(wrongKey.get("visible-signature")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
