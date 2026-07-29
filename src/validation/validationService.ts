import {
  findDuplicateManagedKeys,
  normaliseEnvironmentVariables,
} from "../configuration/mergeEnvironmentVariables.js";
import { PROVIDER_KEY_NAMES } from "../configuration/managedKeys.js";
import type {
  EnvironmentVariable,
  ProviderId,
  SyntheticSettings,
} from "../providers/types.js";
import { findProviderConflicts } from "./conflictDetector.js";

export class ConfigurationValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Claude Code configuration is invalid: ${issues.join(" ")}`);
    this.name = "ConfigurationValidationError";
  }
}

const SYNTHETIC_EXPECTATIONS: ReadonlyArray<
  readonly [keyof SyntheticSettings, string]
> = [
  ["baseUrl", "ANTHROPIC_BASE_URL"],
  ["defaultModel", "ANTHROPIC_MODEL"],
  ["opusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["sonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["haikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
  ["subagentModel", "CLAUDE_CODE_SUBAGENT_MODEL"],
];

export class ValidationService {
  public validateVariables(
    providerId: ProviderId,
    rawVariables: unknown,
    syntheticSettings: SyntheticSettings,
  ): EnvironmentVariable[] {
    const issues: string[] = [];
    const normalised = normaliseEnvironmentVariables(rawVariables);
    const variables = normalised.variables;

    if (
      normalised.containerWasMalformed ||
      normalised.malformedEntries.length > 0
    ) {
      issues.push(
        "Every environment-variable entry must contain string name and value fields.",
      );
    }

    const duplicates = findDuplicateManagedKeys(variables);
    if (duplicates.length > 0) {
      issues.push(`Duplicate managed keys: ${duplicates.join(", ")}.`);
    }

    const conflicts = findProviderConflicts(variables);
    if (conflicts.length > 0) {
      issues.push(
        `Conflicting Claude platform selection: ${conflicts
          .map((conflict) => conflict.providerLabel)
          .join(", ")}.`,
      );
    }

    if (providerId === "synthetic") {
      this.validateSynthetic(variables, syntheticSettings, issues);
    } else {
      this.validateAnthropic(variables, issues);
    }

    if (issues.length > 0) {
      throw new ConfigurationValidationError(issues);
    }

    return variables;
  }

  private validateSynthetic(
    variables: readonly EnvironmentVariable[],
    expected: SyntheticSettings,
    issues: string[],
  ): void {
    const values = new Map(
      variables.map((variable) => [variable.name, variable.value]),
    );
    const baseUrl = values.get("ANTHROPIC_BASE_URL");

    if (baseUrl) {
      try {
        if (new URL(baseUrl).protocol !== "https:") {
          issues.push("Synthetic base URL must use HTTPS.");
        }
      } catch {
        issues.push("Synthetic base URL must be a valid URL.");
      }
    }

    for (const [settingKey, environmentKey] of SYNTHETIC_EXPECTATIONS) {
      const expectedValue = expected[settingKey];
      if (!expectedValue.trim()) {
        issues.push(`The configured ${environmentKey} target is empty.`);
      } else if (values.get(environmentKey) !== expectedValue) {
        issues.push(`${environmentKey} does not match the configured profile.`);
      }
    }

    if (!values.get("ANTHROPIC_AUTH_TOKEN")?.trim()) {
      issues.push("ANTHROPIC_AUTH_TOKEN is missing or empty.");
    }

    if (values.has("ANTHROPIC_API_KEY")) {
      issues.push(
        "ANTHROPIC_API_KEY must be removed when Synthetic token authentication is active.",
      );
    }
  }

  private validateAnthropic(
    variables: readonly EnvironmentVariable[],
    issues: string[],
  ): void {
    const presentKeys = new Set(variables.map((variable) => variable.name));
    const staleKeys = PROVIDER_KEY_NAMES.filter((key) => presentKeys.has(key));

    if (staleKeys.length > 0) {
      issues.push(
        `Native Anthropic must not contain provider overrides: ${staleKeys.join(
          ", ",
        )}.`,
      );
    }
  }
}
