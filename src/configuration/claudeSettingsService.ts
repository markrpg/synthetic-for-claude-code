import * as vscode from "vscode";
import {
  environmentVariablesEqual,
  normaliseEnvironmentVariables,
  type NormalisedEnvironment,
} from "./mergeEnvironmentVariables.js";
import type { EnvironmentVariable } from "../providers/types.js";
import {
  findOverrideScopes,
  type OverrideScope,
} from "./configurationInspection.js";

export interface ClaudeConfiguration {
  effective: NormalisedEnvironment;
  global: NormalisedEnvironment;
  effectiveRawValue: unknown;
  globalRawValue: unknown;
  overrideScopes: OverrideScope[];
}

export class ClaudeSettingsService {
  public read(): ClaudeConfiguration {
    const configuration = vscode.workspace.getConfiguration("claudeCode");
    const inspection =
      configuration.inspect<EnvironmentVariable[]>("environmentVariables");
    const effectiveRawValue = configuration.get<unknown>(
      "environmentVariables",
      [],
    );
    const globalRawValue = inspection?.globalValue;

    return {
      effective: normaliseEnvironmentVariables(effectiveRawValue),
      global: normaliseEnvironmentVariables(globalRawValue),
      effectiveRawValue,
      globalRawValue,
      overrideScopes: findOverrideScopes(inspection),
    };
  }

  public async write(
    environmentVariables: readonly EnvironmentVariable[],
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("claudeCode");
    await configuration.update(
      "environmentVariables",
      [...environmentVariables],
      vscode.ConfigurationTarget.Global,
    );
  }

  public verifyWritten(expected: readonly EnvironmentVariable[]): void {
    const readBack = this.read();
    if (
      readBack.global.containerWasMalformed ||
      readBack.global.malformedEntries.length > 0 ||
      !environmentVariablesEqual(readBack.global.variables, expected)
    ) {
      throw new Error(
        "Claude Code settings did not match the requested configuration after writing.",
      );
    }
  }

  public async openGlobalSettings(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "claudeCode.environmentVariables",
    );
  }

  public async openWorkspaceSettings(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.openWorkspaceSettings",
      "claudeCode.environmentVariables",
    );
  }
}
