import * as vscode from "vscode";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { CredentialService } from "../credentials/credentialService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import {
  formatQuotaDetails,
  formatQuotaStatus,
  SYNTHETIC_USAGE_URL,
  type SyntheticApiService,
  type SyntheticQuota,
} from "../synthetic/syntheticApiService.js";
import { detectProvider } from "../validation/providerDetector.js";
import { promptForSyntheticToken } from "../commands/credentialCommands.js";

const DEFAULT_REFRESH_MINUTES = 5;

export class SyntheticQuotaStatusBarController
  implements vscode.Disposable
{
  private readonly statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  private timer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<SyntheticQuota | undefined> | undefined;

  public constructor(
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly credentialService: CredentialService,
    private readonly apiService: SyntheticApiService,
    private readonly logger: RedactingLogger,
  ) {
    this.statusItem.command = "claudeProvider.select";
  }

  public start(): void {
    this.reschedule();
    void this.refresh();
  }

  public handleConfigurationChange(): void {
    this.reschedule();
    void this.refresh();
  }

  public async showDetails(): Promise<void> {
    if (
      !(await this.credentialService.hasSyntheticToken()) &&
      !(await promptForSyntheticToken(this.credentialService))
    ) {
      return;
    }

    let quota = await this.refresh(true);
    while (quota) {
      const action = await vscode.window.showInformationMessage(
        formatQuotaDetails(quota),
        "Refresh",
        "Open Usage & Billing",
      );
      if (action === "Refresh") {
        quota = await this.refresh(true);
      } else {
        if (action === "Open Usage & Billing") {
          await this.openUsageAndBilling();
        }
        return;
      }
    }
    if (!quota) {
      await vscode.window.showErrorMessage(
        "Synthetic quota is currently unavailable.",
      );
    }
  }

  public async openUsageAndBilling(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(SYNTHETIC_USAGE_URL));
  }

  public async refresh(
    forceVisible = false,
  ): Promise<SyntheticQuota | undefined> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh(forceVisible);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.statusItem.dispose();
  }

  private async performRefresh(
    forceVisible: boolean,
  ): Promise<SyntheticQuota | undefined> {
    const currentProvider = detectProvider(
      this.settingsService.read().effectiveRawValue,
      this.providerRegistry.getSyntheticSettings().baseUrl,
    );
    if (currentProvider !== "synthetic" && !forceVisible) {
      this.statusItem.hide();
      return undefined;
    }

    const showStatus = currentProvider === "synthetic";
    if (showStatus) {
      this.statusItem.show();
    } else {
      this.statusItem.hide();
    }
    if (!(await this.credentialService.hasSyntheticToken())) {
      if (showStatus) {
        this.statusItem.text = "$(key) Syn quota: set token";
        this.statusItem.tooltip =
          "Set a Synthetic API token to view quota. Click to switch provider.";
      }
      return undefined;
    }

    if (showStatus) {
      this.statusItem.text = "$(sync~spin) Syn quota";
      this.statusItem.tooltip =
        "Refreshing Synthetic quota. Click to switch provider.";
    }
    try {
      const quota = await this.apiService.getQuota();
      if (showStatus) {
        this.statusItem.text = `$(graph) Syn: ${formatQuotaStatus(quota)}`;
        this.statusItem.tooltip = `${formatQuotaDetails(
          quota,
        )} Click to switch provider or open usage tools.`;
      }
      return quota;
    } catch (error) {
      this.logger.error(error);
      if (showStatus) {
        this.statusItem.text = "$(warning) Syn quota unavailable";
        this.statusItem.tooltip =
          "Synthetic quota could not be loaded. Click to switch provider or retry from the menu.";
      }
      return undefined;
    }
  }

  private reschedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const minutes = vscode.workspace
      .getConfiguration("claudeProvider")
      .get("synthetic.usageRefreshMinutes", DEFAULT_REFRESH_MINUTES);
    if (minutes > 0) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, minutes * 60_000);
    }
  }
}
