export function pairingWindowExpiresAt(
  configuredAt: number,
  maximumSessionMs: number,
  pairingOpenedAt: number,
  pairingTtlMs: number,
): number {
  return Math.min(
    configuredAt + maximumSessionMs,
    pairingOpenedAt + pairingTtlMs,
  );
}

export function newDevicePairingAllowed(
  now: number,
  pairingOpenedAt: number,
  pairingTtlMs: number,
  sessionExpiresAt = Number.POSITIVE_INFINITY,
): boolean {
  return (
    now >= pairingOpenedAt &&
    now - pairingOpenedAt <= pairingTtlMs &&
    now < sessionExpiresAt
  );
}

export type RemoteBootstrapConnectionDecision =
  | "connect"
  | "pairing-expired"
  | "session-expired";

export type RemoteDeviceConnectionDecision =
  | "known-device"
  | "new-device-pairing"
  | "pairing-expired"
  | "session-expired";

/**
 * The Mac is authoritative for reconnect trust. A browser may have lost its
 * local host-fingerprint marker while retaining the same non-extractable
 * device key, so client-side expiry must never reject it before this check.
 */
export function remoteDeviceConnectionDecision(
  now: number,
  pairingOpenedAt: number,
  pairingTtlMs: number,
  sessionExpiresAt: number,
  knownDevice: boolean,
): RemoteDeviceConnectionDecision {
  if (knownDevice) {
    return "known-device";
  }
  if (now >= sessionExpiresAt) {
    return "session-expired";
  }
  return newDevicePairingAllowed(
    now,
    pairingOpenedAt,
    pairingTtlMs,
    sessionExpiresAt,
  )
    ? "new-device-pairing"
    : "pairing-expired";
}

/**
 * The server remains authoritative for a previously paired device. This lets
 * it reconnect to an over-limit active turn for approvals, questions, reads,
 * or explicit cancellation. Unknown devices remain bounded by both clocks.
 */
export function remoteBootstrapConnectionDecision(
  now: number,
  pairingExpiresAt: number,
  sessionExpiresAt: number,
  hasConfirmedHostIdentity: boolean,
): RemoteBootstrapConnectionDecision {
  if (hasConfirmedHostIdentity) {
    return "connect";
  }
  if (now >= sessionExpiresAt) {
    return "session-expired";
  }
  return now > pairingExpiresAt ? "pairing-expired" : "connect";
}
