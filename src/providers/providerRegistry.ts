import * as vscode from "vscode";
import type { CredentialService } from "../credentials/credentialService.js";
import { anthropicProfile } from "./anthropicProvider.js";
import {
  createSyntheticProfile,
  DEFAULT_SYNTHETIC_SETTINGS,
} from "./syntheticProvider.js";
import type {
  EnvironmentVariable,
  ProviderId,
  ProviderProfile,
  SyntheticSettings,
} from "./types.js";
import type { SyntheticModelSettingKey } from "../models/modelRouting.js";

export class ProviderRegistry {
  public constructor(private readonly credentialService: CredentialService) {}

  public getSyntheticSettings(): SyntheticSettings {
    const configuration = vscode.workspace.getConfiguration("claudeProvider");
    return {
      baseUrl: configuration.get(
        "synthetic.baseUrl",
        DEFAULT_SYNTHETIC_SETTINGS.baseUrl,
      ),
      defaultModel: configuration.get(
        "synthetic.defaultModel",
        DEFAULT_SYNTHETIC_SETTINGS.defaultModel,
      ),
      opusModel: configuration.get(
        "synthetic.opusModel",
        DEFAULT_SYNTHETIC_SETTINGS.opusModel,
      ),
      sonnetModel: configuration.get(
        "synthetic.sonnetModel",
        DEFAULT_SYNTHETIC_SETTINGS.sonnetModel,
      ),
      haikuModel: configuration.get(
        "synthetic.haikuModel",
        DEFAULT_SYNTHETIC_SETTINGS.haikuModel,
      ),
      subagentModel: configuration.get(
        "synthetic.subagentModel",
        DEFAULT_SYNTHETIC_SETTINGS.subagentModel,
      ),
    };
  }

  public getProfile(providerId: ProviderId): ProviderProfile {
    return providerId === "synthetic"
      ? createSyntheticProfile(this.getSyntheticSettings())
      : anthropicProfile;
  }

  public async updateSyntheticModel(
    settingKey: SyntheticModelSettingKey,
    modelId: string,
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration("claudeProvider")
      .update(
        `synthetic.${settingKey}`,
        modelId,
        vscode.ConfigurationTarget.Global,
      );
  }

  public async buildEnvironment(
    providerId: ProviderId,
  ): Promise<EnvironmentVariable[]> {
    const profile = this.getProfile(providerId);
    if (providerId === "anthropic") {
      return [...profile.environmentVariables];
    }

    const token = await this.credentialService.getSyntheticToken();
    return [
      ...profile.environmentVariables.slice(0, 1),
      { name: "ANTHROPIC_AUTH_TOKEN", value: token },
      ...profile.environmentVariables.slice(1),
    ];
  }
}
