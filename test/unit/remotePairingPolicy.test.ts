import { describe, expect, it } from "vitest";
import {
  newDevicePairingAllowed,
  pairingWindowExpiresAt,
  remoteBootstrapConnectionDecision,
  remoteDeviceConnectionDecision,
} from "../../src/remote/pairingPolicy.js";

describe("remote pairing window", () => {
  it("can be refreshed without extending the absolute session", () => {
    const configuredAt = 1_000;
    const maximumSessionMs = 10_000;
    const pairingTtlMs = 2_000;

    expect(
      newDevicePairingAllowed(
        configuredAt + pairingTtlMs,
        configuredAt,
        pairingTtlMs,
      ),
    ).toBe(true);
    expect(
      newDevicePairingAllowed(
        configuredAt + pairingTtlMs + 1,
        configuredAt,
        pairingTtlMs,
      ),
    ).toBe(false);

    const refreshedAt = configuredAt + 5_000;
    expect(
      newDevicePairingAllowed(
        refreshedAt + 1,
        refreshedAt,
        pairingTtlMs,
        configuredAt + maximumSessionMs,
      ),
    ).toBe(true);
    expect(
      newDevicePairingAllowed(
        configuredAt + maximumSessionMs,
        configuredAt + 9_500,
        pairingTtlMs,
        configuredAt + maximumSessionMs,
      ),
    ).toBe(false);
    expect(
      pairingWindowExpiresAt(
        configuredAt,
        maximumSessionMs,
        refreshedAt,
        pairingTtlMs,
      ),
    ).toBe(refreshedAt + pairingTtlMs);
    expect(
      pairingWindowExpiresAt(
        configuredAt,
        maximumSessionMs,
        configuredAt + 9_500,
        pairingTtlMs,
      ),
    ).toBe(configuredAt + maximumSessionMs);
  });

  it("lets a known phone attempt same-link reconnect after pairing expiry", () => {
    expect(
      remoteBootstrapConnectionDecision(5_000, 2_000, 10_000, true),
    ).toBe("connect");
    expect(
      remoteBootstrapConnectionDecision(5_000, 2_000, 10_000, false),
    ).toBe("pairing-expired");
  });

  it("keeps an over-limit active session server-authoritative for known phones", () => {
    expect(
      remoteBootstrapConnectionDecision(10_000, 2_000, 10_000, true),
    ).toBe("connect");
    expect(
      remoteBootstrapConnectionDecision(10_000, 2_000, 10_000, false),
    ).toBe("session-expired");
  });

  it("lets the Mac recognise a paired device after the new-device window closes", () => {
    expect(
      remoteDeviceConnectionDecision(
        5_000,
        1_000,
        2_000,
        10_000,
        true,
      ),
    ).toBe("known-device");
    expect(
      remoteDeviceConnectionDecision(
        5_000,
        1_000,
        2_000,
        10_000,
        false,
      ),
    ).toBe("pairing-expired");
    expect(
      remoteDeviceConnectionDecision(
        10_000,
        1_000,
        2_000,
        10_000,
        false,
      ),
    ).toBe("session-expired");
  });
});
