import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRemoteIdentity,
  decryptEnvelope,
  deriveRemoteSessionKeys,
  encryptEnvelope,
  hostFingerprint,
  pairingSas,
  randomSecret,
} from "../../src/remote/crypto.js";
import type { RemoteConnectionRequest } from "../../src/remote/types.js";

describe("ModelHop Remote encryption", () => {
  it("derives complementary P-256 keys in both directions", () => {
    const host = createRemoteIdentity();
    const phone = createRemoteIdentity();
    const salt = randomSecret();
    const hostKeys = deriveRemoteSessionKeys(
      host.privateKey,
      phone.publicKey,
      salt,
    );
    const phoneKeys = deriveRemoteSessionKeys(
      phone.privateKey,
      host.publicKey,
      salt,
    );

    const request: RemoteConnectionRequest = {
      deviceId: "phone-1",
      deviceName: "Test phone",
      devicePublicKey: phone.publicKey,
    };
    const expectedSas = String(
      createHmac("sha256", phoneKeys.receiveKey)
        .update(
          `session-1:${request.deviceId}:${request.devicePublicKey}`,
        )
        .digest()
        .readUInt32BE(0) % 1_000_000,
    ).padStart(6, "0");

    expect(hostKeys.receiveKey).toEqual(phoneKeys.receiveKey);
    expect(hostKeys.sendKey).toEqual(phoneKeys.sendKey);
    expect(pairingSas(hostKeys, request, "session-1")).toBe(
      expectedSas,
    );
    expect(hostFingerprint(host.publicKey)).toHaveLength(22);
  });

  it("authenticates content and rejects ciphertext changes", () => {
    const host = createRemoteIdentity();
    const phone = createRemoteIdentity();
    const keys = deriveRemoteSessionKeys(
      host.privateKey,
      phone.publicKey,
      randomSecret(),
    );
    const envelope = encryptEnvelope(
      "connection",
      1,
      keys.receiveKey,
      { prompt: "private" },
    );

    expect(
      decryptEnvelope<{ prompt: string }>(
        envelope,
        keys.receiveKey,
      ),
    ).toEqual({ prompt: "private" });
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -2)}AA`,
    };
    expect(() =>
      decryptEnvelope(tampered, keys.receiveKey),
    ).toThrow();
    expect(() =>
      decryptEnvelope(
        {
          ...envelope,
          sequence: envelope.sequence + 1,
        },
        keys.receiveKey,
      ),
    ).toThrow();
    expect(() =>
      decryptEnvelope(
        {
          ...envelope,
          connectionId: "different-connection",
        },
        keys.receiveKey,
      ),
    ).toThrow();
  });
});
