import * as vscode from "vscode";
import type { DetectedProvider, ProviderId } from "../providers/types.js";

const PENDING_RELOAD_KEY = "claudeProvider.pendingReload";
const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

export interface PendingReload {
  provider: ProviderId | DetectedProvider;
  switchedAt: number;
  reason: "switch" | "restore";
  workspaceOverride: boolean;
}

function providerLabel(provider: PendingReload["provider"]): string {
  switch (provider) {
    case "synthetic":
      return "Synthetic";
    case "anthropic":
      return "Anthropic";
    case "custom":
      return "a custom gateway";
    case "invalid":
      return "the restored configuration";
  }
}

export class ReloadCoordinator {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async markPending(pending: PendingReload): Promise<void> {
    await this.context.globalState.update(PENDING_RELOAD_KEY, pending);
  }

  public async clearPending(): Promise<void> {
    await this.context.globalState.update(PENDING_RELOAD_KEY, undefined);
  }

  public async restartExtensionHost(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.restartExtensionHost",
    );
  }

  public async showPostReloadNotification(): Promise<void> {
    const pending =
      this.context.globalState.get<PendingReload>(PENDING_RELOAD_KEY);
    if (!pending) {
      return;
    }

    await this.clearPending();
    if (Date.now() - pending.switchedAt > MAX_PENDING_AGE_MS) {
      return;
    }

    const overrideNote = pending.workspaceOverride
      ? " A workspace or folder setting still overrides the global selection."
      : "";
    void vscode.window.showInformationMessage(
      `Claude Code is now configured for ${providerLabel(
        pending.provider,
      )}.${overrideNote} Open Claude Code to continue.`,
      "Dismiss",
    );
  }
}
