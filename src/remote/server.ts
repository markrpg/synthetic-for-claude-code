import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  decryptEnvelope,
  deriveRemoteSessionKeys,
  encryptEnvelope,
  hostFingerprint,
  pairingSas,
  randomSecret,
  safeTokenEqual,
  type RemoteSessionKeys,
} from "./crypto.js";
import { RemoteDeviceStore } from "./deviceStore.js";
import { RemoteEventJournal } from "./eventJournal.js";
import {
  RemoteCommandLedger,
  remoteCommandRequestHash,
  type DurableCommandReceipt,
} from "./commandLedger.js";
import {
  canSupersedeUnstartedProviderSwitch,
  connectionHoldsRemoteMutationFence,
  evaluateRemoteCommandAdmission,
  remoteCommandRequiresOwnershipFence,
} from "./commandPolicy.js";
import {
  boundedHostActionTerminals,
  deterministicHostActionId,
  deterministicRemoteOperationId,
  hydrateHostActionState,
  type RemoteHostActionCommandReference,
  type RemoteHostActionTerminal,
} from "./hostActionDurability.js";
import { InFlightCommands } from "./inFlightCommands.js";
import {
  recordsAuthenticatedRemoteActivity,
  remoteLifecycleDecision,
  RemoteLifecycleCleanupLatch,
} from "./lifecyclePolicy.js";
import {
  normaliseSdkMessage,
  RemoteSessionController,
  type SdkMessageNormalisationState,
} from "./sessionController.js";
import { loadTranscriptPreview } from "./sessionDiscovery.js";
import {
  REMOTE_BUILD_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type EncryptedEnvelope,
  type PairedDevice,
  type RemoteClientCommand,
  type RemoteCommandResponse,
  type RemoteConnectionRequest,
  type RemoteConnectionStatus,
  type RemoteDaemonConfiguration,
  type RemoteDaemonStatus,
  type RemoteHostAction,
  type RemoteOperation,
  type RemoteActivityEvent,
  type RemotePairingBootstrap,
  type RemoteProviderContext,
  type RemoteRuntimeSnapshot,
  type RemoteSessionLease,
  type RemoteTunnelState,
} from "./types.js";
import { SequenceReplayWindow } from "./sequenceReplayWindow.js";
import { EncryptedRemoteRuntimeStore } from "./runtimeStore.js";
import {
  transcriptTailSignature,
} from "./transcriptIntegrity.js";
import { RemoteWorkspaceReader } from "./workspaceReader.js";
import { validQuickTunnelOrigin } from "./quickTunnelOutput.js";
import {
  pairingWindowExpiresAt,
  remoteDeviceConnectionDecision,
} from "./pairingPolicy.js";
import {
  cloudflaredCommandMatches,
  readProcessCommand,
} from "./processIdentity.js";
import {
  mergeProviderUsage,
  sameRemoteQueryConfiguration,
} from "./providerRuntime.js";
import {
  allowsTerminalRemoteSession,
  REMOTE_COMMAND_BODY_LIMIT,
  REMOTE_CONNECT_BODY_LIMIT,
  requiresLaunchTokenBeforeBody,
  requiresOpenRemoteSession,
  requiresRemoteControlToken,
} from "./routePolicy.js";

const MAX_JSON_BODY_BYTES = REMOTE_COMMAND_BODY_LIMIT;
const MAX_CONTROL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_PUBLIC_BODIES = 8;
const LONG_POLL_MS = 25_000;
const TERMINAL_ACK_TIMEOUT_MS = 8_000;
const TERMINAL_TUNNEL_GRACE_MS = 12_000;
const PAIRING_TTL_MS = 2 * 60 * 1000;
const CONNECTION_STALE_MS = 5 * 60 * 1000;
const ACTION_CLAIM_TTL_MS = 30_000;
const COMPANION_STATE_PATH = path.join(
  homedir(),
  ".modelhop",
  "remote-state.json",
);

interface Arguments {
  port: number;
  stateDirectory: string;
}

interface RemoteConnection {
  id: string;
  request: RemoteConnectionRequest;
  status: "pending" | "confirmed" | "rejected";
  knownDevice: boolean;
  sas: string;
  keys: RemoteSessionKeys;
  createdAt: number;
  lastSeenAt: number;
  inboundSequences: SequenceReplayWindow;
  nextOutboundSequence: number;
  replayThroughEventId: number;
  ownershipFencingGeneration?: number;
}

interface PersistedDaemonRuntime {
  version: 1;
  savedAt: number;
  state: "active" | "stopped" | "execution-lost";
  configuration?: RemoteDaemonConfiguration;
  runtimeSnapshot?: RemoteRuntimeSnapshot;
  hostActions: RemoteHostAction[];
  hostActionTerminals?: RemoteHostActionTerminal[];
  tunnel?: RemoteTunnelState;
  daemon: {
    pid: number;
    startedAt: number;
    buildVersion: string;
  };
}

function parseArguments(argv: readonly string[]): Arguments {
  const portIndex = argv.indexOf("--port");
  const stateIndex = argv.indexOf("--state-dir");
  const port = Number(argv[portIndex + 1]);
  const stateDirectory = argv[stateIndex + 1];
  if (
    portIndex < 0 ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    stateIndex < 0 ||
    !stateDirectory
  ) {
    throw new Error(
      "Usage: remote-daemon --port <port> --state-dir <directory>",
    );
  }
  return { port, stateDirectory };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(
  value: unknown,
  name: string,
  maxLength = 10_000,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function startsNewRemoteWork(command: RemoteClientCommand): boolean {
  return (
    command.type === "prompt.send" ||
    command.type === "provider.change" ||
    command.type === "model.change" ||
    command.type === "reasoning.change" ||
    command.type === "attachment.upload" ||
    command.type === "codex.reset"
  );
}

function requestLaunchToken(
  request: IncomingMessage,
  url: URL,
): string | null {
  const header = request.headers["x-modelhop-launch"];
  return typeof header === "string"
    ? header
    : url.searchParams.get("launch");
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

function text(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
  options: {
    cache?: boolean;
    scriptNonce?: string;
  } = {},
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": options.cache
      ? "private, max-age=3600"
      : "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      `default-src 'self'; script-src 'self'${
        options.scriptNonce
          ? ` 'nonce-${options.scriptNonce}'`
          : ""
      }; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    "Permissions-Policy":
      "camera=(self), microphone=(self), geolocation=()",
  });
  response.end(body);
}

class RemoteHttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(
  request: IncomingMessage,
  maximumBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string") {
    const declared = Number(declaredLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > maximumBytes
    ) {
      throw new RemoteHttpError(
        413,
        "The remote request is too large.",
      );
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new RemoteHttpError(
        413,
        "The remote request is too large.",
      );
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function controlAuthorised(
  request: IncomingMessage,
  controlToken: string,
): boolean {
  const candidate = request.headers["x-modelhop-control"];
  return (
    typeof candidate === "string" &&
    safeTokenEqual(controlToken, candidate)
  );
}

function validConnectionRequest(
  value: unknown,
): RemoteConnectionRequest {
  if (!isRecord(value)) {
    throw new Error("Invalid device connection request.");
  }
  const devicePublicKey = stringValue(
    value.devicePublicKey,
    "device public key",
    512,
  );
  const decoded = Buffer.from(devicePublicKey, "base64");
  if (decoded.length !== 65 || decoded[0] !== 4) {
    throw new Error("Invalid P-256 device public key.");
  }
  return {
    deviceId: stringValue(value.deviceId, "device ID", 128),
    deviceName: stringValue(value.deviceName, "device name", 100),
    devicePublicKey,
    hostFingerprint:
      typeof value.hostFingerprint === "string"
        ? value.hostFingerprint
        : undefined,
  };
}

function validEnvelope(value: unknown): EncryptedEnvelope {
  if (!isRecord(value)) {
    throw new Error("Invalid encrypted message.");
  }
  if (value.version !== REMOTE_PROTOCOL_VERSION) {
    throw new Error("Unsupported ModelHop Remote protocol version.");
  }
  return {
    version: REMOTE_PROTOCOL_VERSION,
    connectionId: stringValue(
      value.connectionId,
      "connection ID",
      128,
    ),
    sequence:
      typeof value.sequence === "number" &&
      Number.isSafeInteger(value.sequence) &&
      value.sequence > 0
        ? value.sequence
        : (() => {
            throw new Error("Invalid encrypted message sequence.");
          })(),
    nonce: stringValue(value.nonce, "message nonce", 128),
    ciphertext: stringValue(
      value.ciphertext,
      "message ciphertext",
      MAX_JSON_BODY_BYTES,
    ),
  };
}

function validClientCommand(value: unknown): RemoteClientCommand {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string"
  ) {
    throw new Error("Invalid remote command.");
  }
  const id = stringValue(value.id, "command ID", 128);
  switch (value.type) {
    case "prompt.send": {
      const prompt =
        typeof value.prompt === "string" &&
        value.prompt.length <= 30_000
          ? value.prompt
          : (() => {
              throw new Error("Invalid remote prompt.");
            })();
      const attachmentIds =
        value.attachmentIds === undefined
          ? undefined
          : Array.isArray(value.attachmentIds) &&
              value.attachmentIds.length <= 10 &&
              value.attachmentIds.every(
                (entry) =>
                  typeof entry === "string" && entry.length <= 128,
              )
            ? value.attachmentIds
            : (() => {
                throw new Error("Invalid attachment list.");
              })();
      return { id, type: value.type, prompt, attachmentIds };
    }
    case "turn.cancel":
    case "usage.refresh":
    case "git.status":
      return { id, type: value.type };
    case "session.handback":
      return {
        id,
        type: value.type,
        strategy:
          value.strategy === "cancel" ||
          value.cancelActive === true
            ? "cancel"
            : "finish",
        cancelActive: value.cancelActive === true,
      };
    case "session.handback.continue":
    case "session.handback.cancel-request":
      return {
        id,
        type: value.type,
        operationId: stringValue(
          value.operationId,
          "hand-back operation ID",
          128,
        ),
      };
    case "session.terminal.ack":
      if (
        typeof value.terminalEventId !== "number" ||
        !Number.isSafeInteger(value.terminalEventId) ||
        value.terminalEventId <= 0
      ) {
        throw new Error("Invalid terminal event ID.");
      }
      return {
        id,
        type: value.type,
        terminalEventId: value.terminalEventId,
      };
    case "permission.mode.set":
      if (
        value.mode !== "default" &&
        value.mode !== "acceptEdits" &&
        value.mode !== "auto-safe" &&
        value.mode !== "plan"
      ) {
        throw new Error("Invalid remote permission mode.");
      }
      return {
        id,
        type: value.type,
        mode: value.mode,
      };
    case "permission.resolve":
      if (
        value.decision !== "allow" &&
        value.decision !== "allow-session" &&
        value.decision !== "deny"
      ) {
        throw new Error("Invalid permission decision.");
      }
      return {
        id,
        type: value.type,
        requestId: stringValue(
          value.requestId,
          "permission request ID",
          128,
        ),
        decision: value.decision,
        message:
          typeof value.message === "string"
            ? value.message.slice(0, 2_000)
            : undefined,
      };
    case "question.resolve": {
      if (!isRecord(value.answers)) {
        throw new Error("Invalid question answers.");
      }
      const answerEntries = Object.entries(value.answers);
      if (
        answerEntries.length === 0 ||
        answerEntries.length > 20 ||
        answerEntries.some(
          ([question, answer]) =>
            question.length === 0 ||
            question.length > 2_000 ||
            typeof answer !== "string" ||
            answer.length > 4_000,
        )
      ) {
        throw new Error("Invalid question answers.");
      }
      return {
        id,
        type: value.type,
        requestId: stringValue(
          value.requestId,
          "question request ID",
          128,
        ),
        answers: Object.fromEntries(
          answerEntries as Array<[string, string]>,
        ),
      };
    }
    case "provider.change":
      if (
        value.provider !== "anthropic" &&
        value.provider !== "synthetic" &&
        value.provider !== "openai-api" &&
        value.provider !== "openai-codex"
      ) {
        throw new Error("Invalid provider.");
      }
      return { id, type: value.type, provider: value.provider };
    case "symbols.search":
      return {
        id,
        type: value.type,
        query: stringValue(value.query, "symbol query", 200),
      };
    case "model.change": {
      const effort = value.reasoningEffort;
      if (
        effort !== undefined &&
        (typeof effort !== "string" ||
          !["none", "low", "medium", "high", "xhigh", "max"].includes(
            effort,
          ))
      ) {
        throw new Error("Invalid reasoning effort.");
      }
      return {
        id,
        type: value.type,
        model: stringValue(value.model, "model", 200),
        reasoningEffort: effort as
          | "none"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max"
          | undefined,
      };
    }
    case "reasoning.change": {
      const effort = value.effort;
      if (
        effort !== undefined &&
        (typeof effort !== "string" ||
          !["none", "low", "medium", "high", "xhigh", "max"].includes(
            effort,
          ))
      ) {
        throw new Error("Invalid reasoning effort.");
      }
      for (const key of [
        "thinkingEnabled",
        "workflowsEnabled",
        "ultraEnabled",
      ] as const) {
        if (value[key] !== undefined && typeof value[key] !== "boolean") {
          throw new Error(`Invalid ${key} value.`);
        }
      }
      if (
        effort === undefined &&
        value.thinkingEnabled === undefined &&
        value.workflowsEnabled === undefined &&
        value.ultraEnabled === undefined
      ) {
        throw new Error("No reasoning setting was supplied.");
      }
      return {
        id,
        type: value.type,
        effort: effort as
          | "none"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max"
          | undefined,
        thinkingEnabled: value.thinkingEnabled as boolean | undefined,
        workflowsEnabled: value.workflowsEnabled as boolean | undefined,
        ultraEnabled: value.ultraEnabled as boolean | undefined,
      };
    }
    case "files.search":
      return {
        id,
        type: value.type,
        query:
          typeof value.query === "string"
            ? value.query.slice(0, 500)
            : undefined,
      };
    case "files.list": {
      const pageSize =
        value.pageSize === undefined
          ? undefined
          : typeof value.pageSize === "number" &&
              Number.isSafeInteger(value.pageSize) &&
              value.pageSize > 0 &&
              value.pageSize <= 100
            ? value.pageSize
            : (() => {
                throw new Error("Invalid directory page size.");
              })();
      return {
        id,
        type: value.type,
        rootId:
          typeof value.rootId === "string"
            ? value.rootId.slice(0, 128)
            : undefined,
        path:
          typeof value.path === "string"
            ? value.path.slice(0, 4_096)
            : undefined,
        cursor:
          typeof value.cursor === "string"
            ? value.cursor.slice(0, 128)
            : undefined,
        pageSize,
      };
    }
    case "file.read":
      return {
        id,
        type: value.type,
        path: stringValue(value.path, "file path", 4_096),
      };
    case "file.reference.read":
      return {
        id,
        type: value.type,
        reference: stringValue(
          value.reference,
          "file reference",
          4_096,
        ),
      };
    case "git.diff":
      return { id, type: value.type, staged: value.staged === true };
    case "attachment.upload":
      return {
        id,
        type: value.type,
        name: stringValue(value.name, "attachment name", 200),
        mediaType: stringValue(
          value.mediaType,
          "attachment media type",
          100,
        ),
        contentBase64: stringValue(
          value.contentBase64,
          "attachment content",
          14 * 1024 * 1024,
        ),
      };
    case "codex.reset":
      return {
        id,
        type: value.type,
        creditId:
          typeof value.creditId === "string"
            ? value.creditId.slice(0, 128)
            : undefined,
      };
    default:
      throw new Error("Unknown remote command.");
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class ModelHopRemoteDaemon {
  private configuration: RemoteDaemonConfiguration | undefined;
  private deviceStore: RemoteDeviceStore | undefined;
  private sessionController: RemoteSessionController | undefined;
  private workspaceReader: RemoteWorkspaceReader | undefined;
  private readonly connections = new Map<string, RemoteConnection>();
  private mutationOwnerConnectionId: string | undefined;
  private readonly hostActions = new Map<string, RemoteHostAction>();
  private readonly hostActionTerminals = new Map<
    string,
    RemoteHostActionTerminal
  >();
  private hostActionMutationTail: Promise<void> = Promise.resolve();
  private remoteMutationTail: Promise<void> = Promise.resolve();
  private readonly actionClaims = new Map<
    string,
    {
      owner: string;
      token: string;
      claimedAt: number;
      expiresAt: number;
    }
  >();
  /** Prevents the editor poller claiming an action while it is being retired. */
  private readonly hostActionsBeingSuperseded = new Set<string>();
  private readonly pairingClaims = new Map<
    string,
    { owner: string; claimedAt: number }
  >();
  private readonly commandsInFlight =
    new InFlightCommands<RemoteCommandResponse>();
  private readonly commandLedger: RemoteCommandLedger;
  private readonly runtimeStore: EncryptedRemoteRuntimeStore<PersistedDaemonRuntime>;
  private recoveredRuntime: PersistedDaemonRuntime | undefined;
  private readonly daemonStartedAt = Date.now();
  private readonly attachmentPaths = new Map<string, string>();
  private sessionSalt = randomSecret();
  private configuredAt = 0;
  private pairingOpenedAt = 0;
  private sourceTranscriptSignature = "";
  private tunnel: RemoteTunnelState | undefined;
  private remoteAccessOpen = false;
  private remoteInputOpen = false;
  private readonly timeoutCleanup = new RemoteLifecycleCleanupLatch();
  private disconnectedTurnJournaledAt: number | undefined;
  private tunnelStopErrorReported = false;
  private timer: NodeJS.Timeout | undefined;
  private terminalTunnelStopTimer: NodeJS.Timeout | undefined;
  private terminalAccessOpen = false;
  private terminalEventId: number | undefined;
  private readonly terminalAcknowledgements = new Set<string>();
  private readonly terminalAcknowledgementWaiters = new Set<() => void>();
  private lifecycleTickInFlight = false;
  private shuttingDown = false;

  public constructor(
    private readonly port: number,
    private readonly stateDirectory: string,
    private readonly controlToken: string,
    private readonly journal: RemoteEventJournal,
    runtimeEncryptionKey: string,
  ) {
    this.commandLedger = new RemoteCommandLedger(journal);
    this.runtimeStore = new EncryptedRemoteRuntimeStore(
      path.join(stateDirectory, "runtime-manifest.enc"),
      runtimeEncryptionKey,
    );
  }

  public async initialize(): Promise<void> {
    await mkdir(this.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    this.recoveredRuntime = await this.runtimeStore.load();
    await unlink(COMPANION_STATE_PATH).catch(() => undefined);
    const replay = this.journal.window(
      Math.max(0, this.journal.earliestId() - 1),
      10_000,
    ).events;
    this.commandLedger.hydrate(replay);
    const hydratedActions = hydrateHostActionState(
      replay,
      this.recoveredRuntime?.hostActions,
      this.recoveredRuntime?.hostActionTerminals,
    );
    for (const [id, action] of hydratedActions.actions) {
      this.hostActions.set(id, action);
    }
    for (const [id, terminal] of hydratedActions.terminals) {
      this.hostActionTerminals.set(id, terminal);
    }
    if (this.recoveredRuntime?.state === "active") {
      this.recoveredRuntime = {
        ...this.recoveredRuntime,
        state: "execution-lost",
      };
      await this.journal.append("notification", {
        level: "warning",
        message:
          "The detached Remote controller restarted. ModelHop preserved the transcript and operation ledger and is waiting for the owning editor to verify execution before accepting new work.",
        recoveryState: "execution-lost-transcript-recoverable",
      });
    }
    this.scheduleLifecycleTick(2_000);
  }

  public status(): RemoteDaemonStatus {
    const runtime = this.runtimeSnapshot(this.journal.latestId());
    const status: RemoteDaemonStatus = {
      name: "modelhop-remote",
      version: REMOTE_PROTOCOL_VERSION,
      buildVersion: REMOTE_BUILD_VERSION,
      ready: true,
      configured: Boolean(this.configuration),
      lease:
        this.sessionController?.getLease() ??
        this.recoveredRuntime?.runtimeSnapshot?.lease ??
        this.configuration?.lease,
      pendingPairings: [...this.connections.values()]
        .filter((connection) => connection.status === "pending")
        .map((connection) => ({
          connectionId: connection.id,
          deviceId: connection.request.deviceId,
          deviceName: connection.request.deviceName,
          sas: connection.sas,
          createdAt: connection.createdAt,
        })),
      pairedDevices: this.deviceStore?.list() ?? [],
      hostActions: [...this.hostActions.values()],
      tunnel: this.tunnel,
      journal: runtime
        ? {
            ...runtime.journal,
            earliestEventId: this.journal.earliestId(),
          }
        : undefined,
      ownership: runtime?.ownership,
      transport: runtime?.transport,
      query: runtime
        ? {
            generation: runtime.execution.queryGeneration,
            state: runtime.execution.state,
            lastProgressAt: runtime.execution.lastProgressAt,
            blockerIds: runtime.operation?.blockerIds,
          }
        : undefined,
    };
    return Object.assign(status, {
      recovery:
        (this.recoveredRuntime?.state === "active" ||
          this.recoveredRuntime?.state === "execution-lost") &&
        !this.sessionController
          ? {
              state: "execution-lost",
              savedAt: this.recoveredRuntime.savedAt,
              transcriptRecoverable: true,
            }
          : undefined,
    });
  }

  public async configure(
    configuration: RemoteDaemonConfiguration,
  ): Promise<void> {
    if (configuration.launchToken.length < 32) {
      throw new Error("The remote launch token is invalid.");
    }
    const recoveredConfiguration = this.recoveredRuntime?.configuration;
    const previousConfiguration =
      this.configuration ?? recoveredConfiguration;
    const sameLease =
      previousConfiguration?.lease.id === configuration.lease.id;
    const recoveringSameLease =
      !this.sessionController &&
      recoveredConfiguration?.lease.id === configuration.lease.id;
    const sameQueryConfiguration =
      previousConfiguration !== undefined &&
      sameRemoteQueryConfiguration(
        previousConfiguration,
        configuration,
      );
    if (!sameLease && this.sessionController) {
      this.remoteAccessOpen = false;
      this.remoteInputOpen = false;
      await this.sessionController.stop();
      await this.stopTunnel();
      this.sessionController = undefined;
      this.workspaceReader = undefined;
      this.connections.clear();
      this.mutationOwnerConnectionId = undefined;
      this.hostActions.clear();
      this.hostActionTerminals.clear();
      this.actionClaims.clear();
      this.pairingClaims.clear();
      this.commandLedger.hydrate([]);
      this.commandsInFlight.clear();
      this.attachmentPaths.clear();
    }
    if (!sameLease && !this.sessionController) {
      this.hostActions.clear();
      this.hostActionTerminals.clear();
      this.actionClaims.clear();
      this.pairingClaims.clear();
      this.commandsInFlight.clear();
      this.attachmentPaths.clear();
    }
    this.configuration = configuration;
    if (!sameLease) {
      this.configuredAt = Date.now();
      this.pairingOpenedAt = this.configuredAt;
      this.sessionSalt = randomSecret();
      this.remoteAccessOpen = true;
      this.remoteInputOpen =
        configuration.lease.remoteInputRevokedAt === undefined;
      this.timeoutCleanup.reset();
      this.disconnectedTurnJournaledAt = undefined;
      this.tunnelStopErrorReported = false;
      this.terminalAccessOpen = false;
      this.terminalEventId = undefined;
      this.terminalAcknowledgements.clear();
      this.resolveTerminalAcknowledgementWaiters();
    }
    this.deviceStore = new RemoteDeviceStore(
      path.join(this.stateDirectory, "paired-devices.enc"),
      configuration.pairedDeviceStoreKey,
    );
    await this.deviceStore.initialize();
    const gitDirectory = path.join(
      configuration.lease.workspacePath,
      ".git",
    );
    const uploadRoot = await stat(gitDirectory)
      .then((entry) =>
        entry.isDirectory() ? gitDirectory : configuration.lease.workspacePath,
      )
      .catch(() => configuration.lease.workspacePath);
    const uploadDirectory = path.join(
      uploadRoot,
      uploadRoot === gitDirectory
        ? "modelhop-remote"
        : ".modelhop-remote",
      configuration.lease.id,
    );
    this.workspaceReader = new RemoteWorkspaceReader(
      configuration.lease.workspacePath,
      uploadDirectory,
      (configuration.lease.workspacePaths ?? []).filter(
        (workspacePath) =>
          workspacePath !== configuration.lease.workspacePath,
      ),
    );
    try {
      this.sourceTranscriptSignature =
        await transcriptTailSignature(
          configuration.lease.sourceTranscriptPath,
        );
      configuration.lease.sourceTranscriptSignature =
        this.sourceTranscriptSignature;
    } catch {
      this.sourceTranscriptSignature = "";
    }

    if (
      recoveringSameLease &&
      (this.recoveredRuntime?.state === "active" ||
        this.recoveredRuntime?.state === "execution-lost")
    ) {
      // A new daemon cannot prove that it owns or can safely reattach the old
      // SDK child. Keep the encrypted journal and transcript available for
      // recovery, but fence all mutation instead of silently starting a
      // duplicate model turn.
      this.remoteAccessOpen = true;
      this.remoteInputOpen = false;
      this.recoveredRuntime = {
        ...this.recoveredRuntime,
        state: "execution-lost",
        configuration,
        savedAt: Date.now(),
      };
      await this.persistRuntime("execution-lost");
      return;
    }

    if (!this.sessionController) {
      if (!recoveringSameLease) {
        await this.journal.reset();
        this.commandLedger.hydrate([]);
      }
      const bootstrapNormalisationState: SdkMessageNormalisationState = {
        permissionMode:
          configuration.lease.permissionMode ??
          (configuration.permissionMode === "auto"
            ? "auto-safe"
            : configuration.permissionMode),
      };
      for (const message of recoveringSameLease
        ? []
        : await loadTranscriptPreview(
            configuration.lease.sourceTranscriptPath,
          ).catch(() => [])) {
        for (const event of normaliseSdkMessage(
          message as never,
          configuration.lease.provider,
          new Map(),
          bootstrapNormalisationState,
        )) {
          await this.journal.append(event.type, event.payload);
        }
      }
      const sessionController = new RemoteSessionController(
        configuration,
        this.journal,
        async () => {
          if (
            ![...this.hostActions.values()].some(
              (action) => action.type === "usage.refresh",
            )
          ) {
            await this.queueHostAction("usage.refresh", {});
          }
        },
      );
      try {
        await sessionController.start({
          resumeSessionId:
            configuration.lease.activeSessionId ??
            configuration.lease.sourceSessionId,
          forkSession: !configuration.lease.activeSessionId,
        });
        this.sessionController = sessionController;
      } catch (error) {
        await sessionController.close().catch(() => undefined);
        throw error;
      }
    } else if (
      this.sessionController.getLease().state ===
        "switching-provider" ||
      !sameQueryConfiguration
    ) {
      await this.sessionController.reconfigure(configuration);
    } else {
      await this.sessionController.updateProviderContext(
        configuration.lease.provider,
      );
    }
    this.recoveredRuntime = undefined;
    await this.persistRuntime("active");
  }

  public bootstrap(
    launchToken: string | null,
  ): RemotePairingBootstrap {
    const configuration = this.requireConfiguration();
    if (!this.launchTokenAuthorised(launchToken)) {
      throw new Error("This ModelHop Remote link is no longer valid.");
    }
    return {
      version: REMOTE_PROTOCOL_VERSION,
      sessionId: configuration.lease.id,
      hostPublicKey: configuration.hostIdentityPublicKey,
      sessionSalt: this.sessionSalt,
      serverNow: Date.now(),
      pairingExpiresAt: pairingWindowExpiresAt(
        this.configuredAt,
        configuration.maximumSessionMs,
        this.pairingOpenedAt,
        PAIRING_TTL_MS,
      ),
      sessionExpiresAt:
        this.configuredAt + configuration.maximumSessionMs,
    };
  }

  public launchTokenAuthorised(
    launchToken: string | null,
  ): boolean {
    const configuration = this.configuration;
    return Boolean(
      configuration &&
        safeTokenEqual(
          configuration.launchToken,
          launchToken ?? "",
        ),
    );
  }

  public publicAccessAvailable(): boolean {
    return Boolean(this.configuration && this.remoteAccessOpen);
  }

  public terminalAccessAvailable(): boolean {
    return Boolean(this.configuration && this.terminalAccessOpen);
  }

  public refreshPairingWindow(): void {
    this.requireConfiguration();
    this.pairingOpenedAt = Date.now();
    for (const [id, connection] of this.connections) {
      if (connection.status !== "confirmed") {
        this.connections.delete(id);
      }
    }
  }

  public async connect(
    launchToken: string | null,
    value: unknown,
  ): Promise<RemoteConnectionStatus> {
    const configuration = this.requireConfiguration();
    if (!this.launchTokenAuthorised(launchToken)) {
      throw new Error("This ModelHop Remote link is no longer valid.");
    }
    const request = validConnectionRequest(value);
    for (const [id, connection] of this.connections) {
      if (
        (connection.status !== "confirmed" &&
          Date.now() - connection.createdAt > PAIRING_TTL_MS) ||
        (connection.status === "confirmed" &&
          Date.now() - connection.lastSeenAt > 5 * 60 * 1000)
      ) {
        this.connections.delete(id);
      }
    }
    if (this.connections.size >= 100) {
      throw new Error("Too many remote connection attempts.");
    }
    const fingerprint = hostFingerprint(
      configuration.hostIdentityPublicKey,
    );
    if (
      request.hostFingerprint &&
      request.hostFingerprint !== fingerprint
    ) {
      throw new Error(
        "The host identity changed. Remove the old pairing and confirm this Mac again.",
      );
    }
    const known = this.deviceStore?.findActive(request.deviceId);
    const knownDevice =
      known?.publicKey === request.devicePublicKey;
    const connectionDecision = remoteDeviceConnectionDecision(
      Date.now(),
      this.pairingOpenedAt,
      PAIRING_TTL_MS,
      this.configuredAt + configuration.maximumSessionMs,
      knownDevice,
    );
    if (connectionDecision === "session-expired") {
      throw new Error(
        "This ModelHop Remote session has expired. Start a new phone session on the Mac.",
      );
    }
    if (connectionDecision === "pairing-expired") {
      throw new Error(
        "The new-device pairing window expired. Run “ModelHop: Continue on Phone” again on the Mac.",
      );
    }
    const keys = deriveRemoteSessionKeys(
      configuration.hostIdentityPrivateKey,
      request.devicePublicKey,
      this.sessionSalt,
    );
    const connection: RemoteConnection = {
      id: randomUUID(),
      request,
      status: knownDevice ? "confirmed" : "pending",
      knownDevice,
      sas: pairingSas(keys, request, configuration.lease.id),
      keys,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      inboundSequences: new SequenceReplayWindow(),
      nextOutboundSequence: 1,
      replayThroughEventId: this.journal.latestId(),
    };
    this.connections.set(connection.id, connection);
    if (knownDevice) {
      await this.deviceStore?.touch(request.deviceId);
      await this.claimLease(connection);
    }
    return this.connectionStatus(connection, fingerprint);
  }

  public connectionStatusById(
    connectionId: string,
  ): RemoteConnectionStatus {
    const configuration = this.requireConfiguration();
    const connection = this.requireConnection(connectionId);
    connection.lastSeenAt = Date.now();
    return this.connectionStatus(
      connection,
      hostFingerprint(configuration.hostIdentityPublicKey),
    );
  }

  public async confirmPairing(
    connectionId: string,
    allow: boolean,
  ): Promise<void> {
    const connection = this.requireConnection(connectionId);
    if (connection.status !== "pending") {
      return;
    }
    if (!allow) {
      connection.status = "rejected";
      return;
    }
    const device: PairedDevice = {
      id: connection.request.deviceId,
      name: connection.request.deviceName,
      publicKey: connection.request.devicePublicKey,
      pairedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    await this.deviceStore?.pair(device);
    connection.status = "confirmed";
    await this.claimLease(connection);
  }

  public async revokeDevice(deviceId: string): Promise<boolean> {
    return this.runRemoteMutationSerial(async () => {
      const revoked = (await this.deviceStore?.revoke(deviceId)) ?? false;
      if (revoked) {
        for (const connection of this.connections.values()) {
          if (connection.request.deviceId === deviceId) {
            connection.status = "rejected";
            connection.ownershipFencingGeneration = undefined;
          }
        }
        await this.sessionController?.releaseDeviceOwnership(deviceId);
        if (
          this.mutationOwnerConnectionId &&
          this.connections.get(this.mutationOwnerConnectionId)?.request
            .deviceId === deviceId
        ) {
          this.mutationOwnerConnectionId = undefined;
        }
      }
      return revoked;
    });
  }

  public async encryptedCommand(
    value: unknown,
  ): Promise<EncryptedEnvelope> {
    const envelope = validEnvelope(value);
    const connection = this.requireConfirmedConnection(
      envelope.connectionId,
    );
    const decrypted = decryptEnvelope<unknown>(
      envelope,
      connection.keys.receiveKey,
    );
    if (!connection.inboundSequences.accept(envelope.sequence)) {
      throw new Error("Duplicate or expired remote message.");
    }
    const command = validClientCommand(decrypted);
    connection.lastSeenAt = Date.now();
    const priorReceipt = this.commandLedger.get(command.id);
    this.requireMutationOwnership(connection, command);
    if (!priorReceipt) {
      // Reject conflicting work before it receives a durable accepted
      // receipt. This keeps route and hand-back transactions mutually
      // exclusive even if a stale or modified phone UI sends a command.
      this.requireOperationAdmission(command);
    }
    if (
      !this.remoteAccessOpen &&
      !priorReceipt &&
      command.type !== "session.terminal.ack"
    ) {
      throw new Error("This ModelHop Remote session is closed.");
    }
    if (
      !priorReceipt &&
      !this.remoteInputOpen &&
      startsNewRemoteWork(command)
    ) {
      throw new Error(
        "This ModelHop Remote session is no longer accepting new work. The current turn can still finish and be returned safely.",
      );
    }
    const admitted = await this.commandLedger.accept(command);
    if (
      (admitted.state === "completed" || admitted.state === "failed") &&
      admitted.response
    ) {
      return this.encryptFor(connection, admitted.response);
    }
    if (recordsAuthenticatedRemoteActivity(command)) {
      await this.sessionController?.touchRemoteActivity();
    }
    const response = await this.commandsInFlight.run(
      command.id,
      async () => {
        const current = this.commandLedger.get(command.id) ?? admitted;
        if (
          (current.state === "completed" || current.state === "failed") &&
          current.response
        ) {
          return current.response;
        }
        // An `executing` receipt with no in-memory promise survived a daemon
        // restart. Repeating it could duplicate a prompt, approval, provider
        // switch, reset credit, or hand-back, so fail closed and let the client
        // reconcile the original ID from the journal.
        if (current.state === "executing") {
          const reconcile = () =>
            this.reconcileExecutingCommand(command, current);
          const reconciled = remoteCommandRequiresOwnershipFence(command)
            ? await this.runRemoteMutationSerial(reconcile)
            : await reconcile();
          if (reconciled) {
            await this.commitCommandResponse(current, reconciled);
            return reconciled;
          }
          return this.commandLedger.ambiguousResponse(command.id);
        }
        const executeAccepted = async (): Promise<RemoteCommandResponse> => {
          const executing = await this.commandLedger.markExecuting(current);
          let generated: RemoteCommandResponse;
          try {
            // Ownership can change while admission is being fsynced. Recheck
            // immediately before dispatch and terminally reject the already
            // accepted receipt rather than allowing a stale device to commit.
            this.requireMutationOwnership(connection, command);
            this.requireOperationAdmission(command);
            generated =
              command.type === "session.terminal.ack"
                ? this.acknowledgeTerminal(
                    connection.id,
                    command.id,
                    command.terminalEventId,
                  )
                : await this.dispatchCommand(command);
          } catch (error) {
            generated = {
              id: command.id,
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "The remote command failed before dispatch completed.",
            };
          }
          await this.commitCommandResponse(executing, generated);
          return generated;
        };
        return remoteCommandRequiresOwnershipFence(command)
          ? this.runRemoteMutationSerial(executeAccepted)
          : executeAccepted();
      },
    );
    return this.encryptFor(connection, response);
  }

  private async commitCommandResponse(
    receipt: DurableCommandReceipt,
    response: RemoteCommandResponse,
  ): Promise<void> {
    await this.commandLedger.complete(receipt, response);
    // Preserve the v1 terminal event for older clients while v2 clients
    // consume the richer command.receipt state machine.
    await this.journal.append("command.response", {
      commandId: receipt.commandId,
      response,
    });
  }

  /**
   * A hand-back is represented by a deterministic durable host action. If
   * the HTTP response was lost, the restarted daemon can therefore complete
   * the original command receipt without starting a second hand-back.
   */
  private async reconcileExecutingCommand(
    command: RemoteClientCommand,
    receipt: DurableCommandReceipt,
  ): Promise<RemoteCommandResponse | undefined> {
    if (command.type !== "session.handback") {
      return undefined;
    }
    const lease =
      this.sessionController?.getLease() ??
      this.recoveredRuntime?.runtimeSnapshot?.lease ??
      this.configuration?.lease;
    if (!lease) {
      return {
        id: command.id,
        ok: false,
        error:
          "ModelHop could not recover durable evidence for the interrupted hand-back command.",
      };
    }
    const reference = {
      commandId: command.id,
      requestHash: receipt.requestHash,
    } satisfies RemoteHostActionCommandReference;
    const expectedActionId = deterministicHostActionId({
      type: "session.handback",
      leaseId: lease.id,
      ...reference,
    });
    const terminal = this.hostActionTerminals.get(expectedActionId);
    if (terminal) {
      return {
        id: command.id,
        ok: true,
        data: {
          queued: true,
          actionId: expectedActionId,
          operationId: terminal.operationId,
          terminalState: terminal.state,
        },
      };
    }
    let action =
      this.hostActions.get(expectedActionId) ??
      [...this.hostActions.values()].find(
        (candidate) =>
          candidate.type === "session.handback" &&
          candidate.leaseId === lease.id,
      );
    const cancelActive =
      command.strategy === "cancel" || Boolean(command.cancelActive);
    if (action && cancelActive && action.payload.cancelActive !== true) {
      action = {
        ...action,
        payload: {
          ...action.payload,
          strategy: "cancel",
          cancelActive: true,
        },
      };
      await this.journal.append("host.action", action);
      this.hostActions.set(action.id, action);
      await this.sessionController?.requestHandbackCancellation();
    }
    if (!action) {
      const operationId = deterministicRemoteOperationId(
        "handback",
        expectedActionId,
      );
      const operation = this.durableOperation(operationId, lease);
      if (
        operation?.kind === "handback" &&
        operation.id === operationId
      ) {
        action = {
          id: expectedActionId,
          type: "session.handback",
          payload: {
            strategy: cancelActive ? "cancel" : "finish",
            cancelActive,
          },
          createdAt: receipt.acceptedAt,
          leaseId: lease.id,
          ownerWorkspacePath: lease.workspacePath,
          operationId,
          ...reference,
        };
        await this.journal.append("host.action", action);
        this.hostActions.set(action.id, action);
      }
    }
    if (!action) {
      return {
        id: command.id,
        ok: false,
        error:
          "The interrupted hand-back has no durable host action and was not repeated.",
      };
    }
    return {
      id: command.id,
      ok: true,
      data: {
        queued: true,
        actionId: action.id,
        operationId: action.operationId,
      },
    };
  }

  private durableOperation(
    operationId: string,
    lease: RemoteSessionLease,
  ): RemoteOperation | undefined {
    if (lease.operation?.id === operationId) {
      return lease.operation;
    }
    const events = this.journal.window(
      Math.max(0, this.journal.latestId() - 10_000),
      10_000,
    ).events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        !event ||
        event.type !== "operation.state" ||
        !isRecord(event.payload)
      ) {
        continue;
      }
      if (
        event.payload.id === operationId &&
        event.payload.kind === "handback" &&
        event.payload.leaseId === lease.id
      ) {
        return event.payload as unknown as RemoteOperation;
      }
    }
    return undefined;
  }

  public confirmedConnectionAuthorised(
    connectionId: string | undefined,
  ): boolean {
    return Boolean(
      connectionId &&
        this.connections.get(connectionId)?.status === "confirmed",
    );
  }

  public async encryptedEvents(
    connectionId: string,
    after: number,
  ): Promise<EncryptedEnvelope> {
    const connection =
      this.requireConfirmedConnection(connectionId);
    connection.lastSeenAt = Date.now();
    const window = await this.journal.waitSince(
      Math.max(0, after),
      LONG_POLL_MS,
    );
    const runtimeSnapshot = window.gap
      ? this.runtimeSnapshot(window.latestEventId)
      : undefined;
    if (runtimeSnapshot) {
      await this.journal.saveSnapshot(
        runtimeSnapshot,
        window.latestEventId,
      );
    }
    const ownership = this.currentMutationOwnership();
    const canMutate = this.connectionCanMutate(
      connection,
      ownership,
    );
    const viewerOwnership = {
      deviceId: connection.request.deviceId,
      ownerDeviceId: ownership.ownerDeviceId,
      fencingGeneration: ownership.fencingGeneration,
      canMutate,
      owner: canMutate ? "phone" : "non-owner",
    };
    const lease = this.sessionController?.getLease();
    const viewerLease = lease
      ? { ...lease, ownership: viewerOwnership }
      : undefined;
    const viewerSnapshot = runtimeSnapshot
      ? {
          ...runtimeSnapshot,
          ownership: {
            ...runtimeSnapshot.ownership,
            ...viewerOwnership,
          },
        }
      : undefined;
    return this.encryptFor(connection, {
      events: window.events,
      lease: viewerLease,
      provider: lease?.provider,
      epoch: window.epoch,
      earliestEventId: window.earliestEventId,
      latestEventId: window.events.at(-1)?.id ?? window.latestEventId,
      snapshotCursor: runtimeSnapshot
        ? window.latestEventId
        : 0,
      journalLatestEventId: window.latestEventId,
      journalEpoch: window.epoch,
      earliestAvailableEventId: window.earliestEventId,
      gap: window.gap,
      snapshot: viewerSnapshot,
      snapshotThroughEventId: viewerSnapshot
        ? window.latestEventId
        : undefined,
      terminalEventId: this.terminalEventId,
      replayThroughEventId: connection.replayThroughEventId,
    });
  }

  private runtimeSnapshot(
    throughEventId: number,
  ): RemoteRuntimeSnapshot | undefined {
    const runtime =
      this.sessionController?.getRuntimeSnapshot() ??
      this.recoveredRuntime?.runtimeSnapshot;
    if (!runtime) {
      return undefined;
    }
    const tunnelConnected = Boolean(
      this.tunnel && processAlive(this.tunnel.pid),
    );
    const executionLost =
      !this.sessionController &&
      this.recoveredRuntime?.state === "execution-lost";
    return {
      ...structuredClone(runtime),
      capturedAt: Date.now(),
      lease: executionLost
        ? {
            ...structuredClone(runtime.lease),
            state: "error",
            turnPhase: "failed",
            error:
              "The detached controller stopped and could not safely reattach to its Claude process. The transcript remains recoverable.",
          }
        : structuredClone(runtime.lease),
      transport: {
        state: tunnelConnected
          ? "connected"
          : this.tunnel
            ? "recovering"
            : "link-lost",
        updatedAt: Date.now(),
      },
      execution: executionLost
        ? {
            ...structuredClone(runtime.execution),
            state: "error",
            foregroundActive: false,
            workItems: runtime.execution.workItems.map((item) =>
              item.phase === "complete" ||
              item.phase === "failed" ||
              item.phase === "cancelled"
                ? structuredClone(item)
                : {
                    ...structuredClone(item),
                    phase: "completion-unknown" as const,
                  },
            ),
          }
        : structuredClone(runtime.execution),
      journal: {
        epoch: this.journal.epoch(),
        latestEventId: throughEventId,
        snapshotCursor: throughEventId,
      },
    };
  }

  private async persistRuntime(
    state: PersistedDaemonRuntime["state"],
  ): Promise<void> {
    await this.runtimeStore.save({
      version: 1,
      savedAt: Date.now(),
      state,
      configuration: this.configuration,
      runtimeSnapshot: this.runtimeSnapshot(this.journal.latestId()),
      hostActions: [...this.hostActions.values()],
      hostActionTerminals: boundedHostActionTerminals(
        this.hostActionTerminals.values(),
      ),
      tunnel: this.tunnel,
      daemon: {
        pid: process.pid,
        startedAt: this.daemonStartedAt,
        buildVersion: REMOTE_BUILD_VERSION,
      },
    });
  }

  public setTunnel(value: unknown): void {
    if (!this.publicAccessAvailable()) {
      throw new Error(
        "A Cloudflare tunnel cannot be attached to a closed remote session.",
      );
    }
    if (!isRecord(value)) {
      throw new Error("The remote tunnel state is invalid.");
    }
    const baseUrl =
      typeof value.baseUrl === "string"
        ? validQuickTunnelOrigin(value.baseUrl)
        : undefined;
    if (
      value.transport !== "cloudflare-quick" ||
      !baseUrl ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.executable !== "string" ||
      !path.isAbsolute(value.executable) ||
      value.originPort !== this.port ||
      typeof value.configPath !== "string" ||
      !path.isAbsolute(value.configPath) ||
      path.dirname(path.resolve(value.configPath)) !==
        path.resolve(this.stateDirectory) ||
      !/^cloudflared-quick-[a-f0-9-]+\.yml$/i.test(
        path.basename(value.configPath),
      ) ||
      typeof value.logPath !== "string" ||
      !path.isAbsolute(value.logPath) ||
      path.dirname(path.resolve(value.logPath)) !==
        path.resolve(this.stateDirectory) ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      value.startedAt > Date.now() + 60_000 ||
      value.startedAt < Date.now() - 24 * 60 * 60 * 1000
    ) {
      throw new Error("The Cloudflare Quick Tunnel state is invalid.");
    }
    this.tunnel = {
      transport: "cloudflare-quick",
      pid: value.pid,
      baseUrl,
      executable: value.executable,
      originPort: value.originPort,
      configPath: value.configPath,
      logPath: value.logPath,
      startedAt: value.startedAt,
    };
  }

  public claimHostActions(
    owner: string,
    workspaceOwnerId: string,
  ): RemoteHostAction[] {
    if (
      this.configuration?.workspaceOwnerId &&
      workspaceOwnerId !== this.configuration.workspaceOwnerId
    ) {
      return [];
    }
    const now = Date.now();
    return [...this.hostActions.values()].flatMap((action) => {
      const controller = this.sessionController;
      const requiresQuiescentController =
        action.type === "provider.change" ||
        action.type === "session.handback";
      if (this.hostActionsBeingSuperseded.has(action.id)) {
        return [];
      }
      const operation = controller?.getLease().operation;
      if (
        requiresQuiescentController &&
        action.operationId &&
        (!operation ||
          operation.id !== action.operationId ||
          operation.phase === "complete" ||
          operation.phase === "failed")
      ) {
        // A daemon interruption between operation retirement and action
        // tombstoning must never let the old desktop action mutate the route.
        return [];
      }
      if (requiresQuiescentController && controller?.isBusy()) {
        return [];
      }
      let claim = this.actionClaims.get(action.id);
      if (
        claim &&
        claim.owner !== owner &&
        claim.expiresAt > now
      ) {
        return [];
      }
      if (!claim || claim.owner !== owner || claim.expiresAt <= now) {
        claim = {
          owner,
          token: randomSecret(),
          claimedAt: now,
          expiresAt: now + ACTION_CLAIM_TTL_MS,
        };
      } else {
        claim = {
          ...claim,
          claimedAt: now,
          expiresAt: now + ACTION_CLAIM_TTL_MS,
        };
      }
      this.actionClaims.set(action.id, claim);
      return [
        {
          ...action,
          claimToken: claim.token,
          claimOwner: claim.owner,
          claimExpiresAt: claim.expiresAt,
        },
      ];
    });
  }

  public heartbeatHostAction(
    actionId: string,
    owner: string,
    claimToken: string,
  ): number {
    if (!this.hostActions.has(actionId)) {
      throw new Error("The remote action no longer exists.");
    }
    const claim = this.actionClaims.get(actionId);
    if (
      !claim ||
      claim.owner !== owner ||
      !safeTokenEqual(claim.token, claimToken)
    ) {
      throw new Error("The remote action claim is stale.");
    }
    const expiresAt = Date.now() + ACTION_CLAIM_TTL_MS;
    this.actionClaims.set(actionId, {
      ...claim,
      claimedAt: Date.now(),
      expiresAt,
    });
    return expiresAt;
  }

  public claimPairings(
    owner: string,
    workspaceOwnerId: string,
  ): RemoteDaemonStatus["pendingPairings"] {
    if (
      this.configuration?.workspaceOwnerId &&
      workspaceOwnerId !== this.configuration.workspaceOwnerId
    ) {
      return [];
    }
    const now = Date.now();
    return this.status().pendingPairings.filter((pairing) => {
      const claim = this.pairingClaims.get(pairing.connectionId);
      if (
        claim &&
        claim.owner !== owner &&
        now - claim.claimedAt < 5_000
      ) {
        return false;
      }
      this.pairingClaims.set(pairing.connectionId, {
        owner,
        claimedAt: now,
      });
      return true;
    });
  }

  public async completeHostAction(
    actionId: string,
    success: boolean,
    error?: string,
    claimToken?: string,
    owner?: string,
  ): Promise<void> {
    const requestedState = success ? "complete" : "failed";
    const priorTerminal = this.hostActionTerminals.get(actionId);
    if (priorTerminal) {
      if (priorTerminal.state !== requestedState) {
        throw new Error(
          `The remote action already finished as ${priorTerminal.state}.`,
        );
      }
      // The editor can lose the HTTP response after the terminal journal
      // commit. Treat an identical replay as acknowledgement of that commit.
      return;
    }
    const action = this.hostActions.get(actionId);
    if (!action) {
      throw new Error("The remote action no longer exists.");
    }
    const claim = this.actionClaims.get(actionId);
    if (
      claim &&
      (!claimToken ||
        !owner ||
        claim.owner !== owner ||
        !safeTokenEqual(claim.token, claimToken))
    ) {
      throw new Error("The remote action claim is stale.");
    }
    const operation = this.sessionController?.getLease().operation;
    if (operation && operation.id === action.operationId) {
      const controller = this.sessionController;
      if (controller) {
        await controller.setOperation({
          ...operation,
          phase: success ? "complete" : "failed",
          updatedAt: Date.now(),
          error: success
            ? undefined
            : error ?? "The requested desktop action failed.",
        });
      }
    }
    // Complete the activity row created by `host.action` instead of showing
    // a detached toast. Generic completion popups arrived after the visible
    // provider/usage state and looked like unrelated, out-of-order requests.
    await this.recordHostActionTerminal(
      action,
      requestedState,
      success
        ? "Completed on your Mac."
        : error ?? "The requested desktop action failed.",
    );
    if (success && operation?.id === action.operationId) {
      await this.sessionController?.setOperation(undefined);
    }
  }

  private async recordHostActionTerminal(
    action: RemoteHostAction,
    state: RemoteHostActionTerminal["state"],
    message: string,
  ): Promise<void> {
    const terminal: RemoteHostActionTerminal = {
      id: action.id,
      state,
      completedAt: Date.now(),
      message,
      leaseId: action.leaseId,
      operationId: action.operationId,
      commandId: action.commandId,
      requestHash: action.requestHash,
    };
    await this.journal.append("host.action.state", terminal);
    this.hostActionTerminals.set(action.id, terminal);
    this.hostActions.delete(action.id);
    this.actionClaims.delete(action.id);
    const retained = boundedHostActionTerminals(
      this.hostActionTerminals.values(),
    );
    this.hostActionTerminals.clear();
    for (const item of retained) {
      this.hostActionTerminals.set(item.id, item);
    }
  }

  private providerSwitchActions(
    operation: RemoteOperation,
  ): RemoteHostAction[] {
    return [...this.hostActions.values()].filter(
      (action) =>
        action.type === "provider.change" &&
        action.operationId === operation.id,
    );
  }

  private assertProviderSwitchCanYieldToHandback(
    operation: RemoteOperation,
  ): RemoteHostAction[] {
    const actions = this.providerSwitchActions(operation);
    if (
      !canSupersedeUnstartedProviderSwitch(
        operation,
        actions,
        new Set(this.actionClaims.keys()),
      )
    ) {
      throw new Error(
        "The provider switch has already been claimed or begun. It must commit or roll back before returning this conversation to the laptop.",
      );
    }
    return actions;
  }

  /**
   * Retires an unclaimed provider-change action before installing hand-back.
   * `hostActionMutationTail` serializes phone and desktop enqueue requests;
   * the synchronous reservation below additionally fences the editor poller.
   */
  private async supersedeUnstartedProviderSwitch(
    operation: RemoteOperation,
  ): Promise<void> {
    const controller = this.sessionController;
    if (!controller) {
      throw new Error("The remote Claude session is unavailable.");
    }
    const actions = this.assertProviderSwitchCanYieldToHandback(operation);
    for (const action of actions) {
      this.hostActionsBeingSuperseded.add(action.id);
    }
    try {
      const current = controller.getLease().operation;
      if (
        !current ||
        current.id !== operation.id ||
        current.kind !== "provider-switch" ||
        current.phase !== "waiting-for-turn" ||
        actions.some((action) => this.actionClaims.has(action.id))
      ) {
        throw new Error(
          "The provider switch began before hand-back could replace it. It must commit or roll back first.",
        );
      }
      const now = Date.now();
      await controller.setOperation({
        ...current,
        phase: "failed",
        rollbackResult: "not-needed",
        updatedAt: now,
        error:
          "Provider switch cancelled before route mutation because the user requested hand-back.",
      });
      for (const action of actions) {
        await this.recordHostActionTerminal(
          action,
          "failed",
          "Provider switch cancelled before route changes began; returning the conversation to the laptop instead.",
        );
      }
      await controller.setOperation(undefined);
    } finally {
      for (const action of actions) {
        this.hostActionsBeingSuperseded.delete(action.id);
      }
    }
  }

  public async updateProvider(
    provider: RemoteProviderContext,
  ): Promise<void> {
    const controller = this.sessionController;
    if (!controller) {
      return;
    }
    const activeProvider = controller.getLease().provider;
    const merged = mergeProviderUsage(activeProvider, provider);
    await controller.updateProviderContext(merged);
    await this.journal.append("usage.snapshot", {
      kind: "usage.snapshot",
      provider: merged.provider,
      status:
        merged.usage === undefined ? "unavailable" : "available",
      model: merged.model,
      updatedAt: merged.updatedAt,
      allowance: merged.usage,
    });
  }

  public async updateActivity(
    value: unknown,
  ): Promise<void> {
    if (!isRecord(value)) {
      throw new Error("The bridge activity payload is invalid.");
    }
    const phase = value.phase;
    if (
      phase !== "idle" &&
      phase !== "counting" &&
      phase !== "compacting" &&
      phase !== "requesting"
    ) {
      throw new Error("The bridge activity phase is invalid.");
    }
    const mappedPhase: RemoteActivityEvent["phase"] =
      phase === "idle" ? "idle" : phase;
    const activityIdentity =
      typeof value.requestId === "string" && value.requestId
        ? value.requestId
        : typeof value.startedAt === "number"
          ? String(value.startedAt)
          : "idle";
    await this.journal.append("activity.event", {
      kind: "activity.event",
      id: `bridge-activity-${activityIdentity}`,
      category:
        phase === "compacting" ? "compaction" : "status",
      phase: mappedPhase,
      title:
        phase === "idle"
          ? "Bridge ready"
          : phase === "counting"
            ? "Counting conversation tokens"
            : phase === "compacting"
              ? "Compressing conversation"
              : "Requesting model response",
      detail:
        typeof value.estimatedInputTokens === "number"
          ? `${Math.round(value.estimatedInputTokens).toLocaleString()} estimated tokens`
          : undefined,
      createdAt:
        typeof value.startedAt === "number"
          ? value.startedAt
          : Date.now(),
      updatedAt:
        typeof value.updatedAt === "number"
          ? value.updatedAt
          : Date.now(),
      data: value,
    } satisfies RemoteActivityEvent);
  }

  public async updateOperation(value: unknown): Promise<void> {
    if (!isRecord(value)) {
      throw new Error("The remote operation payload is invalid.");
    }
    const current = this.sessionController?.getLease().operation;
    if (
      !current ||
      value.id !== current.id ||
      typeof value.phase !== "string" ||
      ![
        "waiting-for-turn",
        "waiting-for-work",
        "reconciling-final-record",
        "quiescing",
        "stabilizing-transcript",
        "open-command-sent",
        "desktop-confirmed",
        "phone-terminal-acked",
        "cleanup-pending",
        "applying",
        "reloading",
        "restarting",
        "opening-session",
        "rolling-back",
        "complete",
        "failed",
      ].includes(value.phase)
    ) {
      throw new Error("The remote operation is no longer active.");
    }
    await this.sessionController?.setOperation({
      ...current,
      phase: value.phase as RemoteOperation["phase"],
      updatedAt: Date.now(),
      ...(typeof value.waitReason === "string"
        ? { waitReason: value.waitReason.slice(0, 2_000) }
        : {}),
      error:
        typeof value.error === "string"
          ? value.error.slice(0, 2_000)
          : undefined,
    });
  }

  public async prepareHandback(
    strategy: "finish" | "cancel",
    expected: { operationId: string; leaseId: string },
  ): Promise<RemoteSessionLease | undefined> {
    const controller = this.sessionController;
    if (!controller) {
      throw new Error("The remote Claude session is unavailable.");
    }
    const lease = controller.getLease();
    const operation = lease.operation;
    if (
      lease.id !== expected.leaseId ||
      operation?.kind !== "handback" ||
      operation.id !== expected.operationId ||
      operation.phase === "complete" ||
      operation.phase === "failed"
    ) {
      throw new Error(
        "The requested hand-back generation is no longer active.",
      );
    }
    return controller.prepareHandback(strategy);
  }

  public requestHandback(
    requestId: string,
    strategy: "finish" | "cancel",
  ): Promise<{ queued: true; actionId: string; operationId?: string }> {
    const command: RemoteClientCommand = {
      id: requestId,
      type: "session.handback",
      strategy,
      cancelActive: strategy === "cancel",
    };
    return this.runRemoteMutationSerial(() => {
      this.requireOperationAdmission(command);
      return this.queueHostAction(
        "session.handback",
        {
          strategy,
          cancelActive: strategy === "cancel",
          requestedBy: "desktop",
        },
        {
          commandId: requestId,
          requestHash: remoteCommandRequestHash(command),
        },
      );
    });
  }

  public cancelHandbackRequest(
    operationId: string,
  ): Promise<{ cancelled: true; operationId: string }> {
    return this.runRemoteMutationSerial(async () => {
      const controller = this.sessionController;
      if (!controller) {
        throw new Error("The remote Claude session is unavailable.");
      }
      const operation = controller.getLease().operation;
      if (
        !operation ||
        operation.kind !== "handback" ||
        operation.id !== operationId
      ) {
        throw new Error(
          "The hand-back operation is no longer available to cancel.",
        );
      }
      const relatedActions = [...this.hostActions.values()].filter(
        (action) => action.operationId === operation.id,
      );
      if (
        relatedActions.some(
          (action) =>
            action.payload.cancelActive === true ||
            action.payload.strategy === "cancel",
        ) ||
        !controller.cancelHandbackRequest()
      ) {
        throw new Error(
          "Active work cancellation has already begun, so this hand-back can no longer be withdrawn.",
        );
      }
      for (const action of relatedActions) {
        await this.recordHostActionTerminal(
          action,
          "failed",
          "Hand-back cancelled. Remote work remains available on this phone.",
        );
      }
      await controller.setOperation(undefined);
      return { cancelled: true, operationId: operation.id };
    });
  }

  public async stopSession(): Promise<
    ReturnType<RemoteSessionController["getLease"]> | undefined
  > {
    this.terminalAccessOpen = true;
    this.remoteAccessOpen = false;
    this.remoteInputOpen = false;
    const controller = this.sessionController;
    const lease =
      controller?.getLease().state === "stopped"
        ? controller.getLease()
        : await controller?.stop();
    if (lease?.state === "stopped") {
      this.terminalEventId = this.journal.latestId();
    }
    await unlink(COMPANION_STATE_PATH).catch(() => undefined);
    if (this.terminalTunnelStopTimer) {
      clearTimeout(this.terminalTunnelStopTimer);
    }
    // Keep the connector alive while the phone renders and acknowledges the
    // authoritative stopped lease. The deadline prevents an orphan if the
    // browser disappeared before hand-back completed.
    this.terminalTunnelStopTimer = setTimeout(() => {
      this.terminalTunnelStopTimer = undefined;
      void this.stopTunnel().catch(async (error) => {
        await this.journal.append("error", {
          message:
            error instanceof Error
              ? error.message
              : "The Cloudflare Quick Tunnel did not stop cleanly.",
        });
      });
    }, TERMINAL_TUNNEL_GRACE_MS);
    await this.waitForTerminalAcknowledgement(
      TERMINAL_ACK_TIMEOUT_MS,
    );
    await this.persistRuntime("stopped");
    return lease;
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.stopSession();
    await this.stopTunnel().catch(async (error) => {
      await this.journal.append("error", {
        message:
          error instanceof Error
            ? error.message
            : "The Cloudflare Quick Tunnel did not stop cleanly.",
      });
    });
    await this.journal.flush();
    await this.runtimeStore.flush();
  }

  public async serveAsset(
    pathname: string,
    response: ServerResponse,
  ): Promise<boolean> {
    const configuration = this.requireConfiguration();
    const assets = new Map<
      string,
      { file: string; contentType: string; cache?: boolean }
    >([
      [
        "/",
        {
          file: "index.html",
          contentType: "text/html; charset=utf-8",
        },
      ],
      [
        "/app.js",
        {
          file: "app.js",
          contentType: "text/javascript; charset=utf-8",
          cache: true,
        },
      ],
      [
        "/styles.css",
        {
          file: "styles.css",
          contentType: "text/css; charset=utf-8",
          cache: true,
        },
      ],
      [
        "/chat-mesh.svg",
        {
          file: "chat-mesh.svg",
          contentType: "image/svg+xml; charset=utf-8",
          cache: true,
        },
      ],
    ]);
    if (pathname === "/icon.png") {
      text(
        response,
        200,
        "image/png",
        await readFile(configuration.iconPath),
        { cache: true },
      );
      return true;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      return false;
    }
    const assetBody = await readFile(
      path.join(configuration.assetsDirectory, asset.file),
    );
    const scriptNonce = asset.file === "index.html"
      ? randomSecret(24)
      : undefined;
    const body = scriptNonce
      ? assetBody.toString("utf8").replace(
          "<head>",
          `<head>\n    <meta name="modelhop-csp-nonce" content="${scriptNonce}" />`,
        )
      : assetBody;
    text(
      response,
      200,
      asset.contentType,
      body,
      { cache: asset.cache, scriptNonce },
    );
    return true;
  }

  private requireConfiguration(): RemoteDaemonConfiguration {
    if (!this.configuration) {
      throw new Error("ModelHop Remote is not configured.");
    }
    return this.configuration;
  }

  private requireConnection(connectionId: string): RemoteConnection {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error("Unknown remote connection.");
    }
    return connection;
  }

  private acknowledgeTerminal(
    connectionId: string,
    commandId: string,
    terminalEventId: number,
  ): RemoteCommandResponse {
    if (
      !this.terminalAccessOpen ||
      this.terminalEventId === undefined ||
      terminalEventId < this.terminalEventId
    ) {
      return {
        id: commandId,
        ok: false,
        error: "The terminal session state is not available to acknowledge.",
      };
    }
    this.terminalAcknowledgements.add(connectionId);
    this.resolveTerminalAcknowledgementWaiters();
    return {
      id: commandId,
      ok: true,
      data: { acknowledged: true },
    };
  }

  private async waitForTerminalAcknowledgement(
    timeoutMs: number,
  ): Promise<void> {
    const hasPairedPhone = [...this.connections.values()].some(
      (connection) => connection.status === "confirmed",
    );
    if (!hasPairedPhone || this.terminalAcknowledgements.size > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout);
        this.terminalAcknowledgementWaiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.terminalAcknowledgementWaiters.add(finish);
    });
  }

  private resolveTerminalAcknowledgementWaiters(): void {
    for (const resolve of this.terminalAcknowledgementWaiters) {
      resolve();
    }
    this.terminalAcknowledgementWaiters.clear();
  }

  private requireConfirmedConnection(
    connectionId: string,
  ): RemoteConnection {
    const connection = this.requireConnection(connectionId);
    if (connection.status !== "confirmed") {
      throw new Error("The remote device is not paired.");
    }
    return connection;
  }

  private connectionStatus(
    connection: RemoteConnection,
    fingerprint: string,
  ): RemoteConnectionStatus {
    const ownership = this.currentMutationOwnership();
    return {
      connectionId: connection.id,
      status: connection.status,
      sas:
        connection.status === "pending"
          ? connection.sas
          : undefined,
      knownDevice: connection.knownDevice,
      hostFingerprint: fingerprint,
      canMutate: this.connectionCanMutate(connection, ownership),
      ownershipFencingGeneration: ownership.fencingGeneration,
      ownerDeviceId: ownership.ownerDeviceId,
    };
  }

  private currentMutationOwnership(): {
    ownerDeviceId?: string;
    fencingGeneration: number;
  } {
    const ownership =
      this.sessionController?.getRuntimeSnapshot().ownership ??
      this.recoveredRuntime?.runtimeSnapshot?.ownership;
    return {
      ownerDeviceId: ownership?.deviceId,
      fencingGeneration: ownership?.fencingGeneration ?? 0,
    };
  }

  private connectionCanMutate(
    connection: RemoteConnection,
    ownership = this.currentMutationOwnership(),
  ): boolean {
    return (
      connection.status === "confirmed" &&
      connectionHoldsRemoteMutationFence(
        {
          deviceId: connection.request.deviceId,
          fencingGeneration: connection.ownershipFencingGeneration,
        },
        ownership,
      )
    );
  }

  private requireMutationOwnership(
    connection: RemoteConnection,
    command: RemoteClientCommand,
  ): void {
    if (
      remoteCommandRequiresOwnershipFence(command) &&
      !this.connectionCanMutate(connection)
    ) {
      throw new Error(
        "This paired phone is read-only because another device owns the remote conversation.",
      );
    }
  }

  private requireOperationAdmission(command: RemoteClientCommand): void {
    const operation = this.sessionController?.getLease().operation;
    const activeOperation =
      operation &&
      operation.phase !== "complete" &&
      operation.phase !== "failed"
        ? operation
        : undefined;
    const admission = evaluateRemoteCommandAdmission(
      command,
      activeOperation,
    );
    if (!admission.allowed) {
      throw new Error(admission.reason);
    }
    if (
      command.type === "session.handback" &&
      activeOperation?.kind === "provider-switch"
    ) {
      // The phase-only policy admits the narrow escape hatch. The daemon is
      // the authority for the second fence: a desktop claim means encrypted
      // checkpoint capture or route mutation may already have started.
      this.assertProviderSwitchCanYieldToHandback(activeOperation);
    }
  }

  private runRemoteMutationSerial<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.remoteMutationTail.then(task);
    this.remoteMutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async claimLease(
    connection: RemoteConnection,
  ): Promise<void> {
    return this.runRemoteMutationSerial(() =>
      this.claimLeaseSerial(connection),
    );
  }

  private async claimLeaseSerial(
    connection: RemoteConnection,
  ): Promise<void> {
    const controller = this.sessionController;
    if (!controller) {
      return;
    }
    const currentOwner = controller.getLease().ownerDeviceId;
    if (
      currentOwner === undefined ||
      currentOwner === connection.request.deviceId
    ) {
      await controller.claimDevice(
        connection.request.deviceId,
        currentOwner === connection.request.deviceId &&
          this.mutationOwnerConnectionId !== connection.id,
      );
      this.mutationOwnerConnectionId = connection.id;
    }
    const ownership = this.currentMutationOwnership();
    const ownsLease =
      ownership.ownerDeviceId === connection.request.deviceId;
    connection.ownershipFencingGeneration = ownsLease
      ? ownership.fencingGeneration
      : undefined;
    await this.journal.append("notification", {
      level: ownsLease ? "success" : "warning",
      message: ownsLease
        ? `${connection.request.deviceName} connected securely.`
        : `${connection.request.deviceName} connected securely in read-only mode because another phone owns this conversation.`,
    });
    connection.replayThroughEventId = this.journal.latestId();
  }

  private encryptFor(
    connection: RemoteConnection,
    value: unknown,
  ): EncryptedEnvelope {
    const envelope = encryptEnvelope(
      connection.id,
      connection.nextOutboundSequence,
      connection.keys.sendKey,
      value,
    );
    connection.nextOutboundSequence += 1;
    return envelope;
  }

  private async dispatchCommand(
    command: RemoteClientCommand,
  ): Promise<RemoteCommandResponse> {
    try {
      const data = await this.runCommand(command);
      return { id: command.id, ok: true, data };
    } catch (error) {
      return {
        id: command.id,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "The remote command failed.",
      };
    }
  }

  private async runCommand(
    command: RemoteClientCommand,
  ): Promise<unknown> {
    const controller = this.sessionController;
    const workspace = this.workspaceReader;
    if (!controller || !workspace) {
      throw new Error("The remote session is not ready.");
    }
    switch (command.type) {
      case "prompt.send": {
        const attachmentPaths = (command.attachmentIds ?? []).map(
          (id) => {
            const filePath = this.attachmentPaths.get(id);
            if (!filePath) {
              throw new Error(`Attachment ${id} is unavailable.`);
            }
            return filePath;
          },
        );
        if (controller.getLease().operation) {
          throw new Error(
            "ModelHop is completing a provider switch or hand-back. Wait for it to finish before sending another prompt.",
          );
        }
        await controller.sendPrompt(
          command.prompt,
          attachmentPaths,
          command.id,
        );
        return { accepted: true };
      }
      case "turn.cancel":
        await controller.cancel();
        return { cancelled: true };
      case "permission.resolve":
        await controller.resolvePermission(
          command.requestId,
          command.decision,
          command.message,
        );
        return { resolved: true };
      case "permission.mode.set":
        await controller.setPermissionMode(command.mode);
        await this.persistRuntime("active");
        return { changed: true, mode: command.mode };
      case "question.resolve":
        await controller.resolveQuestion(
          command.requestId,
          command.answers,
        );
        return { resolved: true };
      case "model.change": {
        if (controller.isBusy()) {
          throw new Error(
            "Wait for the current response before changing model.",
          );
        }
        await controller.setModel(
          command.model,
          command.reasoningEffort,
        );
        const selectedProvider = controller.getLease().provider;
        return {
          changed: true,
          ...(await this.queueHostAction("model.sync", {
            provider: selectedProvider.provider,
            model: selectedProvider.model,
            reasoningEffort: selectedProvider.reasoningEffort,
            providerUpdatedAt: selectedProvider.updatedAt,
          })),
        };
      }
      case "reasoning.change": {
        if (controller.isBusy()) {
          throw new Error(
            "Wait for the current response before changing reasoning settings.",
          );
        }
        const provider = await controller.setReasoning(command);
        const hostAction =
          command.effort !== undefined &&
          provider.provider !== "anthropic" &&
          provider.provider !== "synthetic"
            ? await this.queueHostAction("model.sync", {
                provider: provider.provider,
                model: provider.model,
                reasoningEffort: provider.reasoningEffort,
                providerUpdatedAt: provider.updatedAt,
              })
            : undefined;
        return {
          changed: true,
          provider,
          ...(hostAction ? { hostAction } : {}),
        };
      }
      case "provider.change":
        return this.queueHostAction(command.type, {
          provider: command.provider,
        });
      case "usage.refresh":
        return this.queueHostAction(command.type, {});
      case "codex.reset":
        return this.queueHostAction(command.type, {
          ...(command.creditId
            ? { creditId: command.creditId }
            : {}),
        });
      case "session.handback":
        return this.queueHostAction(
          command.type,
          {
            strategy:
              command.strategy ??
              (command.cancelActive ? "cancel" : "finish"),
            cancelActive:
              command.strategy === "cancel" ||
              Boolean(command.cancelActive),
          },
          {
            commandId: command.id,
            requestHash: remoteCommandRequestHash(command),
          },
        );
      case "session.handback.continue": {
        const operation = controller.getLease().operation;
        if (
          !operation ||
          operation.kind !== "handback" ||
          operation.id !== command.operationId
        ) {
          throw new Error(
            "The hand-back operation is no longer waiting for attention.",
          );
        }
        const now = Date.now();
        await controller.setOperation({
          ...operation,
          attentionAt: now + 15 * 60 * 1_000,
          updatedAt: now,
          waitReason:
            operation.waitReason ?? "Waiting for terminal work evidence",
        });
        return {
          continued: true,
          operationId: operation.id,
          attentionAt: now + 15 * 60 * 1_000,
        };
      }
      case "session.handback.cancel-request": {
        const operation = controller.getLease().operation;
        if (
          !operation ||
          operation.kind !== "handback" ||
          operation.id !== command.operationId
        ) {
          throw new Error(
            "The hand-back operation is no longer available to cancel.",
          );
        }
        const relatedActions = [...this.hostActions.values()].filter(
          (action) => action.operationId === operation.id,
        );
        if (
          relatedActions.some(
            (action) =>
              action.payload.cancelActive === true ||
              action.payload.strategy === "cancel",
          ) ||
          !controller.cancelHandbackRequest()
        ) {
          throw new Error(
            "Active work cancellation has already begun, so this hand-back can no longer be withdrawn.",
          );
        }
        for (const action of relatedActions) {
          await this.recordHostActionTerminal(
            action,
            "failed",
            "Hand-back cancelled. Remote work remains available on this phone.",
          );
        }
        await controller.setOperation(undefined);
        return {
          cancelled: true,
          operationId: operation.id,
        };
      }
      case "session.terminal.ack":
        throw new Error(
          "Terminal acknowledgements must use the terminal command path.",
        );
      case "files.search":
        return { files: await workspace.searchFiles(command.query) };
      case "files.list":
        return {
          roots: workspace.workspaceRoots(),
          page: await workspace.listDirectory(
            command.rootId,
            command.path,
            command.cursor,
            command.pageSize,
          ),
        };
      case "symbols.search":
        return {
          symbols: await workspace.searchSymbols(command.query),
        };
      case "file.read":
        return workspace.readFile(command.path);
      case "file.reference.read":
        return workspace.readReference(command.reference);
      case "git.status":
        return { content: await workspace.gitStatus() };
      case "git.diff":
        return {
          content: await workspace.gitDiff(Boolean(command.staged)),
        };
      case "attachment.upload": {
        const attachment = await workspace.storeAttachment(
          command.id,
          command.name,
          command.contentBase64,
        );
        this.attachmentPaths.set(command.id, attachment.path);
        return attachment;
      }
    }
  }

  private queueHostAction(
    type: RemoteHostAction["type"],
    payload: Record<string, unknown>,
    commandReference?: RemoteHostActionCommandReference,
  ): Promise<{ queued: true; actionId: string; operationId?: string }> {
    const pending = this.hostActionMutationTail.then(() =>
      this.queueHostActionSerial(type, payload, commandReference),
    );
    this.hostActionMutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async queueHostActionSerial(
    type: RemoteHostAction["type"],
    payload: Record<string, unknown>,
    commandReference?: RemoteHostActionCommandReference,
  ): Promise<{ queued: true; actionId: string; operationId?: string }> {
    const controller = this.sessionController;
    let lease = controller?.getLease();
    const actionId = commandReference
      ? deterministicHostActionId({
          type,
          leaseId: lease?.id,
          ...commandReference,
        })
      : randomUUID();
    const cancelHandback =
      type === "session.handback" &&
      (payload.cancelActive === true || payload.strategy === "cancel");
    let operation: RemoteOperation | undefined;
    if (
      type === "session.handback" &&
      lease?.operation?.kind === "provider-switch"
    ) {
      await this.supersedeUnstartedProviderSwitch(
        lease.operation,
      );
      lease = controller?.getLease();
    }
    if (type === "session.handback" && lease?.operation?.kind === "handback") {
      operation = lease.operation;
      const existing = [...this.hostActions.values()].find(
        (candidate) =>
          candidate.type === "session.handback" &&
          candidate.operationId === lease.operation?.id,
      );
      if (existing) {
        if (cancelHandback) {
          if (
            existing.payload.strategy !== "cancel" ||
            existing.payload.cancelActive !== true
          ) {
            const updated: RemoteHostAction = {
              ...existing,
              payload: {
                ...existing.payload,
                strategy: "cancel",
                cancelActive: true,
              },
            };
            // Persist the monotonic escalation before exposing it to either
            // the editor poller or the cancellation actuator.
            await this.journal.append("host.action", updated);
            this.hostActions.set(updated.id, updated);
          }
          if (
            operation.phase !== "quiescing" ||
            operation.waitReason !==
              "Cancelling active work at your request"
          ) {
            operation = {
              ...operation,
              phase: "quiescing",
              waitReason: "Cancelling active work at your request",
              updatedAt: Date.now(),
            };
            await controller?.setOperation(operation);
          }
          // The daemon owns force escalation. The editor action is deliberately
          // unclaimable while busy, so polling can never be the only path that
          // delivers an explicit cancellation request.
          await controller?.requestHandbackCancellation();
        }
        return {
          queued: true,
          actionId: existing.id,
          operationId: operation.id,
        };
      }
    }
    if (
      lease &&
      !operation &&
      (type === "provider.change" || type === "session.handback")
    ) {
      const now = Date.now();
      operation = {
        id: commandReference
          ? deterministicRemoteOperationId(
              type === "provider.change"
                ? "provider-switch"
                : "handback",
              actionId,
            )
          : randomUUID(),
        kind:
          type === "provider.change"
            ? "provider-switch"
            : "handback",
        phase:
          this.sessionController?.isBusy() &&
          !cancelHandback
            ? "waiting-for-turn"
            : "quiescing",
        leaseId: lease.id,
        ownerWorkspacePath: lease.workspacePath,
        requestedAt: now,
        updatedAt: now,
        attentionAt: now + 15 * 60 * 1000,
        attempt: 1,
        fencingGeneration: 1,
        rollbackResult:
          type === "provider.change" ? "pending" : "not-needed",
        availableActions:
          type === "session.handback"
            ? [
                "continue-waiting",
                "cancel-handback",
                "cancel-work-and-return",
              ]
            : undefined,
        targetProvider:
          type === "provider.change" &&
          typeof payload.provider === "string"
            ? (payload.provider as RemoteOperation["targetProvider"])
            : undefined,
        previousProvider: lease.provider.provider,
        waitReason: cancelHandback
          ? "Cancelling active work at your request"
          : undefined,
      };
      await controller?.setOperation(operation);
    }
    if (
      cancelHandback &&
      operation?.kind === "handback" &&
      (operation.phase !== "quiescing" ||
        operation.waitReason !==
          "Cancelling active work at your request")
    ) {
      operation = {
        ...operation,
        phase: "quiescing",
        waitReason: "Cancelling active work at your request",
        updatedAt: Date.now(),
      };
      await controller?.setOperation(operation);
    }
    const action: RemoteHostAction = {
      id: actionId,
      type,
      payload,
      createdAt: Date.now(),
      leaseId: lease?.id,
      ownerWorkspacePath: lease?.workspacePath,
      operationId: operation?.id,
      ...commandReference,
    };
    await this.journal.append("host.action", action);
    this.hostActions.set(action.id, action);
    if (cancelHandback) {
      await controller?.requestHandbackCancellation();
    }
    return {
      queued: true,
      actionId: action.id,
      operationId: operation?.id,
    };
  }

  private scheduleLifecycleTick(delayMs: number): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runLifecycleTick();
    }, delayMs);
  }

  private async runLifecycleTick(): Promise<void> {
    if (this.lifecycleTickInFlight) {
      this.scheduleLifecycleTick(2_000);
      return;
    }
    this.lifecycleTickInFlight = true;
    let nextDelay = 2_000;
    try {
      await this.checkTimeoutsAndDivergence();
    } catch (error) {
      nextDelay = 5_000;
      await this.journal
        .append("error", {
          message:
            error instanceof Error
              ? `Remote supervisor check failed: ${error.message}`
              : "Remote supervisor check failed.",
          retrying: true,
        })
        .catch(() => undefined);
    } finally {
      if (this.configuration) {
        await this.persistRuntime(
          this.sessionController?.getLease().state === "stopped"
            ? "stopped"
            : "active",
        ).catch(() => undefined);
      }
      this.lifecycleTickInFlight = false;
      this.scheduleLifecycleTick(nextDelay);
    }
  }

  private async checkTimeoutsAndDivergence(): Promise<void> {
    const configuration = this.configuration;
    const controller = this.sessionController;
    if (!configuration || !controller) {
      return;
    }
    const now = Date.now();
    await controller.evaluateOperationAttention(now);
    const lease = controller.getLease();
    const confirmed = [...this.connections.values()].filter(
      (connection) => connection.status === "confirmed",
    );
    const connected = confirmed.filter(
      (connection) => now - connection.lastSeenAt < CONNECTION_STALE_MS,
    );
    const lastConnectionSeenAt = confirmed.length
      ? Math.max(
          ...confirmed.map((connection) => connection.lastSeenAt),
        )
      : undefined;

    if (
      controller.isBusy() &&
      lease.ownerDeviceId &&
      connected.length === 0
    ) {
      const turnStartedAt =
        lease.turnStartedAt ?? lease.lastActivityAt;
      if (this.disconnectedTurnJournaledAt !== turnStartedAt) {
        this.disconnectedTurnJournaledAt = turnStartedAt;
        await this.journal.append("activity.event", {
          kind: "activity.event",
          id: `phone-disconnected-${String(turnStartedAt)}`,
          category: "lifecycle",
          phase: lease.turnPhase ?? "streaming",
          title: "Phone disconnected; Claude is still working",
          detail:
            "The active turn continues on this Mac. Reopen the same private link to replay progress from the encrypted journal.",
          createdAt: now,
          updatedAt: now,
          data: { turnStartedAt },
        } satisfies RemoteActivityEvent);
      }
    }

    const decision = remoteLifecycleDecision({
      now,
      configuredAt: this.configuredAt,
      ownerDeviceId: lease.ownerDeviceId,
      busy: controller.isBusy(),
      turnCompletedAt: lease.turnCompletedAt,
      lastActivityAt: lease.lastActivityAt,
      lastConnectionSeenAt,
      idleTimeoutMs: configuration.idleTimeoutMs,
      unpairedTimeoutMs: configuration.unpairedTimeoutMs,
      maximumSessionMs: configuration.maximumSessionMs,
    });
    if (decision === "revoke-input-until-turn-completes") {
      this.remoteInputOpen = false;
      await controller.revokeRemoteInput("maximum-session", now);
      return;
    }
    if (decision === "stop-unpaired") {
      this.remoteAccessOpen = false;
      this.remoteInputOpen = false;
      if (this.timeoutCleanup.tryClaim()) {
        try {
          await this.journal.append("activity.event", {
            kind: "activity.event",
            id: "unpaired-session-expired",
            category: "lifecycle",
            phase: "complete",
            title: "Unpaired phone link expired",
            detail:
              "No phone paired within ten minutes, so ModelHop closed the private link.",
            createdAt: now,
            updatedAt: now,
          } satisfies RemoteActivityEvent);
          await this.stopSession();
        } catch (error) {
          this.timeoutCleanup.reset();
          throw error;
        }
      }
      await this.stopTunnel().catch(async (error) => {
        if (!this.tunnelStopErrorReported) {
          this.tunnelStopErrorReported = true;
          await this.journal.append("error", {
            message:
              error instanceof Error
                ? error.message
                : "The Cloudflare Quick Tunnel did not stop cleanly.",
          });
        }
      });
      return;
    }
    if (
      decision === "handback-after-idle" ||
      decision === "handback-after-maximum"
    ) {
      if (!this.timeoutCleanup.tryClaim()) {
        return;
      }
      this.remoteInputOpen = false;
      const reason =
        decision === "handback-after-maximum"
          ? "maximum-session"
          : "idle-timeout";
      try {
        await controller.revokeRemoteInput(reason, now);
        if (
          ![...this.hostActions.values()].some(
            (action) => action.type === "session.handback",
          )
        ) {
          await this.runRemoteMutationSerial(() =>
            this.queueHostAction("session.handback", {
              cancelActive: false,
              strategy: "finish",
              reason,
            }),
          );
        }
      } catch (error) {
        this.timeoutCleanup.reset();
        throw error;
      }
      return;
    }
    if (
      this.hostActions.size > 0 ||
      ![
        "paired",
        "running",
        "waiting-for-permission",
        "waiting-for-question",
      ].includes(controller.getLease().state)
    ) {
      return;
    }
    try {
      const current = await transcriptTailSignature(
        configuration.lease.sourceTranscriptPath,
      );
      if (
        this.sourceTranscriptSignature &&
        current !== this.sourceTranscriptSignature
      ) {
        this.sourceTranscriptSignature = current;
        this.remoteInputOpen = false;
        await controller.revokeRemoteInput(
          "desktop-diverged",
          now,
        );
        await controller.markDiverged();
      }
    } catch {
      // A missing source transcript is handled when handing back.
    }
  }

  private async stopTunnel(): Promise<void> {
    if (this.terminalTunnelStopTimer) {
      clearTimeout(this.terminalTunnelStopTimer);
      this.terminalTunnelStopTimer = undefined;
    }
    const tunnel = this.tunnel;
    if (!tunnel) {
      this.terminalAccessOpen = false;
      this.resolveTerminalAcknowledgementWaiters();
      return;
    }
    if (!processAlive(tunnel.pid)) {
      this.tunnel = undefined;
      await unlink(tunnel.configPath).catch(() => undefined);
      this.terminalAccessOpen = false;
      this.resolveTerminalAcknowledgementWaiters();
      return;
    }
    if (!(await this.tunnelProcessMatches(tunnel))) {
      throw new Error(
        "The Cloudflare tunnel process could not be verified for safe shutdown.",
      );
    }
    try {
      process.kill(tunnel.pid, "SIGTERM");
    } catch {
      // The tunnel may already have exited.
    }
    const deadline = Date.now() + 5_000;
    while (processAlive(tunnel.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processAlive(tunnel.pid)) {
      throw new Error(
        "The Cloudflare tunnel process did not stop within five seconds.",
      );
    }
    this.tunnel = undefined;
    await unlink(tunnel.configPath).catch(() => undefined);
    this.terminalAccessOpen = false;
    this.resolveTerminalAcknowledgementWaiters();
  }

  private async tunnelProcessMatches(
    tunnel: RemoteTunnelState,
  ): Promise<boolean> {
    const command = await readProcessCommand(tunnel.pid);
    return Boolean(
      command && cloudflaredCommandMatches(tunnel, command),
    );
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const controlToken = process.env.MODELHOP_REMOTE_CONTROL_TOKEN;
  const journalKey = process.env.MODELHOP_REMOTE_JOURNAL_KEY;
  if (!controlToken) {
    throw new Error("Missing ModelHop Remote control token.");
  }
  if (!journalKey) {
    throw new Error("Missing ModelHop Remote journal key.");
  }
  const journal = new RemoteEventJournal(
    path.join(args.stateDirectory, "events.jsonl"),
    journalKey,
  );
  await journal.initialize();
  const daemon = new ModelHopRemoteDaemon(
    args.port,
    args.stateDirectory,
    controlToken,
    journal,
    journalKey,
  );
  await daemon.initialize();

  let activePublicBodies = 0;
  const readPublicJson = async (
    request: IncomingMessage,
    maximumBytes: number,
  ): Promise<unknown> => {
    if (activePublicBodies >= MAX_CONCURRENT_PUBLIC_BODIES) {
      throw new RemoteHttpError(
        429,
        "Too many concurrent remote requests.",
      );
    }
    activePublicBodies += 1;
    try {
      return await readJson(request, maximumBytes);
    } finally {
      activePublicBodies -= 1;
    }
  };

  const server = createServer({
    requestTimeout: 45_000,
    headersTimeout: 15_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 16 * 1024,
  // Node's HTTP server intentionally owns this request promise.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  }, async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://127.0.0.1:${args.port}`,
    );
    try {
      if (
        requiresRemoteControlToken(url.pathname) &&
        !controlAuthorised(request, controlToken)
      ) {
        json(response, 401, { error: "Unauthorized." });
        return;
      }
      if (
        requiresOpenRemoteSession(url.pathname) &&
        !daemon.publicAccessAvailable() &&
        !(
          allowsTerminalRemoteSession(url.pathname) &&
          daemon.terminalAccessAvailable()
        )
      ) {
        json(response, 410, {
          error: "This ModelHop Remote session is closed.",
        });
        return;
      }
      if (
        requiresLaunchTokenBeforeBody(url.pathname) &&
        !daemon.launchTokenAuthorised(
          requestLaunchToken(request, url),
        )
      ) {
        json(response, 401, { error: "Unauthorized." });
        return;
      }
      if (url.pathname === "/health" && request.method === "GET") {
        json(response, 200, daemon.status());
        return;
      }
      if (url.pathname.startsWith("/control/")) {
        if (
          url.pathname === "/control/configure" &&
          request.method === "POST"
        ) {
          await daemon.configure(
            (await readJson(
              request,
              MAX_CONTROL_BODY_BYTES,
            )) as RemoteDaemonConfiguration,
          );
          json(response, 200, daemon.status());
          return;
        }
        if (
          url.pathname === "/control/status" &&
          request.method === "GET"
        ) {
          json(response, 200, daemon.status());
          return;
        }
        if (
          url.pathname === "/control/pair/confirm" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          await daemon.confirmPairing(
            stringValue(body.connectionId, "connection ID", 128),
            body.allow === true,
          );
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/devices/revoke" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          json(response, 200, {
            revoked: await daemon.revokeDevice(
              stringValue(body.deviceId, "device ID", 128),
            ),
          });
          return;
        }
        if (
          url.pathname === "/control/tunnel" &&
          request.method === "POST"
        ) {
          daemon.setTunnel(
            await readJson(request, MAX_CONTROL_BODY_BYTES),
          );
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/pairing/refresh" &&
          request.method === "POST"
        ) {
          daemon.refreshPairingWindow();
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/pairings" &&
          request.method === "GET"
        ) {
          json(response, 200, {
            pairings: daemon.claimPairings(
              stringValue(
                url.searchParams.get("owner"),
                "window owner",
                128,
              ),
              stringValue(
                url.searchParams.get("workspaceOwner"),
                "workspace owner",
                128,
              ),
            ),
          });
          return;
        }
        if (
          url.pathname === "/control/actions" &&
          request.method === "GET"
        ) {
          json(response, 200, {
            actions: daemon.claimHostActions(
              stringValue(
                url.searchParams.get("owner"),
                "window owner",
                128,
              ),
              stringValue(
                url.searchParams.get("workspaceOwner"),
                "workspace owner",
                128,
              ),
            ),
          });
          return;
        }
        if (
          url.pathname === "/control/actions/heartbeat" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          json(response, 200, {
            expiresAt: daemon.heartbeatHostAction(
              stringValue(body.actionId, "action ID", 128),
              stringValue(body.owner, "window owner", 128),
              stringValue(body.claimToken, "claim token", 256),
            ),
          });
          return;
        }
        if (
          url.pathname === "/control/actions/complete" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          await daemon.completeHostAction(
            stringValue(body.actionId, "action ID", 128),
            body.success === true,
            typeof body.error === "string" ? body.error : undefined,
            typeof body.claimToken === "string"
              ? body.claimToken
              : undefined,
            typeof body.owner === "string" ? body.owner : undefined,
          );
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/provider" &&
          request.method === "POST"
        ) {
          await daemon.updateProvider(
            (await readJson(request)) as RemoteProviderContext,
          );
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/activity" &&
          request.method === "POST"
        ) {
          await daemon.updateActivity(await readJson(request));
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/operation" &&
          request.method === "POST"
        ) {
          await daemon.updateOperation(await readJson(request));
          json(response, 200, { ok: true });
          return;
        }
        if (
          url.pathname === "/control/session/request-handback" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          json(
            response,
            200,
            await daemon.requestHandback(
              stringValue(body.requestId, "request ID", 128),
              body.strategy === "cancel" ? "cancel" : "finish",
            ),
          );
          return;
        }
        if (
          url.pathname === "/control/session/prepare-handback" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          json(response, 200, {
            lease: await daemon.prepareHandback(
              body.strategy === "cancel" ? "cancel" : "finish",
              {
                operationId: stringValue(
                  body.operationId,
                  "hand-back operation ID",
                  128,
                ),
                leaseId: stringValue(
                  body.leaseId,
                  "hand-back lease ID",
                  128,
                ),
              },
            ),
          });
          return;
        }
        if (
          url.pathname === "/control/session/cancel-handback-request" &&
          request.method === "POST"
        ) {
          const body = (await readJson(request)) as Record<
            string,
            unknown
          >;
          json(
            response,
            200,
            await daemon.cancelHandbackRequest(
              stringValue(body.operationId, "operation ID", 128),
            ),
          );
          return;
        }
        if (
          url.pathname === "/control/session/stop" &&
          request.method === "POST"
        ) {
          json(response, 200, {
            lease: await daemon.stopSession(),
          });
          return;
        }
        if (
          url.pathname === "/control/shutdown" &&
          request.method === "POST"
        ) {
          await daemon.shutdown();
          json(response, 200, { ok: true });
          server.close(() => process.exit(0));
          return;
        }
        json(response, 404, { error: "Unknown control endpoint." });
        return;
      }

      if (
        url.pathname === "/api/bootstrap" &&
        request.method === "GET"
      ) {
        json(
          response,
          200,
          daemon.bootstrap(requestLaunchToken(request, url)),
        );
        return;
      }
      if (
        url.pathname === "/api/connect" &&
        request.method === "POST"
      ) {
        json(
          response,
          200,
          await daemon.connect(
            requestLaunchToken(request, url),
            await readPublicJson(
              request,
              REMOTE_CONNECT_BODY_LIMIT,
            ),
          ),
        );
        return;
      }
      if (
        url.pathname.startsWith("/api/connect/") &&
        request.method === "GET"
      ) {
        json(
          response,
          200,
          daemon.connectionStatusById(
            decodeURIComponent(
              url.pathname.slice("/api/connect/".length),
            ),
          ),
        );
        return;
      }
      if (
        url.pathname === "/api/command" &&
        request.method === "POST"
      ) {
        const connectionHeader =
          request.headers["x-modelhop-connection"];
        if (
          !daemon.confirmedConnectionAuthorised(
            typeof connectionHeader === "string"
              ? connectionHeader
              : undefined,
          )
        ) {
          json(response, 401, { error: "Unauthorized." });
          return;
        }
        json(
          response,
          200,
          await daemon.encryptedCommand(
            await readPublicJson(
              request,
              REMOTE_COMMAND_BODY_LIMIT,
            ),
          ),
        );
        return;
      }
      if (
        url.pathname === "/api/events" &&
        request.method === "GET"
      ) {
        json(
          response,
          200,
          await daemon.encryptedEvents(
            stringValue(
              url.searchParams.get("connection"),
              "connection ID",
              128,
            ),
            Number(url.searchParams.get("after") ?? "0"),
          ),
        );
        return;
      }
      if (
        await daemon.serveAsset(
          url.pathname,
          response,
        )
      ) {
        return;
      }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      if (
        error instanceof RemoteHttpError &&
        (error.status === 413 || error.status === 429)
      ) {
        response.shouldKeepAlive = false;
        response.once("finish", () => request.destroy());
      }
      json(response, error instanceof RemoteHttpError ? error.status : 400, {
        error:
          error instanceof Error
            ? error.message
            : "Remote request failed.",
      });
    }
  });

  server.listen(args.port, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    void writeFile(
      path.join(args.stateDirectory, "remote-port"),
      String(address.port),
      { encoding: "utf8", mode: 0o600 },
    );
  });

  const shutdown = async (): Promise<void> => {
    await daemon.shutdown().catch(() => undefined);
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main().catch(async (error) => {
  try {
    const args = parseArguments(process.argv.slice(2));
    await mkdir(args.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(args.stateDirectory, "remote-error.log"),
      error instanceof Error ? error.stack ?? error.message : String(error),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // There is no safe logging destination.
  }
  process.exit(1);
});
