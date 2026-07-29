import * as vscode from "vscode";

export async function showConfigurationError(
  message: string,
): Promise<void> {
  await vscode.window.showErrorMessage(message);
}

export async function showConfigurationInfo(
  message: string,
): Promise<void> {
  await vscode.window.showInformationMessage(message);
}
