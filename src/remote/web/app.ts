import { REMOTE_PROTOCOL_VERSION } from "../types.js";
import type {
  EncryptedEnvelope,
  RemoteCommandResponse,
  RemoteConnectionStatus,
  RemotePairingBootstrap,
} from "../types.js";
import { remoteEnvelopeAdditionalData } from "../envelopeMetadata.js";
import {
  mountRemoteApp,
  type MountedRemoteApp,
  type RemoteEventBatch,
  type RemoteNotificationAdapter,
  type RemoteTransport,
  type RemoteWebCommand,
} from "./mobileApp.js";
import {
  clearStoredLaunchCapability,
  localLaunchCapabilityExpiry,
  provisionalLaunchCapabilityExpiry,
  readStoredLaunchCapability,
  resolveLaunchToken,
  storeLaunchCapability,
} from "./launchToken.js";
import { acknowledgeTerminalWithRetry } from "./terminalAck.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LAUNCH_TOKEN_STORAGE_KEY = "modelhop.remote.launch";
const launchLocation = new URL(location.href);
const launchCapabilityStorage = durableLaunchStorage();
let legacyStoredLaunchToken: string | null = null;
try {
  legacyStoredLaunchToken = sessionStorage.getItem(
    LAUNCH_TOKEN_STORAGE_KEY,
  );
} catch {
  // Initial links still work when browser storage is unavailable.
}
const durableStoredLaunchToken = launchCapabilityStorage
  ? readStoredLaunchCapability(launchCapabilityStorage)
  : null;
const resolvedLaunch = resolveLaunchToken(
  new URLSearchParams(launchLocation.hash.slice(1)).get("launch"),
  launchLocation.searchParams.get("launch"),
  durableStoredLaunchToken ?? legacyStoredLaunchToken,
);
const launchToken = resolvedLaunch.token;
if (resolvedLaunch.cameFromLocation) {
  try {
    sessionStorage.setItem(LAUNCH_TOKEN_STORAGE_KEY, launchToken);
  } catch {
    // The in-memory token remains valid for this page.
  }
}
if (launchToken && launchCapabilityStorage) {
  storeLaunchCapability(
    launchCapabilityStorage,
    launchToken,
    provisionalLaunchCapabilityExpiry(),
  );
}
launchLocation.hash = "";
launchLocation.searchParams.delete("launch");
history.replaceState(
  null,
  "",
  `${launchLocation.pathname}${launchLocation.search}`,
);

interface StoredDeviceIdentity {
  id: string;
  name: string;
  privateKey: CryptoKey;
  publicKey: string;
  hostFingerprint?: string;
}

interface SessionCrypto {
  connectionId: string;
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  nextSendSequence: number;
  seenReceiveSequences: Set<number>;
}

const pairingView = required<HTMLElement>("pairing-view");
const pairingMessage = required<HTMLElement>("pairing-message");
const pairingCodeWrap = required<HTMLElement>("pairing-code-wrap");
const pairingCode = required<HTMLOutputElement>("pairing-code");

let sessionCrypto: SessionCrypto | undefined;
let identity: StoredDeviceIdentity | undefined;
let latestEventId = 0;
let eventLoopStopped = false;
let encryptionChain: Promise<void> = Promise.resolve();
let mountedApp: MountedRemoteApp | undefined;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing interface element: ${id}`);
  }
  return element as T;
}

function durableLaunchStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function clearLaunchToken(): void {
  if (launchCapabilityStorage) {
    clearStoredLaunchCapability(launchCapabilityStorage);
  }
  try {
    sessionStorage.removeItem(LAUNCH_TOKEN_STORAGE_KEY);
  } catch {
    // There is no persisted token to clear.
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 16_384;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + chunkSize),
    );
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesBuffer(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new RemoteResponseError(
      response.status,
      value.error ?? `Request failed (${response.status}).`,
    );
  }
  return value;
}

class RemoteResponseError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteResponseError";
  }
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("modelhop-remote", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("identity");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("The device identity database could not be opened."),
      );
  });
}

async function loadStoredIdentity(): Promise<
  StoredDeviceIdentity | undefined
> {
  const database = await openIdentityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction("identity", "readonly")
        .objectStore("identity")
        .get("device");
      request.onsuccess = () =>
        resolve(
          request.result as StoredDeviceIdentity | undefined,
        );
      request.onerror = () =>
        reject(
          request.error ??
            new Error("The paired device identity could not be read."),
        );
    });
  } finally {
    database.close();
  }
}

async function saveIdentity(
  value: StoredDeviceIdentity,
): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction("identity", "readwrite")
        .objectStore("identity")
        .put(value, "device");
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          request.error ??
            new Error("The paired device identity could not be saved."),
        );
    });
  } finally {
    database.close();
  }
}

async function getOrCreateIdentity(): Promise<StoredDeviceIdentity> {
  const existing = await loadStoredIdentity();
  if (existing) {
    return existing;
  }
  const generated = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", generated.publicKey),
  );
  const privatePkcs8 = await crypto.subtle.exportKey(
    "pkcs8",
    generated.privateKey,
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privatePkcs8,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const created: StoredDeviceIdentity = {
    id: crypto.randomUUID(),
    name: navigator.userAgent.includes("iPhone")
      ? "iPhone"
      : navigator.userAgent.includes("Android")
        ? "Android phone"
        : "Mobile browser",
    privateKey,
    publicKey: bytesToBase64(publicKey),
  };
  await saveIdentity(created);
  return created;
}

async function fingerprint(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytesBuffer(base64ToBytes(publicKey)),
  );
  return base64Url(new Uint8Array(digest)).slice(0, 22);
}

async function deriveKeys(
  deviceIdentity: StoredDeviceIdentity,
  hostPublicKey: string,
  salt: string,
): Promise<{
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  sasKey: Uint8Array;
}> {
  const importedHostKey = await crypto.subtle.importKey(
    "raw",
    bytesBuffer(base64ToBytes(hostPublicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: importedHostKey },
    deviceIdentity.privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    shared,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const material = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: bytesBuffer(base64ToBytes(salt)),
        info: bytesBuffer(encoder.encode("modelhop-remote-v1")),
      },
      hkdfKey,
      512,
    ),
  );
  return {
    sasKey: material.slice(0, 32),
    sendKey: await crypto.subtle.importKey(
      "raw",
      material.slice(0, 32),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    ),
    receiveKey: await crypto.subtle.importKey(
      "raw",
      material.slice(32, 64),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    ),
  };
}

async function computePairingSas(
  key: Uint8Array,
  sessionId: string,
  deviceIdentity: StoredDeviceIdentity,
): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    bytesBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      bytesBuffer(
        encoder.encode(
          `${sessionId}:${deviceIdentity.id}:${deviceIdentity.publicKey}`,
        ),
      ),
    ),
  );
  const view = new DataView(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength,
  );
  return String(view.getUint32(0) % 1_000_000).padStart(6, "0");
}

async function encryptValue(
  value: unknown,
  cryptoState: SessionCrypto,
): Promise<EncryptedEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sequence = cryptoState.nextSendSequence;
  cryptoState.nextSendSequence += 1;
  const version = REMOTE_PROTOCOL_VERSION;
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bytesBuffer(nonce),
      additionalData: bytesBuffer(
        encoder.encode(
          remoteEnvelopeAdditionalData(
            version,
            cryptoState.connectionId,
            sequence,
          ),
        ),
      ),
    },
    cryptoState.sendKey,
    bytesBuffer(encoder.encode(JSON.stringify(value))),
  );
  return {
    version,
    connectionId: cryptoState.connectionId,
    sequence,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptValue<T>(
  envelope: EncryptedEnvelope,
  cryptoState: SessionCrypto,
): Promise<T> {
  if (
    envelope.connectionId !== cryptoState.connectionId ||
    cryptoState.seenReceiveSequences.has(envelope.sequence)
  ) {
    throw new Error("Replayed or mismatched encrypted response.");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytesBuffer(base64ToBytes(envelope.nonce)),
      additionalData: bytesBuffer(
        encoder.encode(
          remoteEnvelopeAdditionalData(
            envelope.version,
            envelope.connectionId,
            envelope.sequence,
          ),
        ),
      ),
    },
    cryptoState.receiveKey,
    bytesBuffer(base64ToBytes(envelope.ciphertext)),
  );
  cryptoState.seenReceiveSequences.add(envelope.sequence);
  if (cryptoState.seenReceiveSequences.size > 2_000) {
    const oldest = cryptoState.seenReceiveSequences.values().next().value;
    if (typeof oldest === "number") {
      cryptoState.seenReceiveSequences.delete(oldest);
    }
  }
  return JSON.parse(decoder.decode(plaintext)) as T;
}

async function encryptInOrder(
  command: RemoteWebCommand,
  cryptoState: SessionCrypto,
): Promise<EncryptedEnvelope> {
  let resolveEnvelope!: (value: EncryptedEnvelope) => void;
  let rejectEnvelope!: (reason: unknown) => void;
  const result = new Promise<EncryptedEnvelope>((resolve, reject) => {
    resolveEnvelope = resolve;
    rejectEnvelope = reject;
  });
  encryptionChain = encryptionChain
    .then(async () => {
      resolveEnvelope(await encryptValue(command, cryptoState));
    })
    .catch((error: unknown) => {
      rejectEnvelope(error);
    });
  return result;
}

const productionTransport: RemoteTransport = {
  async send<T = unknown>(command: RemoteWebCommand): Promise<T> {
    const cryptoState = sessionCrypto;
    if (!cryptoState) {
      throw new Error("The encrypted session is unavailable.");
    }
    const timeoutMilliseconds =
      command.type === "attachment.upload" ||
      command.type === "session.handback"
        ? 120_000
        : 30_000;
    const sendOnce = async (): Promise<EncryptedEnvelope> => {
      const envelope = await encryptInOrder(command, cryptoState);
      return fetchJson<EncryptedEnvelope>("/api/command", {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMilliseconds),
        headers: {
          "X-ModelHop-Connection": cryptoState.connectionId,
        },
        body: JSON.stringify(envelope),
      });
    };
    let encrypted: EncryptedEnvelope;
    try {
      encrypted = await sendOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        !/replayed or out-of-order remote message|duplicate or expired remote message/iu.test(
          message,
        )
      ) {
        throw error;
      }
      // Older detached daemons enforced arrival order across independent HTTP
      // requests. Retry the same idempotent command with a fresh sequence so
      // this transport detail never leaks into the phone interface.
      encrypted = await sendOnce();
    }
    const response = await decryptValue<RemoteCommandResponse>(
      encrypted,
      cryptoState,
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(response.error ?? "Remote command failed."),
        { authoritative: true },
      );
    }
    return response.data as T;
  },
};

async function acknowledgeTerminalEvent(
  terminalEventId: number,
): Promise<void> {
  await acknowledgeTerminalWithRetry({
    terminalEventId,
    createCommandId: () => crypto.randomUUID(),
    send: (command) => productionTransport.send(command),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  // The ended screen remains authoritative. If every acknowledgement attempt
  // failed, the daemon's bounded shutdown grace period performs cleanup.
}

const productionNotifications: RemoteNotificationAdapter = {
  supported: () => "Notification" in window,
  permission: () =>
    "Notification" in window
      ? Notification.permission
      : "unsupported",
  requestPermission: async () =>
    "Notification" in window
      ? Notification.requestPermission()
      : "unsupported",
  notify: ({ id, title, body, onClick }) => {
    if (
      !("Notification" in window) ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    const notification = new Notification(title, {
      body,
      icon: "/icon.png",
      tag: id,
    });
    notification.onclick = () => {
      notification.close();
      window.focus();
      onClick?.();
    };
  },
  vibrate: (pattern) => {
    navigator.vibrate?.(pattern);
  },
};

async function waitForPairing(connectionId: string): Promise<void> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const status = await fetchJson<RemoteConnectionStatus>(
      `/api/connect/${encodeURIComponent(connectionId)}`,
    );
    if (status.status === "confirmed") {
      return;
    }
    if (status.status === "rejected") {
      clearLaunchToken();
      throw new Error("The pairing request was rejected on the Mac.");
    }
  }
}

async function connect(): Promise<void> {
  if (!launchToken) {
    throw new Error(
      "This link is missing its one-time ModelHop launch token.",
    );
  }
  let bootstrap: RemotePairingBootstrap;
  try {
    bootstrap = await fetchJson<RemotePairingBootstrap>("/api/bootstrap", {
      headers: { "X-ModelHop-Launch": launchToken },
    });
  } catch (error) {
    if (
      error instanceof RemoteResponseError &&
      (error.status === 401 || error.status === 410)
    ) {
      clearLaunchToken();
    }
    throw error;
  }
  if (launchCapabilityStorage) {
    storeLaunchCapability(
      launchCapabilityStorage,
      launchToken,
      localLaunchCapabilityExpiry(
        bootstrap.serverNow,
        bootstrap.sessionExpiresAt,
      ),
    );
  }
  identity = await getOrCreateIdentity();
  const hostFingerprint = await fingerprint(bootstrap.hostPublicKey);
  if (
    identity.hostFingerprint &&
    identity.hostFingerprint !== hostFingerprint
  ) {
    throw new Error(
      "This Mac has a different encryption identity. Revoke the old pairing from ModelHop before continuing.",
    );
  }
  const keys = await deriveKeys(
    identity,
    bootstrap.hostPublicKey,
    bootstrap.sessionSalt,
  );
  const status = await fetchJson<RemoteConnectionStatus>(
    "/api/connect",
    {
      method: "POST",
      headers: { "X-ModelHop-Launch": launchToken },
      body: JSON.stringify({
        deviceId: identity.id,
        deviceName: identity.name,
        devicePublicKey: identity.publicKey,
        hostFingerprint: identity.hostFingerprint,
      }),
    },
  );
  const expectedSas = await computePairingSas(
    keys.sasKey,
    bootstrap.sessionId,
    identity,
  );
  if (status.sas && status.sas !== expectedSas) {
    throw new Error(
      "The encrypted pairing code did not match. Close this page and stop remote access on the Mac.",
    );
  }
  sessionCrypto = {
    connectionId: status.connectionId,
    sendKey: keys.sendKey,
    receiveKey: keys.receiveKey,
    nextSendSequence: 1,
    seenReceiveSequences: new Set(),
  };
  if (status.status === "pending") {
    pairingMessage.textContent =
      "Check that this six-digit code matches the prominent confirmation shown in Cursor or VS Code.";
    pairingCodeWrap.hidden = false;
    pairingCode.textContent = expectedSas.replace(
      /^(\d{3})(\d{3})$/u,
      "$1 $2",
    );
    await waitForPairing(status.connectionId);
  } else if (status.status === "rejected") {
    clearLaunchToken();
    throw new Error("This device was not approved.");
  }
  identity.hostFingerprint = hostFingerprint;
  await saveIdentity(identity);
  pairingView.hidden = true;
  mountedApp = mountRemoteApp({
    document,
    transport: productionTransport,
    notifications: productionNotifications,
  });
  mountedApp.setConnection("secure");
  void pollEvents();
}

async function pollEvents(): Promise<void> {
  while (!eventLoopStopped && sessionCrypto && mountedApp) {
    try {
      const encrypted = await fetchJson<EncryptedEnvelope>(
        `/api/events?connection=${encodeURIComponent(
          sessionCrypto.connectionId,
        )}&after=${latestEventId}`,
      );
      const batch = await decryptValue<RemoteEventBatch>(
        encrypted,
        sessionCrypto,
      );
      mountedApp.applyBatch(batch);
      for (const event of batch.events) {
        latestEventId = Math.max(latestEventId, event.id);
      }
      const snapshotLease = batch.snapshot &&
        typeof batch.snapshot === "object"
        ? (batch.snapshot as { lease?: { state?: string } }).lease
        : undefined;
      const terminal =
        batch.lease?.state === "stopped" ||
        snapshotLease?.state === "stopped" ||
        batch.events.some((event) => {
          if (event.type === "session.state") {
            const payload =
              typeof event.payload === "object" &&
              event.payload !== null
                ? (event.payload as Record<string, unknown>)
                : {};
            return payload.state === "stopped";
          }
          if (event.type === "notification") {
            const payload =
              typeof event.payload === "object" &&
              event.payload !== null
                ? (event.payload as Record<string, unknown>)
                : {};
            return payload.terminal === true || payload.ended === true;
          }
          return false;
        });
      if (terminal) {
        eventLoopStopped = true;
        clearLaunchToken();
        const terminalEventId =
          batch.terminalEventId ?? batch.latestEventId ?? latestEventId;
        if (terminalEventId > 0) {
          await acknowledgeTerminalEvent(terminalEventId);
        }
      } else {
        const transportState = batch.snapshot &&
          typeof batch.snapshot === "object"
          ? (
              batch.snapshot as {
                transport?: { state?: string };
              }
            ).transport?.state
          : undefined;
        mountedApp.setConnection(
          transportState === "link-lost"
            ? "link-lost"
            : transportState === "recovering"
              ? "reconnecting"
              : "secure",
        );
      }
    } catch (error) {
      const terminalLinkState = error instanceof RemoteResponseError
        ? error.status === 401 || error.status === 403
          ? "revoked"
          : error.status === 404 || error.status === 410
            ? "expired"
            : undefined
        : undefined;
      if (terminalLinkState) {
        mountedApp.setConnection(terminalLinkState);
        eventLoopStopped = true;
        clearLaunchToken();
        break;
      }
      mountedApp.setConnection("reconnecting");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (!(error instanceof Error)) {
        console.warn("ModelHop Remote event stream failed.");
      } else if (navigator.onLine) {
        console.warn(error.message);
      }
    }
  }
}

window.addEventListener("pagehide", () => {
  // The daemon owns the active model turn. Closing or suspending this tab
  // must not cancel work or silently stop the tunnel.
  mountedApp?.setConnection("reconnecting", "Suspended");
});

void connect().catch((error: unknown) => {
  pairingCodeWrap.hidden = true;
  pairingMessage.textContent =
    error instanceof Error
      ? error.message
      : "ModelHop Remote could not connect.";
});
