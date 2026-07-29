import * as vscode from "vscode";
import {
  isValidSyntheticModelId,
  MODEL_ROLES,
  type ModelRole,
  type SyntheticModelSettingKey,
} from "../models/modelRouting.js";
import type { SyntheticSettings } from "../providers/types.js";
import {
  formatModelDisplayName,
  syntheticModelDisplayName,
  type SyntheticModel,
} from "../synthetic/syntheticApiService.js";

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
  const currentModel =
    alias ?? models.find((model) => model.id === current);
  const displayName = currentModel
    ? syntheticModelDisplayName(currentModel)
    : formatModelDisplayName(current);
  return {
    selection: role.settingKey,
    label: `$(symbol-variable) ${role.label}`,
    description: displayName,
    detail: alias?.aliasResolution
      ? `${role.description} Automatic route via ${current}; current documented model: ${alias.aliasResolution}.`
      : `${role.description} Model ID: ${current}.`,
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
  const displayName = syntheticModelDisplayName(model);
  if (model.source === "alias") {
    return {
      modelId: model.id,
      label: `${currentMarker}$(references) ${displayName}`,
      description: `${model.category ?? "Synthetic"} · automatic`,
      detail: model.aliasResolution
        ? `Routes through ${model.id}. Current documented model ID: ${model.aliasResolution}.`
        : `Automatic route: ${model.id}.`,
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
    label: `${currentMarker}$(server) ${displayName}`,
    description: metadata || "Available model",
    detail: `${model.id}. Synthetic may remove pinned models during rotations.`,
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
    description: "Advanced: use an hf: model ID or syn: automatic route",
  };
  const currentEntry = models.find(
    (model) => model.id === currentModel,
  );
  const currentDisplayName = currentEntry
    ? syntheticModelDisplayName(currentEntry)
    : formatModelDisplayName(currentModel);
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Automatic model routes",
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
      placeHolder: `Current: ${currentDisplayName}`,
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
