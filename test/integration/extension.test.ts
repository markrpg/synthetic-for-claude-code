import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";

suite("ModelHop for Claude Code extension", () => {
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
      "ModelHop for Claude Code",
    );
    assert.equal(extension.packageJSON.version, "2.2.4");
    await extension.activate();
    assert.equal(extension.isActive, true);

    if (process.env.MODELHOP_PACKAGED_SMOKE === "1") {
      assert.equal(
        extension.extensionPath,
        process.env.MODELHOP_EXPECTED_EXTENSION_PATH,
        "Packaged smoke test did not activate the installed VSIX contents",
      );
      for (const requiredAsset of [
        "dist/extension.js",
        "dist/remote-daemon.mjs",
        "dist/remote/index.html",
        "dist/remote/styles.css",
        "dist/remote/chat-mesh.svg",
        "dist/remote/app.js",
      ]) {
        await fs.access(
          vscode.Uri.joinPath(
            extension.extensionUri,
            requiredAsset,
          ).fsPath,
        );
      }
      await assert.rejects(
        fs.access(
          vscode.Uri.joinPath(
            extension.extensionUri,
            "dist-test",
          ).fsPath,
        ),
        "Fixture build leaked into the installed VSIX",
      );
      const remoteBundle = await fs.readFile(
        vscode.Uri.joinPath(
          extension.extensionUri,
          "dist/remote/app.js",
        ).fsPath,
        "utf8",
      );
      assert.equal(
        remoteBundle.includes("__MODELHOP_FIXTURE_BUILD__"),
        false,
        "Fixture transport leaked into the production mobile bundle",
      );
    }

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("workbench.action.reloadWindow"),
      "The editor does not provide the full-window reload command",
    );
    for (const command of [
      "modelHop.select",
      "modelHop.useAnthropic",
      "modelHop.useSynthetic",
      "modelHop.useOpenAIApi",
      "modelHop.useOpenAICodex",
      "modelHop.configureSyntheticModels",
      "modelHop.configureOpenAIApiModels",
      "modelHop.configureOpenAICodexModels",
      "modelHop.setSyntheticToken",
      "modelHop.clearSyntheticToken",
      "modelHop.setOpenAIKey",
      "modelHop.clearOpenAIKey",
      "modelHop.logoutOpenAICodex",
      "modelHop.showUsage",
      "modelHop.openSyntheticUsage",
      "modelHop.validate",
      "modelHop.showEffectiveConfiguration",
      "modelHop.restore",
      "modelHop.repairConversations",
      "modelHop.openSettings",
      "modelHop.continueOnPhone",
      "modelHop.returnToLaptop",
      "modelHop.recoverRemoteConversation",
      "modelHop.stopRemoteAccess",
      "modelHop.managePairedDevices",
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
      "claudeProvider.repairConversations",
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
