import * as vscode from "vscode";
import type {
  DetectedProvider,
  ProviderId,
  ProviderProfile,
} from "../providers/types.js";

interface ProviderQuickPickItem extends vscode.QuickPickItem {
  selection: ProviderId;
}

interface TokenQuickPickItem extends vscode.QuickPickItem {
  selection: "set-token" | "configure-models" | "show-usage";
}

function quickPickItem(
  profile: ProviderProfile,
  current: DetectedProvider,
): ProviderQuickPickItem {
  const icon =
    profile.id === "synthetic" ? "$(server-environment)" : "$(sparkle)";
  const currentMarker = profile.id === current ? "$(check) " : "";
  return {
    selection: profile.id,
    label: `${currentMarker}${icon} ${profile.shortLabel}`,
    description:
      profile.id === "synthetic"
        ? "Configurable model routing"
        : "Native Claude",
    detail: profile.description,
    picked: profile.id === current,
  };
}

export type ProviderQuickPickSelection =
  | ProviderId
  | "set-token"
  | "configure-models"
  | "show-usage";

export async function showProviderQuickPick(
  profiles: readonly ProviderProfile[],
  current: DetectedProvider,
  tokenConfigured: boolean,
): Promise<ProviderQuickPickSelection | undefined> {
  const tokenItem: TokenQuickPickItem = {
    selection: "set-token",
    label: "$(key) Set or update Synthetic token",
    description: tokenConfigured ? "Token saved" : "Token not set",
    detail:
      "Stored in Cursor SecretStorage and applied when Synthetic is selected.",
  };
  const modelItem: TokenQuickPickItem = {
    selection: "configure-models",
    label: "$(settings-gear) Configure Synthetic model routing",
    description: "Default, Opus, Sonnet, Haiku, and subagents",
    detail:
      "Choose by model name from the models returned by Synthetic.",
  };
  const usageItem: TokenQuickPickItem = {
    selection: "show-usage",
    label: "$(graph) View Synthetic quota and usage",
    description: "Five-hour requests and weekly credits",
    detail:
      "Reads rolling quota and regeneration data directly from Synthetic.",
  };
  const selected = await vscode.window.showQuickPick(
    [
      ...profiles.map((profile) => quickPickItem(profile, current)),
      {
        label: "Synthetic credentials",
        kind: vscode.QuickPickItemKind.Separator,
      },
      usageItem,
      modelItem,
      tokenItem,
    ],
    {
      placeHolder: "Select the provider for Claude Code",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return selected && "selection" in selected
    ? selected.selection
    : undefined;
}
