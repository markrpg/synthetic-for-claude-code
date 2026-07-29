import type {
  ModelRoutingSettings,
  OpenAIProviderSettings,
  ProviderId,
  SyntheticSettings,
} from "../providers/types.js";

export const BRIDGE_PROTOCOL_VERSION = "2.1.0+context-ledger";

export type BridgeProviderId = Extract<
  ProviderId,
  "synthetic" | "openai-api" | "openai-codex"
>;

export interface ContextManagementSettings {
  enabled: boolean;
  thresholdPercent: number;
  fallbackContextTokens: number;
  retainRecentTokens: number;
}

interface BridgeConfigurationBase {
  provider: BridgeProviderId;
  bridgeAuthToken: string;
  contextManagement: ContextManagementSettings;
}

export interface SyntheticBridgeConfiguration
  extends BridgeConfigurationBase {
  provider: "synthetic";
  syntheticToken: string;
  syntheticSettings: SyntheticSettings;
}

export interface OpenAIApiBridgeConfiguration
  extends BridgeConfigurationBase {
  provider: "openai-api";
  openAIApiKey: string;
  openAISettings: OpenAIProviderSettings;
}

export interface OpenAICodexBridgeConfiguration
  extends BridgeConfigurationBase {
  provider: "openai-codex";
  openAISettings: OpenAIProviderSettings;
  openAIApiKey?: string;
  codexExecutable: string;
  codexWorkingDirectory: string;
}

export type BridgeConfiguration =
  | SyntheticBridgeConfiguration
  | OpenAIApiBridgeConfiguration
  | OpenAICodexBridgeConfiguration;

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
  contextWindow?: number;
}

export type BridgeRoutingSettings =
  | ModelRoutingSettings
  | OpenAIProviderSettings;
