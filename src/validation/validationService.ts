import {
  findDuplicateManagedKeys,
  normaliseEnvironmentVariables,
} from "../configuration/mergeEnvironmentVariables.js";
import { PROVIDER_KEY_NAMES } from "../configuration/managedKeys.js";
import type {
  EnvironmentVariable,
  OpenAIProviderSettings,
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
    openAISettings?: OpenAIProviderSettings,
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

    switch (providerId) {
      case "synthetic":
        this.validateSynthetic(variables, syntheticSettings, issues);
        break;
      case "openai-api":
      case "openai-codex":
        this.validateOpenAI(
          providerId,
          variables,
          openAISettings,
          issues,
        );
        break;
      case "anthropic":
        this.validateAnthropic(variables, issues);
        break;
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

    if (!baseUrl) {
      issues.push("ANTHROPIC_BASE_URL is missing.");
    } else {
      try {
        const url = new URL(baseUrl);
        const isConfiguredUpstream =
          url.toString().replace(/\/$/, "") ===
          new URL(expected.baseUrl).toString().replace(/\/$/, "");
        const isModelHopBridge =
          url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" ||
            url.hostname === "localhost") &&
          values.get("MODELHOP_PROVIDER") === "synthetic";
        if (!isConfiguredUpstream && !isModelHopBridge) {
          issues.push(
            "Synthetic must use its configured HTTPS endpoint or the ModelHop loopback bridge.",
          );
        }
      } catch {
        issues.push("Synthetic base URL must be a valid URL.");
      }
    }

    for (const [settingKey, environmentKey] of SYNTHETIC_EXPECTATIONS) {
      if (settingKey === "baseUrl") {
        continue;
      }
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
    if (
      values.has("MODELHOP_PROVIDER") &&
      values.get("MODELHOP_PROVIDER") !== "synthetic"
    ) {
      issues.push("MODELHOP_PROVIDER does not match Synthetic.");
    }
  }

  private validateAnthropic(
    variables: readonly EnvironmentVariable[],
    issues: string[],
  ): void {
    const presentKeys = new Set(variables.map((variable) => variable.name));
    const staleKeys = PROVIDER_KEY_NAMES.filter(
      (key) => key !== "ANTHROPIC_API_KEY" && presentKeys.has(key),
    );

    if (staleKeys.length > 0) {
      issues.push(
        `Native Anthropic must not contain provider overrides: ${staleKeys.join(
          ", ",
        )}.`,
      );
    }
  }

  private validateOpenAI(
    providerId: Extract<ProviderId, "openai-api" | "openai-codex">,
    variables: readonly EnvironmentVariable[],
    expected: OpenAIProviderSettings | undefined,
    issues: string[],
  ): void {
    if (!expected) {
      issues.push("OpenAI provider settings were not supplied for validation.");
      return;
    }
    const values = new Map(
      variables.map((variable) => [variable.name, variable.value]),
    );
    const baseUrl = values.get("ANTHROPIC_BASE_URL");
    if (!baseUrl) {
      issues.push("ANTHROPIC_BASE_URL is missing.");
    } else {
      try {
        const url = new URL(baseUrl);
        if (
          url.protocol !== "http:" ||
          (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
        ) {
          issues.push("The ModelHop bridge must use a loopback HTTP URL.");
        }
      } catch {
        issues.push("The ModelHop bridge URL is invalid.");
      }
    }

    const routeExpectations: ReadonlyArray<
      readonly [keyof SyntheticSettings, string]
    > = SYNTHETIC_EXPECTATIONS;
    for (const [settingKey, environmentKey] of routeExpectations) {
      if (values.get(environmentKey) !== expected[settingKey]) {
        issues.push(`${environmentKey} does not match the configured profile.`);
      }
    }
    if (!values.get("ANTHROPIC_AUTH_TOKEN")?.trim()) {
      issues.push("The local bridge authentication token is missing.");
    }
    if (values.has("ANTHROPIC_API_KEY")) {
      issues.push(
        "ANTHROPIC_API_KEY must not be exposed while a ModelHop bridge is active.",
      );
    }
    if (values.get("MODELHOP_PROVIDER") !== providerId) {
      issues.push("MODELHOP_PROVIDER does not match the selected provider.");
    }
  }
}
