import type { ProviderProfile } from "./types.js";

export const anthropicProfile: ProviderProfile = {
  id: "anthropic",
  label: "Anthropic — Native Claude",
  shortLabel: "Anthropic",
  description: "Use Claude Code's native Anthropic authentication.",
  requiresCredential: false,
  environmentVariables: [],
};
