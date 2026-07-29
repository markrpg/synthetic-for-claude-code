import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import {
  environmentVariablesEqual,
  mergeEnvironmentVariables,
  preserveExistingSharedVariables,
} from "../configuration/mergeEnvironmentVariables.js";
import { applySwitchTransaction } from "../core/switchTransaction.js";
import type { CredentialService } from "../credentials/credentialService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { ProviderId } from "../providers/types.js";
import type { ReloadCoordinator } from "../reload/reloadCoordinator.js";
import type { SnapshotService } from "../snapshots/snapshotService.js";
import {
  confirmProviderSwitch,
  showConflictDialog,
  showOverrideWarning,
} from "../ui/confirmationDialog.js";
import { findProviderConflicts } from "../validation/conflictDetector.js";
import { detectProvider } from "../validation/providerDetector.js";
import type { ValidationService } from "../validation/validationService.js";
import { promptForSyntheticToken } from "./credentialCommands.js";

export class SwitchProviderCommand {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly credentialService: CredentialService,
    private readonly validationService: ValidationService,
    private readonly snapshotService: SnapshotService,
    private readonly reloadCoordinator: ReloadCoordinator,
    private readonly logger: RedactingLogger,
  ) {}

  public async execute(
    providerId: ProviderId,
    options: { skipConfirmation?: boolean } = {},
  ): Promise<void> {
    const configuration = this.settingsService.read();
    if (
      configuration.global.containerWasMalformed ||
      configuration.global.malformedEntries.length > 0
    ) {
      const action = await vscode.window.showErrorMessage(
        "The global Claude Code environment setting is malformed. Fix it before switching providers so no entries are lost.",
        "Open Settings",
      );
      if (action === "Open Settings") {
        await this.settingsService.openGlobalSettings();
      }
      return;
    }

    let continuedPastOverride = false;
    if (configuration.overrideScopes.length > 0) {
      const decision = await showOverrideWarning(
        configuration.overrideScopes,
      );
      if (decision === "open-settings") {
        await this.settingsService.openWorkspaceSettings();
        return;
      }
      if (decision === "cancel") {
        return;
      }
      continuedPastOverride = true;
    }

    const conflicts = findProviderConflicts(
      configuration.effective.variables,
    );
    if (conflicts.length > 0) {
      const decision = await showConflictDialog(conflicts);
      if (decision === "open-settings") {
        if (configuration.overrideScopes.length > 0) {
          await this.settingsService.openWorkspaceSettings();
        } else {
          await this.settingsService.openGlobalSettings();
        }
      }
      return;
    }

    const currentProvider = detectProvider(
      configuration.effectiveRawValue,
      this.providerRegistry.getSyntheticSettings().baseUrl,
    );
    const profile = this.providerRegistry.getProfile(providerId);
    if (
      providerId === "synthetic" &&
      !(await this.credentialService.hasSyntheticToken()) &&
      !(await promptForSyntheticToken(this.credentialService))
    ) {
      return;
    }
    if (currentProvider === "anthropic" && providerId === "synthetic") {
      const anthropicApiKey = configuration.global.variables.find(
        (variable) => variable.name === "ANTHROPIC_API_KEY",
      )?.value;
      await this.credentialService.rememberAnthropicApiKey(
        anthropicApiKey,
      );
    }
    let targetVariables =
      await this.providerRegistry.buildEnvironment(providerId);
    const preserveShared = vscode.workspace
      .getConfiguration("claudeProvider")
      .get("preserveSharedPreferences", true);
    if (preserveShared) {
      targetVariables = preserveExistingSharedVariables(
        configuration.global.variables,
        targetVariables,
      );
    }

    const candidateVariables = mergeEnvironmentVariables(
      configuration.global.variables,
      targetVariables,
    );
    this.validationService.validateVariables(
      providerId,
      candidateVariables,
      this.providerRegistry.getSyntheticSettings(),
    );

    if (
      environmentVariablesEqual(
        candidateVariables,
        configuration.global.variables,
      )
    ) {
      const overrideNote = continuedPastOverride
        ? " The workspace override remains effective."
        : "";
      await vscode.window.showInformationMessage(
        `${profile.shortLabel} is already configured globally.${overrideNote}`,
      );
      return;
    }

    const shouldConfirm = vscode.workspace
      .getConfiguration("claudeProvider")
      .get("confirmBeforeReload", true);
    if (
      !options.skipConfirmation &&
      shouldConfirm &&
      !(await confirmProviderSwitch(currentProvider, profile))
    ) {
      return;
    }

    const previousProvider = currentProvider;
    await applySwitchTransaction(
      providerId,
      configuration.global.variables,
      targetVariables,
      {
        capture: (variables) => this.snapshotService.capture(variables),
        write: async (variables) => {
          await this.settingsService.write(variables);
        },
        verify: (targetProvider, variables) => {
          this.settingsService.verifyWritten(variables);
          this.validationService.validateVariables(
            targetProvider,
            this.settingsService.read().globalRawValue,
            this.providerRegistry.getSyntheticSettings(),
          );
        },
        saveLastKnownGood: async (snapshot) => {
          await this.snapshotService.saveLastKnownGood(snapshot);
        },
        restore: async (snapshot) => {
          await this.settingsService.write(
            snapshot.environmentVariables,
          );
          this.settingsService.verifyWritten(
            snapshot.environmentVariables,
          );
        },
        updateActiveProvider: async (activeProvider) => {
          await this.context.globalState.update(
            "claudeProvider.activeProvider",
            activeProvider,
          );
        },
        clearActiveProvider: async () => {
          await this.context.globalState.update(
            "claudeProvider.activeProvider",
            previousProvider === "synthetic" ||
              previousProvider === "anthropic"
              ? previousProvider
              : undefined,
          );
        },
        markPendingReload: async (activeProvider) => {
          await this.reloadCoordinator.markPending({
            provider: activeProvider,
            switchedAt: Date.now(),
            reason: "switch",
            workspaceOverride: continuedPastOverride,
          });
        },
        clearPendingReload: async () => {
          await this.reloadCoordinator.clearPending();
        },
        reload: async () => {
          this.logger.info("Configuration verification passed");
          this.logger.info("Extension host restart requested");
          await this.reloadCoordinator.restartExtensionHost();
        },
      },
    );
  }
}
