import type { SyntheticSettings } from "../providers/types.js";

export type SyntheticModelSettingKey = Exclude<
  keyof SyntheticSettings,
  "baseUrl"
>;

export interface ModelRole {
  settingKey: SyntheticModelSettingKey;
  label: string;
  environmentKey: string;
  description: string;
}

export const MODEL_ROLES: readonly ModelRole[] = [
  {
    settingKey: "defaultModel",
    label: "Default",
    environmentKey: "ANTHROPIC_MODEL",
    description: "Claude Code's default model when no family is specified.",
  },
  {
    settingKey: "opusModel",
    label: "Opus",
    environmentKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    description: "Used when Claude Code requests the Opus model family.",
  },
  {
    settingKey: "sonnetModel",
    label: "Sonnet",
    environmentKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    description: "Used when Claude Code requests the Sonnet model family.",
  },
  {
    settingKey: "haikuModel",
    label: "Haiku",
    environmentKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    description:
      "Used for Haiku-family work such as fast tasks and summarization.",
  },
  {
    settingKey: "subagentModel",
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
