import * as vscode from "vscode";
import type {
  DetectedProvider,
  ProviderId,
  ProviderProfile,
} from "../providers/types.js";

interface ProviderQuickPickItem extends vscode.QuickPickItem {
  selection: ProviderId;
}

interface ActionQuickPickItem extends vscode.QuickPickItem {
  selection:
    | "set-synthetic-token"
    | "set-openai-key"
    | "logout-openai-codex"
    | "configure-synthetic-models"
    | "configure-openai-api-models"
    | "configure-openai-codex-models"
    | "show-usage";
}

function quickPickItem(
  profile: ProviderProfile,
  current: DetectedProvider,
): ProviderQuickPickItem {
  const icon =
    profile.id === "synthetic"
      ? "$(server-environment)"
      : profile.id === "anthropic"
        ? "$(sparkle)"
        : profile.id === "openai-codex"
          ? "$(beaker)"
          : "$(hubot)";
  const currentMarker = profile.id === current ? "$(check) " : "";
  return {
    selection: profile.id,
    label: `${currentMarker}${icon} ${profile.shortLabel}`,
    description: profile.experimental
      ? "Experimental"
      : profile.id === "anthropic"
        ? "Native Claude"
        : "Configurable model routing",
    detail: profile.description,
    picked: profile.id === current,
  };
}

export type ProviderQuickPickSelection =
  | ProviderId
  | "set-synthetic-token"
  | "set-openai-key"
  | "logout-openai-codex"
  | "configure-synthetic-models"
  | "configure-openai-api-models"
  | "configure-openai-codex-models"
  | "show-usage";

export async function showProviderQuickPick(
  profiles: readonly ProviderProfile[],
  current: DetectedProvider,
  credentials: {
    synthetic: boolean;
    openAI: boolean;
  },
): Promise<ProviderQuickPickSelection | undefined> {
  const syntheticTokenItem: ActionQuickPickItem = {
    selection: "set-synthetic-token",
    label: "$(key) Set or update Synthetic token",
    description: credentials.synthetic ? "Token saved" : "Token not set",
    detail:
      "Stored in Cursor SecretStorage and supplied only to the local ModelHop bridge.",
  };
  const openAIKeyItem: ActionQuickPickItem = {
    selection: "set-openai-key",
    label: "$(key) Set or update OpenAI API key",
    description: credentials.openAI ? "Key saved" : "Key not set",
    detail:
      "Stored in Cursor SecretStorage and supplied only to the local ModelHop bridge.",
  };
  const syntheticModelItem: ActionQuickPickItem = {
    selection: "configure-synthetic-models",
    label: "$(settings-gear) Configure Synthetic model routing",
    description: "Default, Opus, Sonnet, Haiku, and subagents",
    detail:
      "Choose by model name from the models returned by Synthetic.",
  };
  const openAIModelItem: ActionQuickPickItem = {
    selection: "configure-openai-api-models",
    label: "$(settings-gear) Configure OpenAI API model routing",
    description: "GPT model and reasoning effort per Claude role",
  };
  const codexModelItem: ActionQuickPickItem = {
    selection: "configure-openai-codex-models",
    label: "$(beaker) Configure ChatGPT/Codex model routing",
    description: "Experimental · models available to the signed-in account",
  };
  const codexLogoutItem: ActionQuickPickItem = {
    selection: "logout-openai-codex",
    label: "$(sign-out) Sign out of ChatGPT/Codex",
    description: "Experimental provider account",
    detail:
      "Signs the managed local Codex runtime out of its ChatGPT account.",
  };
  const usageItem: ActionQuickPickItem = {
    selection: "show-usage",
    label: "$(graph) View active provider usage",
    description: "Quota, tokens, rate limits, and resets when available",
  };
  const selected = await vscode.window.showQuickPick(
    [
      ...profiles.map((profile) => quickPickItem(profile, current)),
      {
        label: "Provider tools",
        kind: vscode.QuickPickItemKind.Separator,
      },
      usageItem,
      syntheticModelItem,
      openAIModelItem,
      codexModelItem,
      codexLogoutItem,
      syntheticTokenItem,
      openAIKeyItem,
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
