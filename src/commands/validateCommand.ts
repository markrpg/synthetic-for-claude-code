import * as vscode from "vscode";
import {
  MANAGED_KEYS,
  SECRET_ENVIRONMENT_KEYS,
} from "../configuration/managedKeys.js";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import { detectProvider } from "../validation/providerDetector.js";
import type { ValidationService } from "../validation/validationService.js";

export async function validateCommand(
  settingsService: ClaudeSettingsService,
  providerRegistry: ProviderRegistry,
  validationService: ValidationService,
): Promise<void> {
  const configuration = settingsService.read();
  const provider = detectProvider(
    configuration.effectiveRawValue,
    providerRegistry.getSyntheticSettings().baseUrl,
  );
  if (provider === "invalid") {
    throw new Error(
      "Claude Code environment variables contain a malformed entry or invalid provider URL.",
    );
  }
  if (provider === "custom") {
    if (
      configuration.effective.containerWasMalformed ||
      configuration.effective.malformedEntries.length > 0
    ) {
      throw new Error("The custom gateway configuration is malformed.");
    }
    await vscode.window.showInformationMessage(
      "Claude Code is using a structurally valid custom gateway. Custom gateways are not managed by this extension.",
    );
    return;
  }

  validationService.validateVariables(
    provider,
    configuration.effectiveRawValue,
    providerRegistry.getSyntheticSettings(),
  );
  await vscode.window.showInformationMessage(
    `Claude Code ${provider === "synthetic" ? "Synthetic" : "Anthropic"} configuration is valid.`,
  );
}

export function showEffectiveConfiguration(
  settingsService: ClaudeSettingsService,
  providerRegistry: ProviderRegistry,
  logger: RedactingLogger,
): void {
  const configuration = settingsService.read();
  const provider = detectProvider(
    configuration.effectiveRawValue,
    providerRegistry.getSyntheticSettings().baseUrl,
  );
  const managed = configuration.effective.variables.filter((variable) =>
    MANAGED_KEYS.has(variable.name),
  );
  const unrelatedNames = configuration.effective.variables
    .filter((variable) => !managed.includes(variable))
    .map((variable) => variable.name);

  logger.info(`Detected provider: ${provider}`);
  logger.info(
    `Configuration scope: ${
      configuration.overrideScopes.length > 0
        ? configuration.overrideScopes.join(", ")
        : "global/default"
    }`,
  );
  for (const variable of managed) {
    const value = SECRET_ENVIRONMENT_KEYS.has(variable.name)
      ? "[REDACTED]"
      : variable.value;
    logger.info(`${variable.name}=${value}`);
  }
  logger.info(
    `Unrelated variables preserved: ${
      unrelatedNames.length > 0 ? unrelatedNames.join(", ") : "none"
    }`,
  );
  logger.show();
}
