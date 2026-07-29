import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import { detectProvider } from "../validation/providerDetector.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";

export class StatusBarController implements vscode.Disposable {
  private readonly statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  public constructor(
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly logger: RedactingLogger,
    private readonly bridgeBaseUrl?: string,
  ) {
    this.statusItem.command = "modelHop.select";
    this.statusItem.tooltip = "Switch Claude Code provider";
  }

  public refresh(): void {
    try {
      const configuration = this.settingsService.read();
      const provider = detectProvider(
        configuration.effectiveRawValue,
        this.providerRegistry.getSyntheticSettings().baseUrl,
        this.bridgeBaseUrl,
      );

      switch (provider) {
        case "synthetic":
          this.statusItem.text =
            "$(server-environment) Claude: Synthetic";
          break;
        case "anthropic":
          this.statusItem.text = "$(sparkle) Claude: Anthropic";
          break;
        case "openai-api":
          this.statusItem.text = `$(hubot) Claude: OpenAI API · ${
            this.providerRegistry.getOpenAISettings("openai-api")
              .defaultModel
          }`;
          break;
        case "openai-codex":
          this.statusItem.text = `$(beaker) Claude: OpenAI via Codex · ${
            this.providerRegistry.getOpenAISettings("openai-codex")
              .defaultModel
          }`;
          break;
        case "custom":
          this.statusItem.text = "$(server) Claude: Custom Gateway";
          break;
        case "invalid":
          this.statusItem.text = "$(warning) Claude: Invalid Config";
          break;
      }

      this.statusItem.show();
    } catch (error) {
      this.statusItem.text = "$(warning) Claude: Invalid Config";
      this.statusItem.show();
      this.logger.error(error);
    }
  }

  public dispose(): void {
    this.statusItem.dispose();
  }
}
