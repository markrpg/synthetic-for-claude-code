import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ReloadCoordinator } from "../reload/reloadCoordinator.js";
import type { SnapshotService } from "../snapshots/snapshotService.js";
import { showOverrideWarning } from "../ui/confirmationDialog.js";

export async function restoreCommand(
  settingsService: ClaudeSettingsService,
  snapshotService: SnapshotService,
  reloadCoordinator: ReloadCoordinator,
  logger: RedactingLogger,
): Promise<void> {
  const snapshot = await snapshotService.getLastKnownGood();
  if (!snapshot) {
    await vscode.window.showInformationMessage(
      "No previous Claude Code configuration snapshot is available.",
    );
    return;
  }

  const current = settingsService.read();
  let continuedPastOverride = false;
  if (current.overrideScopes.length > 0) {
    const decision = await showOverrideWarning(current.overrideScopes);
    if (decision === "open-settings") {
      await settingsService.openWorkspaceSettings();
      return;
    }
    if (decision === "cancel") {
      return;
    }
    continuedPastOverride = true;
  }

  const action = await vscode.window.showWarningMessage(
    "Restore Claude Code environment settings from the snapshot created before the last provider switch? Cursor must reload, and active Claude Code work will stop.",
    { modal: true },
    "Restore and Reload Window",
  );
  if (action !== "Restore and Reload Window") {
    return;
  }

  const rollbackSnapshot = snapshotService.capture(
    current.global.variables,
  );
  try {
    await settingsService.write(snapshot.environmentVariables);
    settingsService.verifyWritten(snapshot.environmentVariables);
    await snapshotService.saveLastKnownGood(rollbackSnapshot);
    await reloadCoordinator.markPending({
      provider: snapshot.detectedProvider,
      switchedAt: Date.now(),
      reason: "restore",
      workspaceOverride: continuedPastOverride,
    });
    logger.info("Previous configuration restored");
    logger.info("Full editor window reload requested");
    await reloadCoordinator.reloadWindow();
  } catch (error) {
    let rollbackError: unknown;
    try {
      await settingsService.write(
        rollbackSnapshot.environmentVariables,
      );
      settingsService.verifyWritten(
        rollbackSnapshot.environmentVariables,
      );
    } catch (failure) {
      rollbackError = failure;
    }
    try {
      await reloadCoordinator.clearPending();
    } catch (failure) {
      rollbackError ??= failure;
    }
    if (rollbackError !== undefined) {
      throw new Error(
        "Restoring the previous configuration failed, and the current configuration could not be recovered automatically.",
        { cause: error },
      );
    }
    throw error;
  }
}
