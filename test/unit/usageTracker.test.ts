import { describe, expect, it } from "vitest";
import { UsageTracker } from "../../src/bridge/usageTracker.js";

describe("UsageTracker", () => {
  it("accumulates tokens and estimates while replacing live headroom", () => {
    const tracker = new UsageTracker();
    tracker.setProvider("openai-api");
    tracker.record(
      {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        requestCount: 1,
      },
      { remainingRequests: 99, limitRequests: 100 },
      0.01,
    );
    tracker.record(
      { inputTokens: 10, outputTokens: 5, requestCount: 1 },
      { remainingRequests: 98, limitRequests: 100 },
      0.002,
    );

    expect(tracker.snapshot()).toMatchObject({
      provider: "openai-api",
      tokens: {
        inputTokens: 110,
        outputTokens: 25,
        cachedInputTokens: 40,
        requestCount: 2,
        estimatedCostUsd: 0.012,
      },
      rateLimits: { remainingRequests: 98, limitRequests: 100 },
    });
  });
});
