import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Synthetic for Claude Code extension", () => {
  let originalGlobalValue: unknown;

  suiteSetup(async () => {
    const configuration = vscode.workspace.getConfiguration("claudeCode");
    originalGlobalValue =
      configuration.inspect("environmentVariables")?.globalValue;
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration("claudeCode")
      .update(
        "environmentVariables",
        originalGlobalValue,
        vscode.ConfigurationTarget.Global,
      );
  });

  test("activates and registers every public command", async () => {
    const extension = vscode.extensions.getExtension(
      "private.claude-provider-switcher",
    );
    assert.ok(extension, "Development extension was not discovered");
    assert.equal(
      extension.packageJSON.displayName,
      "Synthetic for Claude Code",
    );
    assert.equal(extension.packageJSON.version, "1.2.2");
    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "claudeProvider.select",
      "claudeProvider.useSynthetic",
      "claudeProvider.useAnthropic",
      "claudeProvider.toggle",
      "claudeProvider.validate",
      "claudeProvider.showEffectiveConfiguration",
      "claudeProvider.restore",
      "claudeProvider.setSyntheticToken",
      "claudeProvider.clearSyntheticToken",
      "claudeProvider.openSettings",
      "claudeProvider.configureSyntheticModels",
      "claudeProvider.showSyntheticUsage",
      "claudeProvider.openSyntheticUsage",
    ]) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });

  test("observes global Claude Code configuration writes", async () => {
    const variables = [{ name: "MCP_TIMEOUT", value: "30000" }];
    const configuration = vscode.workspace.getConfiguration("claudeCode");
    const changed = new Promise<void>((resolve) => {
      const disposable = vscode.workspace.onDidChangeConfiguration(
        (event) => {
          if (
            event.affectsConfiguration(
              "claudeCode.environmentVariables",
            )
          ) {
            disposable.dispose();
            resolve();
          }
        },
      );
    });
    await configuration.update(
      "environmentVariables",
      variables,
      vscode.ConfigurationTarget.Global,
    );
    await changed;
    assert.deepEqual(
      vscode.workspace
        .getConfiguration("claudeCode")
        .inspect("environmentVariables")?.globalValue,
      variables,
    );
  });
});
