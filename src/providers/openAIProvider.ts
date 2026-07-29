import type {
  OpenAIProviderSettings,
  ProviderId,
  ProviderProfile,
} from "./types.js";

export const DEFAULT_OPENAI_SETTINGS: OpenAIProviderSettings = {
  baseUrl: "",
  defaultModel: "gpt-5.6-sol",
  opusModel: "gpt-5.6-sol",
  sonnetModel: "gpt-5.6-terra",
  haikuModel: "gpt-5.6-luna",
  subagentModel: "gpt-5.6-terra",
  defaultReasoningEffort: "high",
  opusReasoningEffort: "high",
  sonnetReasoningEffort: "medium",
  haikuReasoningEffort: "low",
  subagentReasoningEffort: "medium",
};

export function createOpenAIProfile(
  providerId: Extract<ProviderId, "openai-api" | "openai-codex">,
  settings: OpenAIProviderSettings,
): ProviderProfile {
  const codex = providerId === "openai-codex";
  return {
    id: providerId,
    label: codex
      ? "OpenAI via ChatGPT/Codex — Experimental"
      : "OpenAI API — GPT models",
    shortLabel: codex ? "OpenAI via Codex" : "OpenAI API",
    description: codex
      ? "Use a ChatGPT/Codex subscription through a managed local Codex runtime."
      : "Use an OpenAI API key through the local Anthropic compatibility bridge.",
    requiresCredential: true,
    experimental: codex,
    environmentVariables: [
      { name: "ANTHROPIC_BASE_URL", value: settings.baseUrl },
      { name: "MODELHOP_PROVIDER", value: providerId },
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
