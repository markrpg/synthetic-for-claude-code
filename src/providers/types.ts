export type ProviderId = "synthetic" | "anthropic";

export type DetectedProvider =
  | "synthetic"
  | "anthropic"
  | "custom"
  | "invalid";

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
  environmentVariables: EnvironmentVariable[];
}

export interface SyntheticSettings {
  baseUrl: string;
  defaultModel: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  subagentModel: string;
}
