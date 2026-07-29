import * as vscode from "vscode";
import {
  clearSyntheticTokenCommand,
  setSyntheticTokenCommand,
} from "./commands/credentialCommands.js";
import { restoreCommand } from "./commands/restoreCommand.js";
import { ModelRoutingCommand } from "./commands/modelRoutingCommand.js";
import { selectProviderCommand } from "./commands/selectProviderCommand.js";
import { SwitchProviderCommand } from "./commands/switchProviderCommand.js";
import {
  showEffectiveConfiguration,
  validateCommand,
} from "./commands/validateCommand.js";
import { ClaudeSettingsService } from "./configuration/claudeSettingsService.js";
import { CredentialService } from "./credentials/credentialService.js";
import { RedactingLogger } from "./logging/redactingLogger.js";
import { ProviderRegistry } from "./providers/providerRegistry.js";
import { ReloadCoordinator } from "./reload/reloadCoordinator.js";
import { SnapshotService } from "./snapshots/snapshotService.js";
import { StatusBarController } from "./ui/statusBarController.js";
import { SyntheticQuotaStatusBarController } from "./ui/syntheticQuotaStatusBarController.js";
import { detectProvider } from "./validation/providerDetector.js";
import { ValidationService } from "./validation/validationService.js";
import { SyntheticApiService } from "./synthetic/syntheticApiService.js";
import { ClaudeTranscriptRepairService } from "./transcripts/claudeTranscriptRepairService.js";

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
    "Synthetic for Claude Code",
  );
  const logger = new RedactingLogger(output);
  const settingsService = new ClaudeSettingsService();
  const credentialService = new CredentialService(
    context.secrets,
    (secret) => {
      logger.registerSecret(secret);
    },
  );
  const providerRegistry = new ProviderRegistry(credentialService);
  const syntheticApiService = new SyntheticApiService(
    credentialService,
  );
  const validationService = new ValidationService();
  const snapshotService = new SnapshotService(
    context,
    () => providerRegistry.getSyntheticSettings().baseUrl,
    (secret) => {
      logger.registerSecret(secret);
    },
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
  );
  const modelRoutingCommand = new ModelRoutingCommand(
    settingsService,
    providerRegistry,
    credentialService,
    syntheticApiService,
    switchCommand,
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

  const register = (
    commandId: string,
    command: Command,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        commandId,
        guardedCommand(logger, command),
      ),
    );
  };

  register("claudeProvider.select", async () => {
    await selectProviderCommand(
      settingsService,
      providerRegistry,
      credentialService,
      switchCommand,
      {
        configureModels: async () => {
          await modelRoutingCommand.execute();
        },
        showUsage: async () => {
          await quotaStatusBarController.showDetails();
        },
      },
    );
    void quotaStatusBarController.refresh();
  });
  register("claudeProvider.useSynthetic", async () => {
    await switchCommand.execute("synthetic");
  });
  register("claudeProvider.useAnthropic", async () => {
    await switchCommand.execute("anthropic");
  });
  register("claudeProvider.toggle", async () => {
    const current = detectProvider(
      settingsService.read().effectiveRawValue,
      providerRegistry.getSyntheticSettings().baseUrl,
    );
    await switchCommand.execute(
      current === "synthetic" ? "anthropic" : "synthetic",
    );
  });
  register("claudeProvider.validate", async () => {
    await validateCommand(
      settingsService,
      providerRegistry,
      validationService,
    );
  });
  register("claudeProvider.showEffectiveConfiguration", () => {
    showEffectiveConfiguration(
      settingsService,
      providerRegistry,
      logger,
    );
  });
  register("claudeProvider.restore", async () => {
    await restoreCommand(
      settingsService,
      snapshotService,
      reloadCoordinator,
      logger,
    );
  });
  register("claudeProvider.setSyntheticToken", async () => {
    if (await setSyntheticTokenCommand(credentialService)) {
      void quotaStatusBarController.refresh();
    }
  });
  register("claudeProvider.clearSyntheticToken", async () => {
    await clearSyntheticTokenCommand(
      credentialService,
      settingsService,
      reloadCoordinator,
      logger,
    );
  });
  register("claudeProvider.openSettings", async () => {
    await settingsService.openGlobalSettings();
  });
  register("claudeProvider.configureSyntheticModels", async () => {
    await modelRoutingCommand.execute();
  });
  register("claudeProvider.showSyntheticUsage", async () => {
    await quotaStatusBarController.showDetails();
  });
  register("claudeProvider.openSyntheticUsage", async () => {
    await quotaStatusBarController.openUsageAndBilling();
  });
  register("claudeProvider.repairConversations", async () => {
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
          : "No incompatible Synthetic conversation data was found.",
      );
      return;
    }
    const provider = detectProvider(
      settingsService.read().effectiveRawValue,
      providerRegistry.getSyntheticSettings().baseUrl,
    );
    await reloadCoordinator.markPending({
      provider,
      switchedAt: Date.now(),
      reason: "repair",
      workspaceOverride: false,
      transcriptRepair: summary,
    });
    await reloadCoordinator.reloadWindow();
  });

  context.subscriptions.push(
    output,
    statusBarController,
    quotaStatusBarController,
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        quotaStatusBarController.handleWindowFocus();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const providerChanged =
        event.affectsConfiguration(
          "claudeCode.environmentVariables",
        ) ||
        event.affectsConfiguration("claudeProvider.synthetic.baseUrl");
      if (providerChanged) {
        statusBarController.refresh();
        quotaStatusBarController.handleConfigurationChange();
      } else if (
        event.affectsConfiguration(
          "claudeProvider.synthetic.usageRefreshMinutes",
        )
      ) {
        quotaStatusBarController.handleConfigurationChange();
      }
    }),
  );

  statusBarController.refresh();
  quotaStatusBarController.start();
  logger.info(
    `Detected provider: ${detectProvider(
      settingsService.read().effectiveRawValue,
      providerRegistry.getSyntheticSettings().baseUrl,
    )}`,
  );
  await reloadCoordinator.showPostReloadNotification();
}

export function deactivate(): void {
  // Disposables are owned by the extension context.
}
