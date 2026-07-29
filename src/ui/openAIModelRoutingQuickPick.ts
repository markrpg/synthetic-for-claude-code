import * as vscode from "vscode";
import {
  isValidOpenAIModelId,
  MODEL_ROLES,
  OPENAI_REASONING_EFFORTS,
  type ModelRole,
  type ModelSettingKey,
} from "../models/modelRouting.js";
import {
  formatOpenAIModelName,
  type OpenAIModel,
} from "../openai/openAIModelService.js";
import type {
  OpenAIProviderSettings,
  OpenAIReasoningEffort,
} from "../providers/types.js";

interface RoleItem extends vscode.QuickPickItem {
  selection: ModelSettingKey;
}

export async function showOpenAIRoutingQuickPick(
  title: string,
  settings: OpenAIProviderSettings,
): Promise<ModelSettingKey | "done" | undefined> {
  const items: Array<RoleItem | (vscode.QuickPickItem & { selection: "done" })> =
    MODEL_ROLES.map((role) => ({
      selection: role.settingKey,
      label: `$(symbol-variable) ${role.label}`,
      description: formatOpenAIModelName(settings[role.settingKey]),
      detail: `${role.description} Reasoning: ${settings[role.reasoningSettingKey]}. Canonical model ID: ${settings[role.settingKey]}.`,
    }));
  items.push({
    selection: "done",
    label: "$(check) Done",
    description: "Save these mappings",
  });
  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Choose a Claude role to configure",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return selected?.selection;
}

export async function showOpenAIModelQuickPick(
  role: ModelRole,
  currentModel: string,
  models: readonly OpenAIModel[],
): Promise<string | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      ...models.map((model) => ({
        modelId: model.id,
        label: `${model.id === currentModel ? "$(check) " : ""}$(hubot) ${model.displayName}`,
        description: model.id,
        detail: model.description,
        picked: model.id === currentModel,
      })),
      {
        manual: true as const,
        label: "$(edit) Enter a model ID",
        description: "Advanced: use another Responses-compatible GPT model",
      },
    ],
    {
      title: `${role.label} model`,
      placeHolder: `Current: ${formatOpenAIModelName(currentModel)}`,
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
  return vscode.window.showInputBox({
    title: `${role.label} OpenAI model ID`,
    value: currentModel,
    prompt: "Enter a Responses-compatible OpenAI model ID",
    validateInput: (value) =>
      isValidOpenAIModelId(value)
        ? undefined
        : "Use a valid OpenAI model ID without spaces.",
  });
}

export async function showReasoningEffortQuickPick(
  model: OpenAIModel | undefined,
  current: OpenAIReasoningEffort,
): Promise<OpenAIReasoningEffort | undefined> {
  const supported =
    model?.supportedReasoningEfforts ?? OPENAI_REASONING_EFFORTS;
  const selected = await vscode.window.showQuickPick(
    supported.map((effort) => ({
      effort,
      label: `${effort === current ? "$(check) " : ""}${effort}`,
      description:
        effort === "high"
          ? "Quality-first"
          : effort === "medium"
            ? "Balanced"
            : effort === "low" || effort === "none"
              ? "Faster and lower cost"
              : "Maximum reasoning; use selectively",
      picked: effort === current,
    })),
    {
      title: `${formatOpenAIModelName(model?.id ?? "OpenAI")} reasoning`,
      placeHolder: `Current: ${current}`,
    },
  );
  return selected?.effort;
}
