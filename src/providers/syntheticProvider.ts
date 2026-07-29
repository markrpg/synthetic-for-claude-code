import type { ProviderProfile, SyntheticSettings } from "./types.js";

export const DEFAULT_SYNTHETIC_SETTINGS: SyntheticSettings = {
  baseUrl: "https://api.synthetic.new/anthropic",
  defaultModel: "hf:moonshotai/Kimi-K3",
  opusModel: "hf:moonshotai/Kimi-K3",
  sonnetModel: "hf:moonshotai/Kimi-K3",
  haikuModel: "hf:zai-org/GLM-4.7-Flash",
  subagentModel: "hf:moonshotai/Kimi-K3",
};

export function createSyntheticProfile(
  settings: SyntheticSettings = DEFAULT_SYNTHETIC_SETTINGS,
): ProviderProfile {
  return {
    id: "synthetic",
    label: "Synthetic — Configurable Models",
    shortLabel: "Synthetic",
    description:
      "Separate model routing for Default, Opus, Sonnet, Haiku, and subagents.",
    requiresCredential: true,
    environmentVariables: [
      { name: "ANTHROPIC_BASE_URL", value: settings.baseUrl },
      { name: "ANTHROPIC_MODEL", value: settings.defaultModel },
      {
        name: "ANTHROPIC_DEFAULT_OPUS_MODEL",
        value: settings.opusModel,
      },
      {
        name: "ANTHROPIC_DEFAULT_SONNET_MODEL",
        value: settings.sonnetModel,
      },
      {
        name: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        value: settings.haikuModel,
      },
      {
        name: "CLAUDE_CODE_SUBAGENT_MODEL",
        value: settings.subagentModel,
      },
      {
        name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        value: "1",
      },
      { name: "CLAUDE_CODE_ATTRIBUTION_HEADER", value: "0" },
    ],
  };
}

export const syntheticProfile = createSyntheticProfile();
