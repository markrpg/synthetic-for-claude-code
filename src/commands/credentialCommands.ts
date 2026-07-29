import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { CredentialService } from "../credentials/credentialService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ReloadCoordinator } from "../reload/reloadCoordinator.js";

export async function setSyntheticTokenCommand(
  credentialService: CredentialService,
): Promise<boolean> {
  const stored = await promptForSyntheticToken(credentialService);
  if (stored) {
    await vscode.window.showInformationMessage(
      "Synthetic API token saved.",
    );
  }
  return stored;
}

export async function promptForSyntheticToken(
  credentialService: CredentialService,
): Promise<boolean> {
  const token = await vscode.window.showInputBox({
    title: "Synthetic API Token",
    prompt:
      "Paste your token. It is stored in Cursor SecretStorage and copied to Claude Code settings while Synthetic is active.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? undefined : "The token cannot be empty.",
  });
  if (token === undefined) {
    return false;
  }

  await credentialService.setSyntheticToken(token);
  return true;
}

export async function clearSyntheticTokenCommand(
  credentialService: CredentialService,
  settingsService: ClaudeSettingsService,
  reloadCoordinator: ReloadCoordinator,
  logger: RedactingLogger,
): Promise<void> {
  const configuration = settingsService.read();
  const configuredToken = configuration.global.variables.find(
    (variable) => variable.name === "ANTHROPIC_AUTH_TOKEN",
  )?.value;
  if (configuredToken) {
    logger.registerSecret(configuredToken);
  }
  const tokenIsInGlobalSettings = configuration.global.variables.some(
    (variable) => variable.name === "ANTHROPIC_AUTH_TOKEN",
  );

  if (!tokenIsInGlobalSettings) {
    await credentialService.clearSyntheticToken();
    await vscode.window.showInformationMessage(
      "Stored Synthetic API token cleared.",
    );
    return;
  }

  const action = await vscode.window.showWarningMessage(
    "Clear the Synthetic token from SecretStorage and global Claude Code settings? Cursor must reload, and Synthetic authentication will stop.",
    { modal: true },
    "Clear and Reload",
  );
  if (action !== "Clear and Reload") {
    return;
  }

  const withoutToken = configuration.global.variables.filter(
    (variable) => variable.name !== "ANTHROPIC_AUTH_TOKEN",
  );
  await settingsService.write(withoutToken);
  settingsService.verifyWritten(withoutToken);
  await credentialService.clearSyntheticToken();
  await reloadCoordinator.markPending({
    provider: "invalid",
    switchedAt: Date.now(),
    reason: "restore",
    workspaceOverride: configuration.overrideScopes.length > 0,
  });
  await reloadCoordinator.reloadWindow();
}
