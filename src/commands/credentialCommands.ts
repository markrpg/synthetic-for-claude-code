import * as vscode from "vscode";
import type { CredentialService } from "../credentials/credentialService.js";

export async function setSyntheticTokenCommand(
  credentialService: CredentialService,
): Promise<boolean> {
  const stored = await promptForSyntheticToken(credentialService);
  if (stored) {
    await vscode.window.showInformationMessage(
      "Synthetic API token saved.",
    );
  }
  return stored;
}

export async function promptForSyntheticToken(
  credentialService: CredentialService,
): Promise<boolean> {
  const token = await vscode.window.showInputBox({
    title: "Synthetic API Token",
    prompt:
      "Paste your token. It is stored in Cursor SecretStorage and supplied only to ModelHop's local bridge.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? undefined : "The token cannot be empty.",
  });
  if (token === undefined) {
    return false;
  }

  await credentialService.setSyntheticToken(token);
  return true;
}

export async function setOpenAIApiKeyCommand(
  credentialService: CredentialService,
): Promise<boolean> {
  const stored = await promptForOpenAIApiKey(credentialService);
  if (stored) {
    await vscode.window.showInformationMessage("OpenAI API key saved.");
  }
  return stored;
}

export async function promptForOpenAIApiKey(
  credentialService: CredentialService,
): Promise<boolean> {
  const apiKey = await vscode.window.showInputBox({
    title: "OpenAI API Key",
    prompt:
      "Paste an OpenAI Platform API key. It stays in Cursor SecretStorage and is sent only to the local ModelHop bridge.",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? undefined : "The API key cannot be empty.",
  });
  if (apiKey === undefined) {
    return false;
  }
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "OpenAI rejected this API key."
        : `OpenAI key validation failed with status ${response.status}.`,
    );
  }
  await credentialService.setOpenAIApiKey(apiKey);
  return true;
}

export async function clearOpenAIApiKeyCommand(
  credentialService: CredentialService,
): Promise<void> {
  await credentialService.clearOpenAIApiKey();
  await vscode.window.showInformationMessage(
    "Stored OpenAI API key cleared. Switch away from OpenAI API before sending another Claude Code message.",
  );
}

export async function clearSyntheticTokenCommand(
  credentialService: CredentialService,
): Promise<void> {
  await credentialService.clearSyntheticToken();
  await vscode.window.showInformationMessage(
    "Stored Synthetic API token cleared.",
  );
}
