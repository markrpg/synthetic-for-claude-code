export type ProviderId =
  | "anthropic"
  | "synthetic"
  | "openai-api"
  | "openai-codex";

export type DetectedProvider =
  | "synthetic"
  | "anthropic"
  | "openai-api"
  | "openai-codex"
  | "custom"
  | "invalid";

export type ClaudeModelRole =
  | "default"
  | "opus"
  | "sonnet"
  | "haiku"
  | "subagent";

export type OpenAIReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface EnvironmentVariable {
  name: string;
  value: string;
}

export interface ProviderProfile {
  id: ProviderId;
  label: string;
  shortLabel: string;
  description: string;
  requiresCredential: boolean;
  experimental?: boolean;
  environmentVariables: EnvironmentVariable[];
}

export interface ModelRoutingSettings {
  baseUrl: string;
  defaultModel: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  subagentModel: string;
}

export type SyntheticSettings = ModelRoutingSettings;

export interface OpenAIProviderSettings extends ModelRoutingSettings {
  defaultReasoningEffort: OpenAIReasoningEffort;
  opusReasoningEffort: OpenAIReasoningEffort;
  sonnetReasoningEffort: OpenAIReasoningEffort;
  haikuReasoningEffort: OpenAIReasoningEffort;
  subagentReasoningEffort: OpenAIReasoningEffort;
}
