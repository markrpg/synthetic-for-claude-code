import { describe, expect, it } from "vitest";
import {
  clearStoredLaunchCapability,
  LAUNCH_CAPABILITY_STORAGE_KEY,
  localLaunchCapabilityExpiry,
  provisionalLaunchCapabilityExpiry,
  readStoredLaunchCapability,
  resolveLaunchToken,
  storeLaunchCapability,
  type LaunchCapabilityStorage,
} from "../../src/remote/web/launchToken.js";

class MemoryStorage implements LaunchCapabilityStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("remote launch token recovery", () => {
  it("persists a fragment token and restores it after URL sanitization", () => {
    const initial = resolveLaunchToken(
      "fragment-capability",
      null,
      null,
    );
    expect(initial).toEqual({
      token: "fragment-capability",
      cameFromLocation: true,
    });

    expect(
      resolveLaunchToken(null, null, initial.token),
    ).toEqual({
      token: "fragment-capability",
      cameFromLocation: false,
    });
  });

  it("prefers a new link over stale per-tab storage", () => {
    expect(
      resolveLaunchToken("fresh", null, "stale"),
    ).toEqual({
      token: "fresh",
      cameFromLocation: true,
    });
  });

  it("restores the active capability from origin-scoped storage after a tab closes", () => {
    const storage = new MemoryStorage();
    const now = 1_000;

    expect(
      storeLaunchCapability(storage, "durable-capability", 10_000, now),
    ).toBe(true);
    expect(readStoredLaunchCapability(storage, now + 1)).toBe(
      "durable-capability",
    );
    expect(
      resolveLaunchToken(
        null,
        null,
        readStoredLaunchCapability(storage, now + 1),
      ),
    ).toEqual({
      token: "durable-capability",
      cameFromLocation: false,
    });
  });

  it("removes expired, malformed, and terminal capabilities", () => {
    const storage = new MemoryStorage();
    expect(
      storeLaunchCapability(storage, "expired-capability", 2_000, 1_000),
    ).toBe(true);
    expect(readStoredLaunchCapability(storage, 2_000)).toBeNull();
    expect(storage.getItem(LAUNCH_CAPABILITY_STORAGE_KEY)).toBeNull();

    storage.setItem(LAUNCH_CAPABILITY_STORAGE_KEY, "not-json");
    expect(readStoredLaunchCapability(storage, 2_001)).toBeNull();
    expect(storage.getItem(LAUNCH_CAPABILITY_STORAGE_KEY)).toBeNull();

    storeLaunchCapability(storage, "active-capability", 5_000, 2_001);
    clearStoredLaunchCapability(storage);
    expect(readStoredLaunchCapability(storage, 2_002)).toBeNull();
  });

  it("translates the Mac deadline without trusting the phone clock", () => {
    const phoneNow = 50_000;
    expect(localLaunchCapabilityExpiry(1_000, 4_000, phoneNow)).toBe(
      53_000,
    );
    expect(provisionalLaunchCapabilityExpiry(phoneNow)).toBe(
      phoneNow + 8 * 60 * 60 * 1_000,
    );
  });
});
