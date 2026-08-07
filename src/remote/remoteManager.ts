import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  Resolver,
  resolve4,
  resolveNs,
} from "node:dns/promises";
import {
  access,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import QRCode from "qrcode";
import * as vscode from "vscode";
import type { BridgeManager } from "../bridge/bridgeManager.js";
import type { SwitchProviderCommand } from "../commands/switchProviderCommand.js";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import {
  hasConfiguredModelHopSetting,
  readModelHopSetting,
} from "../configuration/modelHopConfiguration.js";
import type { CredentialService } from "../credentials/credentialService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type {
  OpenAIModel,
  OpenAIModelService,
} from "../openai/openAIModelService.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type {
  EnvironmentVariable,
  OpenAIReasoningEffort,
  ProviderId,
} from "../providers/types.js";
import type { ReloadCoordinator } from "../reload/reloadCoordinator.js";
import {
  SYNTHETIC_ALIAS_MODELS,
  type SyntheticApiService,
} from "../synthetic/syntheticApiService.js";
import {
  discoverWorkspaceSessions,
  type ClaudeWorkspaceSession,
} from "./sessionDiscovery.js";
import {
  remoteIdleTimeoutMs,
  resolveRemoteIdleTimeoutChoice,
  REMOTE_MAXIMUM_SESSION_MS,
  REMOTE_UNPAIRED_TIMEOUT_MS,
  type RemoteIdleTimeoutChoice,
} from "./lifecyclePolicy.js";
import { locateClaudeExecutable } from "./claudeRuntimeLocator.js";
import {
  claudeTabTitle,
  LEGACY_EXACT_SESSION_UI_CONFIRMATION_ERROR,
  openExactClaudeSession,
  requireVisibleClaudeSession,
} from "./claudeSessionOpener.js";
import { RemoteSetupCancelledError } from "./cancellation.js";
import {
  CloudflaredRuntimeManager,
  validateCloudflaredExecutable,
} from "./cloudflaredRuntimeManager.js";
import { CLOUDFLARED_VERSION } from "./cloudflaredManifest.js";
import { QuickTunnelManager } from "./quickTunnelManager.js";
import {
  NonRetryablePublicBootstrapRequestError,
  probePublicBootstrap,
  validateBootstrapResponse,
  type PublicBootstrapProbeResponse,
} from "./publicBootstrapProbe.js";
import { waitForQuickTunnelDns } from "./quickTunnelDns.js";
import { RemoteDeviceStore } from "./deviceStore.js";
import { RemoteRetentionManager } from "./retentionPolicy.js";
import { writeRemoteSupportBundle } from "./supportBundle.js";
import type {
  RemoteDaemonConfiguration,
  RemoteDaemonStatus,
  RemoteHandoffRecord,
  RemoteHostAction,
  RemotePermissionMode,
  RemoteProviderContext,
  RemoteSessionLease,
  RemoteTunnelState,
} from "./types.js";
import {
  activeTranscriptPath,
  transcriptTailSignature,
  waitForStableTranscript,
} from "./transcriptIntegrity.js";
import {
  REMOTE_BUILD_VERSION,
  REMOTE_PROTOCOL_VERSION,
} from "./types.js";
import {
  anthropicRemoteModel,
  assertRemoteRuntimeModel,
} from "./providerRuntime.js";

const REMOTE_PORT_KEY = "modelHop.remote.port";
const REMOTE_CONSENT_KEY = "modelHop.remote.experimentalConsent";
const REMOTE_WARNING_KEY =
  "modelHop.remote.cloudflareQuickTunnelAcknowledged";
const CLOUDFLARED_CONSENT_KEY =
  `modelHop.remote.cloudflaredDownloadAcknowledged.${CLOUDFLARED_VERSION}`;
const PENDING_SESSION_KEY = "modelHop.remote.pendingSessionOpen";
const TUNNEL_STATE_KEY = "modelHop.remote.cloudflareQuickTunnel";
const LEGACY_TUNNEL_STATE_KEY = "modelHop.remote.nativeTunnel";
const PROVIDER_SWITCH_CHECKPOINT_KEY =
  "modelHop.remote.providerSwitchCheckpoint.v1";
const REMOTE_INITIALIZATION_REQUEST_TIMEOUT_MS = 75_000;

export function preservedRemotePermissionConfiguration(
  lease?: Pick<RemoteSessionLease, "permissionMode">,
): {
  remoteMode: RemotePermissionMode;
  sdkMode: RemoteDaemonConfiguration["permissionMode"];
} {
  const remoteMode = lease?.permissionMode ?? "auto-safe";
  return {
    remoteMode,
    sdkMode: remoteMode === "auto-safe" ? "auto" : remoteMode,
  };
}

type ProviderSwitchCheckpointPhase =
  | "captured"
  | "settings-applied"
  | "reload-requested"
  | "reconfiguring"
  | "verifying"
  | "rolling-back"
  | "rolled-back"
  | "committed";

interface ProviderSwitchCheckpoint {
  version: 1;
  actionId: string;
  operationId: string;
  leaseId: string;
  workspaceOwnerId: string;
  targetProvider: ProviderId;
  previousProvider: ProviderId;
  previousProviderContext: RemoteProviderContext;
  expectedProviderContext: RemoteProviderContext;
  previousGlobalVariables: EnvironmentVariable[];
  previousEffectiveVariables: EnvironmentVariable[];
  previousEnvironmentHash: string;
  targetEnvironmentHash?: string;
  sourceSessionId: string;
  activeSessionId?: string;
  transcriptPath: string;
  transcriptSignature: string;
  repairedTranscriptSignature?: string;
  previousRouteRevision: number;
  targetRouteRevision: number;
  phase: ProviderSwitchCheckpointPhase;
  reloadRequestedByInstanceId?: string;
  reloadRequestedAt?: number;
  attempt: number;
  nextAttemptAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

class DeferredProviderSwitchAction extends Error {}

interface RemoteWorkspaceSelection {
  folders: readonly vscode.WorkspaceFolder[];
  label: string;
}

type PhoneLinkReadiness =
  | "verified"
  | "connector-registered";

interface RemoteRecoveryOptions {
  silentWhenMissing?: boolean;
  retryFailed?: boolean;
  /** Only explicit Recover/Return actions should leave an editor toast. */
  notifyOnFailure?: boolean;
}

function actionClaimToken(
  action: RemoteHostAction,
): string | undefined {
  const token = action.claimToken;
  return typeof token === "string" && token.length > 0
    ? token
    : undefined;
}

function handoffClaimToken(
  record: RemoteHandoffRecord,
): string | undefined {
  const token = record.actionClaimToken;
  return typeof token === "string" && token.length > 0
    ? token
    : undefined;
}

function leaseCanResumeOnPhone(
  state: RemoteSessionLease["state"],
): boolean {
  return [
    "starting",
    "waiting-for-device",
    "paired",
    "running",
    "waiting-for-permission",
    "waiting-for-question",
    "switching-provider",
  ].includes(state);
}

function leaseHasActiveExecution(
  lease: RemoteSessionLease | undefined,
): boolean {
  if (!lease) {
    return false;
  }
  return (
    (lease.backgroundTaskCount ?? 0) > 0 ||
    (lease.turnStartedAt !== undefined &&
      lease.turnCompletedAt === undefined) ||
    [
      "running",
      "waiting-for-permission",
      "waiting-for-question",
      "switching-provider",
      "handing-back",
    ].includes(lease.state)
  );
}

/**
 * Provider mutation is allowed only after the daemon's independent execution
 * axis reports authoritative quiescence. The provider-switch operation itself
 * changes the lease presentation to `switching-provider`, so lease state alone
 * can never be used as the barrier.
 */
export function remoteProviderSwitchIsQuiescent(
  status: Pick<RemoteDaemonStatus, "lease" | "query">,
): boolean {
  if (!status.lease) {
    return false;
  }
  if (status.query) {
    return status.query.state === "idle";
  }
  return (
    (status.lease.backgroundTaskCount ?? 0) === 0 &&
    (status.lease.turnStartedAt === undefined ||
      status.lease.turnCompletedAt !== undefined)
  );
}

/**
 * Compare only route authority, never presentation-only usage/catalog data.
 * A provider may enrich its initialized context, but it cannot silently
 * change the selected provider, model, role routing, or requested effort.
 */
export function remoteProviderRouteMatches(
  expected: RemoteProviderContext,
  actual: RemoteProviderContext,
): boolean {
  if (
    expected.provider !== actual.provider ||
    expected.model !== actual.model ||
    expected.roleModels.default !== actual.roleModels.default ||
    expected.roleModels.opus !== actual.roleModels.opus ||
    expected.roleModels.sonnet !== actual.roleModels.sonnet ||
    expected.roleModels.haiku !== actual.roleModels.haiku ||
    expected.roleModels.subagent !== actual.roleModels.subagent
  ) {
    return false;
  }
  const expectedEffort =
    expected.reasoning?.effectiveEffort ?? expected.reasoningEffort;
  const actualEffort =
    actual.reasoning?.effectiveEffort ?? actual.reasoningEffort;
  return expectedEffort === undefined || expectedEffort === actualEffort;
}

function deterministicPort(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return 18_700 + digest.readUInt16BE(0) % 900;
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function environmentRecord(
  variables: readonly { name: string; value: string }[],
): Record<string, string> {
  return Object.fromEntries(
    variables.map((variable) => [variable.name, variable.value]),
  );
}

function environmentHash(
  variables: readonly { name: string; value: string }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...variables].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      ),
    )
    .digest("hex");
}

function canonicalSyntheticModel(model: string): string {
  const alias = SYNTHETIC_ALIAS_MODELS.find(
    (candidate) => candidate.id === model,
  );
  return alias?.aliasResolution ?? model;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function networkFailureKind(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const code = errorCode(current);
    if (code && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
      return code;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      break;
    }
    current = current.cause;
  }
  return error instanceof Error ? error.name : "network error";
}

function tunnelIdentity(tunnel: RemoteTunnelState): string {
  return [
    tunnel.pid,
    tunnel.startedAt,
    tunnel.baseUrl,
    tunnel.configPath,
  ].join(":");
}

class ReadinessResponseTooLargeError extends Error {
  public constructor() {
    super("The remote readiness response was too large.");
    this.name = "ReadinessResponseTooLargeError";
  }
}

async function readLimitedResponse(
  response: Response,
  maximumBytes = 64 * 1024,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const declared = Number(
    response.headers.get("content-length") ?? "0",
  );
  if (
    Number.isFinite(declared) &&
    declared > maximumBytes
  ) {
    await response.body.cancel();
    throw new ReadinessResponseTooLargeError();
  }
  const reader = response.body.getReader() as unknown as {
    read: () => Promise<{
      done: boolean;
      value?: Uint8Array;
    }>;
    cancel: () => Promise<void>;
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value = result.value;
    if (!value) {
      continue;
    }
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new ReadinessResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

export class RemoteManager implements vscode.Disposable {
  private readonly stateDirectory: string;
  private readonly tunnelManager: QuickTunnelManager;
  private readonly cloudflaredRuntime: CloudflaredRuntimeManager;
  private readonly retentionManager: RemoteRetentionManager;
  private readonly statusItem: vscode.StatusBarItem;
  private port: number;
  private controlToken = "";
  private supervisorTimer: NodeJS.Timeout | undefined;
  private supervisorCycleInFlight = false;
  private supervisorBackoffMs = 700;
  private pollingGeneration = 0;
  private tunnel: RemoteTunnelState | undefined;
  /** Stable across a full-window reload, distinct across editor sessions. */
  private readonly windowOwnerId =
    (vscode.env as typeof vscode.env & { sessionId?: string })
      .sessionId ?? randomUUID();
  /** Changes on every extension activation so reload resumption is explicit. */
  private readonly managerInstanceId = randomUUID();
  private readonly workspaceOwnerId: string;
  private readonly actionsInFlight = new Set<string>();
  private actionPollInFlight = false;
  private readonly blockedHandbackActions = new Set<string>();
  private readonly pairingPrompts = new Set<string>();
  private healthFailureCount = 0;
  private reconcilingFailure = false;
  private lastKnownStatus: RemoteDaemonStatus | undefined;
  private transportUnavailableLeaseId: string | undefined;
  private daemonBuildMismatch = false;
  private disposed = false;
  private lastBridgeActivitySignature = "";
  private recoveryInFlight: Promise<boolean> | undefined;
  private handoffFinalizationTimer: NodeJS.Timeout | undefined;
  private handbackInFlight: Promise<void> | undefined;
  private handbackInFlightStrategy: "finish" | "cancel" | undefined;
  private handbackEscalationInFlight: Promise<void> | undefined;
  private handbackInFlightIdentity:
    | { leaseId: string; operationId: string }
    | undefined;
  private handbackStabilityAttempt:
    | {
        leaseId: string;
        operationId?: string;
        abortController: AbortController;
        restartRequested: boolean;
      }
    | undefined;
  private desktopHandbackIntent:
    | { requestId: string; strategy: "finish" | "cancel" }
    | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly credentials: CredentialService,
    private readonly syntheticApi: SyntheticApiService,
    private readonly bridgeManager: BridgeManager,
    private readonly switchCommand: SwitchProviderCommand,
    private readonly reloadCoordinator: ReloadCoordinator,
    private readonly logger: RedactingLogger,
    private readonly currentProvider: () => ProviderId,
    private readonly openAIModelService?: Pick<
      OpenAIModelService,
      "listModels"
    >,
  ) {
    this.stateDirectory = vscode.Uri.joinPath(
      context.globalStorageUri,
      "remote",
    ).fsPath;
    this.port =
      context.globalState.get<number>(REMOTE_PORT_KEY) ??
      deterministicPort(context.globalStorageUri.fsPath);
    this.workspaceOwnerId = createHash("sha256")
      .update(
        (vscode.workspace.workspaceFolders ?? [])
          .map((folder) => folder.uri.fsPath)
          .sort()
          .join("\0") || context.globalStorageUri.fsPath,
      )
      .digest("hex")
      .slice(0, 32);
    this.tunnelManager = new QuickTunnelManager(
      this.stateDirectory,
      logger,
    );
    this.retentionManager = new RemoteRetentionManager(
      path.join(this.stateDirectory, "retention-manifest.json"),
    );
    this.cloudflaredRuntime = new CloudflaredRuntimeManager(context);
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      89,
    );
    this.statusItem.command = "modelHop.continueOnPhone";
    this.statusItem.name = "ModelHop Remote";
    this.statusItem.text = "$(device-mobile) ModelHop Remote";
    this.statusItem.tooltip =
      "Continue the current Claude Code conversation on your phone";
    this.statusItem.show();
  }

  public async initialize(): Promise<void> {
    this.controlToken =
      await this.credentials.getOrCreateRemoteControlToken();
    let status = await this.health();
    if (
      status &&
      status.buildVersion !== REMOTE_BUILD_VERSION
    ) {
      if (leaseHasActiveExecution(status.lease)) {
        // An extension update must never kill a live detached query. Keep
        // supervising the old build until the turn is authoritatively idle;
        // the next new session can upgrade it under the setup lock.
        this.daemonBuildMismatch = true;
      } else {
        await this.shutdownDaemon();
        status = undefined;
      }
    }
    await this.context.globalState.update(
      LEGACY_TUNNEL_STATE_KEY,
      undefined,
    );
    const active =
      status?.configured && status.lease?.state !== "stopped";
    const authoritative = active ? status?.tunnel : undefined;
    if (
      authoritative &&
      (await this.tunnelManager.isRunning(authoritative))
    ) {
      await this.reconcileTunnels(status, authoritative);
    } else if (active) {
      await this.reconcileTunnels(status);
      if (leaseHasActiveExecution(status?.lease)) {
        // The phone transport is disposable; the detached Claude execution
        // is not. Preserve it and keep the local supervisor attached.
        this.transportUnavailableLeaseId = status?.lease?.id;
      } else {
        await this.shutdownDaemon();
        status = undefined;
      }
    } else {
      await this.reconcileTunnels(status);
    }
    const resumePolling = Boolean(
      status?.configured &&
        (status.lease?.state !== "stopped" ||
          status.hostActions.length > 0),
    );
    if (resumePolling && status) {
      this.updateStatus(status);
    } else if (status?.configured) {
      await this.shutdownDaemon();
    }
    if (status?.configured && status.lease) {
      await this.trackAttachmentRetention(status.lease).catch((error) =>
        this.logger.error(error),
      );
      await this.retentionManager.cleanup().catch((error) =>
        this.logger.error(error),
      );
      await this.reconstructPendingHandoff(status).catch((error) =>
        this.logger.error(error),
      );
      await this.retireFailedHandoffSupersededBy(
        status.lease.id,
      );
    }
    // Durable recovery must run before the daemon can reclaim host actions.
    // Otherwise a previously failed hand-back can overwrite its own recovery
    // record and be reopened in a tight loop during extension activation.
    const recovered = await this.recoverLastRemoteConversation({
      silentWhenMissing: true,
      retryFailed: false,
      notifyOnFailure: false,
    });
    if (
      !recovered &&
      resumePolling &&
      this.pendingHandoff()?.phase !== "session-opened"
    ) {
      this.startPolling();
    }
  }

  public async continueOnPhone(): Promise<void> {
    if (
      !readModelHopSetting("remote.enabled", false) &&
      !this.context.globalState.get<boolean>(
        REMOTE_CONSENT_KEY,
        false,
      )
    ) {
      const action = await vscode.window.showInformationMessage(
        "ModelHop Remote is Experimental. It creates a temporary Cloudflare Quick Tunnel while keeping ModelHop's mobile and inference services bound to this Mac.",
        { modal: true },
        "Enable Remote",
      );
      if (action !== "Enable Remote") {
        return;
      }
      await this.context.globalState.update(
        REMOTE_CONSENT_KEY,
        true,
      );
    }
    if (!(await this.showTunnelSecurityWarning())) {
      return;
    }
    try {
      await this.withRemoteSetupLock(() => this.preparePhoneSession());
    } catch (error) {
      if (error instanceof RemoteSetupCancelledError) {
        return;
      }
      throw error;
    }
  }

  public async createSupportBundle(): Promise<void> {
    const status = await this.health();
    const extensionPackage = this.context.extension.packageJSON as {
      version?: unknown;
    };
    const result = await writeRemoteSupportBundle(
      path.join(this.stateDirectory, "support-bundles"),
      {
        extensionVersion:
          typeof extensionPackage.version === "string"
            ? extensionPackage.version
            : "unknown",
        status,
        handoff: this.pendingHandoff(),
      },
    );
    const action = await vscode.window.showInformationMessage(
      `ModelHop created a privacy-safe Remote support bundle (${result.correlationId}). It excludes prompts, credentials, raw tool arguments, tunnel URLs, logs, and full paths.`,
      "Reveal Bundle",
      "Copy Correlation ID",
    );
    if (action === "Reveal Bundle") {
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(result.path),
      );
    } else if (action === "Copy Correlation ID") {
      await vscode.env.clipboard.writeText(result.correlationId);
    }
  }

  private async preparePhoneSession(): Promise<void> {
    const existing = await this.health();
    if (
      existing?.configured &&
      existing.lease &&
      leaseCanResumeOnPhone(existing.lease.state) &&
      existing.tunnel &&
      (await this.tunnelManager.isRunning(existing.tunnel))
    ) {
      const existingTunnel = existing.tunnel;
      const existingLease = existing.lease;
      await this.reconcileTunnels(existing, existingTunnel);
      try {
        const readiness = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Preparing ModelHop Remote",
            cancellable: true,
          },
          (progress, token) =>
            this.waitForPhoneLinkReady(
              existingTunnel,
              existingLease.id,
              undefined,
              (message) => progress.report({ message }),
              () => token.isCancellationRequested,
            ),
        );
        await this.showQr(
          existingTunnel,
          existingLease.id,
          readiness,
        );
        return;
      } catch (error) {
        await this.closeFailedRemoteSetup(existing);
        throw error;
      }
    }
    if (
      existing?.configured &&
      existing.lease &&
      leaseCanResumeOnPhone(existing.lease.state) &&
      leaseHasActiveExecution(existing.lease)
    ) {
      await this.recreatePhoneLink(existing);
      return;
    }
    // This path replaces, rather than resumes, the observed lease. Invalidate
    // old poll responses before teardown so they cannot restore its status or
    // Return-to-Laptop command while the next session is being prepared.
    this.stopPolling();
    this.updateStatus();
    await this.reconcileTunnels(existing);
    if (existing) {
      await this.shutdownDaemon();
    }
    // A dead daemon can still leave tunnel metadata and its old launch
    // capability behind. Replacing the lease always starts with a fresh token.
    await this.credentials.clearRemoteLaunchToken();

    const workspace = await this.selectWorkspace();
    if (!workspace) {
      return;
    }
    const session = await this.selectSession(workspace.folders);
    if (!session) {
      return;
    }

    if (!(await this.ensureCloudflaredDownloadConsent())) {
      return;
    }
    let preparedLeaseId: string | undefined;
    let preparedReadiness: PhoneLinkReadiness | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Preparing ModelHop Remote",
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({
          message: "Preparing the verified Cloudflare connector…",
        });
        const cloudflared = await this.resolveCloudflared((message) =>
          progress.report({ message }),
        );
        progress.report({ message: "Securing the local session…" });
        await this.ensureDaemon();
        const configuration = await this.createConfiguration(
          session,
          workspace.label,
          workspace.folders.map((folder) => folder.uri.fsPath),
        );
        // The user has now selected and authorised a replacement session.
        // Retire only a failed predecessor at this commit point; cancelling
        // workspace/session selection must leave manual recovery available.
        await this.retireFailedHandoffSupersededBy(
          configuration.lease.id,
        );
        preparedLeaseId = configuration.lease.id;
        const status = await this.control<RemoteDaemonStatus>(
          "/control/configure",
          {
            method: "POST",
            body: configuration,
            timeoutMs: REMOTE_INITIALIZATION_REQUEST_TIMEOUT_MS,
          },
        );

        try {
          progress.report({
            message: "Creating an account-free secure link…",
          });
          this.tunnel = await this.tunnelManager.start(
            cloudflared,
            this.port,
            () => token.isCancellationRequested,
            (message) => progress.report({ message }),
          );
          await this.context.globalState.update(
            TUNNEL_STATE_KEY,
            this.tunnel,
          );
          await this.control("/control/tunnel", {
            method: "POST",
            body: this.tunnel,
          });
          preparedReadiness = await this.waitForPhoneLinkReady(
            this.tunnel,
            configuration.lease.id,
            configuration.hostIdentityPublicKey,
            (message) => progress.report({ message }),
            () => token.isCancellationRequested,
          );
        } catch (error) {
          const failedTunnel = this.tunnel;
          const stopped =
            await this.tunnelManager.stop(failedTunnel);
          if (stopped) {
            this.tunnel = undefined;
            await this.context.globalState.update(
              TUNNEL_STATE_KEY,
              undefined,
            );
          } else if (failedTunnel) {
            await this.context.globalState.update(
              TUNNEL_STATE_KEY,
              failedTunnel,
            );
          }
          await this.shutdownDaemon().catch(() => undefined);
          await this.credentials
            .clearRemoteLaunchToken()
            .catch(() => undefined);
          if (!stopped) {
            throw new Error(
              "ModelHop could not verify that the failed Cloudflare tunnel process stopped. No replacement tunnel will be opened until it is resolved.",
              {
                cause: error,
              },
            );
          }
          throw error;
        }
        this.updateStatus({
          ...status,
          tunnel: this.tunnel,
        });
      },
    );
    this.startPolling();
    if (
      !this.tunnel ||
      !preparedLeaseId ||
      !preparedReadiness
    ) {
      throw new Error(
        "ModelHop did not finish creating the phone link.",
      );
    }
    await this.showQr(
      this.tunnel,
      preparedLeaseId,
      preparedReadiness,
    );
  }

  public async returnToLaptop(): Promise<void> {
    const status = await this.requireActiveStatus();
    if (!status) {
      return;
    }
    let strategy: "finish" | "cancel" = "finish";
    const candidateOperation = status.lease?.operation;
    const activeHandback =
      candidateOperation?.kind === "handback" &&
      candidateOperation.phase !== "complete" &&
      candidateOperation.phase !== "failed"
        ? candidateOperation
        : undefined;
    if (activeHandback) {
      const action = await vscode.window.showWarningMessage(
        "ModelHop is already returning this conversation. Work continues safely while it waits for durable completion. You can keep waiting, withdraw the hand-back while it is still reversible, or explicitly cancel active work and return now.",
        { modal: true },
        "Continue Waiting",
        "Keep Working Remotely",
        "Cancel Work and Return",
      );
      if (!action || action === "Continue Waiting") {
        return;
      }
      if (action === "Keep Working Remotely") {
        await this.control(
          "/control/session/cancel-handback-request",
          {
            method: "POST",
            body: { operationId: activeHandback.id },
            timeoutMs: 15_000,
          },
        );
        this.desktopHandbackIntent = undefined;
        this.updateStatus(await this.health().catch(() => status));
        return;
      }
      strategy = "cancel";
    } else if (
      status.lease?.state === "running" ||
      status.lease?.state === "waiting-for-permission" ||
      status.lease?.state === "waiting-for-question"
    ) {
      const action = await vscode.window.showWarningMessage(
        "Claude is still working remotely. ModelHop can finish this turn before returning it to the laptop, or cancel it immediately.",
        { modal: true },
        "Finish and Return",
        "Cancel and Return",
      );
      if (!action) {
        return;
      }
      strategy =
        action === "Cancel and Return" ? "cancel" : "finish";
    }
    const existing = this.desktopHandbackIntent;
    const intent =
      existing?.strategy === strategy
        ? existing
        : { requestId: randomUUID(), strategy };
    this.desktopHandbackIntent = intent;
    try {
      await this.control("/control/session/request-handback", {
        method: "POST",
        body: intent,
        timeoutMs: 15_000,
      });
    } catch (error) {
      // The loopback response may be lost after the daemon durably accepted
      // the request. Reconcile its operation before reporting failure and
      // never start a second, editor-local hand-back transaction.
      const reconciled = await this.health().catch(() => undefined);
      if (reconciled?.lease?.operation?.kind !== "handback") {
        throw error;
      }
    }
    this.startPolling();
    this.updateStatus(await this.health().catch(() => status));
  }

  public async allowLocalProviderSwitch(): Promise<boolean> {
    const status =
      (await this.health().catch(() => undefined)) ??
      this.lastKnownStatus;
    if (!status?.configured || status.lease?.state === "stopped") {
      return true;
    }
    await vscode.window.showWarningMessage(
      "ModelHop Remote currently owns this Claude conversation. Change provider from the phone, or return the conversation to this laptop first, so the route and transcript cannot diverge.",
    );
    return false;
  }

  public async recoverLastRemoteConversation(
    options: RemoteRecoveryOptions = {},
  ): Promise<boolean> {
    if (this.recoveryInFlight) {
      return this.recoveryInFlight;
    }
    // globalState is shared but does not provide compare-and-swap semantics.
    // Reuse the process-safe setup lock so two editor windows cannot both
    // open/finalize the same durable hand-back from the same observed
    // revision.
    const recovery = this.withRemoteSetupLock(() =>
      this.recoverLastRemoteConversationOnce(options),
    );
    const managed = recovery.finally(() => {
      if (this.recoveryInFlight === managed) {
        this.recoveryInFlight = undefined;
      }
    });
    this.recoveryInFlight = managed;
    return managed;
  }

  /**
   * The daemon is the durable authority while hand-back is in flight. An
   * extension reload can lose the editor-side record without losing the
   * detached lease, so rebuild that record before opening or polling. The
   * active fork always wins over the source transcript.
   */
  private async reconstructPendingHandoff(
    status: RemoteDaemonStatus,
  ): Promise<boolean> {
    if (this.pendingHandoff()) {
      return false;
    }
    const lease = status.lease;
    if (!lease || lease.state !== "handing-back") {
      return false;
    }
    const operation =
      lease.operation?.kind === "handback"
        ? lease.operation
        : undefined;
    const sessionId = lease.activeSessionId ?? lease.sourceSessionId;
    const transcriptPath = activeTranscriptPath(
      lease.sourceTranscriptPath,
      sessionId,
    );
    const phase: RemoteHandoffRecord["phase"] = (() => {
      switch (operation?.phase) {
        case "waiting-for-turn":
        case "waiting-for-work":
          return "waiting-for-work";
        case "reconciling-final-record":
          return "reconciling-final-record";
        case "quiescing":
          return "quiescing";
        case "stabilizing-transcript":
          return "stabilizing-transcript";
        case "desktop-confirmed":
          return "session-opened";
        case "phone-terminal-acked":
        case "cleanup-pending":
        case "complete":
          return "cleanup-pending";
        case "failed":
          return "failed";
        case "open-command-sent":
        case "opening-session":
        default:
          return "opening-session";
      }
    })();
    const action = status.hostActions.find(
      (candidate) =>
        candidate.type === "session.handback" &&
        candidate.leaseId === lease.id &&
        (!operation || candidate.operationId === operation.id),
    );
    const transcriptSignature = [
      "opening-session",
      "session-opened",
      "cleanup-pending",
      "failed",
    ].includes(phase)
      ? await transcriptTailSignature(transcriptPath).catch(() => "")
      : "";
    const now = Date.now();
    const reconstructed: RemoteHandoffRecord = {
      version: 2,
      leaseId: lease.id,
      sessionId,
      transcriptPath,
      workspacePath: lease.workspacePath,
      title: lease.title,
      transcriptSignature,
      phase,
      actionId: action?.id,
      actionClaimToken: action ? actionClaimToken(action) : undefined,
      openedAt:
        phase === "session-opened" || phase === "cleanup-pending"
          ? operation?.updatedAt ?? now
          : undefined,
      createdAt: operation?.requestedAt ?? lease.lastActivityAt,
      updatedAt: now,
      lastError: operation?.error,
    };
    // Recheck after filesystem work; another editor may have restored the
    // same global record while the transcript signature was calculated.
    if (this.pendingHandoff()) {
      return false;
    }
    await this.context.globalState.update(
      PENDING_SESSION_KEY,
      reconstructed,
    );
    return true;
  }

  private async recoverLastRemoteConversationOnce(
    options: RemoteRecoveryOptions,
  ): Promise<boolean> {
    const stored =
      this.context.globalState.get<
        RemoteHandoffRecord | string
      >(PENDING_SESSION_KEY);
    if (!stored) {
      if (!options.silentWhenMissing) {
        void vscode.window.showInformationMessage(
          "There is no pending ModelHop Remote conversation to recover.",
        );
      }
      return false;
    }
    const record =
      typeof stored === "string"
        ? await this.upgradeLegacyHandoff(stored)
        : stored;
    if (!record) {
      throw new Error(
        "ModelHop could not locate the pending Claude transcript.",
      );
    }
    const primaryWorkspace = vscode.workspace.workspaceFolders?.[0];
    if (
      !primaryWorkspace ||
      path.resolve(primaryWorkspace.uri.fsPath) !==
        path.resolve(record.workspacePath)
    ) {
      if (!options.silentWhenMissing) {
        void vscode.window.showWarningMessage(
          `This recovery belongs to ${record.workspacePath}. Open that folder as the first workspace folder, then run “ModelHop: Recover Last Remote Conversation” again.`,
        );
      }
      return false;
    }
    const legacyAcceptedOpen =
      record.phase === "failed" &&
      record.lastError ===
        LEGACY_EXACT_SESSION_UI_CONFIRMATION_ERROR;
    if (
      record.phase === "failed" &&
      options.retryFailed === false &&
      !legacyAcceptedOpen
    ) {
      if (record.actionId) {
        this.blockedHandbackActions.add(record.actionId);
      }
      return false;
    }
    let opened = record;
    if (
      [
        "requested",
        "waiting-for-work",
        "reconciling-final-record",
        "quiescing",
        "stabilizing-transcript",
      ].includes(opened.phase)
    ) {
      // The daemon still owns mutable work. Polling will reclaim the original
      // hand-back action once authoritative completion reaches the barrier.
      return false;
    }
    if (legacyAcceptedOpen) {
      try {
        // Older builds emitted this failure only after the exact-ID command
        // returned, and only after validating this session/transcript pair.
        // Revalidate that mapping, then migrate directly to finalization so
        // installing the fix resolves the retained loop automatically.
        await requireVisibleClaudeSession(
          record.sessionId,
          record.workspacePath,
          undefined,
          record.transcriptPath,
        );
        const migrated: RemoteHandoffRecord = {
          ...record,
          phase: "session-opened",
          openedAt: record.updatedAt,
          updatedAt: Date.now(),
          lastError: undefined,
        };
        if (!(await this.replacePendingHandoff(record, migrated))) {
          return false;
        }
        opened = migrated;
      } catch (error) {
        this.logger.error(error);
        if (record.actionId) {
          this.blockedHandbackActions.add(record.actionId);
        }
        return false;
      }
    }
    if (
      opened.phase !== "session-opened" &&
      opened.phase !== "cleanup-pending"
    ) {
      const opening: RemoteHandoffRecord = {
        ...opened,
        phase: "opening-session",
        updatedAt: Date.now(),
        lastError: undefined,
      };
      const claimed =
        typeof stored === "string"
          ? await this.storePendingHandoff(opening, stored)
          : await this.replacePendingHandoff(opened, opening);
      if (!claimed) {
        // Another window or a newer hand-back owns the durable slot. Never
        // overwrite it with the result of this older recovery attempt.
        return false;
      }
      try {
        const signature = await transcriptTailSignature(
          opening.transcriptPath,
        );
        if (
          opening.transcriptSignature &&
          signature !== opening.transcriptSignature
        ) {
          throw new Error(
            "The remote transcript changed after hand-back preparation. Reopen the remote session and retry so ModelHop can preserve its exact ordering.",
          );
        }
        const visibleSession = await requireVisibleClaudeSession(
          opening.sessionId,
          opening.workspacePath,
          undefined,
          opening.transcriptPath,
        );
        await this.openClaudeSession(
          opening.sessionId,
          visibleSession.customTitle ??
            visibleSession.summary ??
            opening.title,
          async () => {
            const accepted: RemoteHandoffRecord = {
              ...opening,
              phase: "session-opened",
              openedAt: Date.now(),
              updatedAt: Date.now(),
              lastError: undefined,
            };
            if (!(await this.replacePendingHandoff(opening, accepted))) {
              throw new Error(
                "A newer ModelHop hand-back replaced this recovery while Claude was opening.",
              );
            }
            opened = accepted;
          },
        );
        // Test hosts and older internal callers may not expose the accepted
        // callback yet. Preserve the same durable transition after their
        // successful return.
        const acceptedAfterOpen = this.pendingHandoff();
        if (
          acceptedAfterOpen?.phase === "session-opened" &&
          this.sameHandoffIdentity(acceptedAfterOpen, opening)
        ) {
          opened = acceptedAfterOpen;
        } else {
          const accepted: RemoteHandoffRecord = {
            ...opening,
            phase: "session-opened",
            openedAt: Date.now(),
            updatedAt: Date.now(),
            lastError: undefined,
          };
          if (!(await this.replacePendingHandoff(opening, accepted))) {
            return false;
          }
          opened = accepted;
        }
      } catch (error) {
        const accepted = this.pendingHandoff();
        if (
          accepted?.phase === "session-opened" &&
          this.sameHandoffIdentity(accepted, opening)
        ) {
          // The exact-ID command already returned and its success was made
          // durable. A later UI-readiness or cleanup signal cannot demote the
          // hand-back to a transcript-open failure.
          this.logger.error(error);
          opened = accepted;
        } else {
          this.logger.error(error);
          const failed: RemoteHandoffRecord = {
            ...opening,
            phase: "failed",
            updatedAt: Date.now(),
            lastError: this.logger.safeErrorMessage(error),
          };
          if (!(await this.replacePendingHandoff(opening, failed))) {
            return false;
          }
          if (failed.actionId) {
            this.blockedHandbackActions.add(failed.actionId);
          }
          if (options.notifyOnFailure !== false) {
            // Do not retain the cross-window recovery lock while an editor
            // notification waits for user interaction. The durable failed
            // record is already committed, so Retry can start a fresh,
            // serialized attempt later.
            void Promise.resolve(
              vscode.window.showErrorMessage(
                "ModelHop could not reopen the exact remote conversation. Its transcript is safe and the recovery record was retained.",
                "Retry",
                "Show Details",
              ),
            )
              .then(
                (retry) => {
                  if (retry === "Retry") {
                    void this.recoverLastRemoteConversation().catch(
                      (retryError) => this.logger.error(retryError),
                    );
                  } else if (retry === "Show Details") {
                    this.logger.show();
                  }
                },
                (notificationError) =>
                  this.logger.error(notificationError),
              );
          }
          return false;
        }
      }
    }

    return this.finalizeOpenedHandoff(opened);
  }

  private finalizeOpenedHandoff(
    opened: RemoteHandoffRecord,
  ): boolean {
    const durable = this.pendingHandoff();
    if (
      !durable ||
      (durable.phase !== "session-opened" &&
        durable.phase !== "cleanup-pending") ||
      !this.sameHandoffIdentity(durable, opened)
    ) {
      return false;
    }
    // The exact Claude tab is now the sole writable owner. Cleanup is not
    // part of that ownership commit: Cloudflare or daemon shutdown trouble
    // must never demote the open, leave Return disabled, or block a new lease.
    if (durable.actionId) {
      this.blockedHandbackActions.add(durable.actionId);
    }
    this.transportUnavailableLeaseId = undefined;
    this.updateStatus();
    this.scheduleHandoffFinalizationRetry(0);
    return true;
  }

  private async runOpenedHandoffCleanup(): Promise<void> {
    const durable = this.pendingHandoff();
    if (
      !durable ||
      (durable.phase !== "session-opened" &&
        durable.phase !== "cleanup-pending")
    ) {
      return;
    }
    // Exact-session desktop confirmation is the only point at which Remote
    // recovery material becomes eligible for the documented retention
    // policy. Retention failure is deliberately isolated from ownership and
    // tunnel cleanup; it fails closed and leaves every artifact untouched.
    await this.confirmLeaseRetention(durable).catch((error) =>
      this.logger.error(error),
    );
    let finalizing = durable;
    const status = await this.health();
    const sameLease = Boolean(
      status?.configured && status.lease?.id === durable.leaseId,
    );
    const differentLease = Boolean(
      status?.configured && status.lease?.id !== durable.leaseId,
    );
    const cleanupErrors: unknown[] = [];

    if (differentLease) {
      cleanupErrors.push(
        new Error(
          "A newer remote lease is active. ModelHop retained the prior hand-back recovery record until the old ownership is positively retired.",
        ),
      );
    }

    if (durable.actionId && !durable.actionAcknowledgedAt) {
      if (sameLease) {
        let claimToken = handoffClaimToken(finalizing);
        const reclaimed = await this.claimHostActionForCleanup(
          durable.actionId,
        ).catch((error) => {
          this.logger.error(error);
          return undefined;
        });
        const reclaimedToken = reclaimed
          ? actionClaimToken(reclaimed)
          : undefined;
        if (
          reclaimedToken &&
          reclaimedToken !== finalizing.actionClaimToken
        ) {
          const refreshed: RemoteHandoffRecord = {
            ...finalizing,
            actionClaimToken: reclaimedToken,
            updatedAt: Date.now(),
            lastError: undefined,
          };
          if (!(await this.replacePendingHandoff(finalizing, refreshed))) {
            return;
          }
          finalizing = refreshed;
          claimToken = reclaimedToken;
        }
        // If the action is absent because the previous completion response
        // was lost, the daemon's terminal tombstone accepts this replay.
        // If it is still pending, the freshly claimed token fences completion.
        await this.completeAction(
          durable.actionId,
          true,
          undefined,
          claimToken,
        ).catch((error) => {
          this.logger.error(error);
          cleanupErrors.push(error);
        });
      }
      if (sameLease && cleanupErrors.length === 0) {
        const acknowledged: RemoteHandoffRecord = {
          ...finalizing,
          actionAcknowledgedAt: Date.now(),
          updatedAt: Date.now(),
          lastError: undefined,
        };
        if (!(await this.replacePendingHandoff(finalizing, acknowledged))) {
          return;
        }
        finalizing = acknowledged;
      }
    }

    if (sameLease) {
      // stopSession itself waits for the authenticated phone terminal event
      // acknowledgement (or its bounded eight-second absence timeout).
      await this.control("/control/session/stop", {
        method: "POST",
        body: {},
        timeoutMs: 15_000,
      }).catch((error) => {
        this.logger.error(error);
        cleanupErrors.push(error);
      });
    }
    if (!differentLease) {
      await this.reconcileTunnels(status).catch((error) => {
        this.logger.error(error);
        cleanupErrors.push(error);
      });
      await this.shutdownDaemon().catch((error) => {
        this.logger.error(error);
        cleanupErrors.push(error);
      });
    }
    if (cleanupErrors.length > 0) {
      const cleanupPending: RemoteHandoffRecord = {
        ...finalizing,
        phase: "cleanup-pending",
        updatedAt: Date.now(),
        lastError: this.logger.safeErrorMessage(cleanupErrors[0]),
      };
      await this.replacePendingHandoff(finalizing, cleanupPending);
      this.scheduleHandoffFinalizationRetry();
      return;
    }
    if (!(await this.clearPendingHandoff(finalizing))) {
      return;
    }
    if (finalizing.actionId) {
      this.blockedHandbackActions.delete(finalizing.actionId);
    }
    if (!differentLease) {
      await this.credentials.clearRemoteLaunchToken();
      this.stopPolling();
      this.updateStatus();
    }
  }

  private pendingHandoff(): RemoteHandoffRecord | undefined {
    const stored =
      this.context.globalState.get<RemoteHandoffRecord | string>(
        PENDING_SESSION_KEY,
      );
    return typeof stored === "object" && stored !== null
      ? stored
      : undefined;
  }

  private sameHandoffIdentity(
    left: RemoteHandoffRecord,
    right: RemoteHandoffRecord,
  ): boolean {
    return (
      left.createdAt === right.createdAt &&
      this.sameHandoffTarget(left, right) &&
      left.actionId === right.actionId
    );
  }

  private sameHandoffTarget(
    left: RemoteHandoffRecord,
    right: RemoteHandoffRecord,
  ): boolean {
    return (
      left.leaseId === right.leaseId &&
      left.sessionId === right.sessionId &&
      left.transcriptPath === right.transcriptPath
    );
  }

  private sameHandoffRevision(
    left: RemoteHandoffRecord,
    right: RemoteHandoffRecord,
  ): boolean {
    return (
      this.sameHandoffIdentity(left, right) &&
      left.phase === right.phase &&
      left.updatedAt === right.updatedAt &&
      left.openedAt === right.openedAt &&
      left.actionAcknowledgedAt === right.actionAcknowledgedAt &&
      left.actionClaimToken === right.actionClaimToken
    );
  }

  private async storePendingHandoff(
    record: RemoteHandoffRecord,
    expectedLegacy?: string,
  ): Promise<boolean> {
    if (
      expectedLegacy !== undefined &&
      this.context.globalState.get<RemoteHandoffRecord | string>(
        PENDING_SESSION_KEY,
      ) !== expectedLegacy
    ) {
      return false;
    }
    await this.context.globalState.update(PENDING_SESSION_KEY, record);
    return true;
  }

  private async replacePendingHandoff(
    expected: RemoteHandoffRecord,
    replacement: RemoteHandoffRecord,
  ): Promise<boolean> {
    const current = this.pendingHandoff();
    if (!current || !this.sameHandoffRevision(current, expected)) {
      return false;
    }
    if (
      current.phase === "session-opened" &&
      replacement.phase !== "session-opened" &&
      replacement.phase !== "cleanup-pending"
    ) {
      // Exact-session acceptance is monotonic. A delayed command rejection,
      // timeout, or second-window attempt may add cleanup diagnostics, but it
      // must never put the transcript back into an opening/failed state.
      return false;
    }
    await this.context.globalState.update(
      PENDING_SESSION_KEY,
      replacement,
    );
    return true;
  }

  private async clearPendingHandoff(
    expected: RemoteHandoffRecord,
  ): Promise<boolean> {
    const current = this.pendingHandoff();
    if (!current || !this.sameHandoffRevision(current, expected)) {
      return false;
    }
    await this.context.globalState.update(
      PENDING_SESSION_KEY,
      undefined,
    );
    return true;
  }

  private scheduleHandoffFinalizationRetry(
    delayMs = 1_500,
  ): void {
    if (this.disposed || this.handoffFinalizationTimer) {
      return;
    }
    this.handoffFinalizationTimer = setTimeout(() => {
      this.handoffFinalizationTimer = undefined;
      void this.withRemoteSetupLock(() =>
        this.runOpenedHandoffCleanup(),
      ).catch((error) => {
        this.logger.error(error);
        this.scheduleHandoffFinalizationRetry(5_000);
      });
    }, delayMs);
  }

  private retireFailedHandoffSupersededBy(
    leaseId: string,
  ): Promise<void> {
    const pending = this.pendingHandoff();
    if (
      !pending ||
      (pending.phase !== "failed" &&
        pending.phase !== "session-opened" &&
        pending.phase !== "cleanup-pending") ||
      pending.leaseId === leaseId
    ) {
      return Promise.resolve();
    }
    // A different live lease is not proof that the prior daemon/action was
    // retired. Keep the recovery tombstone so a stale window cannot silently
    // discard ownership evidence or reopen the wrong transcript.
    if (
      pending.phase === "session-opened" ||
      pending.phase === "cleanup-pending"
    ) {
      this.scheduleHandoffFinalizationRetry();
    }
    return Promise.resolve();
  }

  public async stopRemoteAccess(): Promise<void> {
    const status = await this.health();
    const knownTunnels = this.knownTunnels(status);
    if (!status?.configured && knownTunnels.length === 0) {
      await vscode.window.showInformationMessage(
        "ModelHop Remote is not running.",
      );
      return;
    }
    const action = await vscode.window.showWarningMessage(
      "Stop phone access and close the Cloudflare Quick Tunnel?",
      { modal: true },
      "Stop Remote Access",
    );
    if (action !== "Stop Remote Access") {
      return;
    }
    let cleanupError: unknown;
    try {
      if (status?.configured) {
        await this.control("/control/session/stop", {
          method: "POST",
          body: {},
        }).catch(() => undefined);
      }
      await this.reconcileTunnels(status);
      if (status) {
        await this.shutdownDaemon();
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      if (!cleanupError) {
        await this.context.globalState.update(
          TUNNEL_STATE_KEY,
          undefined,
        );
        await this.credentials.clearRemoteLaunchToken();
        this.tunnel = undefined;
      }
      this.stopPolling();
      this.updateStatus();
    }
    if (cleanupError) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("ModelHop could not stop remote access.");
    }
  }

  public async managePairedDevices(): Promise<void> {
    const status = await this.health();
    const localStore = new RemoteDeviceStore(
      path.join(this.stateDirectory, "paired-devices.enc"),
      await this.credentials.getOrCreateRemoteDeviceStoreKey(),
    );
    await localStore.initialize();
    const devices =
      status && status.pairedDevices.length > 0
        ? status.pairedDevices
        : localStore.list();
    if (devices.length === 0) {
      await vscode.window.showInformationMessage(
        "No phones are paired with ModelHop Remote.",
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(
      devices.map((device) => ({
        label: `$(device-mobile) ${device.name}`,
        description: device.revokedAt
          ? "Revoked"
          : `Last used ${new Date(device.lastUsedAt).toLocaleString()}`,
        detail: `Paired ${new Date(device.pairedAt).toLocaleString()}`,
        device,
      })),
      {
        placeHolder: "Choose a paired phone to revoke",
        title: "ModelHop Paired Devices",
      },
    );
    if (!selected || selected.device.revokedAt) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Revoke ${selected.device.name}? It must be paired again before it can control Claude Code.`,
      { modal: true },
      "Revoke",
    );
    if (confirm !== "Revoke") {
      return;
    }
    if (status) {
      await this.control("/control/devices/revoke", {
        method: "POST",
        body: { deviceId: selected.device.id },
      });
    } else {
      await localStore.revoke(selected.device.id);
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.handoffFinalizationTimer) {
      clearTimeout(this.handoffFinalizationTimer);
      this.handoffFinalizationTimer = undefined;
    }
    this.stopPolling();
    this.statusItem.dispose();
  }

  private async selectWorkspace(): Promise<
    RemoteWorkspaceSelection | undefined
  > {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error(
        "Open the workspace containing the Claude Code conversation first.",
      );
    }
    if (folders.length === 1) {
      return {
        folders,
        label: folders[0]!.name,
      };
    }
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: "$(files) All workspace folders",
          description: `${folders.length} roots`,
          detail:
            "Continue a Claude conversation from the primary root and keep every workspace folder available.",
          folders,
          workspaceLabel:
            vscode.workspace.name ?? `${folders.length} workspace folders`,
        },
        ...folders.map((folder) => ({
          label: folder.name,
          description: folder.uri.fsPath,
          detail: "Use only this workspace folder.",
          folders: [folder],
          workspaceLabel: folder.name,
        })),
      ],
      {
        title: "Continue Claude Code on Phone",
        placeHolder:
          "Choose all folders or one workspace root to continue",
      },
    );
    return selected
      ? {
          folders: selected.folders,
          label: selected.workspaceLabel,
        }
      : undefined;
  }

  private async selectSession(
    folders: readonly vscode.WorkspaceFolder[],
  ): Promise<ClaudeWorkspaceSession | undefined> {
    const primaryFolder = vscode.workspace.workspaceFolders?.[0];
    if (!primaryFolder) {
      throw new Error(
        "Claude Code needs an open workspace before ModelHop can continue a conversation on your phone.",
      );
    }
    if (
      !folders.some(
        (folder) =>
          path.resolve(folder.uri.fsPath) ===
          path.resolve(primaryFolder.uri.fsPath),
      )
    ) {
      throw new Error(
        "Claude Code can reopen conversations only from this window's primary workspace root. Open the selected folder in its own window or choose All workspace folders.",
      );
    }
    const sessions = (
      await discoverWorkspaceSessions(primaryFolder.uri.fsPath)
    )
      .filter((session) => session.visibleToClaudeIde)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    if (sessions.length === 0) {
      throw new Error(
        "No Claude Code conversations were found for this workspace. Start a conversation in Claude Code first.",
      );
    }
    const recent = sessions.filter(
      (session) => Date.now() - session.modifiedAt < 30 * 60 * 1000,
    );
    if (recent.length === 1) {
      return recent[0];
    }
    const selected = await vscode.window.showQuickPick(
      sessions.slice(0, 30).map((session) => ({
        label: session.title,
        description: `${
          folders.find(
            (folder) =>
              folder.uri.fsPath === session.workspacePath,
          )?.name ?? path.basename(session.workspacePath)
        } · ${new Date(session.modifiedAt).toLocaleString()}`,
        detail: session.model
          ? `${session.model} · ${session.sessionId}`
          : session.sessionId,
        session,
      })),
      {
        title: "Continue Claude Code on Phone",
        placeHolder: "Choose the conversation to continue",
      },
    );
    return selected?.session;
  }

  private async createConfiguration(
    session: ClaudeWorkspaceSession,
    workspaceName: string,
    workspacePaths: readonly string[],
    existingLease?: RemoteSessionLease,
  ): Promise<RemoteDaemonConfiguration> {
    const discoveredProvider = await this.providerContext(
      this.currentProvider(),
      session.model,
    );
    const provider: RemoteProviderContext =
      existingLease?.provider.provider ===
        discoveredProvider.provider &&
      existingLease.provider.model === discoveredProvider.model
        ? {
            ...discoveredProvider,
            reasoning: existingLease.provider.reasoning,
            reasoningEffort:
              existingLease.provider.reasoningEffort ??
              discoveredProvider.reasoningEffort,
          }
        : discoveredProvider;
    const permission = preservedRemotePermissionConfiguration(
      existingLease,
    );
    const permissionMode = permission.remoteMode;
    const now = Date.now();
    const currentEffectiveVariables =
      this.settingsService.read().effective.variables;
    const currentEnvironmentHash = environmentHash(
      currentEffectiveVariables,
    );
    const identity =
      await this.credentials.getOrCreateRemoteHostIdentity();
    const lease: RemoteSessionLease = existingLease
      ? {
          ...existingLease,
          permissionMode,
          provider,
          workspacePaths: [...workspacePaths],
          lastActivityAt: now,
          desktopEnvironmentHash: currentEnvironmentHash,
        }
      : {
          id: randomUUID(),
          sourceSessionId: session.sessionId,
          sourceTranscriptPath: session.transcriptPath,
          workspacePath: session.workspacePath,
          workspacePaths: [...workspacePaths],
          workspaceName,
          title: session.title,
          state: "waiting-for-device",
          permissionMode,
          provider,
          createdAt: now,
          lastActivityAt: now,
          providerChanged: false,
          desktopEnvironmentHash: currentEnvironmentHash,
        };
    await this.trackAttachmentRetention(lease).catch((error) =>
      this.logger.error(error),
    );
    return {
      lease,
      workspaceOwnerId: this.workspaceOwnerId,
      claudeExecutable: await locateClaudeExecutable(),
      environment: environmentRecord(
        currentEffectiveVariables,
      ),
      permissionMode: permission.sdkMode,
      pairedDeviceStoreKey:
        await this.credentials.getOrCreateRemoteDeviceStoreKey(),
      hostIdentityPrivateKey: identity.privateKey,
      hostIdentityPublicKey: identity.publicKey,
      launchToken:
        await this.credentials.getOrCreateRemoteLaunchToken(lease.id),
      assetsDirectory: this.context.asAbsolutePath("dist/remote"),
      iconPath: this.context.asAbsolutePath(
        "media/modelhop-icon.png",
      ),
      unpairedTimeoutMs: REMOTE_UNPAIRED_TIMEOUT_MS,
      idleTimeoutMs: remoteIdleTimeoutMs(
        resolveRemoteIdleTimeoutChoice(
          hasConfiguredModelHopSetting("remote.idleTimeout")
            ? readModelHopSetting<RemoteIdleTimeoutChoice>(
                "remote.idleTimeout",
                "60m",
              )
            : undefined,
          readModelHopSetting<number | undefined>(
            "remote.inactivityMinutes",
            undefined,
          ),
        ),
      ),
      maximumSessionMs: REMOTE_MAXIMUM_SESSION_MS,
    };
  }

  private async attachmentRetentionRoot(
    workspacePath: string,
  ): Promise<string> {
    const gitDirectory = path.join(workspacePath, ".git");
    const gitBacked = await stat(gitDirectory)
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    return gitBacked
      ? path.join(gitDirectory, "modelhop-remote")
      : path.join(workspacePath, ".modelhop-remote");
  }

  private async trackAttachmentRetention(
    lease: Pick<RemoteSessionLease, "id" | "workspacePath">,
  ): Promise<void> {
    const root = await this.attachmentRetentionRoot(
      lease.workspacePath,
    );
    this.retentionManager.registerOwnedRoot(
      "attachment-directory",
      root,
    );
    await this.retentionManager.recordArtifact({
      kind: "attachment-directory",
      path: path.join(root, lease.id),
      sessionCorrelationId: lease.id,
      createdAt: Date.now(),
    });
  }

  private async confirmLeaseRetention(
    handoff: RemoteHandoffRecord,
  ): Promise<void> {
    await this.trackAttachmentRetention({
      id: handoff.leaseId,
      workspacePath: handoff.workspacePath,
    });
    const backupRoot = path.join(
      path.dirname(handoff.transcriptPath),
      ".modelhop-backups",
    );
    await this.retentionManager.recordRecoveryBackups(
      backupRoot,
      handoff.leaseId,
      [handoff.sessionId],
    );
    await this.retentionManager.confirmSuccessfulSession(
      handoff.leaseId,
    );
    await this.retentionManager.cleanup();
  }

  private async providerContext(
    provider: ProviderId,
    transcriptModel?: string,
  ): Promise<RemoteProviderContext> {
    let roleModels: RemoteProviderContext["roleModels"];
    let model = anthropicRemoteModel(transcriptModel);
    let reasoningEffort: OpenAIReasoningEffort | undefined;
    let usage: unknown;
    if (provider === "synthetic") {
      const settings = this.providerRegistry.getSyntheticSettings();
      roleModels = {
        default: canonicalSyntheticModel(settings.defaultModel),
        opus: canonicalSyntheticModel(settings.opusModel),
        sonnet: canonicalSyntheticModel(settings.sonnetModel),
        haiku: canonicalSyntheticModel(settings.haikuModel),
        subagent: canonicalSyntheticModel(settings.subagentModel),
      };
      model = roleModels.default;
      usage = await this.syntheticApi.getQuota().catch(() => undefined);
      const syntheticModels = await this.syntheticApi
        .listModels()
        .catch(() => []);
      const modelCatalog =
        syntheticModels.length > 0
          ? {
              source: "synthetic-api" as const,
              authoritative: true,
              options: syntheticModels.map((candidate) => ({
                selector: candidate.id,
                ...(candidate.aliasResolution
                  ? { resolvedModel: candidate.aliasResolution }
                  : {}),
                displayName:
                  candidate.aliasResolution ?? candidate.id,
                description:
                  candidate.source === "alias"
                    ? `${candidate.id} currently resolves to this Synthetic model.`
                    : "Synthetic model",
                source: "synthetic-api" as const,
                ...(candidate.contextLength
                  ? { contextWindow: candidate.contextLength }
                  : {}),
              })),
              updatedAt: Date.now(),
            }
          : undefined;
      return {
        provider,
        label: this.providerRegistry.getProfile(provider).shortLabel,
        model,
        roleModels,
        usage,
        ...(modelCatalog ? { modelCatalog } : {}),
        updatedAt: Date.now(),
      };
    } else if (
      provider === "openai-api" ||
      provider === "openai-codex"
    ) {
      const settings = this.providerRegistry.getOpenAISettings(provider);
      roleModels = {
        default: settings.defaultModel,
        opus: settings.opusModel,
        sonnet: settings.sonnetModel,
        haiku: settings.haikuModel,
        subagent: settings.subagentModel,
      };
      model = settings.defaultModel;
      reasoningEffort = settings.defaultReasoningEffort;
      usage = await this.bridgeManager.usage().catch(() => undefined);
      const providerModels: OpenAIModel[] =
        provider === "openai-codex"
          ? await this.bridgeManager.codexModels().catch(() => [])
          : await this.openAIModelService
              ?.listModels()
              .catch(() => []) ?? [];
      const modelReasoningEfforts =
        providerModels.length > 0
          ? Object.fromEntries(
              providerModels.map((candidate) => [
                candidate.id,
                [...candidate.supportedReasoningEfforts],
              ]),
            )
          : undefined;
      const modelCatalog =
        providerModels.length > 0
          ? {
              source:
                provider === "openai-codex"
                  ? ("codex-model-list" as const)
                  : ("openai-api" as const),
              authoritative: true,
              options: providerModels.map((candidate) => ({
                selector: candidate.id,
                resolvedModel: candidate.id,
                displayName: candidate.displayName || candidate.id,
                ...(candidate.description
                  ? { description: candidate.description }
                  : {}),
                source:
                  provider === "openai-codex"
                    ? ("codex-model-list" as const)
                    : ("openai-api" as const),
                supportsEffort:
                  candidate.supportedReasoningEfforts.length > 0,
                supportedEffortLevels: [
                  ...candidate.supportedReasoningEfforts,
                ],
              })),
              updatedAt: Date.now(),
            }
          : undefined;
      return {
        provider,
        label: this.providerRegistry.getProfile(provider).shortLabel,
        model,
        reasoningEffort,
        ...(modelReasoningEfforts &&
        Object.keys(modelReasoningEfforts).length > 0
          ? { modelReasoningEfforts }
          : {}),
        ...(modelCatalog ? { modelCatalog } : {}),
        roleModels,
        usage,
        updatedAt: Date.now(),
      };
    } else {
      roleModels = {
        default: model,
        opus: model,
        sonnet: model,
        haiku: model,
        subagent: model,
      };
    }
    return {
      provider,
      label: this.providerRegistry.getProfile(provider).shortLabel,
      model,
      reasoningEffort,
      roleModels,
      usage,
      updatedAt: Date.now(),
    };
  }

  private async withRemoteSetupLock<T>(
    action: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const lockPath = path.join(
      this.stateDirectory,
      "remote-setup.lock",
    );
    const deadline = Date.now() + 10 * 60 * 1000;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
      try {
        const candidate = await open(lockPath, "wx", 0o600);
        try {
          await candidate.writeFile(
            JSON.stringify({
              pid: process.pid,
              windowOwnerId: this.windowOwnerId,
              createdAt: Date.now(),
            }),
            "utf8",
          );
          lock = candidate;
        } catch (error) {
          await candidate.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
        try {
          const value = JSON.parse(
            await readFile(lockPath, "utf8"),
          ) as { pid?: number };
          if (
            !Number.isInteger(value.pid) ||
            (value.pid ?? 0) <= 0
          ) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
          process.kill(value.pid as number, 0);
        } catch (ownerError) {
          if (
            errorCode(ownerError) === "ESRCH" ||
            errorCode(ownerError) === "ENOENT" ||
            ownerError instanceof SyntaxError
          ) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "Timed out waiting for another ModelHop window to finish preparing phone access.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    try {
      return await action();
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async ensureDaemon(): Promise<void> {
    const existing = await this.health();
    if (existing?.buildVersion === REMOTE_BUILD_VERSION) {
      this.daemonBuildMismatch = false;
      return;
    }
    if (existing) {
      if (leaseHasActiveExecution(existing.lease)) {
        this.daemonBuildMismatch = true;
        throw new Error(
          "ModelHop Remote is still finishing work in the previous controller build. Return or stop that session after its active turn completes, then create the new phone link.",
        );
      }
      await this.shutdownDaemon();
    }
    if (!(await portAvailable(this.port))) {
      for (
        let candidate = this.port + 1;
        candidate < this.port + 25;
        candidate += 1
      ) {
        if (await portAvailable(candidate)) {
          this.port = candidate;
          break;
        }
      }
    }
    if (!(await portAvailable(this.port))) {
      throw new Error(
        "ModelHop could not reserve a loopback port for Remote.",
      );
    }
    await this.context.globalState.update(REMOTE_PORT_KEY, this.port);
    await mkdir(this.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const daemonPath = this.context.asAbsolutePath(
      "dist/remote-daemon.mjs",
    );
    await access(daemonPath);
    const child = spawn(
      process.execPath,
      [
        daemonPath,
        "--port",
        String(this.port),
        "--state-dir",
        this.stateDirectory,
      ],
      {
        detached: true,
        env: {
          ...process.env,
          MODELHOP_REMOTE_CONTROL_TOKEN: this.controlToken,
          MODELHOP_REMOTE_JOURNAL_KEY:
            await this.credentials.getOrCreateRemoteDeviceStoreKey(),
        },
        stdio: "ignore",
      },
    );
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.health()) {
        this.daemonBuildMismatch = false;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const log = await readFile(
      path.join(this.stateDirectory, "remote-error.log"),
      "utf8",
    ).catch(() => "");
    throw new Error(
      log.trim() || "The ModelHop Remote controller did not start.",
    );
  }

  private async showTunnelSecurityWarning(): Promise<boolean> {
    if (this.context.globalState.get<boolean>(REMOTE_WARNING_KEY)) {
      return true;
    }
    const action = await vscode.window.showWarningMessage(
      "Cloudflare Quick Tunnels create a temporary public trycloudflare.com address without an account or uptime guarantee. ModelHop still requires the secret link and desktop-confirmed encrypted pairing, keeps provider credentials on this Mac, and closes the tunnel on hand-back or timeout. Use this Experimental feature only for your own short-lived coding sessions.",
      { modal: true },
      "I Understand",
    );
    if (action !== "I Understand") {
      return false;
    }
    await this.context.globalState.update(REMOTE_WARNING_KEY, true);
    return true;
  }

  private async ensureCloudflaredDownloadConsent(): Promise<boolean> {
    const configured = this.configuredCloudflaredPath();
    if (
      configured ||
      (await this.cloudflaredRuntime.getInstalledExecutable()) ||
      this.context.globalState.get<boolean>(
        CLOUDFLARED_CONSENT_KEY,
      )
    ) {
      return true;
    }
    if (!this.cloudflaredRuntime.isSupported()) {
      throw new Error(
        "ModelHop does not provide a managed cloudflared runtime for this platform. Set modelHop.remote.cloudflaredPath to a compatible executable.",
      );
    }
    const action = await vscode.window.showWarningMessage(
      `ModelHop will download the official cloudflared ${CLOUDFLARED_VERSION} runtime into private extension storage, verify Cloudflare's published SHA-256 digest, and disable runtime auto-updates. Cloudflare's software license, online-service terms, and privacy policy apply.`,
      { modal: true },
      "Download and Continue",
      "View Cloudflare Details",
    );
    if (action === "View Cloudflare Details") {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/",
        ),
      );
      await vscode.window.showInformationMessage(
        "Review the Cloudflare details, then run “ModelHop: Continue on Phone” again when ready.",
      );
      return false;
    }
    if (action !== "Download and Continue") {
      return false;
    }
    await this.context.globalState.update(
      CLOUDFLARED_CONSENT_KEY,
      true,
    );
    return true;
  }

  private async resolveCloudflared(
    report: (message: string) => void,
  ): Promise<string> {
    const configured = this.configuredCloudflaredPath();
    if (configured) {
      if (!path.isAbsolute(configured)) {
        throw new Error(
          "modelHop.remote.cloudflaredPath must be an absolute path.",
        );
      }
      await access(configured);
      await validateCloudflaredExecutable(configured);
      return configured;
    }
    return this.cloudflaredRuntime.ensureInstalled(report);
  }

  private configuredCloudflaredPath(): string {
    const configuration =
      vscode.workspace.getConfiguration("modelHop");
    const inspected = configuration.inspect<string>(
      "remote.cloudflaredPath",
    );
    return (inspected?.globalValue ?? "").trim();
  }

  private knownTunnels(
    status?: RemoteDaemonStatus,
  ): RemoteTunnelState[] {
    const saved =
      this.context.globalState.get<RemoteTunnelState>(
        TUNNEL_STATE_KEY,
      );
    return [...new Map(
      [status?.tunnel, this.tunnel, saved]
        .filter(
          (candidate): candidate is RemoteTunnelState =>
            candidate !== undefined,
        )
        .map((candidate) => [
          tunnelIdentity(candidate),
          candidate,
        ]),
    ).values()];
  }

  private async reconcileTunnels(
    status?: RemoteDaemonStatus,
    preserve?: RemoteTunnelState,
  ): Promise<void> {
    const preservedIdentity = preserve
      ? tunnelIdentity(preserve)
      : undefined;
    for (const candidate of this.knownTunnels(status)) {
      if (tunnelIdentity(candidate) === preservedIdentity) {
        continue;
      }
      if (!(await this.tunnelManager.stop(candidate))) {
        throw new Error(
          "ModelHop found a live process where its Cloudflare tunnel should be, but could not verify ownership. No replacement tunnel was opened. Stop the process manually, then try again.",
        );
      }
    }
    this.tunnel = preserve;
    await this.context.globalState.update(
      TUNNEL_STATE_KEY,
      preserve,
    );
  }

  private async recreatePhoneLink(
    status: RemoteDaemonStatus,
  ): Promise<void> {
    const lease = status.lease;
    if (!lease) {
      throw new Error("The remote lease is unavailable.");
    }
    if (!(await this.ensureCloudflaredDownloadConsent())) {
      return;
    }
    let recreated: RemoteTunnelState | undefined;
    let readiness: PhoneLinkReadiness | undefined;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Reconnecting ModelHop Remote",
        cancellable: true,
      },
      async (progress, token) => {
        const cloudflared = await this.resolveCloudflared((message) =>
          progress.report({ message }),
        );
        progress.report({
          message: "Replacing only the phone link; Mac-side work continues…",
        });
        await this.reconcileTunnels(status);
        try {
          recreated = await this.tunnelManager.start(
            cloudflared,
            this.port,
            () => token.isCancellationRequested,
            (message) => progress.report({ message }),
          );
          this.tunnel = recreated;
          await this.context.globalState.update(
            TUNNEL_STATE_KEY,
            recreated,
          );
          await this.control("/control/tunnel", {
            method: "POST",
            body: recreated,
          });
          readiness = await this.waitForPhoneLinkReady(
            recreated,
            lease.id,
            undefined,
            (message) => progress.report({ message }),
            () => token.isCancellationRequested,
          );
        } catch (error) {
          if (recreated) {
            const stopped = await this.tunnelManager.stop(recreated);
            if (stopped) {
              this.tunnel = undefined;
              await this.context.globalState.update(
                TUNNEL_STATE_KEY,
                undefined,
              );
            }
          }
          this.transportUnavailableLeaseId = lease.id;
          this.updateTransportUnavailableStatus(status);
          throw error;
        }
      },
    );
    if (!recreated || !readiness) {
      throw new Error(
        "ModelHop did not finish recreating the phone link. Mac-side work was left running.",
      );
    }
    this.transportUnavailableLeaseId = undefined;
    this.updateStatus({ ...status, tunnel: recreated });
    this.startPolling();
    await this.showQr(recreated, lease.id, readiness);
  }

  private async closeFailedRemoteSetup(
    status: RemoteDaemonStatus,
  ): Promise<void> {
    await this.control("/control/session/stop", {
      method: "POST",
      body: {},
    }).catch(() => undefined);
    try {
      await this.reconcileTunnels(status);
    } catch (firstError) {
      await this.shutdownDaemon().catch(() => undefined);
      try {
        await this.reconcileTunnels(status);
      } catch {
        throw new Error(
          "ModelHop rejected the existing phone link but could not verify that its Cloudflare connector stopped. Run “ModelHop: Stop Remote Access” before trying again.",
          { cause: firstError },
        );
      }
    }
    if (await this.health()) {
      await this.shutdownDaemon();
    }
    await this.context.globalState.update(
      TUNNEL_STATE_KEY,
      undefined,
    );
    await this.credentials.clearRemoteLaunchToken();
    this.tunnel = undefined;
    this.stopPolling();
    this.updateStatus();
  }

  private async waitForPhoneLinkReady(
    tunnel: RemoteTunnelState,
    leaseId: string,
    expectedHostPublicKey?: string,
    report?: (message: string) => void,
    cancelled?: () => boolean,
  ): Promise<PhoneLinkReadiness> {
    if (cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }
    const launchToken =
      await this.credentials.getOrCreateRemoteLaunchToken(leaseId);
    const hostPublicKey =
      expectedHostPublicKey ??
      (
        await this.credentials.getOrCreateRemoteHostIdentity()
      ).publicKey;
    const expected = {
      version: REMOTE_PROTOCOL_VERSION,
      sessionId: leaseId,
      hostPublicKey,
      now: () => Date.now(),
    };
    const readLocalBootstrap =
      async (): Promise<PublicBootstrapProbeResponse> => {
        const localResponse = await fetch(
          `http://127.0.0.1:${this.port}/api/bootstrap`,
          {
            headers: {
              "X-ModelHop-Launch": launchToken,
            },
            redirect: "error",
            signal: AbortSignal.timeout(2_000),
          },
        );
        return {
          status: localResponse.status,
          body: await readLimitedResponse(localResponse),
        };
      };
    const validateLocalBootstrap = async (): Promise<void> => {
      validateBootstrapResponse(
        await readLocalBootstrap(),
        expected,
      );
    };
    validateBootstrapResponse(
      await readLocalBootstrap(),
      expected,
      { allowExpired: true },
    );
    if (cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }
    await this.control("/control/pairing/refresh", {
      method: "POST",
      body: {},
    });
    await validateLocalBootstrap();

    if (!(await this.tunnelManager.isRunning(tunnel))) {
      throw new Error(
        "The Cloudflare connector stopped before the phone link was ready.",
      );
    }

    report?.("Waiting for Cloudflare to publish the phone address…");
    const nameservers = await resolveNs(
      "trycloudflare.com",
    ).catch(() => []);
    const nameserverAddresses = (
      await Promise.all(
        nameservers.map((nameserver) =>
          resolve4(nameserver).catch(() => []),
        ),
      )
    ).flat();
    let dnsReadiness: Awaited<
      ReturnType<typeof waitForQuickTunnelDns>
    >;
    if (nameserverAddresses.length === 0) {
      dnsReadiness = { state: "unavailable" };
    } else {
      const authoritativeResolver = new Resolver({
        timeout: 1_500,
        tries: 1,
      });
      authoritativeResolver.setServers(nameserverAddresses);
      dnsReadiness = await waitForQuickTunnelDns({
        hostname: new URL(tunnel.baseUrl).hostname,
        resolver: {
          resolve4: async (hostname) => {
            try {
              return await authoritativeResolver.resolve4(hostname);
            } catch (error) {
              const code = errorCode(error);
              if (code === "ENOTFOUND" || code === "ENODATA") {
                return [];
              }
              throw error;
            }
          },
        },
        attempts: 120,
        maxConsecutiveErrors: 3,
        cancelled,
        wait: async () =>
          new Promise((resolve) => setTimeout(resolve, 1_000)),
      });
    }

    if (dnsReadiness.state === "not-published") {
      throw new Error(
        "Cloudflare registered the connector but did not publish its temporary phone address within two minutes. This is a Cloudflare Quick Tunnel service failure; try again later.",
      );
    }
    if (cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }
    if (!(await this.tunnelManager.isRunning(tunnel))) {
      throw new Error(
        "The Cloudflare connector stopped before the phone link was ready.",
      );
    }
    await this.control("/control/pairing/refresh", {
      method: "POST",
      body: {},
    });
    await validateLocalBootstrap();
    if (cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }

    if (dnsReadiness.state === "unavailable") {
      this.logger.info(
        "Cloudflare registered the phone link and ModelHop verified its local endpoint; the independent Cloudflare DNS check was unavailable, so the phone will perform the external connection check.",
      );
      return "connector-registered";
    }

    report?.("Verifying the secure phone link…");
    let lastTransportFailure = "network error";
    const result = await probePublicBootstrap({
      request: async (): Promise<PublicBootstrapProbeResponse> => {
        let response: Response;
        try {
          response = await fetch(
            `${tunnel.baseUrl}/api/bootstrap`,
            {
              headers: {
                "X-ModelHop-Launch": launchToken,
              },
              redirect: "error",
              signal: AbortSignal.timeout(2_000),
            },
          );
        } catch (error) {
          lastTransportFailure = networkFailureKind(error);
          throw error;
        }
        if (response.status !== 200) {
          return {
            status: response.status,
            body: "",
          };
        }
        try {
          return {
            status: response.status,
            body: await readLimitedResponse(response),
          };
        } catch (error) {
          if (error instanceof ReadinessResponseTooLargeError) {
            throw new NonRetryablePublicBootstrapRequestError(
              error.message,
              { cause: error },
            );
          }
          lastTransportFailure = networkFailureKind(error);
          throw error;
        }
      },
      isRunning: () => this.tunnelManager.isRunning(tunnel),
      expected,
      attempts: 3,
      cancelled,
      wait: async () =>
        new Promise((resolve) => setTimeout(resolve, 400)),
    });
    if (cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }
    if (result.state === "connector-registered") {
      const detail =
        result.lastFailure.kind === "transient-http"
          ? `HTTP ${result.lastFailure.status}`
          : lastTransportFailure;
      this.logger.info(
        `Cloudflare registered the phone link and ModelHop verified its local endpoint; the editor's public self-check was unavailable (${detail}), so the phone will perform the external connection check.`,
      );
    }
    return result.state;
  }

  private async showQr(
    tunnel: RemoteTunnelState,
    leaseId: string,
    readiness: PhoneLinkReadiness,
  ): Promise<void> {
    const link = new URL(tunnel.baseUrl);
    link.hash = `launch=${encodeURIComponent(
      await this.credentials.getOrCreateRemoteLaunchToken(leaseId),
    )}`;
    const remoteUrl = link.toString();
    const qr = await QRCode.toDataURL(remoteUrl, {
      width: 520,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    const readinessNote =
      readiness === "verified"
        ? ""
        : '<p class="muted">Cloudflare registered this tunnel, but the editor could not independently open the public address. If the phone cannot open it, wait a few seconds and try the link again.</p>';
    const panel = vscode.window.createWebviewPanel(
      "modelHop.remoteQr",
      "Continue Claude Code on Phone",
      vscode.ViewColumn.Active,
      { enableScripts: false },
    );
    panel.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<style>
body{font:15px var(--vscode-font-family);color:var(--vscode-foreground);
background:var(--vscode-editor-background);display:grid;place-items:center;
min-height:90vh;margin:0}.card{max-width:560px;text-align:center;padding:28px}
img{width:min(82vw,420px);background:white;border-radius:24px;padding:16px}
a{color:var(--vscode-textLink-foreground)}
.muted{color:var(--vscode-descriptionForeground);line-height:1.5}
</style></head><body><main class="card">
<h1>Continue on your phone</h1>
<p class="muted">Scan the QR code—there is no account sign-in—then confirm the same six-digit pairing code on both devices.</p>
<img src="${qr}" alt="ModelHop phone link QR code">
<p><a href="${htmlEscape(remoteUrl)}">Open the secure phone link</a></p>
${readinessNote}
<p class="muted">Temporary host: ${htmlEscape(new URL(tunnel.baseUrl).hostname)}<br>Your provider credentials remain on this Mac. Stop access from ModelHop when finished.</p>
</main></body></html>`;
  }

  private startPolling(): void {
    this.stopPolling();
    const generation = this.pollingGeneration;
    this.supervisorBackoffMs = 700;
    this.scheduleSupervisorCycle(generation, 0);
  }

  private stopPolling(): void {
    this.pollingGeneration += 1;
    if (this.supervisorTimer) {
      clearTimeout(this.supervisorTimer);
      this.supervisorTimer = undefined;
    }
  }

  private scheduleSupervisorCycle(
    generation: number,
    delayMs: number,
  ): void {
    if (!this.pollIsCurrent(generation) || this.supervisorTimer) {
      return;
    }
    this.supervisorTimer = setTimeout(() => {
      this.supervisorTimer = undefined;
      void this.runSupervisorCycle(generation);
    }, delayMs);
  }

  private async runSupervisorCycle(
    generation: number,
  ): Promise<void> {
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    if (this.supervisorCycleInFlight) {
      // A new generation can begin while the stale generation is unwinding.
      // Keep retrying the new lane rather than losing its only scheduled tick.
      this.scheduleSupervisorCycle(generation, 100);
      return;
    }
    this.supervisorCycleInFlight = true;
    try {
      // Pairing, health, tunnel reconciliation and host actions share one
      // ordered lane. A slow cycle can delay the next check, but can never
      // overlap it and apply stale ownership or teardown decisions.
      await this.pollPairings(generation);
      if (this.pollIsCurrent(generation)) {
        await this.pollActions(generation);
      }
      this.supervisorBackoffMs =
        this.healthFailureCount > 0
          ? Math.min(
              10_000,
              700 * 2 ** Math.min(this.healthFailureCount, 4),
            )
          : 700;
    } catch (error) {
      this.logger.error(error);
      this.supervisorBackoffMs = Math.min(
        10_000,
        Math.max(1_400, this.supervisorBackoffMs * 2),
      );
    } finally {
      this.supervisorCycleInFlight = false;
      if (this.pollIsCurrent(generation)) {
        this.scheduleSupervisorCycle(
          generation,
          this.supervisorBackoffMs,
        );
      }
    }
  }

  private pollIsCurrent(generation: number): boolean {
    return !this.disposed && generation === this.pollingGeneration;
  }

  private async pollPairings(generation: number): Promise<void> {
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    const status = await this.health();
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    if (!status) {
      this.healthFailureCount += 1;
      if (this.healthFailureCount >= 3) {
        await this.handleRemoteTransportFailure(
          "The local ModelHop Remote controller stopped responding.",
        );
      }
      return;
    }
    this.lastKnownStatus = status;
    this.healthFailureCount = 0;
    if (status.tunnel) {
      const tunnelRunning =
        await this.tunnelManager.isRunning(status.tunnel);
      if (!this.pollIsCurrent(generation)) {
        return;
      }
      if (!tunnelRunning) {
        await this.handleRemoteTransportFailure(
          "The Cloudflare Quick Tunnel disconnected.",
        );
        return;
      }
    }
    this.transportUnavailableLeaseId = undefined;
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    this.updateStatus(status);
    const claimed = await this.control<{
      pairings: RemoteDaemonStatus["pendingPairings"];
    }>(
      `/control/pairings?owner=${encodeURIComponent(
        this.windowOwnerId,
      )}&workspaceOwner=${encodeURIComponent(
        this.workspaceOwnerId,
      )}`,
    ).catch(() => ({ pairings: [] }));
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    for (const pairing of claimed.pairings) {
      if (this.pairingPrompts.has(pairing.connectionId)) {
        continue;
      }
      this.pairingPrompts.add(pairing.connectionId);
      void this.confirmPairing(pairing).finally(() => {
        this.pairingPrompts.delete(pairing.connectionId);
      });
    }
  }

  private async handleRemoteTransportFailure(
    message: string,
  ): Promise<void> {
    if (this.reconcilingFailure || this.disposed) {
      return;
    }
    this.reconcilingFailure = true;
    try {
      const liveStatus = await this.health();
      const status = liveStatus ?? this.lastKnownStatus;
      if (
        liveStatus?.configured &&
        liveStatus.lease?.state !== "stopped" &&
        liveStatus.tunnel &&
        (await this.tunnelManager.isRunning(liveStatus.tunnel))
      ) {
        this.healthFailureCount = 0;
        this.transportUnavailableLeaseId = undefined;
        return;
      }

      if (
        leaseHasActiveExecution(status?.lease) ||
        (!liveStatus && status?.configured)
      ) {
        // A failed display transport or an ambiguous health probe cannot be
        // treated as permission to kill detached work. Retire only tunnel
        // metadata we can positively identify; keep the controller/query and
        // local supervisor alive so the exact conversation remains recoverable.
        if (liveStatus) {
          await this.reconcileTunnels(liveStatus).catch((error) =>
            this.logger.error(error),
          );
        }
        const leaseId = status?.lease?.id ?? "unknown";
        const firstNotice =
          this.transportUnavailableLeaseId !== leaseId;
        this.transportUnavailableLeaseId = leaseId;
        this.updateTransportUnavailableStatus(status);
        if (firstNotice) {
          void vscode.window.showWarningMessage(
            `${message} Work is still running safely on this Mac. Use “ModelHop: Continue on Phone” to create a fresh link without interrupting it, or return the exact conversation to the laptop.`,
          );
        }
        return;
      }
      await this.withRemoteSetupLock(async () => {
        await this.reconcileTunnels(liveStatus);
        if (liveStatus) {
          await this.shutdownDaemon().catch(() => undefined);
        }
      });
      await this.credentials.clearRemoteLaunchToken();
      this.stopPolling();
      this.updateStatus();
      await vscode.window.showErrorMessage(
        `${message} Phone access has been closed; run “ModelHop: Continue on Phone” to create a fresh link.`,
      );
    } catch (error) {
      this.logger.error(error);
      this.stopPolling();
      this.updateStatus();
      await vscode.window.showErrorMessage(
        `${message} ModelHop could not verify that the previous tunnel stopped. Run “ModelHop: Stop Remote Access” before trying again.`,
      );
    } finally {
      this.reconcilingFailure = false;
    }
  }

  private async confirmPairing(
    pairing: RemoteDaemonStatus["pendingPairings"][number],
  ): Promise<void> {
    const deviceName = pairing.deviceName
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64)
      .toUpperCase();
    const action = await vscode.window.showInformationMessage(
      `PAIR ${pairing.sas} WITH ${deviceName}? Compare this code with the phone. You do not need to enter it anywhere.`,
      { modal: true },
      "Pair Phone",
      "Reject",
    );
    await this.control("/control/pair/confirm", {
      method: "POST",
      body: {
        connectionId: pairing.connectionId,
        allow: action === "Pair Phone",
      },
    });
  }

  private async pollActions(generation: number): Promise<void> {
    if (this.actionPollInFlight) {
      return;
    }
    this.actionPollInFlight = true;
    try {
      await this.pollActionsOnce(generation);
    } finally {
      this.actionPollInFlight = false;
    }
  }

  /**
   * Drain host actions in one ordered lane. Different command IDs are still
   * independently idempotent, but provider/model settings must never race
   * each other through overlapping polling ticks.
   */
  private async pollActionsOnce(generation: number): Promise<void> {
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    const activeProvider = this.currentProvider();
    if (
      activeProvider === "synthetic" ||
      activeProvider === "openai-api" ||
      activeProvider === "openai-codex"
    ) {
      const bridgeActivity = await this.bridgeManager
        .activity()
        .catch(() => undefined);
      if (!this.pollIsCurrent(generation)) {
        return;
      }
      if (bridgeActivity) {
        const signature = JSON.stringify(bridgeActivity);
        if (signature !== this.lastBridgeActivitySignature) {
          this.lastBridgeActivitySignature = signature;
          await this.control("/control/activity", {
            method: "POST",
            body: bridgeActivity,
          }).catch(() => undefined);
        }
      }
    }
    const result = await this.control<{ actions: RemoteHostAction[] }>(
      `/control/actions?owner=${encodeURIComponent(
        this.windowOwnerId,
      )}&workspaceOwner=${encodeURIComponent(
        this.workspaceOwnerId,
      )}`,
    ).catch(() => undefined);
    if (!this.pollIsCurrent(generation)) {
      return;
    }
    for (const action of result?.actions ?? []) {
      let pendingHandoff = this.pendingHandoff();
      const claimedToken = actionClaimToken(action);
      if (
        action.type === "session.handback" &&
        pendingHandoff?.actionId === action.id &&
        claimedToken &&
        pendingHandoff.actionClaimToken !== claimedToken
      ) {
        const refreshed: RemoteHandoffRecord = {
          ...pendingHandoff,
          actionClaimToken: claimedToken,
          updatedAt: Date.now(),
        };
        if (
          await this.replacePendingHandoff(
            pendingHandoff,
            refreshed,
          )
        ) {
          pendingHandoff = refreshed;
        }
      }
      if (
        action.type === "session.handback" &&
        pendingHandoff?.actionId === action.id
      ) {
        if (pendingHandoff.phase === "failed") {
          // A failed exact-session open is a durable, user-recoverable state.
          // Do not let daemon polling turn it into an automatic retry loop.
          this.blockedHandbackActions.add(action.id);
          continue;
        }
        if (
          pendingHandoff.phase === "session-opened" ||
          pendingHandoff.phase === "cleanup-pending"
        ) {
          if (this.actionsInFlight.has(action.id)) {
            continue;
          }
          this.actionsInFlight.add(action.id);
          try {
            // The exact Claude tab was already confirmed. Only retry the
            // daemon acknowledgement and terminal cleanup.
            await this.withActionClaimHeartbeat(action, () =>
              this.recoverLastRemoteConversation({
                silentWhenMissing: true,
                notifyOnFailure: false,
              }),
            );
          } finally {
            this.actionsInFlight.delete(action.id);
          }
          return;
        }
      }
      if (
        this.actionsInFlight.has(action.id) ||
        this.blockedHandbackActions.has(action.id)
      ) {
        continue;
      }
      this.actionsInFlight.add(action.id);
      if (action.type === "session.handback") {
        try {
          await this.withActionClaimHeartbeat(action, () =>
            this.handBack(
              action.payload.strategy === "cancel" ||
                action.payload.cancelActive === true
                ? "cancel"
                : "finish",
              action.id,
              claimedToken,
            ),
          );
        } catch (error) {
          this.logger.error(error);
          // A failed exact-session reopen remains recoverable. Do not
          // acknowledge or delete the host action until recovery succeeds.
          // This is a background phone-owned action, so an editor toast can
          // outlive a later successful retry and falsely report failure.
        } finally {
          this.actionsInFlight.delete(action.id);
        }
        return;
      }
      try {
        await this.withActionClaimHeartbeat(action, async () => {
          await this.handleAction(action);
          await this.completeAction(
            action.id,
            true,
            undefined,
            claimedToken,
          );
          if (action.type === "provider.change") {
            await this.clearProviderSwitchCheckpoint(action.id);
          }
        });
      } catch (error) {
        if (error instanceof DeferredProviderSwitchAction) {
          continue;
        }
        await this.completeAction(
          action.id,
          false,
          this.logger.safeErrorMessage(error),
          actionClaimToken(action),
        ).catch((completionError) => {
          this.logger.error(completionError);
        });
      } finally {
        this.actionsInFlight.delete(action.id);
      }
    }
  }

  private async readProviderSwitchCheckpoint(): Promise<
    ProviderSwitchCheckpoint | undefined
  > {
    const raw = await this.context.secrets.get(
      PROVIDER_SWITCH_CHECKPOINT_KEY,
    );
    if (!raw) {
      return undefined;
    }
    const value = JSON.parse(raw) as Partial<ProviderSwitchCheckpoint>;
    if (
      value.version !== 1 ||
      typeof value.actionId !== "string" ||
      typeof value.operationId !== "string" ||
      typeof value.leaseId !== "string" ||
      typeof value.workspaceOwnerId !== "string" ||
      typeof value.targetProvider !== "string" ||
      typeof value.previousProvider !== "string" ||
      typeof value.phase !== "string"
    ) {
      throw new Error(
        "The encrypted provider-switch recovery checkpoint is invalid. ModelHop left the active route unchanged.",
      );
    }
    return value as ProviderSwitchCheckpoint;
  }

  private async writeProviderSwitchCheckpoint(
    checkpoint: ProviderSwitchCheckpoint,
  ): Promise<void> {
    checkpoint.updatedAt = Date.now();
    await this.context.secrets.store(
      PROVIDER_SWITCH_CHECKPOINT_KEY,
      JSON.stringify(checkpoint),
    );
  }

  private async clearProviderSwitchCheckpoint(
    actionId?: string,
  ): Promise<void> {
    if (actionId) {
      const checkpoint = await this.readProviderSwitchCheckpoint();
      if (checkpoint && checkpoint.actionId !== actionId) {
        return;
      }
    }
    await this.context.secrets.delete(
      PROVIDER_SWITCH_CHECKPOINT_KEY,
    );
  }

  private providerSwitchSession(
    status: RemoteDaemonStatus,
  ): ClaudeWorkspaceSession {
    const lease = status.lease;
    if (!lease) {
      throw new Error("The remote lease is unavailable.");
    }
    return {
      sessionId: lease.sourceSessionId,
      transcriptPath: lease.sourceTranscriptPath,
      workspacePath: lease.workspacePath,
      title: lease.title,
      visibleToClaudeIde: true,
      modifiedAt: lease.lastActivityAt,
      size: 0,
      model: lease.provider.model,
    };
  }

  private async updateProviderSwitchOperation(
    checkpoint: ProviderSwitchCheckpoint,
    phase:
      | "waiting-for-turn"
      | "quiescing"
      | "applying"
      | "reloading"
      | "restarting"
      | "rolling-back",
    error?: string,
  ): Promise<void> {
    await this.control("/control/operation", {
      method: "POST",
      body: {
        id: checkpoint.operationId,
        phase,
        error,
      },
    });
  }

  private async captureProviderSwitchCheckpoint(
    action: RemoteHostAction,
    targetProvider: ProviderId,
    status: RemoteDaemonStatus,
  ): Promise<ProviderSwitchCheckpoint> {
    const lease = status.lease;
    if (!lease || !action.operationId) {
      throw new Error(
        "The provider switch has no durable remote operation.",
      );
    }
    assertRemoteRuntimeModel(
      lease.provider.provider,
      lease.provider.model,
    );
    if (this.currentProvider() !== lease.provider.provider) {
      throw new Error(
        `The editor is configured for ${this.currentProvider()}, but the detached Claude query still owns ${lease.provider.provider}. ModelHop refused to checkpoint a mixed route.`,
      );
    }
    const configuration = this.settingsService.read();
    const previousGlobalVariables = configuration.global.variables.map(
      (variable) => ({ ...variable }),
    );
    const previousEffectiveVariables =
      configuration.effective.variables.map((variable) => ({
        ...variable,
      }));
    const transcriptPath =
      lease.activeSessionId &&
      lease.activeSessionId !== lease.sourceSessionId
        ? activeTranscriptPath(
            lease.sourceTranscriptPath,
            lease.activeSessionId,
          )
        : lease.sourceTranscriptPath;
    const now = Date.now();
    const previousRouteRevision = lease.provider.updatedAt;
    const expectedProviderContext = await this.providerContext(
      targetProvider,
      lease.provider.model,
    );
    expectedProviderContext.updatedAt = Math.max(
      expectedProviderContext.updatedAt,
      previousRouteRevision + 1,
    );
    const checkpoint: ProviderSwitchCheckpoint = {
      version: 1,
      actionId: action.id,
      operationId: action.operationId,
      leaseId: lease.id,
      workspaceOwnerId: this.workspaceOwnerId,
      targetProvider,
      previousProvider: lease.provider.provider,
      previousProviderContext: structuredClone(lease.provider),
      expectedProviderContext,
      previousGlobalVariables,
      previousEffectiveVariables,
      previousEnvironmentHash: environmentHash(
        previousEffectiveVariables,
      ),
      sourceSessionId: lease.sourceSessionId,
      activeSessionId: lease.activeSessionId,
      transcriptPath,
      transcriptSignature: await transcriptTailSignature(
        transcriptPath,
      ),
      previousRouteRevision,
      targetRouteRevision: expectedProviderContext.updatedAt,
      phase: "captured",
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeProviderSwitchCheckpoint(checkpoint);
    return checkpoint;
  }

  private validateProviderSwitchCheckpoint(
    checkpoint: ProviderSwitchCheckpoint,
    action: RemoteHostAction,
    status: RemoteDaemonStatus,
  ): void {
    if (
      checkpoint.actionId !== action.id ||
      checkpoint.operationId !== action.operationId ||
      checkpoint.leaseId !== status.lease?.id ||
      checkpoint.workspaceOwnerId !== this.workspaceOwnerId
    ) {
      throw new Error(
        "A different editor or remote lease owns this provider switch.",
      );
    }
  }

  private assertConfiguredProviderRoute(
    status: RemoteDaemonStatus,
    expected: RemoteProviderContext,
    expectedEnvironmentHash: string,
    operationId: string,
  ): void {
    const lease = status.lease;
    if (!lease || lease.operation?.id !== operationId) {
      throw new Error(
        "The provider route initialized outside the durable switch operation.",
      );
    }
    assertRemoteRuntimeModel(
      lease.provider.provider,
      lease.provider.model,
    );
    if (!remoteProviderRouteMatches(expected, lease.provider)) {
      throw new Error(
        `Claude Code initialized ${lease.provider.provider} · ${lease.provider.model}, but ModelHop expected ${expected.provider} · ${expected.model}.`,
      );
    }
    if (lease.desktopEnvironmentHash !== expectedEnvironmentHash) {
      throw new Error(
        "Claude Code initialized with a different provider environment than the one ModelHop verified.",
      );
    }
    if (status.query && status.query.state !== "idle") {
      throw new Error(
        `The replacement Claude query did not reach an authoritative idle initialization state (${status.query.state}).`,
      );
    }
  }

  private async providerTransactionConfiguration(
    checkpoint: ProviderSwitchCheckpoint,
    status: RemoteDaemonStatus,
    provider: RemoteProviderContext,
  ): Promise<RemoteDaemonConfiguration> {
    const lease = status.lease;
    if (!lease) {
      throw new Error("The remote lease is unavailable.");
    }
    const session = this.providerSwitchSession(status);
    const configuration = await this.createConfiguration(
      session,
      lease.workspaceName,
      lease.workspacePaths ?? [lease.workspacePath],
      lease,
    );
    const effectiveVariables =
      this.settingsService.read().effective.variables;
    configuration.environment = environmentRecord(effectiveVariables);
    configuration.lease.desktopEnvironmentHash = environmentHash(
      effectiveVariables,
    );
    configuration.lease.provider = structuredClone(provider);
    configuration.lease.operation = lease.operation;
    configuration.lease.activeSessionId =
      checkpoint.activeSessionId ?? lease.activeSessionId;
    return configuration;
  }

  private async rollBackProviderSwitch(
    checkpoint: ProviderSwitchCheckpoint,
    status: RemoteDaemonStatus,
    cause: unknown,
  ): Promise<void> {
    const safeCause = this.logger.safeErrorMessage(cause);
    checkpoint.phase = "rolling-back";
    checkpoint.lastError = safeCause;
    checkpoint.attempt += 1;
    await this.writeProviderSwitchCheckpoint(checkpoint);
    await this.updateProviderSwitchOperation(
      checkpoint,
      "rolling-back",
      safeCause,
    ).catch(() => undefined);
    try {
      await this.switchCommand.execute(checkpoint.previousProvider, {
        skipConfirmation: true,
        reload: false,
        allowDuringRemoteSession: true,
      });
      // SwitchProviderCommand restores provider-owned state. The encrypted
      // checkpoint then restores the exact pre-switch global environment,
      // including shared preferences, without exposing it to the phone.
      await this.settingsService.write(
        checkpoint.previousGlobalVariables,
      );
      this.settingsService.verifyWritten(
        checkpoint.previousGlobalVariables,
      );
      if (this.currentProvider() !== checkpoint.previousProvider) {
        throw new Error(
          `ModelHop could not restore ${checkpoint.previousProvider}.`,
        );
      }
      const restoredEffectiveVariables =
        this.settingsService.read().effective.variables;
      if (
        environmentHash(restoredEffectiveVariables) !==
        checkpoint.previousEnvironmentHash
      ) {
        throw new Error(
          "The previous provider environment changed during rollback.",
        );
      }
      const currentStatus = await this.control<RemoteDaemonStatus>(
        "/control/status",
      );
      const restoredProvider = {
        ...structuredClone(checkpoint.previousProviderContext),
        updatedAt: Math.max(
          Date.now(),
          checkpoint.targetRouteRevision + 1,
        ),
      };
      const rollbackConfiguration =
        await this.providerTransactionConfiguration(
          checkpoint,
          currentStatus,
          restoredProvider,
        );
      const rollbackStatus = await this.control<RemoteDaemonStatus>(
        "/control/configure",
        {
          method: "POST",
          body: rollbackConfiguration,
          timeoutMs: REMOTE_INITIALIZATION_REQUEST_TIMEOUT_MS,
        },
      );
      this.assertConfiguredProviderRoute(
        rollbackStatus,
        restoredProvider,
        checkpoint.previousEnvironmentHash,
        checkpoint.operationId,
      );
      checkpoint.phase = "rolled-back";
      checkpoint.nextAttemptAt = undefined;
      await this.writeProviderSwitchCheckpoint(checkpoint);
    } catch (rollbackError) {
      checkpoint.phase = "rolling-back";
      checkpoint.lastError = `${safeCause} Rollback is still pending: ${this.logger.safeErrorMessage(
        rollbackError,
      )}`;
      checkpoint.nextAttemptAt =
        Date.now() + Math.min(30_000, 1_000 * checkpoint.attempt);
      await this.writeProviderSwitchCheckpoint(checkpoint);
      throw new DeferredProviderSwitchAction(
        checkpoint.lastError,
      );
    }
  }

  private async runProviderSwitchTransaction(
    action: RemoteHostAction,
    targetProvider: ProviderId,
    initialStatus: RemoteDaemonStatus,
  ): Promise<void> {
    let checkpoint = await this.readProviderSwitchCheckpoint();
    if (!checkpoint) {
      if (!remoteProviderSwitchIsQuiescent(initialStatus)) {
        if (action.operationId) {
          await this.control("/control/operation", {
            method: "POST",
            body: {
              id: action.operationId,
              phase: "waiting-for-turn",
            },
          }).catch(() => undefined);
        }
        throw new DeferredProviderSwitchAction(
          "Waiting for authoritative terminal work evidence.",
        );
      }
      checkpoint = await this.captureProviderSwitchCheckpoint(
        action,
        targetProvider,
        initialStatus,
      );
    }
    this.validateProviderSwitchCheckpoint(
      checkpoint,
      action,
      initialStatus,
    );
    if (checkpoint.targetProvider !== targetProvider) {
      throw new Error(
        "The requested provider changed after the switch transaction began.",
      );
    }
    if (
      checkpoint.nextAttemptAt &&
      checkpoint.nextAttemptAt > Date.now()
    ) {
      throw new DeferredProviderSwitchAction(
        "The previous route is being restored before this action can continue.",
      );
    }
    if (checkpoint.phase === "rolling-back") {
      await this.rollBackProviderSwitch(
        checkpoint,
        initialStatus,
        checkpoint.lastError ?? "The provider switch did not commit.",
      );
      return;
    }
    if (
      checkpoint.phase === "committed" ||
      checkpoint.phase === "rolled-back"
    ) {
      return;
    }
    if (checkpoint.previousProvider === targetProvider) {
      checkpoint.phase = "committed";
      await this.writeProviderSwitchCheckpoint(checkpoint);
      return;
    }
    try {
      if (checkpoint.phase === "captured") {
        await this.updateProviderSwitchOperation(
          checkpoint,
          "applying",
        );
        await this.switchCommand.execute(targetProvider, {
          skipConfirmation: true,
          reload: false,
          allowDuringRemoteSession: true,
        });
        if (this.currentProvider() !== targetProvider) {
          throw new Error(
            `ModelHop could not activate ${targetProvider} for the remote session.`,
          );
        }
        const effectiveVariables =
          this.settingsService.read().effective.variables;
        checkpoint.targetEnvironmentHash =
          environmentHash(effectiveVariables);
        checkpoint.repairedTranscriptSignature =
          await transcriptTailSignature(checkpoint.transcriptPath);
        checkpoint.phase = "settings-applied";
        await this.writeProviderSwitchCheckpoint(checkpoint);
      }
      if (checkpoint.phase === "settings-applied") {
        await this.updateProviderSwitchOperation(
          checkpoint,
          "reloading",
        );
        checkpoint.phase = "reload-requested";
        checkpoint.reloadRequestedAt = Date.now();
        checkpoint.reloadRequestedByInstanceId =
          this.managerInstanceId;
        await this.writeProviderSwitchCheckpoint(checkpoint);
        await this.reloadCoordinator.markPending({
          provider: targetProvider,
          switchedAt: checkpoint.reloadRequestedAt,
          reason: "switch",
          workspaceOverride: false,
        });
        await this.reloadCoordinator.reloadWindow();
        throw new DeferredProviderSwitchAction(
          "The provider switch will resume after the editor reload.",
        );
      }
      if (checkpoint.phase === "reload-requested") {
        if (
          checkpoint.reloadRequestedByInstanceId ===
          this.managerInstanceId
        ) {
          if (
            checkpoint.reloadRequestedAt &&
            Date.now() - checkpoint.reloadRequestedAt > 10_000
          ) {
            checkpoint.reloadRequestedAt = Date.now();
            await this.writeProviderSwitchCheckpoint(checkpoint);
            await this.reloadCoordinator.reloadWindow();
          }
          throw new DeferredProviderSwitchAction(
            "Waiting for the editor reload to reclaim the provider switch.",
          );
        }
        if (this.currentProvider() !== targetProvider) {
          throw new Error(
            `The reloaded editor did not retain the ${targetProvider} route.`,
          );
        }
        const transcriptSignature = await transcriptTailSignature(
          checkpoint.transcriptPath,
        );
        if (
          checkpoint.repairedTranscriptSignature &&
          transcriptSignature !==
            checkpoint.repairedTranscriptSignature
        ) {
          throw new Error(
            "The Claude transcript changed while the provider switch was reloading.",
          );
        }
        checkpoint.phase = "reconfiguring";
        await this.writeProviderSwitchCheckpoint(checkpoint);
      }
      const currentStatus = await this.control<RemoteDaemonStatus>(
        "/control/status",
      );
      if (!currentStatus.lease) {
        throw new Error("The remote lease disappeared during provider switch.");
      }
      const targetEnvironmentHash = environmentHash(
        this.settingsService.read().effective.variables,
      );
      if (
        checkpoint.targetEnvironmentHash !== targetEnvironmentHash
      ) {
        throw new Error(
          "The target provider environment changed during the editor reload.",
        );
      }
      await this.updateProviderSwitchOperation(
        checkpoint,
        "restarting",
      );
      const targetProviderContext = {
        ...structuredClone(checkpoint.expectedProviderContext),
        updatedAt: Math.max(
          checkpoint.targetRouteRevision,
          Date.now(),
        ),
      };
      if (
        currentStatus.lease.provider.provider === targetProvider &&
        remoteProviderRouteMatches(
          targetProviderContext,
          currentStatus.lease.provider,
        ) &&
        currentStatus.lease.desktopEnvironmentHash ===
          targetEnvironmentHash
      ) {
        if (
          !currentStatus.query ||
          currentStatus.query.state === "idle"
        ) {
          this.assertConfiguredProviderRoute(
            currentStatus,
            targetProviderContext,
            targetEnvironmentHash,
            checkpoint.operationId,
          );
          checkpoint.phase = "committed";
          checkpoint.lastError = undefined;
          checkpoint.nextAttemptAt = undefined;
          await this.writeProviderSwitchCheckpoint(checkpoint);
          return;
        }
        if (currentStatus.query.state !== "error") {
          checkpoint.lastError =
            "Checking the Mac for the authoritative SDK initialization result.";
          checkpoint.nextAttemptAt = Date.now() + 2_000;
          await this.writeProviderSwitchCheckpoint(checkpoint);
          throw new DeferredProviderSwitchAction(
            checkpoint.lastError,
          );
        }
      }
      const targetConfiguration =
        await this.providerTransactionConfiguration(
          checkpoint,
          currentStatus,
          targetProviderContext,
        );
      let configuredStatus: RemoteDaemonStatus;
      try {
        configuredStatus = await this.control<RemoteDaemonStatus>(
          "/control/configure",
          {
            method: "POST",
            body: targetConfiguration,
            timeoutMs: REMOTE_INITIALIZATION_REQUEST_TIMEOUT_MS,
          },
        );
      } catch (configurationError) {
        // A lost HTTP response is not an authoritative rejection. The daemon
        // may still be initializing the target query, so inspect its durable
        // route before deciding whether rollback is safe.
        const observed = await this.control<RemoteDaemonStatus>(
          "/control/status",
        ).catch(() => undefined);
        if (
          observed?.lease &&
          observed.lease.provider.provider === targetProvider &&
          remoteProviderRouteMatches(
            targetProviderContext,
            observed.lease.provider,
          ) &&
          observed.lease.desktopEnvironmentHash ===
            targetEnvironmentHash &&
          observed.query?.state !== "error"
        ) {
          if (!observed.query || observed.query.state === "idle") {
            configuredStatus = observed;
          } else {
            checkpoint.lastError =
              "Checking the Mac after the provider response was interrupted.";
            checkpoint.nextAttemptAt = Date.now() + 2_000;
            await this.writeProviderSwitchCheckpoint(checkpoint);
            throw new DeferredProviderSwitchAction(
              checkpoint.lastError,
            );
          }
        } else {
          throw configurationError;
        }
      }
      checkpoint.phase = "verifying";
      await this.writeProviderSwitchCheckpoint(checkpoint);
      this.assertConfiguredProviderRoute(
        configuredStatus,
        targetProviderContext,
        targetEnvironmentHash,
        checkpoint.operationId,
      );
      checkpoint.phase = "committed";
      checkpoint.lastError = undefined;
      await this.writeProviderSwitchCheckpoint(checkpoint);
    } catch (error) {
      if (error instanceof DeferredProviderSwitchAction) {
        throw error;
      }
      await this.rollBackProviderSwitch(
        checkpoint,
        initialStatus,
        error,
      );
    }
  }

  private async handleAction(action: RemoteHostAction): Promise<void> {
    switch (action.type) {
      case "provider.change": {
        const provider = action.payload.provider;
        if (
          provider !== "anthropic" &&
          provider !== "synthetic" &&
          provider !== "openai-api" &&
          provider !== "openai-codex"
        ) {
          throw new Error("Unknown requested provider.");
        }
        const status = await this.control<RemoteDaemonStatus>(
          "/control/status",
        );
        if (!status.lease) {
          throw new Error("The remote lease is unavailable.");
        }
        if (
          action.leaseId &&
          action.leaseId !== status.lease.id
        ) {
          throw new Error(
            "The provider switch belongs to an expired remote session.",
          );
        }
        await this.runProviderSwitchTransaction(
          action,
          provider,
          status,
        );
        return;
      }
      case "usage.refresh": {
        const status = await this.control<RemoteDaemonStatus>(
          "/control/status",
        );
        const daemonProvider = status.lease?.provider.provider;
        if (!daemonProvider) {
          return;
        }
        // Settings are written before the detached daemon is reconfigured.
        // A concurrent refresh must not relabel the old query during that gap.
        if (this.currentProvider() !== daemonProvider) {
          return;
        }
        await this.control("/control/provider", {
          method: "POST",
          body: await this.providerContext(
            daemonProvider,
            status.lease?.provider.model,
          ),
        });
        return;
      }
      case "model.sync": {
        const status = await this.control<RemoteDaemonStatus>(
          "/control/status",
        );
        if (!status.lease) {
          throw new Error("The remote lease is unavailable.");
        }
        if (action.leaseId && action.leaseId !== status.lease.id) {
          throw new Error(
            "The model change belongs to an expired remote session.",
          );
        }
        const requestedProvider = action.payload.provider;
        if (
          requestedProvider !== "anthropic" &&
          requestedProvider !== "synthetic" &&
          requestedProvider !== "openai-api" &&
          requestedProvider !== "openai-codex"
        ) {
          throw new Error("The model change has no valid provider owner.");
        }
        const providerRevision = action.payload.providerUpdatedAt;
        if (
          typeof providerRevision !== "number" ||
          !Number.isFinite(providerRevision) ||
          providerRevision !== status.lease.provider.updatedAt ||
          requestedProvider !== status.lease.provider.provider ||
          requestedProvider !== this.currentProvider()
        ) {
          throw new Error(
            "The provider changed before this model update could be synchronized.",
          );
        }
        const provider = requestedProvider;
        const model =
          typeof action.payload.model === "string"
            ? action.payload.model
            : undefined;
        if (
          !model ||
          model !== status.lease.provider.model ||
          provider === "anthropic"
        ) {
          return;
        }
        if (provider === "synthetic") {
          await this.providerRegistry.updateSyntheticModel(
            "defaultModel",
            model,
          );
        } else {
          const effort =
            typeof action.payload.reasoningEffort === "string" &&
            [
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ].includes(action.payload.reasoningEffort)
              ? (action.payload
                  .reasoningEffort as OpenAIReasoningEffort)
              : this.providerRegistry.getOpenAISettings(provider)
                  .defaultReasoningEffort;
          await this.providerRegistry.updateOpenAIRoute(
            provider,
            "defaultModel",
            model,
            effort,
          );
        }
        await this.switchCommand.execute(provider, {
          skipConfirmation: true,
          reload: false,
          allowDuringRemoteSession: true,
        });
        return;
      }
      case "codex.reset": {
        const confirm = await vscode.window.showWarningMessage(
          "Use one available Codex reset credit for the remote session?",
          { modal: true },
          "Use Reset Credit",
        );
        if (confirm !== "Use Reset Credit") {
          throw new Error("Reset credit use was cancelled.");
        }
        await this.bridgeManager.consumeCodexReset(
          typeof action.payload.creditId === "string"
            ? action.payload.creditId
            : undefined,
        );
        return;
      }
      case "session.handback":
        // Terminal hand-back is handled by pollActions so it can be
        // acknowledged before the detached daemon shuts down.
        return;
    }
  }

  private async handBack(
    strategy: "finish" | "cancel",
    actionId?: string,
    claimToken?: string,
  ): Promise<void> {
    if (this.handbackInFlight) {
      const activeHandback = this.handbackInFlight;
      if (strategy === "cancel") {
        if (this.handbackInFlightStrategy === "cancel") {
          await this.restartCurrentHandbackStability();
          return activeHandback;
        }
        if (!this.handbackEscalationInFlight) {
          const escalation = this.escalateHandbackCancellation().then(
            () => {
              // Do not suppress a retry until the operation-fenced daemon
              // request has actually succeeded. A dropped request before
              // acceptance must leave a later Force action effective.
              if (this.handbackInFlight === activeHandback) {
                this.handbackInFlightStrategy = "cancel";
              }
            },
          );
          const managedEscalation = escalation.finally(() => {
            if (
              this.handbackEscalationInFlight === managedEscalation
            ) {
              this.handbackEscalationInFlight = undefined;
            }
          });
          this.handbackEscalationInFlight = managedEscalation;
        }
        await this.handbackEscalationInFlight;
      }
      return activeHandback;
    }
    this.handbackInFlightStrategy = strategy;
    const pending = this.handBackOnce(
      strategy,
      actionId,
      claimToken,
    );
    const managed = pending.finally(() => {
      if (this.handbackInFlight === managed) {
        this.handbackInFlight = undefined;
        this.handbackInFlightStrategy = undefined;
        this.handbackInFlightIdentity = undefined;
      }
    });
    this.handbackInFlight = managed;
    return managed;
  }

  private async escalateHandbackCancellation(): Promise<void> {
    const expected = this.handbackInFlightIdentity;
    if (!expected) {
      throw new Error(
        "The original hand-back identity is not available yet. Retry Force in a moment.",
      );
    }
    const status = await this.control<RemoteDaemonStatus>(
      "/control/status",
    );
    const lease = status.lease;
    const operation = lease?.operation;
    if (
      !lease ||
      operation?.kind !== "handback" ||
      lease.id !== expected.leaseId ||
      operation.id !== expected.operationId ||
      operation.phase === "complete" ||
      operation.phase === "failed"
    ) {
      throw new Error(
        "The durable hand-back operation is no longer available to force.",
      );
    }
    await this.control("/control/session/prepare-handback", {
      method: "POST",
      body: {
        strategy: "cancel",
        operationId: expected.operationId,
        leaseId: expected.leaseId,
      },
      timeoutMs: 30_000,
    });
    await this.restartCurrentHandbackStability(
      expected.leaseId,
      expected.operationId,
    );
  }

  private async restartCurrentHandbackStability(
    expectedLeaseId?: string,
    expectedOperationId?: string,
  ): Promise<void> {
    const attempt = this.handbackStabilityAttempt;
    if (
      !attempt ||
      (expectedLeaseId !== undefined &&
        attempt.leaseId !== expectedLeaseId) ||
      (expectedOperationId !== undefined &&
        attempt.operationId !== expectedOperationId)
    ) {
      return;
    }
    if (attempt.restartRequested) {
      return;
    }
    attempt.restartRequested = true;
    if (attempt.operationId) {
      await this.control("/control/operation", {
        method: "POST",
        body: {
          id: attempt.operationId,
          phase: "stabilizing-transcript",
          waitReason:
            "Explicit cancellation acknowledged; rechecking the final transcript",
        },
      }).catch((error) => this.logger.error(error));
    }
    attempt.abortController.abort(
      new Error(
        "Explicit cancellation was acknowledged; transcript stabilization is restarting.",
      ),
    );
  }

  private async waitForStableHandbackTranscript(
    transcriptPath: string,
    leaseId: string,
    operationId?: string,
  ): ReturnType<typeof waitForStableTranscript> {
    for (;;) {
      const attempt = {
        leaseId,
        operationId,
        abortController: new AbortController(),
        restartRequested: false,
      };
      this.handbackStabilityAttempt = attempt;
      try {
        return await waitForStableTranscript(transcriptPath, {
          signal: attempt.abortController.signal,
        });
      } catch (error) {
        if (!attempt.restartRequested) {
          throw error;
        }
        // Force never accepts an unstable transcript. It only discards the
        // current observation window and starts a fresh, fully qualified one.
      } finally {
        if (this.handbackStabilityAttempt === attempt) {
          this.handbackStabilityAttempt = undefined;
        }
      }
    }
  }

  private async handBackOnce(
    strategy: "finish" | "cancel",
    actionId?: string,
    claimToken?: string,
  ): Promise<void> {
    const status = await this.control<RemoteDaemonStatus>(
      "/control/status",
    );
    const operationId =
      status.lease?.operation?.kind === "handback"
        ? status.lease.operation.id
        : undefined;
    if (status.lease?.id && operationId) {
      this.handbackInFlightIdentity = {
        leaseId: status.lease.id,
        operationId,
      };
    }
    if (operationId) {
      await this.control("/control/operation", {
        method: "POST",
        body: { id: operationId, phase: "quiescing" },
      });
    }
    const result = await this.control<{
      lease?: RemoteSessionLease;
    }>("/control/session/prepare-handback", {
      method: "POST",
      body: {
        strategy,
        ...(operationId ? { operationId } : {}),
        ...(status.lease?.id ? { leaseId: status.lease.id } : {}),
      },
      timeoutMs:
        strategy === "finish" ? false : 30_000,
    });
    const lease = result.lease ?? status.lease;
    if (!lease) {
      throw new Error("The remote lease is unavailable.");
    }
    const sessionId = lease.activeSessionId ?? lease.sourceSessionId;
    const transcriptPath = activeTranscriptPath(
      lease.sourceTranscriptPath,
      sessionId,
    );
    if (operationId) {
      await this.control("/control/operation", {
        method: "POST",
        body: {
          id: operationId,
          phase: "stabilizing-transcript",
        },
      });
    }
    const stableTranscript =
      await this.waitForStableHandbackTranscript(
        transcriptPath,
        lease.id,
        operationId,
      );
    const transcriptSignature = stableTranscript.signature;
    const record: RemoteHandoffRecord = {
      version: 1,
      leaseId: lease.id,
      sessionId,
      transcriptPath,
      workspacePath: lease.workspacePath,
      title: lease.title,
      transcriptSignature,
      phase: "preparing",
      actionId,
      actionClaimToken: claimToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const superseded = this.pendingHandoff();
    if (
      superseded?.phase === "session-opened" &&
      this.sameHandoffTarget(superseded, record)
    ) {
      // A duplicate Return request can arrive while terminal cleanup is
      // still finishing. Reuse the accepted record; never replace it with a
      // new preparing revision for the same transcript.
      await this.recoverLastRemoteConversation({
        notifyOnFailure: actionId === undefined,
      });
      return;
    }
    await this.context.globalState.update(
      PENDING_SESSION_KEY,
      record,
    );
    if (operationId) {
      await this.control("/control/operation", {
        method: "POST",
        body: { id: operationId, phase: "opening-session" },
      });
    }
    if (
      superseded?.actionId &&
      superseded.actionId !== record.actionId
    ) {
      this.blockedHandbackActions.delete(superseded.actionId);
    }
    const currentEnvironmentHash = environmentHash(
      this.settingsService.read().effective.variables,
    );
    if (
      lease.desktopEnvironmentHash
        ? lease.desktopEnvironmentHash !== currentEnvironmentHash
        : lease.providerChanged
    ) {
      const pendingReload = {
        ...record,
        phase: "pending-reload",
        updatedAt: Date.now(),
      } satisfies RemoteHandoffRecord;
      if (!(await this.replacePendingHandoff(record, pendingReload))) {
        // Another serialized recovery already advanced this exact hand-off.
        // In particular, never overwrite session-opened with pending-reload.
        return;
      }
      await this.reloadCoordinator.markPending({
        provider: lease.provider.provider,
        switchedAt: Date.now(),
        reason: "switch",
        workspaceOverride: false,
      });
      await this.reloadCoordinator.reloadWindow();
      return;
    }
    await this.recoverLastRemoteConversation({
      notifyOnFailure: actionId === undefined,
    });
  }

  private async openClaudeSession(
    sessionId: string,
    expectedTitle?: string,
    onAccepted?: () => Promise<void>,
  ): Promise<void> {
    const expectedTabTitle = claudeTabTitle(expectedTitle ?? "");
    const existingTabs = new Set(
      vscode.window.tabGroups.all.flatMap((group) => group.tabs),
    );
    const initialTabLabels = new Map(
      [...existingTabs].map((tab) => [tab, tab.label]),
    );
    const candidateTabs = new Set<vscode.Tab>();
    const initialActiveTab =
      vscode.window.tabGroups.activeTabGroup?.activeTab;
    const isClaudeTab = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputWebview &&
      tab.input.viewType === "claudeVSCodePanel";
    const claudeTabs = (): vscode.Tab[] =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter(isClaudeTab);
    const rememberAttributedTabs = (): void => {
      for (const tab of claudeTabs()) {
        if (
          !existingTabs.has(tab) ||
          initialTabLabels.get(tab) !== tab.label
        ) {
          candidateTabs.add(tab);
        }
      }
      const activeTab =
        vscode.window.tabGroups.activeTabGroup?.activeTab;
      if (
        activeTab &&
        activeTab !== initialActiveTab &&
        isClaudeTab(activeTab)
      ) {
        candidateTabs.add(activeTab);
      }
    };
    await openExactClaudeSession(sessionId, {
      activateClaudeExtension: async () => {
        const extension =
          vscode.extensions.getExtension("anthropic.claude-code") ??
          vscode.extensions.getExtension("Anthropic.claude-code");
        if (!extension) {
          return false;
        }
        await extension.activate();
        return true;
      },
      listCommands: () =>
        Promise.resolve(vscode.commands.getCommands(true)),
      executeCommand: async (command, targetSessionId) => {
        try {
          await vscode.commands.executeCommand(
            command,
            targetSessionId,
            undefined,
            vscode.ViewColumn.Active,
          );
        } finally {
          // A command handler can reject after creating its webview. Capture
          // the attributed tab before propagating that late error.
          rememberAttributedTabs();
        }
      },
      confirmSessionOpen: () => {
        rememberAttributedTabs();
        const currentTabs = new Set(claudeTabs());
        return Promise.resolve(
          [...candidateTabs].some(
            (tab) =>
              currentTabs.has(tab) &&
              tab.label.trim() === expectedTabTitle,
          ),
        );
      },
    });
    // Command completion only proves that Claude accepted an instruction.
    // openExactClaudeSession returns here only after the attributed tab also
    // proves the distinctive title for this already-validated transcript.
    await onAccepted?.();
  }

  private async upgradeLegacyHandoff(
    sessionId: string,
  ): Promise<RemoteHandoffRecord | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const sessions = await discoverWorkspaceSessions(folder.uri.fsPath);
      const session = sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (!session) {
        continue;
      }
      return {
        version: 1,
        leaseId: "legacy",
        sessionId,
        transcriptPath: session.transcriptPath,
        workspacePath: session.workspacePath,
        title: session.title,
        transcriptSignature: await transcriptTailSignature(
          session.transcriptPath,
        ),
        phase: "opening-session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    return undefined;
  }

  private async completeAction(
    actionId: string,
    success: boolean,
    error?: string,
    claimToken?: string,
  ): Promise<void> {
    await this.control("/control/actions/complete", {
      method: "POST",
      body: {
        actionId,
        success,
        error,
        claimToken,
        owner: this.windowOwnerId,
      },
    });
  }

  private async claimHostActionForCleanup(
    actionId: string,
  ): Promise<RemoteHostAction | undefined> {
    const result = await this.control<{ actions: RemoteHostAction[] }>(
      `/control/actions?owner=${encodeURIComponent(
        this.windowOwnerId,
      )}&workspaceOwner=${encodeURIComponent(
        this.workspaceOwnerId,
      )}`,
    );
    return result.actions.find((action) => action.id === actionId);
  }

  private async heartbeatHostAction(
    actionId: string,
    claimToken: string,
  ): Promise<number> {
    const result = await this.control<{ expiresAt: number }>(
      "/control/actions/heartbeat",
      {
        method: "POST",
        body: {
          actionId,
          claimToken,
          owner: this.windowOwnerId,
        },
      },
    );
    return result.expiresAt;
  }

  private async withActionClaimHeartbeat<T>(
    action: RemoteHostAction,
    task: () => Promise<T>,
  ): Promise<T> {
    const claimToken = actionClaimToken(action);
    if (!claimToken) {
      return task();
    }
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    let expiresAt =
      action.claimExpiresAt ?? Date.now() + 30_000;
    const schedule = (): void => {
      if (stopped) {
        return;
      }
      const remaining = Math.max(2_000, expiresAt - Date.now());
      const delay = Math.max(
        1_000,
        Math.min(10_000, Math.floor(remaining / 2)),
      );
      timer = setTimeout(() => {
        timer = undefined;
        heartbeatInFlight = this.heartbeatHostAction(
          action.id,
          claimToken,
        )
          .then((renewedExpiry) => {
            expiresAt = renewedExpiry;
          })
          .catch((error) => {
            this.logger.error(error);
          })
          .finally(() => {
            heartbeatInFlight = undefined;
            schedule();
          });
      }, delay);
    };
    schedule();
    try {
      return await task();
    } finally {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      await heartbeatInFlight;
    }
  }

  private async requireActiveStatus(): Promise<
    RemoteDaemonStatus | undefined
  > {
    const status = await this.health();
    if (!status?.configured || status.lease?.state === "stopped") {
      await vscode.window.showInformationMessage(
        "No ModelHop Remote session is active.",
      );
      return undefined;
    }
    return status;
  }

  private updateStatus(status?: RemoteDaemonStatus): void {
    if (this.pendingHandoff()?.phase === "session-opened") {
      this.statusItem.text = "$(device-mobile) ModelHop Remote";
      this.statusItem.command = "modelHop.continueOnPhone";
      this.statusItem.tooltip =
        "The exact Claude conversation is open on this laptop. ModelHop is finishing phone-link cleanup in the background.";
      return;
    }
    if (
      status?.configured &&
      status.lease &&
      status.lease.state !== "stopped"
    ) {
      if (this.transportUnavailableLeaseId === status.lease.id) {
        this.updateTransportUnavailableStatus(status);
        return;
      }
      this.statusItem.text = `$(broadcast) Remote: ${status.lease.state}`;
      this.statusItem.command = "modelHop.returnToLaptop";
      this.statusItem.tooltip = this.daemonBuildMismatch
        ? "Remote work is still running in the previous ModelHop controller build. It will not be interrupted; click to return it safely before upgrading the phone session."
        : "ModelHop Remote is active — click to return to this editor";
    } else {
      this.statusItem.text = "$(device-mobile) ModelHop Remote";
      this.statusItem.command = "modelHop.continueOnPhone";
      this.statusItem.tooltip =
        "Continue the current Claude Code conversation on your phone";
    }
  }

  private updateTransportUnavailableStatus(
    status?: RemoteDaemonStatus,
  ): void {
    const work = status?.lease?.backgroundTaskCount ?? 0;
    this.statusItem.text =
      work > 0
        ? `$(debug-disconnect) Remote link lost · ${work} task${work === 1 ? "" : "s"} still running`
        : "$(debug-disconnect) Remote link lost · work continues";
    this.statusItem.command = "modelHop.returnToLaptop";
    this.statusItem.tooltip =
      "The phone link disconnected, but ModelHop preserved the detached Claude work on this Mac. Click to return the exact conversation to this editor.";
  }

  private async health(): Promise<RemoteDaemonStatus | undefined> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.port}/health`,
        {
          headers: {
            "X-ModelHop-Control": this.controlToken,
          },
          signal: AbortSignal.timeout(750),
        },
      );
      if (!response.ok) {
        return undefined;
      }
      const status = (await response.json()) as RemoteDaemonStatus;
      this.lastKnownStatus = status;
      return status;
    } catch {
      return undefined;
    }
  }

  private async shutdownDaemon(): Promise<void> {
    await this.control("/control/shutdown", {
      method: "POST",
      timeoutMs: 10_000,
    }).catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await this.health())) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "The previous ModelHop Remote controller did not stop. Run “ModelHop: Stop Remote Access” and try again.",
    );
  }

  private async control<T = unknown>(
    route: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      timeoutMs?: number | false;
    } = {},
  ): Promise<T> {
    const response = await fetch(
      `http://127.0.0.1:${this.port}${route}`,
      {
        method: options.method ?? "GET",
        headers: {
          "X-ModelHop-Control": this.controlToken,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        signal:
          options.timeoutMs === false
            ? undefined
            : AbortSignal.timeout(options.timeoutMs ?? 5_000),
      },
    );
    const value = (await response.json()) as {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        value.error ?? `Remote controller returned ${response.status}.`,
      );
    }
    return value as T;
  }
}
