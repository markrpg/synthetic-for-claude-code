import {
  readModelHopSetting,
  updateModelHopSetting,
} from "../configuration/modelHopConfiguration.js";
import type { CredentialService } from "../credentials/credentialService.js";
import {
  MODEL_ROLES,
  type ModelSettingKey,
} from "../models/modelRouting.js";
import { anthropicProfile } from "./anthropicProvider.js";
import {
  createOpenAIProfile,
  DEFAULT_OPENAI_SETTINGS,
} from "./openAIProvider.js";
import {
  createSyntheticProfile,
  DEFAULT_SYNTHETIC_SETTINGS,
} from "./syntheticProvider.js";
import type {
  EnvironmentVariable,
  OpenAIProviderSettings,
  OpenAIReasoningEffort,
  ProviderId,
  ProviderProfile,
  SyntheticSettings,
} from "./types.js";

export class ProviderRegistry {
  public constructor(
    private readonly credentialService: CredentialService,
    private readonly getBridgeBaseUrl: () => string = () =>
      "http://127.0.0.1:17777",
  ) {}

  public getSyntheticSettings(): SyntheticSettings {
    return {
      baseUrl: readModelHopSetting(
        "synthetic.baseUrl",
        DEFAULT_SYNTHETIC_SETTINGS.baseUrl,
        "synthetic.baseUrl",
      ),
      defaultModel: readModelHopSetting(
        "synthetic.defaultModel",
        DEFAULT_SYNTHETIC_SETTINGS.defaultModel,
        "synthetic.defaultModel",
      ),
      opusModel: readModelHopSetting(
        "synthetic.opusModel",
        DEFAULT_SYNTHETIC_SETTINGS.opusModel,
        "synthetic.opusModel",
      ),
      sonnetModel: readModelHopSetting(
        "synthetic.sonnetModel",
        DEFAULT_SYNTHETIC_SETTINGS.sonnetModel,
        "synthetic.sonnetModel",
      ),
      haikuModel: readModelHopSetting(
        "synthetic.haikuModel",
        DEFAULT_SYNTHETIC_SETTINGS.haikuModel,
        "synthetic.haikuModel",
      ),
      subagentModel: readModelHopSetting(
        "synthetic.subagentModel",
        DEFAULT_SYNTHETIC_SETTINGS.subagentModel,
        "synthetic.subagentModel",
      ),
    };
  }

  public getOpenAISettings(
    providerId: Extract<ProviderId, "openai-api" | "openai-codex">,
  ): OpenAIProviderSettings {
    const prefix =
      providerId === "openai-api" ? "openaiApi" : "openaiCodex";
    const readModel = (key: ModelSettingKey): string =>
      readModelHopSetting(
        `${prefix}.${key}`,
        DEFAULT_OPENAI_SETTINGS[key],
      );
    const readEffort = (
      key:
        | "defaultReasoningEffort"
        | "opusReasoningEffort"
        | "sonnetReasoningEffort"
        | "haikuReasoningEffort"
        | "subagentReasoningEffort",
    ): OpenAIReasoningEffort =>
      readModelHopSetting(`${prefix}.${key}`, DEFAULT_OPENAI_SETTINGS[key]);

    return {
      baseUrl: this.getBridgeBaseUrl(),
      defaultModel: readModel("defaultModel"),
      opusModel: readModel("opusModel"),
      sonnetModel: readModel("sonnetModel"),
      haikuModel: readModel("haikuModel"),
      subagentModel: readModel("subagentModel"),
      defaultReasoningEffort: readEffort("defaultReasoningEffort"),
      opusReasoningEffort: readEffort("opusReasoningEffort"),
      sonnetReasoningEffort: readEffort("sonnetReasoningEffort"),
      haikuReasoningEffort: readEffort("haikuReasoningEffort"),
      subagentReasoningEffort: readEffort("subagentReasoningEffort"),
    };
  }

  public getProfile(providerId: ProviderId): ProviderProfile {
    switch (providerId) {
      case "synthetic":
        return createSyntheticProfile(this.getSyntheticSettings());
      case "openai-api":
      case "openai-codex":
        return createOpenAIProfile(
          providerId,
          this.getOpenAISettings(providerId),
        );
      case "anthropic":
        return anthropicProfile;
    }
  }

  public async updateSyntheticModel(
    settingKey: ModelSettingKey,
    modelId: string,
  ): Promise<void> {
    await updateModelHopSetting(`synthetic.${settingKey}`, modelId);
  }

  public async updateOpenAIRoute(
    providerId: Extract<ProviderId, "openai-api" | "openai-codex">,
    settingKey: ModelSettingKey,
    modelId: string,
    effort: OpenAIReasoningEffort,
  ): Promise<void> {
    const prefix =
      providerId === "openai-api" ? "openaiApi" : "openaiCodex";
    const role = MODEL_ROLES.find(
      (candidate) => candidate.settingKey === settingKey,
    );
    if (!role) {
      throw new Error(`Unknown Claude model role: ${settingKey}`);
    }
    await updateModelHopSetting(`${prefix}.${settingKey}`, modelId);
    await updateModelHopSetting(
      `${prefix}.${role.reasoningSettingKey}`,
      effort,
    );
  }

  public async buildEnvironment(
    providerId: ProviderId,
  ): Promise<EnvironmentVariable[]> {
    const profile = this.getProfile(providerId);
    if (providerId === "anthropic") {
      const apiKey = await this.credentialService.getAnthropicApiKey();
      return apiKey
        ? [
            ...profile.environmentVariables,
            { name: "ANTHROPIC_API_KEY", value: apiKey },
          ]
        : [...profile.environmentVariables];
    }

    const token =
      providerId === "synthetic"
        ? await this.credentialService.getSyntheticToken()
        : await this.credentialService.getOrCreateBridgeAuthToken();
    return [
      ...profile.environmentVariables.slice(0, 1),
      { name: "ANTHROPIC_AUTH_TOKEN", value: token },
      ...profile.environmentVariables.slice(1),
    ];
  }
}
