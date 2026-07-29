import { describe, expect, it } from "vitest";
import { estimateOpenAICost } from "../../src/openai/openAIPricing.js";

describe("OpenAI API cost estimates", () => {
  it("uses uncached, cached, and output rates for known models", () => {
    expect(
      estimateOpenAICost("gpt-5.6-sol", {
        inputTokens: 100_000,
        cachedInputTokens: 25_000,
        outputTokens: 10_000,
      }),
    ).toBeCloseTo(0.6875);
  });

  it("applies published long-context multipliers", () => {
    expect(
      estimateOpenAICost("gpt-5.6-luna", {
        inputTokens: 300_000,
        cachedInputTokens: 0,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(1.5);
  });

  it("does not invent prices for manually entered models", () => {
    expect(
      estimateOpenAICost("custom-model", {
        inputTokens: 100,
        outputTokens: 20,
      }),
    ).toBeUndefined();
  });
});
