import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { CredentialService } from "../credentials/credentialService.js";
import {
  isValidSyntheticModelId,
  MODEL_ROLES,
  type SyntheticModelSettingKey,
} from "../models/modelRouting.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import {
  mergeAliasAndApiModels,
  type SyntheticApiService,
  type SyntheticModel,
} from "../synthetic/syntheticApiService.js";
import {
  showModelQuickPick,
  showModelRoutingQuickPick,
} from "../ui/modelRoutingQuickPick.js";
import { detectProvider } from "../validation/providerDetector.js";
import {
  promptForSyntheticToken,
  setSyntheticTokenCommand,
} from "./credentialCommands.js";
import type { SwitchProviderCommand } from "./switchProviderCommand.js";

export class ModelRoutingCommand {
  public constructor(
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly credentialService: CredentialService,
    private readonly apiService: SyntheticApiService,
    private readonly switchCommand: SwitchProviderCommand,
    private readonly logger: RedactingLogger,
  ) {}

  public async execute(): Promise<void> {
    if (
      !(await this.credentialService.hasSyntheticToken()) &&
      !(await promptForSyntheticToken(this.credentialService))
    ) {
      return;
    }

    let models = await this.loadModels();
    if (!models) {
      return;
    }
    let changed = false;

    while (true) {
      const selection = await showModelRoutingQuickPick(
        this.providerRegistry.getSyntheticSettings(),
        models,
        models.filter((model) => model.source === "api").length,
      );
      if (!selection || selection === "done") {
        break;
      }
      if (selection === "refresh") {
        const refreshed = await this.loadModels();
        if (refreshed) {
          models = refreshed;
        }
        continue;
      }

      const updated = await this.configureRole(selection, models);
      changed ||= updated;
    }

    if (!changed) {
      return;
    }

    const currentProvider = detectProvider(
      this.settingsService.read().effectiveRawValue,
      this.providerRegistry.getSyntheticSettings().baseUrl,
    );
    if (currentProvider !== "synthetic") {
      await vscode.window.showInformationMessage(
        "Synthetic model routing saved. It will be applied the next time you switch to Synthetic.",
      );
      return;
    }

    const action = await vscode.window.showWarningMessage(
      "Synthetic model routing is saved. Apply it now? Cursor's extensions will restart while the editor window stays open. Active Claude Code work will stop.",
      { modal: true },
      "Apply and Restart Extensions",
      "Later",
    );
    if (action === "Apply and Restart Extensions") {
      await this.switchCommand.execute("synthetic", {
        skipConfirmation: true,
      });
    }
  }

  private async configureRole(
    settingKey: SyntheticModelSettingKey,
    models: readonly SyntheticModel[],
  ): Promise<boolean> {
    const role = MODEL_ROLES.find(
      (candidate) => candidate.settingKey === settingKey,
    );
    if (!role) {
      return false;
    }
    const current =
      this.providerRegistry.getSyntheticSettings()[settingKey];
    const selected = await showModelQuickPick(role, current, models);
    if (!selected) {
      return false;
    }
    const modelId = selected.trim();
    if (!isValidSyntheticModelId(modelId)) {
      throw new Error(
        "Synthetic model IDs must begin with syn: or hf: and cannot contain spaces.",
      );
    }
    if (modelId === current) {
      return false;
    }
    await this.providerRegistry.updateSyntheticModel(
      settingKey,
      modelId,
    );
    return true;
  }

  private async loadModels(): Promise<SyntheticModel[] | undefined> {
    try {
      return await this.apiService.listModels();
    } catch (error) {
      const message = this.logger.error(error);
      const action = await vscode.window.showWarningMessage(
        `${message} You can continue with the four documented syn: aliases.`,
        "Use Aliases Only",
        "Update Token",
      );
      if (action === "Use Aliases Only") {
        return mergeAliasAndApiModels([]);
      }
      if (action === "Update Token") {
        const stored =
          await setSyntheticTokenCommand(this.credentialService);
        if (stored) {
          return this.apiService.listModels();
        }
      }
      return undefined;
    }
  }
}
