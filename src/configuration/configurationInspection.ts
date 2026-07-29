import type { EnvironmentVariable } from "../providers/types.js";

export type OverrideScope = "workspace" | "workspace-folder";

interface EnvironmentVariableInspection {
  workspaceValue?: EnvironmentVariable[];
  workspaceFolderValue?: EnvironmentVariable[];
}

export function findOverrideScopes(
  inspection: EnvironmentVariableInspection | undefined,
): OverrideScope[] {
  if (!inspection) {
    return [];
  }

  const scopes: OverrideScope[] = [];
  if (inspection.workspaceValue !== undefined) {
    scopes.push("workspace");
  }
  if (inspection.workspaceFolderValue !== undefined) {
    scopes.push("workspace-folder");
  }
  return scopes;
}
