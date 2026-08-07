import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RemoteDeviceStore } from "../../src/remote/deviceStore.js";

describe("remote paired-device trust", () => {
  it("survives daemon and lease reinitialisation until explicitly revoked", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "modelhop-device-store-"),
    );
    try {
      const storePath = path.join(directory, "paired-devices.enc");
      const key = randomBytes(32).toString("base64");
      const firstLease = new RemoteDeviceStore(storePath, key);
      await firstLease.initialize();
      await firstLease.pair({
        id: "phone-1",
        name: "Phone",
        publicKey: "phone-public-key",
        pairedAt: 1_000,
        lastUsedAt: 1_000,
      });

      const nextLease = new RemoteDeviceStore(storePath, key);
      await nextLease.initialize();
      expect(nextLease.findActive("phone-1")).toEqual(
        expect.objectContaining({
          id: "phone-1",
          publicKey: "phone-public-key",
        }),
      );

      await nextLease.revoke("phone-1");
      const afterRevocation = new RemoteDeviceStore(storePath, key);
      await afterRevocation.initialize();
      expect(afterRevocation.findActive("phone-1")).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
