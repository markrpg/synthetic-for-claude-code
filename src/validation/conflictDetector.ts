import { CONFLICT_KEY_NAMES } from "../configuration/managedKeys.js";
import type { EnvironmentVariable } from "../providers/types.js";

export interface ProviderConflict {
  key: (typeof CONFLICT_KEY_NAMES)[number];
  providerLabel: string;
}

const CONFLICT_LABELS: Record<
  (typeof CONFLICT_KEY_NAMES)[number],
  string
> = {
  CLAUDE_CODE_USE_BEDROCK: "Amazon Bedrock",
  CLAUDE_CODE_USE_VERTEX: "Google Vertex AI",
  CLAUDE_CODE_USE_FOUNDRY: "Microsoft Foundry",
};

function isEnabled(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function findProviderConflicts(
  variables: readonly EnvironmentVariable[],
): ProviderConflict[] {
  const enabled = new Set(
    variables
      .filter((variable) => isEnabled(variable.value))
      .map((variable) => variable.name),
  );

  return CONFLICT_KEY_NAMES.filter((key) => enabled.has(key)).map((key) => ({
    key,
    providerLabel: CONFLICT_LABELS[key],
  }));
}
