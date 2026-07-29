import { describe, expect, it, vi } from "vitest";
import {
  formatQuotaDetails,
  formatQuotaStatus,
  mergeAliasAndApiModels,
  parseModelsResponse,
  parseQuotaResponse,
  SYNTHETIC_MODELS_URL,
  SyntheticApiError,
  SyntheticApiService,
} from "../../src/synthetic/syntheticApiService.js";

describe("Synthetic API response parsing", () => {
  it("parses live models, metadata, and filters embeddings", () => {
    expect(
      parseModelsResponse({
        data: [
          {
            id: "hf:zai-org/GLM-5.2",
            owned_by: "Synthetic",
            metadata: { context_length: 512_000 },
          },
          {
            id: "hf:nomic-ai/nomic-embed-text-v1.5",
            type: "embedding",
          },
          { malformed: true },
        ],
      }),
    ).toEqual([
      {
        id: "hf:zai-org/GLM-5.2",
        source: "api",
        ownedBy: "Synthetic",
        contextLength: 512_000,
      },
    ]);
  });

  it("rejects malformed model responses", () => {
    expect(() => parseModelsResponse({ models: [] })).toThrow(
      SyntheticApiError,
    );
  });

  it("puts documented aliases before live models without duplicates", () => {
    const models = mergeAliasAndApiModels([
      { id: "syn:large:text", source: "api" },
      { id: "hf:zai-org/GLM-5.2", source: "api" },
    ]);
    expect(models.slice(0, 4).every((model) => model.source === "alias")).toBe(
      true,
    );
    expect(
      models.filter((model) => model.id === "syn:large:text"),
    ).toHaveLength(1);
  });

  it("parses and formats current rolling quotas before legacy counters", () => {
    const quota = parseQuotaResponse({
      subscription: {
        limit: 500,
        requests: 0,
        renewsAt: "2026-07-30T12:00:00.000Z",
      },
      rollingFiveHourLimit: {
        nextTickAt: "2026-07-29T01:00:00.000Z",
        tickPercent: 0.05,
        remaining: 166,
        max: 500,
        limited: false,
      },
      weeklyTokenLimit: {
        nextRegenAt: "2026-07-29T02:00:00.000Z",
        percentRemaining: 56.73,
        maxCredits: "$24.00",
        remainingCredits: "$13.62",
        nextRegenCredits: "$0.48",
      },
    });
    expect(quota).toEqual({
      fiveHour: {
        max: 500,
        remaining: 166,
        used: 334,
        remainingPercent: 33.2,
        nextTickAt: "2026-07-29T01:00:00.000Z",
        tickPercent: 5,
        tickRequests: 25,
        limited: false,
      },
      weekly: {
        percentRemaining: 56.73,
        usedPercent: 43.27,
        nextRegenAt: "2026-07-29T02:00:00.000Z",
        maxCredits: 24,
        remainingCredits: 13.62,
        nextRegenCredits: 0.48,
        regenPercent: 2,
      },
    });
    expect(formatQuotaStatus(quota)).toBe(
      "5h 33.2% · wk 56.73% left",
    );
    const details = formatQuotaDetails(quota);
    expect(details).toContain(
      "Five-hour requests: 166 of 500 remaining (33.2%)",
    );
    expect(details).toContain("Regenerates 5% (25 requests)");
    expect(details).toContain(
      "Weekly credits: $13.62 of $24.00 remaining (56.73%)",
    );
    expect(details).toContain("Regenerates 2% ($0.48)");
  });

  it("accepts whole-number tick percentages", () => {
    const quota = parseQuotaResponse({
      rollingFiveHourLimit: {
        tickPercent: 5,
        remaining: 250,
        max: 500,
        limited: true,
      },
    });
    expect(quota.fiveHour?.tickPercent).toBe(5);
    expect(quota.fiveHour?.tickRequests).toBe(25);
  });

  it("falls back to the documented legacy subscription counter", () => {
    const quota = parseQuotaResponse({
      subscription: {
        limit: 135,
        requests: 35,
        renewsAt: "2026-07-30T12:00:00.000Z",
      },
    });
    expect(quota).toEqual({
      legacy: {
        limit: 135,
        requests: 35,
        remaining: 100,
        renewsAt: "2026-07-30T12:00:00.000Z",
      },
    });
    expect(formatQuotaStatus(quota)).toBe("legacy 100/135 left");
    expect(formatQuotaDetails(quota)).toContain(
      "Synthetic did not return rolling-limit fields",
    );
  });

  it("clamps exhausted legacy quota at zero remaining", () => {
    expect(
      parseQuotaResponse({
        subscription: { limit: 10, requests: 12 },
      }).legacy?.remaining,
    ).toBe(0);
  });

  it("rejects responses without supported quota counters", () => {
    expect(() =>
      parseQuotaResponse({
        subscription: { limit: "135", requests: 1 },
      }),
    ).toThrow(SyntheticApiError);
  });
});

describe("SyntheticApiService", () => {
  it("authenticates model requests without exposing the token", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(_input).toBe(SYNTHETIC_MODELS_URL);
        expect(
          new Headers(init?.headers).get("Authorization"),
        ).toBe("Bearer test-placeholder");
        expect(init?.redirect).toBe("error");
        return new Response(
          JSON.stringify({
            data: [{ id: "hf:zai-org/GLM-5.2" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );
    const service = new SyntheticApiService(
      {
        getSyntheticToken: async () => "test-placeholder",
      },
      fetcher,
    );

    const models = await service.listModels();
    expect(
      models.some((model) => model.id === "hf:zai-org/GLM-5.2"),
    ).toBe(true);
  });

  it("turns authentication failures into safe errors", async () => {
    const service = new SyntheticApiService(
      {
        getSyntheticToken: async () => "test-placeholder",
      },
      async () => new Response("", { status: 401 }),
    );

    const error = await service
      .getQuota()
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SyntheticApiError);
    expect((error as SyntheticApiError).code).toBe("unauthorized");
    expect((error as Error).message).not.toContain("test-placeholder");
  });
});
