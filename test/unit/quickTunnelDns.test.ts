import { describe, expect, it, vi } from "vitest";
import { RemoteSetupCancelledError } from "../../src/remote/cancellation.js";
import { waitForQuickTunnelDns } from "../../src/remote/quickTunnelDns.js";

describe("Cloudflare Quick Tunnel DNS readiness", () => {
  it("waits for a new hostname to appear without using system DNS", async () => {
    const resolve4 = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("not found"), {
          code: "ENOTFOUND",
        }),
      )
      .mockResolvedValueOnce(["104.16.0.1"]);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: { resolve4 },
        attempts: 3,
        wait,
      }),
    ).resolves.toEqual({ state: "published" });
    expect(resolve4).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("reports when authoritative DNS cannot be checked", async () => {
    const resolve4 = vi
      .fn()
      .mockRejectedValue(new Error("DNS unavailable"));

    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: { resolve4 },
        attempts: 2,
      }),
    ).resolves.toEqual({ state: "unavailable" });
    expect(resolve4).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an unpublished hostname from resolver failure", async () => {
    const resolve4 = vi.fn().mockResolvedValue([]);

    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: { resolve4 },
        attempts: 3,
      }),
    ).resolves.toEqual({ state: "not-published" });
    expect(resolve4).toHaveBeenCalledTimes(3);
  });

  it("stops early after the configured resolver error limit", async () => {
    const resolve4 = vi
      .fn()
      .mockRejectedValue(new Error("DNS unavailable"));

    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: { resolve4 },
        attempts: 10,
        maxConsecutiveErrors: 3,
      }),
    ).resolves.toEqual({ state: "unavailable" });
    expect(resolve4).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid attempt count", async () => {
    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: {
          resolve4: async () => ["104.16.0.1"],
        },
        attempts: 0,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects an invalid resolver error limit", async () => {
    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: {
          resolve4: async () => ["104.16.0.1"],
        },
        maxConsecutiveErrors: 0,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("stops polling when phone-link setup is cancelled", async () => {
    const resolve4 = vi.fn().mockResolvedValue([]);

    await expect(
      waitForQuickTunnelDns({
        hostname: "new-link.trycloudflare.com",
        resolver: { resolve4 },
        cancelled: () => true,
      }),
    ).rejects.toBeInstanceOf(RemoteSetupCancelledError);
    expect(resolve4).not.toHaveBeenCalled();
  });
});
