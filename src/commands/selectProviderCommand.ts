import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { SwitchProviderCommand } from "./switchProviderCommand.js";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { CredentialService } from "../credentials/credentialService.js";
import { detectProvider } from "../validation/providerDetector.js";
import { showProviderQuickPick } from "../ui/providerQuickPick.js";
import { setSyntheticTokenCommand } from "./credentialCommands.js";

export async function selectProviderCommand(
  settingsService: ClaudeSettingsService,
  providerRegistry: ProviderRegistry,
  credentialService: CredentialService,
  switchCommand: SwitchProviderCommand,
  actions: {
    configureModels(): Promise<void>;
    showUsage(): Promise<void>;
  },
): Promise<void> {
  while (true) {
    const current = detectProvider(
      settingsService.read().effectiveRawValue,
      providerRegistry.getSyntheticSettings().baseUrl,
    );
    const selected = await showProviderQuickPick(
      [
        providerRegistry.getProfile("synthetic"),
        providerRegistry.getProfile("anthropic"),
      ],
      current,
      await credentialService.hasSyntheticToken(),
    );
    if (!selected) {
      return;
    }
    if (selected === "set-token") {
      const stored =
        await setSyntheticTokenCommand(credentialService);
      if (!stored) {
        return;
      }
      continue;
    }
    if (selected === "configure-models") {
      await actions.configureModels();
      return;
    }
    if (selected === "show-usage") {
      await actions.showUsage();
      return;
    }
    await switchCommand.execute(selected);
    return;
  }
}
