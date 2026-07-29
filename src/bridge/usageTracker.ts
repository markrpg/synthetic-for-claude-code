import type {
  BridgeProviderId,
  BridgeUsageSnapshot,
  RateLimitSnapshot,
  TokenUsageSnapshot,
} from "./types.js";
import type { OpenAIUsageObserver } from "./openAIResponsesClient.js";

export class UsageTracker implements OpenAIUsageObserver {
  private provider: BridgeProviderId | undefined;
  private tokens: TokenUsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    requestCount: 0,
  };
  private rateLimits: RateLimitSnapshot = {};
  private codex: unknown;
  private codexUsage: unknown;
  private updatedAt = Date.now();

  public setProvider(provider: BridgeProviderId): void {
    if (provider !== this.provider) {
      this.provider = provider;
      this.rateLimits = {};
      this.codex = undefined;
      this.codexUsage = undefined;
    }
    this.updatedAt = Date.now();
  }

  public record(
    usage: Partial<TokenUsageSnapshot>,
    rateLimits: RateLimitSnapshot,
    estimatedCostUsd?: number,
  ): void {
    this.tokens.inputTokens += usage.inputTokens ?? 0;
    this.tokens.outputTokens += usage.outputTokens ?? 0;
    this.tokens.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.tokens.requestCount += usage.requestCount ?? 0;
    if (estimatedCostUsd !== undefined) {
      this.tokens.estimatedCostUsd =
        (this.tokens.estimatedCostUsd ?? 0) + estimatedCostUsd;
    }
    this.rateLimits = rateLimits;
    this.updatedAt = Date.now();
  }

  public setCodex(rateLimits: unknown, usage: unknown): void {
    this.codex = rateLimits;
    this.codexUsage = usage;
    this.updatedAt = Date.now();
  }

  public snapshot(): BridgeUsageSnapshot {
    return {
      provider: this.provider,
      updatedAt: this.updatedAt,
      tokens: { ...this.tokens },
      rateLimits: { ...this.rateLimits },
      codex: this.codex,
      codexUsage: this.codexUsage,
    };
  }
}
