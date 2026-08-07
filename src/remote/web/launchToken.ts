export interface ResolvedLaunchToken {
  token: string;
  cameFromLocation: boolean;
}

export interface LaunchCapabilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredLaunchCapability {
  version: 1;
  token: string;
  expiresAt: number;
}

export const LAUNCH_CAPABILITY_STORAGE_KEY =
  "modelhop.remote.launch.capability.v1";

const MAXIMUM_DURABLE_LIFETIME_MS = 8 * 60 * 60 * 1_000;

export function resolveLaunchToken(
  fragmentToken: string | null,
  legacyQueryToken: string | null,
  storedToken: string | null,
): ResolvedLaunchToken {
  const fromLocation = fragmentToken || legacyQueryToken || "";
  return {
    token: fromLocation || storedToken || "",
    cameFromLocation: Boolean(fromLocation),
  };
}

/**
 * Reads the active Quick Tunnel capability from origin-scoped durable
 * storage. Invalid and expired values are removed rather than retried.
 */
export function readStoredLaunchCapability(
  storage: LaunchCapabilityStorage,
  now = Date.now(),
): string | null {
  try {
    const encoded = storage.getItem(LAUNCH_CAPABILITY_STORAGE_KEY);
    if (!encoded) {
      return null;
    }
    const stored = JSON.parse(encoded) as Partial<StoredLaunchCapability>;
    if (
      stored.version !== 1 ||
      typeof stored.token !== "string" ||
      !stored.token ||
      typeof stored.expiresAt !== "number" ||
      !Number.isFinite(stored.expiresAt) ||
      stored.expiresAt <= now
    ) {
      storage.removeItem(LAUNCH_CAPABILITY_STORAGE_KEY);
      return null;
    }
    return stored.token;
  } catch {
    try {
      storage.removeItem(LAUNCH_CAPABILITY_STORAGE_KEY);
    } catch {
      // Storage is optional. The fragment token still works in memory.
    }
    return null;
  }
}

/**
 * Persists only the current lease capability, capped at ModelHop's fixed
 * eight-hour remote-session boundary. Quick Tunnel origins are unique, so the
 * value cannot be read by a later tunnel hostname.
 */
export function storeLaunchCapability(
  storage: LaunchCapabilityStorage,
  token: string,
  expiresAt: number,
  now = Date.now(),
): boolean {
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= now) {
    clearStoredLaunchCapability(storage);
    return false;
  }
  try {
    storage.setItem(
      LAUNCH_CAPABILITY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        token,
        expiresAt: Math.min(
          expiresAt,
          now + MAXIMUM_DURABLE_LIFETIME_MS,
        ),
      } satisfies StoredLaunchCapability),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearStoredLaunchCapability(
  storage: LaunchCapabilityStorage,
): void {
  try {
    storage.removeItem(LAUNCH_CAPABILITY_STORAGE_KEY);
  } catch {
    // Private browsing modes may deny durable storage.
  }
}

/** Converts server deadlines without assuming the phone and Mac clocks match. */
export function localLaunchCapabilityExpiry(
  serverNow: number,
  sessionExpiresAt: number,
  localNow = Date.now(),
): number {
  if (
    !Number.isFinite(serverNow) ||
    !Number.isFinite(sessionExpiresAt)
  ) {
    return localNow;
  }
  const remaining = Math.max(0, sessionExpiresAt - serverNow);
  return localNow + Math.min(remaining, MAXIMUM_DURABLE_LIFETIME_MS);
}

export function provisionalLaunchCapabilityExpiry(
  now = Date.now(),
): number {
  return now + MAXIMUM_DURABLE_LIFETIME_MS;
}
