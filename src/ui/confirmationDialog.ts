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
  const action = await vscode.window.showWarningMessage(
    `Switch Claude Code from ${currentProviderLabel(
      current,
    )} to ${target.shortLabel}? Cursor must reload for Claude Code to receive the new environment. Any active Claude Code generation, Bash command, or subagent will stop.`,
    { modal: true },
    "Switch and Reload",
  );
  return action === "Switch and Reload";
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
