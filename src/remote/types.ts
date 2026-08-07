import type {
  OpenAIReasoningEffort,
  ProviderId,
} from "../providers/types.js";

export const REMOTE_PROTOCOL_VERSION = "1.3.0";
export const REMOTE_BUILD_VERSION = "2.2.4-remote.6";

export type RemoteTurnPhase =
  | "idle"
  | "queued"
  | "counting"
  | "compacting"
  | "requesting"
  | "streaming"
  | "running-tool"
  | "running-task"
  | "settling"
  | "completion-unknown"
  | "waiting-approval"
  | "waiting-question"
  | "switching-provider"
  | "handing-back"
  | "complete"
  | "failed";

export type RemoteLeaseState =
  | "starting"
  | "waiting-for-device"
  | "paired"
  | "running"
  | "waiting-for-permission"
  | "waiting-for-question"
  | "switching-provider"
  | "handing-back"
  | "paused-diverged"
  | "stopped"
  | "error";

export type RemotePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto-safe"
  | "plan";

export type RemoteOperationKind =
  | "provider-switch"
  | "handback";

export type RemoteOperationPhase =
  | "waiting-for-turn"
  | "waiting-for-work"
  | "reconciling-final-record"
  | "quiescing"
  | "stabilizing-transcript"
  | "open-command-sent"
  | "desktop-confirmed"
  | "phone-terminal-acked"
  | "cleanup-pending"
  | "applying"
  | "reloading"
  | "restarting"
  | "opening-session"
  | "rolling-back"
  | "complete"
  | "failed";

export interface RemoteOperation {
  id: string;
  kind: RemoteOperationKind;
  phase: RemoteOperationPhase;
  leaseId: string;
  ownerWorkspacePath: string;
  requestedAt: number;
  updatedAt: number;
  /** Legacy v1 field. It is never interpreted as a cancellation deadline. */
  deadlineAt?: number;
  /**
   * Time at which a long-running operation should ask for attention. This is
   * deliberately not a cancellation deadline: authoritative work keeps
   * running until it reaches terminal evidence or the user cancels it.
   */
  attentionAt?: number;
  blockerIds?: string[];
  waitReason?: string;
  lastProgressAt?: number;
  attempt?: number;
  claimOwner?: string;
  fencingGeneration?: number;
  rollbackResult?: "not-needed" | "pending" | "succeeded" | "failed";
  availableActions?: Array<
    "continue-waiting" | "cancel-handback" | "cancel-work-and-return"
  >;
  targetProvider?: ProviderId;
  previousProvider?: ProviderId;
  error?: string;
}

export type RemoteWorkItemKind =
  | "prompt"
  | "foreground-response"
  | "workflow"
  | "subagent"
  | "tool"
  | "approval"
  | "question";

export type RemoteWorkItemPhase =
  | "queued"
  | "active"
  | "settling"
  | "completion-unknown"
  | "complete"
  | "failed"
  | "cancelled";

export interface RemoteWorkTerminalEvidence {
  source:
    | "sdk-prompt-accepted"
    | "sdk-result"
    | "sdk-assistant-error"
    | "sdk-task-notification"
    | "sdk-task-update"
    | "sdk-tool-result"
    | "user-decision"
    | "explicit-cancellation"
    | "controller-failure";
  status: string;
  recordedAt: number;
}

/**
 * One independently settleable unit of Claude work. A live-list omission is
 * represented by `settling`; only `terminalEvidence` may move the item to a
 * terminal phase.
 */
export interface RemoteWorkItem {
  id: string;
  kind: RemoteWorkItemKind;
  parentId?: string;
  title: string;
  phase: RemoteWorkItemPhase;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  progress?: {
    current?: number;
    total?: number;
    elapsedMs?: number;
  };
  outputReferences?: string[];
  cancellable: boolean;
  terminalEvidence?: RemoteWorkTerminalEvidence;
}

export interface RemoteRuntimeSnapshot {
  version: 1;
  revision: number;
  capturedAt: number;
  lease: RemoteSessionLease;
  transport: {
    state: "unknown" | "connected" | "link-lost" | "recovering";
    updatedAt: number;
  };
  execution: {
    state:
      | "idle"
      | "queued"
      | "running"
      | "settling"
      | "completion-unknown"
      | "error";
    queryGeneration: number;
    workItems: RemoteWorkItem[];
    foregroundActive: boolean;
    lastProgressAt?: number;
    /** True only when every execution contributor is authoritatively idle. */
    quiescent?: boolean;
    /** A terminal SDK result is waiting for the rest of the work graph. */
    pendingResult?: boolean;
    pendingPromptCount?: number;
    pendingApprovalCount?: number;
    pendingQuestionCount?: number;
    terminalProviderFailure?: {
      code: string;
      recordedAt: number;
      queryGeneration: number;
    };
  };
  ownership: {
    workspaceOwnerId: string;
    deviceId?: string;
    fencingGeneration: number;
  };
  route: {
    revision: number;
    provider: RemoteProviderContext;
  };
  usage: unknown;
  journal: {
    epoch: string;
    latestEventId: number;
    snapshotCursor: number;
  };
  pendingInteractions: {
    approvalIds: string[];
    questionIds: string[];
  };
  operation?: RemoteOperation;
}

export type RemoteModelCatalogSource =
  | "claude-sdk"
  | "synthetic-api"
  | "openai-api"
  | "codex-model-list"
  | "merged";

/**
 * A model row safe to send to the remote client. `selector` is the only value
 * that may be passed back to the provider; presentation and canonical wire
 * names are deliberately kept in separate fields.
 */
export interface RemoteModelOption {
  selector: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  source: RemoteModelCatalogSource;
  isDefault?: boolean;
  contextWindow?: number;
  supportsEffort?: boolean;
  supportedEffortLevels?: OpenAIReasoningEffort[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface RemoteModelCatalog {
  source: RemoteModelCatalogSource;
  authoritative: boolean;
  options: RemoteModelOption[];
  updatedAt: number;
}

export interface RemoteProviderContext {
  provider: ProviderId;
  label: string;
  model: string;
  /** Provider selectors and their presentation metadata for this session. */
  modelCatalog?: RemoteModelCatalog;
  reasoningEffort?: OpenAIReasoningEffort;
  /**
   * Model-aware, session-scoped reasoning controls. This describes the
   * active Claude SDK session; changing it never rewrites Claude's user
   * settings file.
   */
  reasoning?: RemoteReasoningContext;
  /**
   * Provider-authoritative effort catalog used to validate a model change.
   * Present for direct OpenAI and ChatGPT/Codex, where provider discovery is
   * authoritative. Claude SDK metadata remains the authority for Anthropic.
   */
  modelReasoningEfforts?: Record<
    string,
    OpenAIReasoningEffort[]
  >;
  roleModels: {
    default: string;
    opus: string;
    sonnet: string;
    haiku: string;
    subagent: string;
  };
  usage?: unknown;
  updatedAt: number;
}

export interface RemoteCapabilityState {
  available: boolean;
  enabled: boolean;
  experimental?: boolean;
  unavailableReason?: string;
}

/** The source that authoritatively described one reasoning capability. */
export type RemoteReasoningCapabilityAuthority =
  | "claude-sdk"
  | "synthetic-api"
  | "openai-model-list"
  | "codex-model-list"
  | "provider-model-catalog"
  | "unavailable";

export interface RemoteReasoningContext {
  /** Claude Code's adaptive-thinking capability for the active model. */
  thinkingSupported: boolean;
  /** Effective session flag; provider-native private reasoning is separate. */
  thinkingEnabled: boolean;
  thinkingUnavailableReason?: string;
  /** Catalog that reported the Claude adaptive-thinking capability. */
  thinkingAuthority?: RemoteReasoningCapabilityAuthority;
  /** Exact values reported by the selected model's authoritative catalog. */
  supportedEffortLevels: OpenAIReasoningEffort[];
  /** Reasoning effort actually selected for subsequent provider turns. */
  effectiveEffort?: OpenAIReasoningEffort;
  effortAuthority?: RemoteReasoningCapabilityAuthority;
  /** Claude-harness dynamic workflows, not Codex-native subagents. */
  workflows: RemoteCapabilityState;
  /** Claude's session-scoped ultracode mode; available means eligible. */
  ultra: RemoteCapabilityState;
}

export interface RemoteReasoningChange {
  thinkingEnabled?: boolean;
  effort?: OpenAIReasoningEffort;
  workflowsEnabled?: boolean;
  ultraEnabled?: boolean;
}

export interface RemoteSessionLease {
  id: string;
  sourceSessionId: string;
  activeSessionId?: string;
  sourceTranscriptPath: string;
  workspacePath: string;
  workspacePaths?: string[];
  workspaceName: string;
  title: string;
  ownerDeviceId?: string;
  state: RemoteLeaseState;
  /**
   * Authoritative phone-facing permission mode. Older persisted leases may
   * omit this field; the daemon derives `auto-safe` from the SDK's `auto`
   * mode when migrating them.
   */
  permissionMode?: RemotePermissionMode;
  provider: RemoteProviderContext;
  createdAt: number;
  lastActivityAt: number;
  tunnelStartedAt?: number;
  error?: string;
  providerChanged: boolean;
  desktopEnvironmentHash?: string;
  turnPhase?: RemoteTurnPhase;
  /** Wall-clock start of the active or most recently completed user turn. */
  turnStartedAt?: number;
  /**
   * Wall-clock completion of the most recent turn. Undefined while that turn
   * is still active, including while it waits for a tool, approval, or answer.
   */
  turnCompletedAt?: number;
  /** Live SDK background tasks (Workflow descendants, Bash, or subagents). */
  backgroundTaskCount?: number;
  /** Set when lifecycle expiry prevents any new model turn. */
  remoteInputRevokedAt?: number;
  remoteInputRevokedReason?:
    | "maximum-session"
    | "idle-timeout"
    | "desktop-diverged";
  operation?: RemoteOperation;
  sourceTranscriptSignature?: string;
  activeTranscriptSignature?: string;
}

export interface RemoteTunnelState {
  transport: "cloudflare-quick";
  pid: number;
  baseUrl: string;
  executable: string;
  originPort: number;
  configPath: string;
  logPath: string;
  startedAt: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: number;
  lastUsedAt: number;
  revokedAt?: number;
}

export interface EncryptedEnvelope {
  version: typeof REMOTE_PROTOCOL_VERSION;
  connectionId: string;
  sequence: number;
  nonce: string;
  ciphertext: string;
}

export interface RemotePairingBootstrap {
  version: typeof REMOTE_PROTOCOL_VERSION;
  sessionId: string;
  hostPublicKey: string;
  sessionSalt: string;
  /** Server clock used to translate deadlines without trusting phone time. */
  serverNow: number;
  /** New, untrusted devices cannot begin pairing after this time. */
  pairingExpiresAt: number;
  /** Absolute boundary for new pairing and model work. */
  sessionExpiresAt: number;
}

export interface RemoteConnectionRequest {
  deviceId: string;
  deviceName: string;
  devicePublicKey: string;
  hostFingerprint?: string;
}

export interface RemoteConnectionStatus {
  connectionId: string;
  status: "pending" | "confirmed" | "rejected";
  sas?: string;
  knownDevice: boolean;
  hostFingerprint: string;
  canMutate?: boolean;
  ownershipFencingGeneration?: number;
  ownerDeviceId?: string;
}

export interface RemoteConversationItem {
  id: string;
  sdkMessageId?: string;
  turnId?: string;
  role: "user" | "assistant";
  status:
    | "queued"
    | "accepted"
    | "streaming"
    | "complete"
    | "failed";
  content: unknown;
  createdAt: number;
  updatedAt: number;
  parentToolUseId?: string;
  synthetic?: boolean;
  error?: string;
}

export interface RemoteConversationEvent {
  kind: "conversation.item";
  operation: "upsert" | "delta" | "remove";
  item: RemoteConversationItem;
  delta?: {
    kind: "text" | "thinking" | "input-json";
    text: string;
    contentBlockIndex?: number;
  };
}

export interface RemoteActivityEvent {
  kind: "activity.event";
  id: string;
  category:
    | "lifecycle"
    | "status"
    | "compaction"
    | "tool"
    | "task"
    | "retry"
    | "permission"
    | "question"
    | "information"
    | "error";
  phase: RemoteTurnPhase;
  title: string;
  detail?: string;
  createdAt: number;
  updatedAt: number;
  toolUseId?: string;
  taskId?: string;
  progress?: {
    elapsedMs?: number;
    current?: number;
    total?: number;
  };
  data?: unknown;
}

export interface RemoteUsageSnapshot {
  kind: "usage.snapshot";
  provider: ProviderId;
  status: "updating" | "available" | "unavailable";
  model: string;
  updatedAt: number;
  session?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens: number;
    costUsd?: number;
    requests?: number;
  };
  context?: {
    usedTokens: number;
    maxTokens: number;
    percentage: number;
  };
  allowance?: unknown;
  error?: string;
}

export interface RemoteSessionCapabilities {
  kind: "session.capabilities";
  model: string;
  permissionMode: RemotePermissionMode;
  tools: string[];
  commands: Array<{
    name: string;
    description?: string;
    argumentHint?: string;
    aliases?: string[];
  }>;
  skills: string[];
  protocolCapabilities: string[];
  reasoning?: RemoteReasoningContext;
  updatedAt: number;
}

export interface RemoteHandoffRecord {
  version: 1 | 2;
  leaseId: string;
  sessionId: string;
  transcriptPath: string;
  workspacePath: string;
  title?: string;
  transcriptSignature: string;
  phase:
    | "requested"
    | "waiting-for-work"
    | "reconciling-final-record"
    | "quiescing"
    | "stabilizing-transcript"
    | "open-command-sent"
    | "desktop-confirmed"
    | "phone-terminal-acked"
    | "cleanup-pending"
    | "complete"
    | "preparing"
    | "pending-reload"
    | "opening-session"
    | "session-opened"
    | "failed";
  actionId?: string;
  /** Fenced host-action claim retained across extension reloads. */
  actionClaimToken?: string;
  /**
   * Set only after Claude Code has authoritatively confirmed the exact
   * session. A retained record with this value needs transport/action
   * cleanup, never another transcript open attempt.
   */
  openedAt?: number;
  /** Set after the detached daemon has accepted the host-action result. */
  actionAcknowledgedAt?: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface RemoteFilePreview {
  path: string;
  content: string;
  size: number;
  language: string;
  mediaType?: string;
  encoding: "utf8" | "base64";
}

export interface RemoteFileReferencePreview extends RemoteFilePreview {
  rootId: string;
  relativePath: string;
  line?: number;
  endLine?: number;
  column?: number;
}

export type RemoteClientCommand =
  | {
      id: string;
      type: "prompt.send";
      prompt: string;
      attachmentIds?: string[];
    }
  | { id: string; type: "turn.cancel" }
  | {
      id: string;
      type: "session.handback";
      strategy?: "finish" | "cancel";
      cancelActive?: boolean;
    }
  | {
      id: string;
      type: "session.handback.continue";
      operationId: string;
    }
  | {
      id: string;
      type: "session.handback.cancel-request";
      operationId: string;
    }
  | {
      id: string;
      type: "session.terminal.ack";
      terminalEventId: number;
    }
  | {
      id: string;
      type: "permission.mode.set";
      mode: RemotePermissionMode;
    }
  | {
      id: string;
      type: "permission.resolve";
      requestId: string;
      decision: "allow" | "allow-session" | "deny";
      message?: string;
    }
  | {
      id: string;
      type: "question.resolve";
      requestId: string;
      answers: Record<string, string>;
    }
  | {
      id: string;
      type: "provider.change";
      provider: ProviderId;
    }
  | {
      id: string;
      type: "model.change";
      model: string;
      reasoningEffort?: OpenAIReasoningEffort;
    }
  | {
      id: string;
      type: "reasoning.change";
      thinkingEnabled?: boolean;
      effort?: OpenAIReasoningEffort;
      workflowsEnabled?: boolean;
      ultraEnabled?: boolean;
    }
  | {
      id: string;
      type: "files.search";
      query?: string;
    }
  | {
      id: string;
      type: "files.list";
      rootId?: string;
      path?: string;
      cursor?: string;
      pageSize?: number;
    }
  | {
      id: string;
      type: "symbols.search";
      query: string;
    }
  | { id: string; type: "file.read"; path: string }
  | {
      id: string;
      type: "file.reference.read";
      reference: string;
    }
  | { id: string; type: "git.status" }
  | { id: string; type: "git.diff"; staged?: boolean }
  | {
      id: string;
      type: "attachment.upload";
      name: string;
      mediaType: string;
      contentBase64: string;
    }
  | { id: string; type: "usage.refresh" }
  | {
      id: string;
      type: "codex.reset";
      creditId?: string;
    };

export interface RemoteCommandResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface RemoteCommandReceipt {
  commandId: string;
  requestHash: string;
  state: "accepted" | "executing" | "completed" | "failed";
  acceptedAt: number;
  updatedAt: number;
  completedAt?: number;
  response?: RemoteCommandResponse;
  error?: string;
}

export interface RemoteJournalEvent {
  id: number;
  type:
    | "session.state"
    | "claude.message"
    | "conversation.item"
    | "activity.event"
    | "work.state"
    | "usage.snapshot"
    | "session.capabilities"
    | "operation.state"
    | "handoff.state"
    | "permission.request"
    | "permission.resolved"
    | "question.request"
    | "question.resolved"
    | "provider.context"
    | "host.action"
    | "host.action.state"
    | "command.receipt"
    | "command.response"
    | "notification"
    | "error";
  createdAt: number;
  payload: unknown;
}

export interface RemoteEventBatch {
  epoch: string;
  earliestEventId: number;
  latestEventId: number;
  snapshotCursor: number;
  gap: boolean;
  snapshot?: RemoteRuntimeSnapshot;
  events: RemoteJournalEvent[];
}

export interface PendingPermission {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  autoSafeReason?: string;
  matchedAskRule?: {
    source: string;
    toolName: string;
    ruleContent?: string;
  };
  sessionSuggestions?: RemoteSessionPermissionSuggestion[];
  createdAt: number;
}

export interface RemoteSessionPermissionSuggestion {
  type: "addRules";
  rules: Array<{
    toolName: string;
    ruleContent?: string;
  }>;
  behavior: "allow";
  destination: "session";
}

export interface RemoteQuestionOption {
  label: string;
  description?: string;
}

export interface RemoteQuestion {
  question: string;
  header?: string;
  options: RemoteQuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  requestId: string;
  toolUseId: string;
  questions: RemoteQuestion[];
  createdAt: number;
}

export interface RemoteHostAction {
  id: string;
  type:
    | "provider.change"
    | "model.sync"
    | "usage.refresh"
    | "codex.reset"
    | "session.handback";
  payload: Record<string, unknown>;
  createdAt: number;
  leaseId?: string;
  ownerWorkspacePath?: string;
  operationId?: string;
  /** Original authenticated phone command which created this action. */
  commandId?: string;
  /** Canonical request hash paired with `commandId` for replay safety. */
  requestHash?: string;
  claimToken?: string;
  claimOwner?: string;
  claimExpiresAt?: number;
}

export interface RemoteDaemonConfiguration {
  lease: RemoteSessionLease;
  workspaceOwnerId: string;
  claudeExecutable: string;
  environment: Record<string, string | undefined>;
  permissionMode: "default" | "acceptEdits" | "auto" | "plan";
  pairedDeviceStoreKey: string;
  hostIdentityPrivateKey: string;
  hostIdentityPublicKey: string;
  launchToken: string;
  assetsDirectory: string;
  iconPath: string;
  unpairedTimeoutMs: number;
  idleTimeoutMs: number | null;
  maximumSessionMs: number;
}

/** Encrypted, crash-recovery state written by the detached daemon. */
export interface RemoteRuntimeManifest {
  version: 1;
  savedAt: number;
  runtime: RemoteRuntimeSnapshot;
  configuration: RemoteDaemonConfiguration;
  process: {
    daemonPid: number;
    queryGeneration: number;
    childPid?: number;
    state: "starting" | "running" | "quiescing" | "stopped" | "lost";
  };
  transport?: RemoteTunnelState;
}

export interface RemoteHealth {
  name: "modelhop-remote";
  version: typeof REMOTE_PROTOCOL_VERSION;
  buildVersion?: string;
  ready: boolean;
  configured: boolean;
  lease?: RemoteSessionLease;
}

export interface RemoteDaemonStatus extends RemoteHealth {
  pendingPairings: Array<{
    connectionId: string;
    deviceId: string;
    deviceName: string;
    sas: string;
    createdAt: number;
  }>;
  pairedDevices: PairedDevice[];
  hostActions: RemoteHostAction[];
  tunnel?: RemoteTunnelState;
  journal?: {
    epoch: string;
    earliestEventId: number;
    latestEventId: number;
    snapshotCursor: number;
  };
  ownership?: {
    workspaceOwnerId: string;
    deviceId?: string;
    fencingGeneration: number;
  };
  transport?: {
    state: "unknown" | "connected" | "link-lost" | "recovering";
    updatedAt: number;
    detail?: string;
  };
  query?: {
    generation: number;
    state:
      | "idle"
      | "queued"
      | "running"
      | "settling"
      | "completion-unknown"
      | "error";
    lastProgressAt?: number;
    blockerIds?: string[];
  };
  recovery?: {
    state: "none" | "recovering" | "recovered" | "execution-lost";
    savedAt?: number;
    transcriptRecoverable: boolean;
    error?: string;
  };
}
