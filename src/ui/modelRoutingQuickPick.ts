import * as vscode from "vscode";
import {
  isValidSyntheticModelId,
  MODEL_ROLES,
  type ModelRole,
  type SyntheticModelSettingKey,
} from "../models/modelRouting.js";
import type { SyntheticSettings } from "../providers/types.js";
import type { SyntheticModel } from "../synthetic/syntheticApiService.js";

interface RoleItem extends vscode.QuickPickItem {
  selection: SyntheticModelSettingKey;
}

interface RoutingActionItem extends vscode.QuickPickItem {
  selection: "refresh" | "done";
}

export type RoutingSelection =
  | SyntheticModelSettingKey
  | "refresh"
  | "done";

function findAlias(
  id: string,
  models: readonly SyntheticModel[],
): SyntheticModel | undefined {
  return models.find(
    (model) => model.source === "alias" && model.id === id,
  );
}

function roleItem(
  role: ModelRole,
  settings: SyntheticSettings,
  models: readonly SyntheticModel[],
): RoleItem {
  const current = settings[role.settingKey];
  const alias = findAlias(current, models);
  return {
    selection: role.settingKey,
    label: `$(symbol-variable) ${role.label}`,
    description: current,
    detail: alias?.aliasResolution
      ? `${role.description} ${current} was documented as resolving to ${alias.aliasResolution} when this extension was released.`
      : role.description,
  };
}

export async function showModelRoutingQuickPick(
  settings: SyntheticSettings,
  models: readonly SyntheticModel[],
  liveModelCount: number,
): Promise<RoutingSelection | undefined> {
  const refreshItem: RoutingActionItem = {
    selection: "refresh",
    label: "$(refresh) Refresh available models",
    description: `${liveModelCount} live model${liveModelCount === 1 ? "" : "s"}`,
  };
  const doneItem: RoutingActionItem = {
    selection: "done",
    label: "$(check) Done",
    description: "Save these mappings",
  };
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Claude model routing",
        kind: vscode.QuickPickItemKind.Separator,
      },
      ...MODEL_ROLES.map((role) =>
        roleItem(role, settings, models),
      ),
      {
        label: "Actions",
        kind: vscode.QuickPickItemKind.Separator,
      },
      refreshItem,
      doneItem,
    ],
    {
      title: "Configure Synthetic Models",
      placeHolder: "Choose a Claude role to change its Synthetic model",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return selected && "selection" in selected
    ? selected.selection
    : undefined;
}

interface ModelItem extends vscode.QuickPickItem {
  modelId: string;
}

interface ManualModelItem extends vscode.QuickPickItem {
  manual: true;
}

function formatContextLength(contextLength: number): string {
  return contextLength >= 1_000
    ? `${Math.round(contextLength / 1_000)}k context`
    : `${contextLength} context`;
}

function modelItem(
  model: SyntheticModel,
  currentModel: string,
): ModelItem {
  const currentMarker = model.id === currentModel ? "$(check) " : "";
  if (model.source === "alias") {
    return {
      modelId: model.id,
      label: `${currentMarker}$(references) ${model.id}`,
      description: model.category,
      detail: model.aliasResolution
        ? `Recommended alias. Documented mapping: ${model.aliasResolution}. Synthetic can update this mapping.`
        : "Recommended Synthetic alias.",
      picked: model.id === currentModel,
    };
  }

  const metadata = [
    model.ownedBy,
    model.contextLength
      ? formatContextLength(model.contextLength)
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return {
    modelId: model.id,
    label: `${currentMarker}$(server) ${model.id}`,
    description: metadata || "Available model",
    detail:
      "Pinned model ID. Synthetic may remove pinned models during rotations.",
    picked: model.id === currentModel,
  };
}

export async function showModelQuickPick(
  role: ModelRole,
  currentModel: string,
  models: readonly SyntheticModel[],
): Promise<string | undefined> {
  const aliases = models.filter((model) => model.source === "alias");
  const liveModels = models.filter((model) => model.source === "api");
  const manualItem: ManualModelItem = {
    manual: true,
    label: "$(edit) Enter a model ID",
    description: "Use a syn: alias or hf: model ID",
  };
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Recommended aliases",
        kind: vscode.QuickPickItemKind.Separator,
      },
      ...aliases.map((model) => modelItem(model, currentModel)),
      ...(liveModels.length > 0
        ? [
            {
              label: "Available models from Synthetic",
              kind: vscode.QuickPickItemKind.Separator,
            } satisfies vscode.QuickPickItem,
            ...liveModels.map((model) =>
              modelItem(model, currentModel),
            ),
          ]
        : []),
      {
        label: "Other",
        kind: vscode.QuickPickItemKind.Separator,
      },
      manualItem,
    ],
    {
      title: `${role.label} model`,
      placeHolder: `Current: ${currentModel}`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  if (!selected) {
    return undefined;
  }
  if ("modelId" in selected) {
    return selected.modelId;
  }
  if ("manual" in selected) {
    return vscode.window.showInputBox({
      title: `${role.label} model ID`,
      prompt: "Enter a Synthetic syn: alias or hf: model ID",
      value: currentModel,
      ignoreFocusOut: true,
      validateInput: (value) =>
        isValidSyntheticModelId(value)
          ? undefined
          : "Use a syn: or hf: model ID without spaces.",
    });
  }
  return undefined;
}
