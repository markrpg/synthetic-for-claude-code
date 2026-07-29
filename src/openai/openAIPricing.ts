import type { TokenUsageSnapshot } from "../bridge/types.js";

interface ModelPrice {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  longContextThreshold?: number;
}

// OpenAI list pricing verified against the model pages on 2026-07-29.
const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-5.6-sol": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    longContextThreshold: 272_000,
  },
  "gpt-5.6-terra": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    longContextThreshold: 272_000,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6,
    longContextThreshold: 272_000,
  },
};

export function estimateOpenAICost(
  model: string,
  usage: Partial<TokenUsageSnapshot>,
): number | undefined {
  const price = MODEL_PRICES[model];
  if (!price) {
    return undefined;
  }
  const input = Math.max(0, usage.inputTokens ?? 0);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens ?? 0));
  const uncached = input - cached;
  const output = Math.max(0, usage.outputTokens ?? 0);
  const longContext =
    price.longContextThreshold !== undefined &&
    input > price.longContextThreshold;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  return (
    ((uncached * price.inputPerMillion +
      cached * price.cachedInputPerMillion) *
      inputMultiplier +
      output * price.outputPerMillion * outputMultiplier) /
    1_000_000
  );
}
