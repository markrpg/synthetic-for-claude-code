import type {
  OpenAIProviderSettings,
  ProviderId,
} from "../providers/types.js";

export const BRIDGE_PROTOCOL_VERSION = "2.0.0+codex-read-only";

export type BridgeProviderId = Extract<
  ProviderId,
  "openai-api" | "openai-codex"
>;

export interface BridgeConfiguration {
  provider: BridgeProviderId;
  bridgeAuthToken: string;
  openAIApiKey?: string;
  openAISettings: OpenAIProviderSettings;
  codexExecutable?: string;
  codexWorkingDirectory?: string;
}

export interface BridgeHealth {
  name: "modelhop-bridge";
  version: string;
  provider?: BridgeProviderId;
  ready: boolean;
}

export interface RateLimitSnapshot {
  remainingRequests?: number;
  limitRequests?: number;
  resetRequests?: string;
  remainingTokens?: number;
  limitTokens?: number;
  resetTokens?: string;
}

export interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  requestCount: number;
  estimatedCostUsd?: number;
}

export interface BridgeUsageSnapshot {
  provider?: BridgeProviderId;
  updatedAt: number;
  tokens?: TokenUsageSnapshot;
  rateLimits?: RateLimitSnapshot;
  codex?: unknown;
  codexUsage?: unknown;
}

export interface BridgeModel {
  id: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: string[];
  isDefault?: boolean;
}
