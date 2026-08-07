import { describe, expect, it, vi } from "vitest";
import { RemoteSetupCancelledError } from "../../src/remote/cancellation.js";
import {
  NonRetryablePublicBootstrapRequestError,
  probePublicBootstrap,
  validateBootstrapResponse,
  type PublicBootstrapProbeResponse,
} from "../../src/remote/publicBootstrapProbe.js";

const expected = {
  version: "1",
  sessionId: "session-1",
  hostPublicKey: "host-key-1",
  now: () => 1_000,
};

function response(
  overrides: Record<string, unknown> = {},
): PublicBootstrapProbeResponse {
  return {
    status: 200,
    body: JSON.stringify({
      version: expected.version,
      sessionId: expected.sessionId,
      hostPublicKey: expected.hostPublicKey,
      pairingExpiresAt: 2_000,
      sessionExpiresAt: 10_000,
      ...overrides,
    }),
  };
}

describe("public bootstrap probe", () => {
  it("verifies an exact current bootstrap response", async () => {
    const request = vi.fn().mockResolvedValue(response());

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
      }),
    ).resolves.toEqual({ state: "verified" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("allows only local identity checks to accept an expired bootstrap", () => {
    const expired = response({ pairingExpiresAt: expected.now() });
    expect(() =>
      validateBootstrapResponse(expired, expected),
    ).toThrow();
    expect(() =>
      validateBootstrapResponse(expired, expected, {
        allowExpired: true,
      }),
    ).not.toThrow();
  });

  it("keeps a registered connector after repeated fetch failures", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
        attempts: 3,
        wait,
      }),
    ).resolves.toEqual({
      state: "connector-registered",
      lastFailure: { kind: "transport" },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("treats response-body stream resets as retryable transport failures", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("terminated"), {
          code: "ECONNRESET",
        }),
      );

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
        attempts: 2,
      }),
    ).resolves.toEqual({
      state: "connector-registered",
      lastFailure: { kind: "transport" },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["version-mismatch", { version: "2" }],
    ["session-mismatch", { sessionId: "other-session" }],
    ["host-key-mismatch", { hostPublicKey: "other-host" }],
    ["expired", { pairingExpiresAt: 1_000 }],
  ] as const)(
    "rejects a %s response without retrying",
    async (code, override) => {
      const request = vi.fn().mockResolvedValue(response(override));

      await expect(
        probePublicBootstrap({
          request,
          isRunning: async () => true,
          expected,
          attempts: 3,
        }),
      ).rejects.toMatchObject({
        code,
      });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("rejects if the connector dies between transient attempts", async () => {
    const isRunning = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const request = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      probePublicBootstrap({
        request,
        isRunning,
        expected,
        attempts: 3,
      }),
    ).rejects.toMatchObject({
      code: "connector-stopped",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries transient gateway statuses and then verifies", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, body: "" })
      .mockResolvedValueOnce({ status: 530, body: "" })
      .mockResolvedValueOnce(response());

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
        attempts: 3,
      }),
    ).resolves.toEqual({ state: "verified" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("returns registered after only transient gateway responses", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 504, body: "" });

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
        attempts: 2,
      }),
    ).resolves.toEqual({
      state: "connector-registered",
      lastFailure: {
        kind: "transient-http",
        status: 504,
      },
    });
  });

  it("rejects non-transient HTTP and malformed success responses", async () => {
    await expect(
      probePublicBootstrap({
        request: async () => ({ status: 410, body: "" }),
        isRunning: async () => true,
        expected,
      }),
    ).rejects.toMatchObject({
      code: "unexpected-status",
    });

    await expect(
      probePublicBootstrap({
        request: async () => ({ status: 200, body: "not JSON" }),
        isRunning: async () => true,
        expected,
      }),
    ).rejects.toMatchObject({
      code: "invalid-body",
    });
  });

  it("does not retry request failures explicitly marked non-retryable", async () => {
    const request = vi.fn().mockRejectedValue(
      new NonRetryablePublicBootstrapRequestError(
        "The response exceeded its size limit.",
      ),
    );

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
        attempts: 3,
      }),
    ).rejects.toBeInstanceOf(
      NonRetryablePublicBootstrapRequestError,
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not issue a public request after cancellation", async () => {
    const request = vi.fn().mockResolvedValue(response());

    await expect(
      probePublicBootstrap({
        request,
        isRunning: async () => true,
        expected,
        cancelled: () => true,
      }),
    ).rejects.toBeInstanceOf(RemoteSetupCancelledError);
    expect(request).not.toHaveBeenCalled();
  });
});
