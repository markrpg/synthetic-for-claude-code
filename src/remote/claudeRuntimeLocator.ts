import { access, constants } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

const CLAUDE_EXTENSION_IDS = [
  "Anthropic.claude-code",
  "anthropic.claude-code",
] as const;

export async function locateClaudeExecutable(): Promise<string> {
  const extension = CLAUDE_EXTENSION_IDS.map((id) =>
    vscode.extensions.getExtension(id),
  ).find((candidate) => candidate !== undefined);
  if (!extension) {
    throw new Error(
      "Install and enable the Claude Code extension before starting ModelHop Remote.",
    );
  }
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  const executable = path.join(
    extension.extensionPath,
    "resources",
    "native-binary",
    binaryName,
  );
  await access(
    executable,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  ).catch(() => {
    throw new Error(
      "ModelHop could not find the Claude Code executable bundled with the installed extension. Update Claude Code and try again.",
    );
  });
  return executable;
}
