import type { ProviderProfile } from "./types.js";

export const anthropicProfile: ProviderProfile = {
  id: "anthropic",
  label: "Anthropic — Native Claude",
  shortLabel: "Anthropic",
  description: "Use Claude Code's native Anthropic authentication.",
  requiresCredential: false,
  environmentVariables: [
    {
      name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      value: "1",
    },
    {
      name: "CLAUDE_CODE_ATTRIBUTION_HEADER",
      value: "0",
    },
  ],
};
