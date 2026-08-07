import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type {
  EncryptedEnvelope,
  RemoteConnectionRequest,
} from "./types.js";
import { remoteEnvelopeAdditionalData } from "./envelopeMetadata.js";
import { REMOTE_PROTOCOL_VERSION } from "./types.js";

const CURVE = "prime256v1";
const INFO = Buffer.from("modelhop-remote-v1", "utf8");

export interface RemoteIdentity {
  privateKey: string;
  publicKey: string;
}

export interface RemoteSessionKeys {
  receiveKey: Buffer;
  sendKey: Buffer;
}

export function createRemoteIdentity(): RemoteIdentity {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey().toString("base64"),
    publicKey: ecdh.getPublicKey().toString("base64"),
  };
}

export function identityFromPrivateKey(
  privateKey: string,
): RemoteIdentity {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64"));
  return {
    privateKey,
    publicKey: ecdh.getPublicKey().toString("base64"),
  };
}

export function hostFingerprint(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("base64url")
    .slice(0, 22);
}

export function deriveRemoteSessionKeys(
  hostPrivateKey: string,
  devicePublicKey: string,
  sessionSalt: string,
): RemoteSessionKeys {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(hostPrivateKey, "base64"));
  const shared = ecdh.computeSecret(
    Buffer.from(devicePublicKey, "base64"),
  );
  const material = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.from(sessionSalt, "base64"),
      INFO,
      64,
    ),
  );
  return {
    receiveKey: material.subarray(0, 32),
    sendKey: material.subarray(32, 64),
  };
}

export function pairingSas(
  keys: RemoteSessionKeys,
  request: RemoteConnectionRequest,
  sessionId: string,
): string {
  const digest = createHmac("sha256", keys.receiveKey)
    .update(
      `${sessionId}:${request.deviceId}:${request.devicePublicKey}`,
    )
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function encryptEnvelope(
  connectionId: string,
  sequence: number,
  key: Buffer,
  value: unknown,
): EncryptedEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.from(
      remoteEnvelopeAdditionalData(
        REMOTE_PROTOCOL_VERSION,
        connectionId,
        sequence,
      ),
      "utf8",
    ),
  );
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: REMOTE_PROTOCOL_VERSION,
    connectionId,
    sequence,
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
  };
}

export function decryptEnvelope<T>(
  envelope: EncryptedEnvelope,
  key: Buffer,
): T {
  if (envelope.version !== REMOTE_PROTOCOL_VERSION) {
    throw new Error("Unsupported ModelHop Remote protocol version.");
  }
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (ciphertext.length < 17) {
    throw new Error("The encrypted remote message is malformed.");
  }
  const data = ciphertext.subarray(0, -16);
  const tag = ciphertext.subarray(-16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.nonce, "base64"),
  );
  decipher.setAAD(
    Buffer.from(
      remoteEnvelopeAdditionalData(
        envelope.version,
        envelope.connectionId,
        envelope.sequence,
      ),
      "utf8",
    ),
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function randomSecret(size = 32): string {
  return randomBytes(size).toString("base64");
}

export function encryptLocalStore(
  keyBase64: string,
  value: unknown,
): string {
  const key = Buffer.from(keyBase64, "base64");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64");
}

export function decryptLocalStore<T>(
  keyBase64: string,
  encoded: string,
): T {
  const packed = Buffer.from(encoded, "base64");
  if (packed.length < 29) {
    throw new Error("The paired-device store is malformed.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyBase64, "base64"),
    packed.subarray(0, 12),
  );
  decipher.setAuthTag(packed.subarray(12, 28));
  const plaintext = Buffer.concat([
    decipher.update(packed.subarray(28)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function safeTokenEqual(
  expected: string,
  actual: string | undefined,
): boolean {
  if (!actual) {
    return false;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return (
    left.length === right.length && timingSafeEqual(left, right)
  );
}
