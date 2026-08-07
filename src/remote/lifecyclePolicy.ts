import type { RemoteClientCommand } from "./types.js";

export const REMOTE_UNPAIRED_TIMEOUT_MS = 10 * 60 * 1_000;
export const REMOTE_MAXIMUM_SESSION_MS = 8 * 60 * 60 * 1_000;

export type RemoteIdleTimeoutChoice =
  | "15m"
  | "30m"
  | "60m"
  | "8h"
  | "manual";

export type RemoteLifecycleDecision =
  | "continue"
  | "stop-unpaired"
  | "revoke-input-until-turn-completes"
  | "handback-after-idle"
  | "handback-after-maximum";

const IDLE_TIMEOUTS: Record<
  Exclude<RemoteIdleTimeoutChoice, "manual">,
  number
> = {
  "15m": 15 * 60 * 1_000,
  "30m": 30 * 60 * 1_000,
  "60m": 60 * 60 * 1_000,
  "8h": REMOTE_MAXIMUM_SESSION_MS,
};

export function resolveRemoteIdleTimeoutChoice(
  configuredChoice: unknown,
  legacyMinutes: unknown,
): RemoteIdleTimeoutChoice {
  if (
    configuredChoice === "15m" ||
    configuredChoice === "30m" ||
    configuredChoice === "60m" ||
    configuredChoice === "8h" ||
    configuredChoice === "manual"
  ) {
    return configuredChoice;
  }
  switch (legacyMinutes) {
    case 15:
      return "15m";
    case 30:
      return "30m";
    case 60:
      return "60m";
    case 480:
      return "8h";
    default:
      return "60m";
  }
}

export function remoteIdleTimeoutMs(choice: unknown): number | null {
  const resolved = resolveRemoteIdleTimeoutChoice(choice, undefined);
  if (resolved === "manual") {
    return null;
  }
  return IDLE_TIMEOUTS[resolved];
}

export interface RemoteLifecycleSnapshot {
  now: number;
  configuredAt: number;
  ownerDeviceId?: string;
  busy: boolean;
  turnCompletedAt?: number;
  lastActivityAt: number;
  /**
   * Transport observation only. Long-poll heartbeats must never extend a
   * completed conversation's user-idle deadline.
   */
  lastConnectionSeenAt?: number;
  idleTimeoutMs: number | null;
  unpairedTimeoutMs: number;
  maximumSessionMs: number;
}

export function recordsAuthenticatedRemoteActivity(
  command: Pick<RemoteClientCommand, "type">,
): boolean {
  return command.type !== "session.terminal.ack";
}

export class RemoteLifecycleCleanupLatch {
  private claimed = false;

  public tryClaim(): boolean {
    if (this.claimed) {
      return false;
    }
    this.claimed = true;
    return true;
  }

  public reset(): void {
    this.claimed = false;
  }
}

/**
 * Pure lifecycle policy for the detached daemon. Active model turns always
 * outrank transport and idle expiry; only the absolute maximum revokes new
 * input while an existing turn is allowed to reach its authoritative result.
 */
export function remoteLifecycleDecision(
  snapshot: RemoteLifecycleSnapshot,
): RemoteLifecycleDecision {
  const sessionExpired =
    snapshot.now - snapshot.configuredAt >=
    snapshot.maximumSessionMs;
  if (sessionExpired) {
    return snapshot.busy
      ? "revoke-input-until-turn-completes"
      : "handback-after-maximum";
  }

  if (!snapshot.ownerDeviceId) {
    return !snapshot.busy &&
      snapshot.now - snapshot.configuredAt >=
        snapshot.unpairedTimeoutMs
      ? "stop-unpaired"
      : "continue";
  }

  if (
    snapshot.busy ||
    snapshot.idleTimeoutMs === null ||
    snapshot.turnCompletedAt === undefined
  ) {
    return "continue";
  }

  const idleSince = Math.max(
    snapshot.turnCompletedAt,
    snapshot.lastActivityAt,
  );
  return snapshot.now - idleSince >= snapshot.idleTimeoutMs
    ? "handback-after-idle"
    : "continue";
}
