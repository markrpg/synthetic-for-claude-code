import { describe, expect, it } from "vitest";
import {
  recordsAuthenticatedRemoteActivity,
  remoteIdleTimeoutMs,
  remoteLifecycleDecision,
  RemoteLifecycleCleanupLatch,
  resolveRemoteIdleTimeoutChoice,
  REMOTE_MAXIMUM_SESSION_MS,
  REMOTE_UNPAIRED_TIMEOUT_MS,
  type RemoteIdleTimeoutChoice,
  type RemoteLifecycleSnapshot,
} from "../../src/remote/lifecyclePolicy.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function snapshot(
  overrides: Partial<RemoteLifecycleSnapshot> = {},
): RemoteLifecycleSnapshot {
  return {
    now: HOUR,
    configuredAt: 0,
    ownerDeviceId: "phone",
    busy: false,
    turnCompletedAt: 1,
    lastActivityAt: 1,
    lastConnectionSeenAt: 1,
    idleTimeoutMs: HOUR,
    unpairedTimeoutMs: REMOTE_UNPAIRED_TIMEOUT_MS,
    maximumSessionMs: REMOTE_MAXIMUM_SESSION_MS,
    ...overrides,
  };
}

describe("remote lifecycle policy", () => {
  it("maps the supported idle choices and defaults safely to 60 minutes", () => {
    const expected = new Map<RemoteIdleTimeoutChoice, number | null>([
      ["15m", 15 * MINUTE],
      ["30m", 30 * MINUTE],
      ["60m", HOUR],
      ["8h", 8 * HOUR],
      ["manual", null],
    ]);
    for (const [choice, milliseconds] of expected) {
      expect(remoteIdleTimeoutMs(choice)).toBe(milliseconds);
    }
    expect(remoteIdleTimeoutMs("unsupported")).toBe(HOUR);
  });

  it("migrates only exact legacy inactivity choices when no new value is set", () => {
    expect(resolveRemoteIdleTimeoutChoice(undefined, 15)).toBe("15m");
    expect(resolveRemoteIdleTimeoutChoice(undefined, 30)).toBe("30m");
    expect(resolveRemoteIdleTimeoutChoice(undefined, 60)).toBe("60m");
    expect(resolveRemoteIdleTimeoutChoice(undefined, 480)).toBe("8h");
    expect(resolveRemoteIdleTimeoutChoice(undefined, 45)).toBe("60m");
    expect(resolveRemoteIdleTimeoutChoice("manual", 15)).toBe("manual");
  });

  it("stops an unpaired link after ten minutes without affecting active work", () => {
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_UNPAIRED_TIMEOUT_MS - 1,
          ownerDeviceId: undefined,
          turnCompletedAt: undefined,
        }),
      ),
    ).toBe("continue");
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_UNPAIRED_TIMEOUT_MS,
          ownerDeviceId: undefined,
          turnCompletedAt: undefined,
        }),
      ),
    ).toBe("stop-unpaired");
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_UNPAIRED_TIMEOUT_MS,
          ownerDeviceId: undefined,
          busy: true,
          turnCompletedAt: undefined,
        }),
      ),
    ).toBe("continue");
  });

  it("never applies connection or idle expiry to an active turn", () => {
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: 7 * HOUR,
          busy: true,
          lastConnectionSeenAt: MINUTE,
          idleTimeoutMs: 15 * MINUTE,
          turnCompletedAt: undefined,
        }),
      ),
    ).toBe("continue");
  });

  it("starts completed-turn idle time from the latest durable activity", () => {
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: 79 * MINUTE,
          turnCompletedAt: 10 * MINUTE,
          lastActivityAt: 20 * MINUTE,
          lastConnectionSeenAt: 79 * MINUTE,
          idleTimeoutMs: HOUR,
        }),
      ),
    ).toBe("continue");
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: 80 * MINUTE,
          turnCompletedAt: 10 * MINUTE,
          lastActivityAt: 20 * MINUTE,
          lastConnectionSeenAt: 80 * MINUTE,
          idleTimeoutMs: HOUR,
        }),
      ),
    ).toBe("handback-after-idle");
  });

  it("counts authenticated commands but not passive event delivery as activity", () => {
    expect(
      recordsAuthenticatedRemoteActivity({ type: "file.read" }),
    ).toBe(true);
    expect(
      recordsAuthenticatedRemoteActivity({ type: "usage.refresh" }),
    ).toBe(true);
    expect(
      recordsAuthenticatedRemoteActivity({
        type: "session.terminal.ack",
      }),
    ).toBe(false);
  });

  it("claims timeout cleanup once and permits a retry after failure", () => {
    const cleanup = new RemoteLifecycleCleanupLatch();
    expect(cleanup.tryClaim()).toBe(true);
    expect(cleanup.tryClaim()).toBe(false);
    cleanup.reset();
    expect(cleanup.tryClaim()).toBe(true);
  });

  it("keeps manual idle sessions until the fixed maximum", () => {
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_MAXIMUM_SESSION_MS - 1,
          idleTimeoutMs: null,
        }),
      ),
    ).toBe("continue");
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_MAXIMUM_SESSION_MS,
          idleTimeoutMs: null,
        }),
      ),
    ).toBe("handback-after-maximum");
  });

  it("revokes new input at eight hours but lets the active turn finish", () => {
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_MAXIMUM_SESSION_MS,
          busy: true,
          turnCompletedAt: undefined,
        }),
      ),
    ).toBe("revoke-input-until-turn-completes");
    expect(
      remoteLifecycleDecision(
        snapshot({
          now: REMOTE_MAXIMUM_SESSION_MS,
          busy: false,
          turnCompletedAt: REMOTE_MAXIMUM_SESSION_MS,
        }),
      ),
    ).toBe("handback-after-maximum");
  });
});
