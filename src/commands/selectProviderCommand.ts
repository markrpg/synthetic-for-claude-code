import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { SwitchProviderCommand } from "./switchProviderCommand.js";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { CredentialService } from "../credentials/credentialService.js";
import { detectProvider } from "../validation/providerDetector.js";
import { showProviderQuickPick } from "../ui/providerQuickPick.js";
import {
  setOpenAIApiKeyCommand,
  setSyntheticTokenCommand,
} from "./credentialCommands.js";

export async function selectProviderCommand(
  settingsService: ClaudeSettingsService,
  providerRegistry: ProviderRegistry,
  credentialService: CredentialService,
  switchCommand: SwitchProviderCommand,
  actions: {
    configureSyntheticModels(): Promise<void>;
    configureOpenAIModels(
      providerId: "openai-api" | "openai-codex",
    ): Promise<void>;
    showUsage(): Promise<void>;
    logoutCodex(): Promise<void>;
  },
  bridgeBaseUrl?: string,
): Promise<void> {
  while (true) {
    const current = detectProvider(
      settingsService.read().effectiveRawValue,
      providerRegistry.getSyntheticSettings().baseUrl,
      bridgeBaseUrl,
    );
    const selected = await showProviderQuickPick(
      [
        providerRegistry.getProfile("anthropic"),
        providerRegistry.getProfile("synthetic"),
        providerRegistry.getProfile("openai-api"),
        providerRegistry.getProfile("openai-codex"),
      ],
      current,
      {
        synthetic: await credentialService.hasSyntheticToken(),
        openAI: await credentialService.hasOpenAIApiKey(),
      },
    );
    if (!selected) {
      return;
    }
    if (selected === "set-synthetic-token") {
      const stored =
        await setSyntheticTokenCommand(credentialService);
      if (!stored) {
        return;
      }
      continue;
    }
    if (selected === "set-openai-key") {
      const stored = await setOpenAIApiKeyCommand(credentialService);
      if (!stored) {
        return;
      }
      if (current === "openai-api") {
        await switchCommand.execute("openai-api", {
          skipConfirmation: true,
        });
      }
      continue;
    }
    if (selected === "configure-synthetic-models") {
      await actions.configureSyntheticModels();
      return;
    }
    if (selected === "configure-openai-api-models") {
      await actions.configureOpenAIModels("openai-api");
      return;
    }
    if (selected === "configure-openai-codex-models") {
      await actions.configureOpenAIModels("openai-codex");
      return;
    }
    if (selected === "show-usage") {
      await actions.showUsage();
      return;
    }
    if (selected === "logout-openai-codex") {
      await actions.logoutCodex();
      return;
    }
    await switchCommand.execute(selected);
    return;
  }
}
