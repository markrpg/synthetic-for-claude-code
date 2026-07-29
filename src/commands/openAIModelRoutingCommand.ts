import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import {
  MODEL_ROLES,
  type ModelSettingKey,
} from "../models/modelRouting.js";
import type {
  OpenAIModel,
  OpenAIModelService,
} from "../openai/openAIModelService.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { ProviderId } from "../providers/types.js";
import {
  showOpenAIModelQuickPick,
  showOpenAIRoutingQuickPick,
  showReasoningEffortQuickPick,
} from "../ui/openAIModelRoutingQuickPick.js";
import { detectProvider } from "../validation/providerDetector.js";
import type { SwitchProviderCommand } from "./switchProviderCommand.js";

export class OpenAIModelRoutingCommand {
  public constructor(
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly modelService: OpenAIModelService,
    private readonly switchCommand: SwitchProviderCommand,
    private readonly getBridgeBaseUrl: () => string,
    private readonly logger: RedactingLogger,
  ) {}

  public async execute(
    providerId: Extract<ProviderId, "openai-api" | "openai-codex">,
    suppliedModels?: readonly OpenAIModel[],
  ): Promise<void> {
    const models =
      suppliedModels ??
      (providerId === "openai-api"
        ? await this.loadApiModels()
        : []);
    if (!models) {
      return;
    }
    let changed = false;
    while (true) {
      const settings = this.providerRegistry.getOpenAISettings(providerId);
      const selection = await showOpenAIRoutingQuickPick(
        providerId === "openai-api"
          ? "Configure OpenAI API Models"
          : "Configure ChatGPT/Codex Models — Experimental",
        settings,
      );
      if (!selection || selection === "done") {
        break;
      }
      changed ||= await this.configureRole(
        providerId,
        selection,
        models,
      );
    }
    if (!changed) {
      return;
    }

    const current = detectProvider(
      this.settingsService.read().effectiveRawValue,
      this.providerRegistry.getSyntheticSettings().baseUrl,
      this.getBridgeBaseUrl(),
    );
    if (current !== providerId) {
      await vscode.window.showInformationMessage(
        "Model routing saved. It will apply the next time this provider is selected.",
      );
      return;
    }
    await this.switchCommand.execute(providerId, {
      skipConfirmation: true,
    });
  }

  private async configureRole(
    providerId: Extract<ProviderId, "openai-api" | "openai-codex">,
    settingKey: ModelSettingKey,
    models: readonly OpenAIModel[],
  ): Promise<boolean> {
    const role = MODEL_ROLES.find((item) => item.settingKey === settingKey);
    if (!role) {
      return false;
    }
    const settings = this.providerRegistry.getOpenAISettings(providerId);
    const selectedModel = await showOpenAIModelQuickPick(
      role,
      settings[settingKey],
      models,
    );
    if (!selectedModel) {
      return false;
    }
    const model = models.find((item) => item.id === selectedModel);
    const effort = await showReasoningEffortQuickPick(
      model,
      settings[role.reasoningSettingKey],
    );
    if (!effort) {
      return false;
    }
    if (
      selectedModel === settings[settingKey] &&
      effort === settings[role.reasoningSettingKey]
    ) {
      return false;
    }
    await this.providerRegistry.updateOpenAIRoute(
      providerId,
      settingKey,
      selectedModel,
      effort,
    );
    return true;
  }

  private async loadApiModels(): Promise<OpenAIModel[] | undefined> {
    try {
      return await this.modelService.listModels();
    } catch (error) {
      const action = await vscode.window.showWarningMessage(
        `${this.logger.error(error)} You can still configure a model ID manually.`,
        "Use Defaults",
      );
      return action === "Use Defaults" ? [] : undefined;
    }
  }
}
