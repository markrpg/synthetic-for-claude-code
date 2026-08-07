import * as vscode from "vscode";
import { BridgeManager } from "./bridge/bridgeManager.js";
import { CodexRuntimeManager } from "./codex/codexRuntimeManager.js";
import {
  clearOpenAIApiKeyCommand,
  clearSyntheticTokenCommand,
  promptForOpenAIApiKey,
  setOpenAIApiKeyCommand,
  setSyntheticTokenCommand,
} from "./commands/credentialCommands.js";
import { ModelRoutingCommand } from "./commands/modelRoutingCommand.js";
import { OpenAIModelRoutingCommand } from "./commands/openAIModelRoutingCommand.js";
import { restoreCommand } from "./commands/restoreCommand.js";
import { selectProviderCommand } from "./commands/selectProviderCommand.js";
import { SwitchProviderCommand } from "./commands/switchProviderCommand.js";
import {
  showEffectiveConfiguration,
  validateCommand,
} from "./commands/validateCommand.js";
import { ClaudeSettingsService } from "./configuration/claudeSettingsService.js";
import { CredentialService } from "./credentials/credentialService.js";
import { RedactingLogger } from "./logging/redactingLogger.js";
import { OpenAIModelService } from "./openai/openAIModelService.js";
import { ProviderRegistry } from "./providers/providerRegistry.js";
import type { ProviderId } from "./providers/types.js";
import { ReloadCoordinator } from "./reload/reloadCoordinator.js";
import { RemoteManager } from "./remote/remoteManager.js";
import { SnapshotService } from "./snapshots/snapshotService.js";
import { SyntheticApiService } from "./synthetic/syntheticApiService.js";
import { ClaudeTranscriptRepairService } from "./transcripts/claudeTranscriptRepairService.js";
import { ProviderUsageStatusBarController } from "./ui/providerUsageStatusBarController.js";
import { StatusBarController } from "./ui/statusBarController.js";
import { SyntheticQuotaStatusBarController } from "./ui/syntheticQuotaStatusBarController.js";
import { detectProvider } from "./validation/providerDetector.js";
import { ValidationService } from "./validation/validationService.js";

type Command = (...args: never[]) => void | Promise<void>;

function guardedCommand(
  logger: RedactingLogger,
  command: Command,
): (...args: never[]) => Promise<void> {
  return async (...args: never[]) => {
    try {
      await command(...args);
    } catch (error) {
      const message = logger.error(error);
      await vscode.window.showErrorMessage(message);
    }
  };
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel(
    "ModelHop for Claude Code",
  );
  const logger = new RedactingLogger(output);
  const settingsService = new ClaudeSettingsService();
  const credentialService = new CredentialService(
    context.secrets,
    (secret) => {
      logger.registerSecret(secret);
    },
  );
  const runtimeManager = new CodexRuntimeManager(context);
  const bridgeManager = new BridgeManager(
    context,
    credentialService,
    runtimeManager,
    logger,
  );
  await bridgeManager.initialize();
  const providerRegistry = new ProviderRegistry(
    credentialService,
    () => bridgeManager.getBaseUrl(),
  );
  const syntheticApiService = new SyntheticApiService(
    credentialService,
  );
  const openAIModelService = new OpenAIModelService(credentialService);
  const validationService = new ValidationService();
  const snapshotService = new SnapshotService(
    context,
    () => providerRegistry.getSyntheticSettings().baseUrl,
    (secret) => {
      logger.registerSecret(secret);
    },
    () => bridgeManager.getBaseUrl(),
  );
  const reloadCoordinator = new ReloadCoordinator(context);
  const transcriptRepairService = new ClaudeTranscriptRepairService(
    vscode.Uri.joinPath(
      context.globalStorageUri,
      "conversation-backups",
    ).fsPath,
  );
  const statusBarController = new StatusBarController(
    settingsService,
    providerRegistry,
    logger,
    bridgeManager.getBaseUrl(),
  );
  const switchCommand = new SwitchProviderCommand(
    context,
    settingsService,
    providerRegistry,
    credentialService,
    validationService,
    snapshotService,
    reloadCoordinator,
    transcriptRepairService,
    logger,
    bridgeManager,
  );
  const modelRoutingCommand = new ModelRoutingCommand(
    settingsService,
    providerRegistry,
    credentialService,
    syntheticApiService,
    switchCommand,
    logger,
  );
  const openAIModelRoutingCommand = new OpenAIModelRoutingCommand(
    settingsService,
    providerRegistry,
    openAIModelService,
    switchCommand,
    () => bridgeManager.getBaseUrl(),
    logger,
  );
  const quotaStatusBarController =
    new SyntheticQuotaStatusBarController(
      settingsService,
      providerRegistry,
      credentialService,
      syntheticApiService,
      logger,
    );
  const providerUsageController =
    new ProviderUsageStatusBarController(
      settingsService,
      providerRegistry,
      bridgeManager,
      logger,
    );

  const register = (
    commandIds: string | readonly string[],
    command: Command,
  ): void => {
    for (const commandId of [commandIds].flat()) {
      context.subscriptions.push(
        vscode.commands.registerCommand(
          commandId,
          guardedCommand(logger, command),
        ),
      );
    }
  };

  const currentProvider = (): ReturnType<typeof detectProvider> =>
    detectProvider(
      settingsService.read().effectiveRawValue,
      providerRegistry.getSyntheticSettings().baseUrl,
      bridgeManager.getBaseUrl(),
    );
  const currentRemoteProvider = (): ProviderId => {
    const provider = currentProvider();
    if (
      provider === "anthropic" ||
      provider === "synthetic" ||
      provider === "openai-api" ||
      provider === "openai-codex"
    ) {
      return provider;
    }
    throw new Error(
      "ModelHop Remote requires Anthropic, Synthetic, OpenAI API, or OpenAI via Codex to be active.",
    );
  };
  const remoteManager = new RemoteManager(
    context,
    settingsService,
    providerRegistry,
    credentialService,
    syntheticApiService,
    bridgeManager,
    switchCommand,
    reloadCoordinator,
    logger,
    currentRemoteProvider,
    openAIModelService,
  );
  switchCommand.setExecutionGuard(() =>
    remoteManager.allowLocalProviderSwitch(),
  );

  const configureOpenAIModels = async (
    providerId: "openai-api" | "openai-codex",
  ): Promise<void> => {
    if (
      providerId === "openai-api" &&
      !(await credentialService.hasOpenAIApiKey()) &&
      !(await promptForOpenAIApiKey(credentialService))
    ) {
      return;
    }
    if (providerId === "openai-codex") {
      await bridgeManager.prepare(
        providerId,
        providerRegistry.getOpenAISettings(providerId),
        { validateModels: false },
      );
      await openAIModelRoutingCommand.execute(
        providerId,
        await bridgeManager.codexModels(),
      );
      return;
    }
    await openAIModelRoutingCommand.execute(providerId);
  };

  const showUsage = async (): Promise<void> => {
    if (currentProvider() === "synthetic") {
      await quotaStatusBarController.showDetails();
    } else {
      await providerUsageController.showDetails();
    }
  };
  const logoutCodex = async (): Promise<void> => {
    if (currentProvider() !== "openai-codex") {
      await vscode.window.showWarningMessage(
        "ChatGPT/Codex account management is available while the experimental Codex provider is active.",
      );
      return;
    }
    const action = await vscode.window.showWarningMessage(
      "Sign the managed Codex runtime out and switch Claude Code back to Anthropic?",
      { modal: true },
      "Sign Out and Switch",
    );
    if (action !== "Sign Out and Switch") {
      return;
    }
    await bridgeManager.logoutCodex();
    await switchCommand.execute("anthropic", {
      skipConfirmation: true,
    });
  };

  register(["modelHop.select", "claudeProvider.select"], async () => {
    await selectProviderCommand(
      settingsService,
      providerRegistry,
      credentialService,
      switchCommand,
      {
        configureSyntheticModels: async () => {
          await modelRoutingCommand.execute();
        },
        configureOpenAIModels,
        showUsage,
        logoutCodex,
      },
      bridgeManager.getBaseUrl(),
    );
    void quotaStatusBarController.refresh();
    void providerUsageController.refresh();
  });
  register(
    ["modelHop.useSynthetic", "claudeProvider.useSynthetic"],
    async () => switchCommand.execute("synthetic"),
  );
  register(
    ["modelHop.useAnthropic", "claudeProvider.useAnthropic"],
    async () => switchCommand.execute("anthropic"),
  );
  register("modelHop.useOpenAIApi", async () =>
    switchCommand.execute("openai-api"),
  );
  register("modelHop.useOpenAICodex", async () =>
    switchCommand.execute("openai-codex"),
  );
  register("modelHop.logoutOpenAICodex", logoutCodex);
  register(["modelHop.toggle", "claudeProvider.toggle"], async () => {
    await switchCommand.execute(
      currentProvider() === "synthetic" ? "anthropic" : "synthetic",
    );
  });
  register(
    ["modelHop.validate", "claudeProvider.validate"],
    async () => {
      await validateCommand(
        settingsService,
        providerRegistry,
        validationService,
        bridgeManager.getBaseUrl(),
      );
    },
  );
  register(
    [
      "modelHop.showEffectiveConfiguration",
      "claudeProvider.showEffectiveConfiguration",
    ],
    () => {
      showEffectiveConfiguration(
        settingsService,
        providerRegistry,
        logger,
        bridgeManager.getBaseUrl(),
      );
    },
  );
  register(["modelHop.restore", "claudeProvider.restore"], async () => {
    await restoreCommand(
      settingsService,
      snapshotService,
      reloadCoordinator,
      logger,
    );
  });
  register(
    ["modelHop.setSyntheticToken", "claudeProvider.setSyntheticToken"],
    async () => {
      if (await setSyntheticTokenCommand(credentialService)) {
        if (currentProvider() === "synthetic") {
          await bridgeManager.prepare(
            "synthetic",
            providerRegistry.getSyntheticSettings(),
          );
        }
        void quotaStatusBarController.refresh();
      }
    },
  );
  register(
    [
      "modelHop.clearSyntheticToken",
      "claudeProvider.clearSyntheticToken",
    ],
    async () => {
      if (currentProvider() === "synthetic") {
        const action = await vscode.window.showWarningMessage(
          "Clearing the active Synthetic token will switch Claude Code back to Anthropic and reload the window.",
          { modal: true },
          "Clear and Switch",
        );
        if (action !== "Clear and Switch") {
          return;
        }
        await clearSyntheticTokenCommand(credentialService);
        await switchCommand.execute("anthropic", {
          skipConfirmation: true,
        });
        return;
      }
      await clearSyntheticTokenCommand(credentialService);
    },
  );
  register("modelHop.setOpenAIKey", async () => {
    if (
      (await setOpenAIApiKeyCommand(credentialService)) &&
      currentProvider() === "openai-api"
    ) {
      await bridgeManager.prepare(
        "openai-api",
        providerRegistry.getOpenAISettings("openai-api"),
      );
    }
  });
  register("modelHop.clearOpenAIKey", async () => {
    if (currentProvider() === "openai-api") {
      const action = await vscode.window.showWarningMessage(
        "Clearing the active OpenAI API key will switch Claude Code back to Anthropic and reload the window.",
        { modal: true },
        "Clear and Switch",
      );
      if (action !== "Clear and Switch") {
        return;
      }
      await clearOpenAIApiKeyCommand(credentialService);
      await switchCommand.execute("anthropic", {
        skipConfirmation: true,
      });
      return;
    }
    await clearOpenAIApiKeyCommand(credentialService);
  });
  register(
    ["modelHop.openSettings", "claudeProvider.openSettings"],
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:private.claude-provider-switcher",
      );
    },
  );
  register(
    "modelHop.continueOnPhone",
    async () => remoteManager.continueOnPhone(),
  );
  register(
    "modelHop.returnToLaptop",
    async () => remoteManager.returnToLaptop(),
  );
  register(
    "modelHop.recoverRemoteConversation",
    async () => {
      await remoteManager.recoverLastRemoteConversation();
    },
  );
  register(
    "modelHop.stopRemoteAccess",
    async () => remoteManager.stopRemoteAccess(),
  );
  register(
    "modelHop.managePairedDevices",
    async () => remoteManager.managePairedDevices(),
  );
  register(
    "modelHop.createRemoteSupportBundle",
    async () => remoteManager.createSupportBundle(),
  );
  register(
    [
      "modelHop.configureSyntheticModels",
      "claudeProvider.configureSyntheticModels",
    ],
    async () => modelRoutingCommand.execute(),
  );
  register("modelHop.configureOpenAIApiModels", async () =>
    configureOpenAIModels("openai-api"),
  );
  register("modelHop.configureOpenAICodexModels", async () =>
    configureOpenAIModels("openai-codex"),
  );
  register(
    [
      "modelHop.showUsage",
      "claudeProvider.showSyntheticUsage",
    ],
    showUsage,
  );
  register(
    [
      "modelHop.openSyntheticUsage",
      "claudeProvider.openSyntheticUsage",
    ],
    async () => quotaStatusBarController.openUsageAndBilling(),
  );
  register(
    [
      "modelHop.repairConversations",
      "claudeProvider.repairConversations",
    ],
    async () => {
      const summary =
        await transcriptRepairService.repairWorkspaceTranscripts(
          (vscode.workspace.workspaceFolders ?? []).map(
            (folder) => folder.uri.fsPath,
          ),
        );
      if (summary.filesChanged === 0) {
        await vscode.window.showInformationMessage(
          summary.filesScanned === 0
            ? "No Claude Code conversations were found for the current workspace."
            : "No incompatible provider conversation data was found.",
        );
        return;
      }
      await reloadCoordinator.markPending({
        provider: currentProvider(),
        switchedAt: Date.now(),
        reason: "repair",
        workspaceOverride: false,
        transcriptRepair: summary,
      });
      await reloadCoordinator.reloadWindow();
    },
  );

  context.subscriptions.push(
    output,
    statusBarController,
    quotaStatusBarController,
    providerUsageController,
    remoteManager,
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        quotaStatusBarController.handleWindowFocus();
        void providerUsageController.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("claudeCode.environmentVariables") ||
        event.affectsConfiguration("modelHop") ||
        event.affectsConfiguration("claudeProvider")
      ) {
        statusBarController.refresh();
        quotaStatusBarController.handleConfigurationChange();
        providerUsageController.handleConfigurationChange();
      }
    }),
  );

  statusBarController.refresh();
  quotaStatusBarController.start();
  providerUsageController.start();
  const detected = currentProvider();
  logger.info(`Detected provider: ${detected}`);
  if (
    detected === "synthetic" ||
    detected === "openai-api" ||
    detected === "openai-codex"
  ) {
    try {
      await bridgeManager.prepare(
        detected,
        detected === "synthetic"
          ? providerRegistry.getSyntheticSettings()
          : providerRegistry.getOpenAISettings(detected),
      );
    } catch (error) {
      logger.error(error);
    }
  }
  try {
    await remoteManager.initialize();
  } catch (error) {
    logger.error(error);
    await vscode.window.showWarningMessage(
      "ModelHop could not reconcile an earlier Remote tunnel safely. Provider switching remains available; run “ModelHop: Stop Remote Access” before starting another phone session.",
    );
  }
  await reloadCoordinator.showPostReloadNotification();
}

export function deactivate(): void {
  // Detached bridge, remote controller, and active Quick Tunnel survive reloads.
}
