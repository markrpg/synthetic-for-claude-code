import type {
  ModelRoutingSettings,
  OpenAIReasoningEffort,
} from "../providers/types.js";

export type ModelSettingKey = Exclude<
  keyof ModelRoutingSettings,
  "baseUrl"
>;
export type SyntheticModelSettingKey = ModelSettingKey;

export interface ModelRole {
  settingKey: ModelSettingKey;
  reasoningSettingKey:
    | "defaultReasoningEffort"
    | "opusReasoningEffort"
    | "sonnetReasoningEffort"
    | "haikuReasoningEffort"
    | "subagentReasoningEffort";
  label: string;
  environmentKey: string;
  description: string;
}

export const MODEL_ROLES: readonly ModelRole[] = [
  {
    settingKey: "defaultModel",
    reasoningSettingKey: "defaultReasoningEffort",
    label: "Default",
    environmentKey: "ANTHROPIC_MODEL",
    description: "Claude Code's default model when no family is specified.",
  },
  {
    settingKey: "opusModel",
    reasoningSettingKey: "opusReasoningEffort",
    label: "Opus",
    environmentKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    description: "Used when Claude Code requests the Opus model family.",
  },
  {
    settingKey: "sonnetModel",
    reasoningSettingKey: "sonnetReasoningEffort",
    label: "Sonnet",
    environmentKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    description: "Used when Claude Code requests the Sonnet model family.",
  },
  {
    settingKey: "haikuModel",
    reasoningSettingKey: "haikuReasoningEffort",
    label: "Haiku",
    environmentKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    description:
      "Used for Haiku-family work such as fast tasks and summarization.",
  },
  {
    settingKey: "subagentModel",
    reasoningSettingKey: "subagentReasoningEffort",
    label: "Subagents",
    environmentKey: "CLAUDE_CODE_SUBAGENT_MODEL",
    description: "Used for Claude Code subagents.",
  },
];

export function isValidSyntheticModelId(value: string): boolean {
  const id = value.trim();
  return (
    (id.startsWith("syn:") || id.startsWith("hf:")) &&
    id.length > 4 &&
    !/\s/.test(id)
  );
}

export function isValidOpenAIModelId(value: string): boolean {
  const id = value.trim();
  return id.length > 1 && id.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(id);
}

export const OPENAI_REASONING_EFFORTS: readonly OpenAIReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
