import * as vscode from "vscode";

function hasConfiguredValue<T>(
  inspection:
    | {
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
      }
    | undefined,
): boolean {
  return Boolean(
    inspection &&
      (inspection.globalValue !== undefined ||
        inspection.workspaceValue !== undefined ||
        inspection.workspaceFolderValue !== undefined),
  );
}

export function readModelHopSetting<T>(
  key: string,
  fallback: T,
  legacyKey?: string,
): T {
  const modelHop = vscode.workspace.getConfiguration("modelHop");
  const inspection =
    typeof modelHop.inspect === "function"
      ? modelHop.inspect<T>(key)
      : undefined;
  if (hasConfiguredValue(inspection)) {
    return modelHop.get<T>(key, fallback);
  }

  if (legacyKey) {
    return vscode.workspace
      .getConfiguration("claudeProvider")
      .get<T>(legacyKey, fallback);
  }
  return fallback;
}

export async function updateModelHopSetting(
  key: string,
  value: unknown,
): Promise<void> {
  await vscode.workspace
    .getConfiguration("modelHop")
    .update(key, value, vscode.ConfigurationTarget.Global);
}
