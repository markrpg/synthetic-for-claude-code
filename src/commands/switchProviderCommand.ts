import * as vscode from "vscode";
import type { BridgeManager } from "../bridge/bridgeManager.js";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import { readModelHopSetting } from "../configuration/modelHopConfiguration.js";
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
import type { ClaudeTranscriptRepairService } from "../transcripts/claudeTranscriptRepairService.js";
import {
  confirmProviderSwitch,
  showConflictDialog,
  showOverrideWarning,
} from "../ui/confirmationDialog.js";
import { findProviderConflicts } from "../validation/conflictDetector.js";
import { detectProvider } from "../validation/providerDetector.js";
import type { ValidationService } from "../validation/validationService.js";
import {
  promptForOpenAIApiKey,
  promptForSyntheticToken,
} from "./credentialCommands.js";

export class SwitchProviderCommand {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly credentialService: CredentialService,
    private readonly validationService: ValidationService,
    private readonly snapshotService: SnapshotService,
    private readonly reloadCoordinator: ReloadCoordinator,
    private readonly transcriptRepairService: ClaudeTranscriptRepairService,
    private readonly logger: RedactingLogger,
    private readonly bridgeManager?: BridgeManager,
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
      this.bridgeManager?.getBaseUrl(),
    );
    const profile = this.providerRegistry.getProfile(providerId);
    if (
      providerId === "synthetic" &&
      !(await this.credentialService.hasSyntheticToken()) &&
      !(await promptForSyntheticToken(this.credentialService))
    ) {
      return;
    }
    if (
      providerId === "openai-api" &&
      !(await this.credentialService.hasOpenAIApiKey()) &&
      !(await promptForOpenAIApiKey(this.credentialService))
    ) {
      return;
    }
    if (currentProvider === "anthropic" && providerId !== "anthropic") {
      const anthropicApiKey = configuration.global.variables.find(
        (variable) => variable.name === "ANTHROPIC_API_KEY",
      )?.value;
      await this.credentialService.rememberAnthropicApiKey(
        anthropicApiKey,
      );
    }
    let targetVariables =
      await this.providerRegistry.buildEnvironment(providerId);
    const preserveShared = readModelHopSetting(
      "preserveSharedPreferences",
      true,
      "preserveSharedPreferences",
    );
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
      providerId === "openai-api" || providerId === "openai-codex"
        ? this.providerRegistry.getOpenAISettings(providerId)
        : undefined,
    );

    if (
      environmentVariablesEqual(
        candidateVariables,
        configuration.global.variables,
      )
    ) {
      if (providerId !== "anthropic" && this.bridgeManager) {
        await this.bridgeManager.prepare(
          providerId,
          providerId === "synthetic"
            ? this.providerRegistry.getSyntheticSettings()
            : this.providerRegistry.getOpenAISettings(providerId),
        );
      }
      const overrideNote = continuedPastOverride
        ? " The workspace override remains effective."
        : "";
      await vscode.window.showInformationMessage(
        `${profile.shortLabel} is already configured globally.${overrideNote}`,
      );
      return;
    }

    const shouldConfirm = readModelHopSetting(
      "confirmBeforeReload",
      true,
      "confirmBeforeReload",
    );
    if (
      !options.skipConfirmation &&
      shouldConfirm &&
      !(await confirmProviderSwitch(currentProvider, profile))
    ) {
      return;
    }

    if (providerId !== "anthropic" && this.bridgeManager) {
      await this.bridgeManager.prepare(
        providerId,
        providerId === "synthetic"
          ? this.providerRegistry.getSyntheticSettings()
          : this.providerRegistry.getOpenAISettings(providerId),
      );
    }
    if (
      providerId === "anthropic" &&
      (currentProvider === "synthetic" ||
        currentProvider === "openai-api" ||
        currentProvider === "openai-codex")
    ) {
      await this.bridgeManager?.deactivate();
    }

    const repairConversationHistory = readModelHopSetting(
      "repairConversationHistory",
      true,
      "repairConversationHistory",
    );
    if (
      currentProvider !== providerId &&
      repairConversationHistory
    ) {
      const transcriptRepair =
        await this.transcriptRepairService.repairWorkspaceTranscripts(
          (vscode.workspace.workspaceFolders ?? []).map(
            (folder) => folder.uri.fsPath,
          ),
        );
      if (transcriptRepair.filesChanged > 0) {
        this.logger.info(
          `Repaired ${transcriptRepair.filesChanged} Claude conversation transcript(s) for Anthropic compatibility`,
        );
      }
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
            targetProvider === "openai-api" ||
              targetProvider === "openai-codex"
              ? this.providerRegistry.getOpenAISettings(targetProvider)
              : undefined,
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
              previousProvider === "anthropic" ||
              previousProvider === "openai-api" ||
              previousProvider === "openai-codex"
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
          this.logger.info("Full editor window reload requested");
          await this.reloadCoordinator.reloadWindow();
        },
      },
    );
  }
}
