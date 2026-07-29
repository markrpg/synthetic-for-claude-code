import * as vscode from "vscode";
import type { ProviderConflict } from "../validation/conflictDetector.js";
import type {
  DetectedProvider,
  ProviderProfile,
} from "../providers/types.js";
import type { OverrideScope } from "../configuration/configurationInspection.js";

function currentProviderLabel(provider: DetectedProvider): string {
  switch (provider) {
    case "synthetic":
      return "Synthetic";
    case "anthropic":
      return "Anthropic";
    case "custom":
      return "a custom gateway";
    case "invalid":
      return "an invalid configuration";
  }
}

export async function confirmProviderSwitch(
  current: DetectedProvider,
  target: ProviderProfile,
): Promise<boolean> {
  const dontAskAgainItem: vscode.QuickPickItem = {
    label: "Don't ask again",
    description:
      "Skip this confirmation for future provider switches",
  };
  const selection = await vscode.window.showQuickPick(
    [dontAskAgainItem],
    {
      title: `Switch Claude Code from ${currentProviderLabel(
        current,
      )} to ${target.shortLabel}?`,
      placeHolder:
        "Optionally tick “Don't ask again”, then confirm to switch and reload the window",
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (selection === undefined) {
    return false;
  }
  if (selection.includes(dontAskAgainItem)) {
    await vscode.workspace
      .getConfiguration("claudeProvider")
      .update(
        "confirmBeforeReload",
        false,
        vscode.ConfigurationTarget.Global,
      );
  }
  return true;
}

export type OverrideDecision =
  | "continue"
  | "open-settings"
  | "cancel";

export async function showOverrideWarning(
  scopes: readonly OverrideScope[],
): Promise<OverrideDecision> {
  const scopeLabel = scopes.includes("workspace-folder")
    ? "workspace-folder"
    : "workspace";
  const action = await vscode.window.showWarningMessage(
    `This ${scopeLabel} defines its own Claude Code environment variables. That value will override the global provider selection.`,
    { modal: true },
    "Open Workspace Settings",
    "Continue Anyway",
  );

  if (action === "Open Workspace Settings") {
    return "open-settings";
  }
  if (action === "Continue Anyway") {
    return "continue";
  }
  return "cancel";
}

export async function showConflictDialog(
  conflicts: readonly ProviderConflict[],
): Promise<"open-settings" | "cancel"> {
  const providers = conflicts
    .map((conflict) => conflict.providerLabel)
    .join(", ");
  const action = await vscode.window.showErrorMessage(
    `Claude Code is configured to use ${providers}. Provider switching would conflict with that setting.`,
    { modal: true },
    "Open Settings",
  );
  return action === "Open Settings" ? "open-settings" : "cancel";
}
