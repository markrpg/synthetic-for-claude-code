/// <reference lib="dom" />

import type {
  PendingPermission,
  PendingQuestion,
  RemoteClientCommand,
  RemoteConversationEvent,
  RemoteJournalEvent,
  RemoteFilePreview,
  RemoteFileReferencePreview,
  RemoteModelOption,
  RemoteProviderContext,
  RemoteSessionLease,
  RemoteUsageSnapshot,
} from "../types.js";
import {
  asRecord,
  buildFileHierarchy,
  constellationLayout,
  findHierarchyNode,
  formatProviderUsage,
  mergeUsageSnapshots,
  normalizeSdkActivity,
  orderedUnseenEvents,
  parentPath,
  providerUsageDetails,
  type ActivityPresentation,
  type FileHierarchyNode,
} from "./presentation.js";
import {
  deriveOperationalStatus,
  operationalWorkItems,
  type RemoteLinkAxis,
  type RemoteOperationalPresentation,
  type RemoteWorkPresentation,
} from "./operationalStatus.js";
import { createChatMesh } from "./chatMesh.js";
import {
  collectDirectoryListing,
  describeDirectoryListing,
  type DirectoryListingStatus,
} from "./directoryListing.js";
import {
  createSafeMarkdownRenderer,
  type MarkdownWorkspaceReference,
} from "./markdown.js";

const SAFE_REMOTE_IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/x-icon",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);
const LARGE_SOURCE_RENDER_BYTES = 768 * 1024;
const LARGE_SOURCE_RENDER_LINES = 5_000;

export type RemotePermissionMode =
  | "auto-safe"
  | "acceptEdits"
  | "default"
  | "plan";

export type RemoteWebCommand = RemoteClientCommand;

export interface RemoteTransport {
  send<T = unknown>(command: RemoteWebCommand): Promise<T>;
}

export interface RemoteClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(handle: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export interface RemoteNotificationAdapter {
  supported(): boolean;
  permission(): NotificationPermission | "unsupported";
  requestPermission(): Promise<NotificationPermission | "unsupported">;
  notify(input: {
    id: string;
    title: string;
    body: string;
    onClick?: () => void;
  }): void;
  vibrate?(pattern: number | number[]): void;
}

export interface RemoteUiStateSnapshot {
  version: 1;
  activePanel?:
    | "chat-panel"
    | "files-panel"
    | "activity-panel"
    | "settings-panel";
  taskView?: "conversation" | "activity";
  fileView?: "constellation" | "tree";
  currentFolderPath?: string;
  conversationScrollTop?: number;
  conversationPinnedToBottom?: boolean;
  headerCollapsed?: boolean;
  pendingHandbackCommand?: {
    id: string;
    strategy: "finish" | "cancel";
    cancelActive: boolean;
  };
}

export interface RemoteStateStore {
  read(): RemoteUiStateSnapshot | undefined;
  write(snapshot: RemoteUiStateSnapshot): void;
}

export interface RemoteEventBatch {
  events: RemoteJournalEvent[];
  lease?: RemoteSessionLease;
  provider?: RemoteProviderContext;
  latestEventId?: number;
  terminalEventId?: number;
  journalEpoch?: string;
  earliestEventId?: number;
  snapshotCursor?: number;
  gap?: boolean;
  runtimeSnapshot?: unknown;
  epoch?: string;
  snapshot?: unknown;
  /** Events at or below this ID reconstruct state and must not replay toasts. */
  replayThroughEventId?: number;
}

export interface RemoteAppDependencies {
  document: Document;
  transport: RemoteTransport;
  clock?: RemoteClock;
  notifications?: RemoteNotificationAdapter;
  stateStore?: RemoteStateStore;
}

export interface MountedRemoteApp {
  applyBatch(batch: RemoteEventBatch): void;
  applyEvent(event: RemoteJournalEvent): void;
  updateLease(lease: RemoteSessionLease): void;
  updateProvider(provider: RemoteProviderContext): void;
  setConnection(
    state: RemoteLinkAxis,
    label?: string,
  ): void;
  destroy(): void;
}

interface SlashCommand {
  name: string;
  description?: string;
}

interface PendingLocalMessage {
  id: string;
  prompt: string;
  element: HTMLElement;
  createdAt: number;
}

interface AttachmentRecord {
  id: string;
  name: string;
}

export interface ActivityRecord extends ActivityPresentation {
  createdAt: number;
}

export interface RemoteElapsedDisplay {
  label: string;
  dateTime: string;
}

const INTERNAL_CLAUDE_ORIGINS = new Set([
  "command",
  "local-command",
  "local_command",
  "task-notification",
  "task_notification",
  "tool",
  "tool-result",
  "tool_result",
]);

const INTERNAL_CLAUDE_ENVELOPE = /^\s*<(?:local-command-caveat|command-name|command-message|command-args|task-notification|task-output|system-reminder|tool-use-result|available-deferred-tools)(?:\s|>)/i;

/**
 * Old journals can contain Claude Code protocol envelopes represented as
 * user-role text. Explicit human provenance always wins: a developer is
 * still allowed to discuss or paste the same XML-like syntax deliberately.
 */
export function isInternalClaudeConversationText(
  text: string,
  originKind?: string,
): boolean {
  if (originKind === "human") {
    return false;
  }
  if (originKind && INTERNAL_CLAUDE_ORIGINS.has(originKind)) {
    return true;
  }
  return INTERNAL_CLAUDE_ENVELOPE.test(text);
}

/** Keep an operation in the position where it first appeared. */
export function reconcileActivityRecords(
  records: readonly ActivityRecord[],
  activity: ActivityPresentation,
  createdAt: number,
  maximum = 200,
): { records: ActivityRecord[]; inserted: boolean } {
  const existingIndex = records.findIndex(
    (candidate) => candidate.key === activity.key,
  );
  if (existingIndex >= 0) {
    const existing = records[existingIndex];
    if (!existing) {
      return { records: [...records], inserted: false };
    }
    const next = [...records];
    next[existingIndex] = {
      ...existing,
      ...activity,
      createdAt: existing.createdAt,
    };
    return { records: next, inserted: false };
  }
  return {
    records: [...records, { ...activity, createdAt }].slice(-maximum),
    inserted: true,
  };
}

export function formatRemoteElapsed(
  startedAt: number | undefined,
  completedAt: number | undefined,
  clientNow: number,
  serverClockOffsetMs = 0,
): RemoteElapsedDisplay {
  if (startedAt === undefined) {
    return { label: "—", dateTime: "" };
  }
  const observedAt = completedAt ?? clientNow + serverClockOffsetMs;
  if (!Number.isFinite(observedAt) || observedAt < startedAt - 1_000) {
    return { label: "Active", dateTime: "" };
  }
  const totalSeconds = Math.max(
    0,
    Math.floor((observedAt - startedAt) / 1_000),
  );
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return {
    label: hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    dateTime: `PT${totalSeconds}S`,
  };
}

export function shouldPresentUsageSnapshot(
  activeProvider: RemoteProviderContext["provider"] | undefined,
  previous: RemoteUsageSnapshot | undefined,
  incoming: RemoteUsageSnapshot,
): boolean {
  if (activeProvider && incoming.provider !== activeProvider) {
    return false;
  }
  return !previous || incoming.updatedAt >= previous.updatedAt;
}

export function shouldMarkActivityUnread(
  initialReplay: boolean,
  presentTransient: boolean,
): boolean {
  return !initialReplay && presentTransient;
}

interface ListedWorkspaceRoot {
  id: string;
  label: string;
}

interface ListedWorkspaceNode {
  rootId: string;
  name: string;
  path: string;
  displayPath: string;
  kind: "directory" | "file";
  extension?: string;
  size?: number;
  hasChildren: boolean;
}

interface DirectoryPage {
  root: ListedWorkspaceRoot;
  path: string;
  parentPath?: string;
  nodes: ListedWorkspaceNode[];
  totalEntries?: number;
  omittedEntries?: {
    protected: number;
    unavailable: number;
    unsupported: number;
  };
  nextCursor?: string;
}

interface DirectoryListResponse {
  roots: ListedWorkspaceRoot[];
  page: DirectoryPage;
}

type Suggestion =
  | { kind: "command"; label: string; detail?: string; value: string }
  | { kind: "file"; label: string; detail?: string; value: string };

type ReasoningEffortValue =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface ReasoningFeatureState {
  available: boolean;
  enabled: boolean;
  unavailableReason?: string;
}

interface ProviderReasoningState {
  ready: boolean;
  thinkingSupported: boolean;
  thinkingEnabled: boolean;
  thinkingUnavailableReason?: string;
  supportedEffortLevels: ReasoningEffortValue[];
  effectiveEffort?: ReasoningEffortValue;
  effortAuthority?:
    | "claude-sdk"
    | "synthetic-api"
    | "openai-model-list"
    | "codex-model-list"
    | "provider-model-catalog"
    | "unavailable";
  workflows: ReasoningFeatureState;
  ultra: ReasoningFeatureState;
}

interface ReasoningChangeCommand {
  id: string;
  type: "reasoning.change";
  thinkingEnabled?: boolean;
  effort?: ReasoningEffortValue;
  workflowsEnabled?: boolean;
  ultraEnabled?: boolean;
}

const REASONING_EFFORT_LABELS: Record<ReasoningEffortValue, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function isReasoningEffort(value: unknown): value is ReasoningEffortValue {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(REASONING_EFFORT_LABELS, value)
  );
}

function providerReasoningState(
  provider: RemoteProviderContext | undefined,
): ProviderReasoningState {
  const raw = provider?.reasoning;
  const supportedEffortLevels = Array.isArray(raw?.supportedEffortLevels)
    ? raw.supportedEffortLevels.filter(isReasoningEffort)
    : [];
  const legacyEffort = isReasoningEffort(provider?.reasoningEffort)
    ? provider.reasoningEffort
    : undefined;
  const effectiveEffort = isReasoningEffort(raw?.effectiveEffort)
    ? raw.effectiveEffort
    : legacyEffort;
  const feature = (
    candidate: Partial<ReasoningFeatureState> | undefined,
  ): ReasoningFeatureState => ({
    available: candidate?.available === true,
    enabled: candidate?.enabled === true,
    unavailableReason:
      typeof candidate?.unavailableReason === "string" &&
      candidate.unavailableReason.trim().length > 0
        ? candidate.unavailableReason.trim()
        : undefined,
  });
  return {
    ready: raw !== undefined,
    thinkingSupported: raw?.thinkingSupported === true,
    thinkingEnabled: raw?.thinkingEnabled === true,
    thinkingUnavailableReason:
      typeof raw?.thinkingUnavailableReason === "string" &&
      raw.thinkingUnavailableReason.trim().length > 0
        ? raw.thinkingUnavailableReason.trim()
        : undefined,
    supportedEffortLevels,
    effectiveEffort,
    effortAuthority:
      raw?.effortAuthority === "claude-sdk" ||
      raw?.effortAuthority === "synthetic-api" ||
      raw?.effortAuthority === "openai-model-list" ||
      raw?.effortAuthority === "codex-model-list" ||
      raw?.effortAuthority === "provider-model-catalog" ||
      raw?.effortAuthority === "unavailable"
        ? raw.effortAuthority
        : undefined,
    workflows: feature(raw?.workflows),
    ultra: feature(raw?.ultra),
  };
}

function reasoningUnavailableCopy(
  feature: "thinking" | "workflows" | "ultra",
  provider: RemoteProviderContext | undefined,
): string {
  const model = provider?.model ?? "this model";
  if (feature === "thinking") {
    return `Thinking controls were not reported as compatible with ${model}.`;
  }
  if (feature === "workflows") {
    return `Claude-harness workflow orchestration was not reported available for this ${model} session.`;
  }
  return "ModelHop Ultra requires Extra high (xhigh) effort and compatible Claude Workflows. Provider-native Ultra modes are separate.";
}

function reasoningHeaderLabel(
  state: ProviderReasoningState,
  privateRoute: boolean,
): string | undefined {
  if (!state.ready) {
    return undefined;
  }
  if (state.ultra.enabled) {
    return "Ultra";
  }
  if (state.effectiveEffort) {
    const prefix = privateRoute && !state.thinkingEnabled
      ? "Reason"
      : "Think";
    return `${prefix} · ${REASONING_EFFORT_LABELS[state.effectiveEffort]}`;
  }
  if (!state.thinkingSupported) {
    return undefined;
  }
  if (!state.thinkingEnabled) {
    return "Thinking · Off";
  }
  return "Thinking on";
}

function canActivateUltra(state: ProviderReasoningState): boolean {
  if (state.ultra.available || state.ultra.enabled) {
    return true;
  }
  return Boolean(
    state.ready &&
      state.workflows.available &&
      state.supportedEffortLevels.includes("xhigh") &&
      state.ultra.unavailableReason &&
      /Turn (?:Thinking|Workflows) on before enabling Ultra\./iu.test(
        state.ultra.unavailableReason,
      ),
  );
}

function matchingModelOption(
  models: readonly RemoteModelOption[],
  value: string,
): RemoteModelOption | undefined {
  const selector = models.find((candidate) => candidate.selector === value);
  if (selector) {
    return selector;
  }
  const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const aliases = models.filter(
    (candidate) =>
      candidate.resolvedModel === value ||
      candidate.displayName === value ||
      candidate.resolvedModel?.toLowerCase().replace(/[^a-z0-9]/gu, "") ===
        normalizedValue ||
      candidate.displayName.toLowerCase().replace(/[^a-z0-9]/gu, "") ===
        normalizedValue,
  );
  if (aliases.length === 1) {
    return aliases[0];
  }
  const defaultAlias = aliases.filter((candidate) => candidate.isDefault);
  return defaultAlias.length === 1 ? defaultAlias[0] : undefined;
}

function modelOptionRepresents(
  model: RemoteModelOption,
  value: string,
): boolean {
  const normalize = (candidate: string): string =>
    candidate.toLowerCase().replace(/[^a-z0-9]/gu, "");
  const normalizedValue = normalize(value);
  return (
    model.selector === value ||
    model.resolvedModel === value ||
    model.displayName === value ||
    normalize(model.selector) === normalizedValue ||
    (model.resolvedModel !== undefined &&
      normalize(model.resolvedModel) === normalizedValue) ||
    normalize(model.displayName) === normalizedValue
  );
}

function browserClock(view: Window): RemoteClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) =>
      view.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => view.clearTimeout(handle),
    setInterval: (callback, milliseconds) =>
      view.setInterval(callback, milliseconds),
    clearInterval: (handle) => view.clearInterval(handle),
    requestAnimationFrame: (callback) =>
      view.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) =>
      view.cancelAnimationFrame(handle),
  };
}

const UI_STATE_STORAGE_KEY = "modelhop.remote.ui.v1";

function browserStateStore(view: Window): RemoteStateStore {
  let fallback: RemoteUiStateSnapshot | undefined;
  return {
    read: () => {
      try {
        const raw = view.sessionStorage.getItem(UI_STATE_STORAGE_KEY);
        if (!raw) {
          return fallback;
        }
        return normalizeUiState(
          JSON.parse(raw) as Partial<RemoteUiStateSnapshot>,
        );
      } catch {
        return fallback;
      }
    },
    write: (snapshot) => {
      fallback = snapshot;
      try {
        view.sessionStorage.setItem(
          UI_STATE_STORAGE_KEY,
          JSON.stringify(snapshot),
        );
      } catch {
        // In-memory state still survives for the life of this page.
      }
    },
  };
}

function normalizeUiState(
  value: Partial<RemoteUiStateSnapshot> | undefined,
): RemoteUiStateSnapshot {
  const panels = new Set<RemoteUiStateSnapshot["activePanel"]>([
    "chat-panel",
    "files-panel",
    "activity-panel",
    "settings-panel",
  ]);
  const scrollTop = Number.isFinite(value?.conversationScrollTop)
    ? Math.max(0, value?.conversationScrollTop ?? 0)
    : undefined;
  return {
    version: 1,
    activePanel: panels.has(value?.activePanel)
      ? value?.activePanel
      : undefined,
    taskView:
      value?.taskView === "activity" || value?.taskView === "conversation"
        ? value.taskView
        : undefined,
    fileView:
      value?.fileView === "tree" || value?.fileView === "constellation"
        ? value.fileView
        : undefined,
    currentFolderPath:
      typeof value?.currentFolderPath === "string"
        ? value.currentFolderPath
        : undefined,
    conversationScrollTop: scrollTop,
    conversationPinnedToBottom:
      typeof value?.conversationPinnedToBottom === "boolean"
        ? value.conversationPinnedToBottom
        : undefined,
    headerCollapsed:
      typeof value?.headerCollapsed === "boolean"
        ? value.headerCollapsed
        : undefined,
    pendingHandbackCommand:
      typeof value?.pendingHandbackCommand?.id === "string" &&
      (value.pendingHandbackCommand.strategy === "finish" ||
        value.pendingHandbackCommand.strategy === "cancel")
        ? {
            id: value.pendingHandbackCommand.id,
            strategy: value.pendingHandbackCommand.strategy,
            cancelActive:
              value.pendingHandbackCommand.cancelActive === true,
          }
        : undefined,
  };
}

function required<T extends Element>(
  document: Document,
  id: string,
): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing interface element: ${id}`);
  }
  return element as unknown as T;
}

export function mountRemoteApp(
  dependencies: RemoteAppDependencies,
): MountedRemoteApp {
  const doc = dependencies.document;
  const browserWindow = doc.defaultView;
  if (!browserWindow) {
    throw new Error("ModelHop Remote requires a browser window.");
  }
  const view: Window = browserWindow;
  const previewScriptNonce = (() => {
    const value = doc
      .querySelector<HTMLMetaElement>('meta[name="modelhop-csp-nonce"]')
      ?.content.trim();
    return value && /^[A-Za-z0-9+/=_-]{16,128}$/u.test(value)
      ? value
      : undefined;
  })();
  const clock = dependencies.clock ?? browserClock(view);
  const transport = dependencies.transport;
  const notifications = dependencies.notifications;
  const stateStore = dependencies.stateStore ?? browserStateStore(view);
  let uiState: RemoteUiStateSnapshot;
  try {
    uiState = normalizeUiState(stateStore.read());
  } catch {
    uiState = { version: 1 };
  }
  const updateUiState = (
    patch: Partial<Omit<RemoteUiStateSnapshot, "version">>,
  ): void => {
    uiState = normalizeUiState({ ...uiState, ...patch, version: 1 });
    try {
      stateStore.write(uiState);
    } catch {
      // UI persistence must never interrupt the active remote session.
    }
  };
  const abortController = new AbortController();
  const listenerOptions = { signal: abortController.signal };

  const app = required<HTMLElement>(doc, "app");
  const taskHeader = required<HTMLElement>(doc, "task-header");
  const headerCollapseButton =
    required<HTMLButtonElement>(doc, "header-collapse-button");
  const fullscreenButton =
    required<HTMLButtonElement>(doc, "fullscreen-button");
  const compactRouteButton =
    required<HTMLButtonElement>(doc, "compact-route-button");
  const compactRouteLabel =
    required<HTMLElement>(doc, "compact-route-label");
  const compactPhaseLabel =
    required<HTMLElement>(doc, "compact-phase-label");
  const mainContent = required<HTMLElement>(doc, "main-content");
  const bottomTabsElement =
    required<HTMLElement>(doc, "tab-chat").parentElement;
  if (!bottomTabsElement) {
    throw new Error("Missing bottom navigation.");
  }
  const bottomTabs: HTMLElement = bottomTabsElement;
  const taskSummaryElement =
    required<HTMLElement>(doc, "task-title").parentElement;
  if (!taskSummaryElement) {
    throw new Error("Missing task summary.");
  }
  const taskSummary: HTMLElement = taskSummaryElement;
  const taskTitle = required<HTMLElement>(doc, "task-title");
  const taskPhase = required<HTMLElement>(doc, "task-phase");
  const taskElapsed = required<HTMLTimeElement>(doc, "task-elapsed");
  const turnElapsedLabel =
    required<HTMLElement>(doc, "turn-elapsed-label");
  const operationElapsedItem =
    required<HTMLElement>(doc, "operation-elapsed-item");
  const operationElapsed =
    required<HTMLTimeElement>(doc, "operation-elapsed");
  const statusRegion = required<HTMLElement>(doc, "status-region");
  const connectionButton =
    required<HTMLButtonElement>(doc, "connection-button");
  const connectionState =
    required<HTMLElement>(doc, "connection-state");
  const routeLabel = required<HTMLElement>(doc, "route-label");
  const reasoningStatePill =
    required<HTMLElement>(doc, "reasoning-state-pill");
  const routeReasoningSummary =
    required<HTMLButtonElement>(doc, "route-reasoning-summary");
  const routeReasoningTitle =
    required<HTMLElement>(doc, "route-reasoning-title");
  const routeReasoningDetail =
    required<HTMLElement>(doc, "route-reasoning-detail");
  const usageValue = required<HTMLElement>(doc, "usage-value");
  const usageLabel = required<HTMLElement>(doc, "usage-label");
  const routeDialog = required<HTMLDialogElement>(doc, "route-dialog");
  const usageDialog = required<HTMLDialogElement>(doc, "usage-dialog");
  const attachmentDialog =
    required<HTMLDialogElement>(doc, "attachment-dialog");
  const fileViewerDialog =
    required<HTMLDialogElement>(doc, "file-viewer-dialog");
  const conversationScroll =
    required<HTMLElement>(doc, "conversation-scroll");
  const conversation = required<HTMLElement>(doc, "conversation");
  const chatMesh = createChatMesh(
    required<HTMLCanvasElement>(doc, "chat-mesh"),
    required<HTMLElement>(doc, "chat-vanta"),
    view,
  );
  const newUpdatesButton =
    required<HTMLButtonElement>(doc, "new-updates-button");
  const newUpdatesCount =
    required<HTMLElement>(doc, "new-updates-count");
  const activityTimeline =
    required<HTMLOListElement>(doc, "activity-timeline");
  const activityTimelineFull =
    required<HTMLOListElement>(doc, "activity-timeline-full");
  const activityCount = required<HTMLElement>(doc, "activity-count");
  const workGraph = required<HTMLElement>(doc, "work-graph");
  const workGraphCount = required<HTMLElement>(doc, "work-graph-count");
  const workGraphSummary = required<HTMLElement>(doc, "work-graph-summary");
  const workGraphItems = required<HTMLOListElement>(doc, "work-graph-items");
  const workGraphActions = required<HTMLElement>(doc, "work-graph-actions");
  const handbackContinueWaiting =
    required<HTMLButtonElement>(doc, "handback-continue-waiting");
  const handbackCancelRequest =
    required<HTMLButtonElement>(doc, "handback-cancel-request");
  const handbackCancelWork =
    required<HTMLButtonElement>(doc, "handback-cancel-work");
  const taskViewTabs = required<HTMLElement>(doc, "task-view-tabs");
  const filesPanel = required<HTMLElement>(doc, "files-panel");
  const filePreview = required<HTMLElement>(doc, "file-preview");
  const permissionLayer =
    required<HTMLElement>(doc, "pending-permissions");
  const approvalAlert = required<HTMLElement>(doc, "approval-alert");
  const promptForm = required<HTMLFormElement>(doc, "prompt-form");
  const promptInput = required<HTMLTextAreaElement>(doc, "prompt-input");
  const sendButton = required<HTMLButtonElement>(doc, "send-button");
  const cancelButton = required<HTMLButtonElement>(doc, "cancel-button");
  const composerState = required<HTMLElement>(doc, "composer-state");
  const suggestionsElement = required<HTMLElement>(doc, "suggestions");
  const attachmentsElement = required<HTMLElement>(doc, "attachments");
  const providerSelect =
    required<HTMLSelectElement>(doc, "provider-select");
  const modelSelect = required<HTMLSelectElement>(doc, "model-select");
  const effortSelect = required<HTMLSelectElement>(doc, "effort-select");
  const reasoningSettingsCard =
    required<HTMLElement>(doc, "reasoning-settings-card");
  const reasoningSettingsStatus =
    required<HTMLElement>(doc, "reasoning-settings-status");
  const reasoningSettingsDescription =
    required<HTMLElement>(doc, "reasoning-settings-description");
  const reasoningSettingsModel =
    required<HTMLElement>(doc, "reasoning-settings-model");
  const thinkingToggle =
    required<HTMLInputElement>(doc, "thinking-toggle");
  const thinkingToggleLabel =
    required<HTMLElement>(doc, "thinking-toggle-label");
  const thinkingHelp = required<HTMLElement>(doc, "thinking-help");
  const thinkingUnavailableReason =
    required<HTMLElement>(doc, "thinking-unavailable-reason");
  const settingsEffortSelect =
    required<HTMLSelectElement>(doc, "settings-effort-select");
  const effortLabel = required<HTMLElement>(doc, "effort-label");
  const effortUnavailableReason =
    required<HTMLElement>(doc, "effort-unavailable-reason");
  const workflowsToggle =
    required<HTMLInputElement>(doc, "workflows-toggle");
  const workflowsUnavailableReason =
    required<HTMLElement>(doc, "workflows-unavailable-reason");
  const ultraToggle = required<HTMLInputElement>(doc, "ultra-toggle");
  const ultraUnavailableReason =
    required<HTMLElement>(doc, "ultra-unavailable-reason");
  const reasoningChangeStatus =
    required<HTMLElement>(doc, "reasoning-change-status");
  const routeEffortLabel =
    required<HTMLElement>(doc, "route-effort-label");
  const routeEffortHelp =
    required<HTMLElement>(doc, "route-effort-help");
  const modelCapabilitySummary =
    required<HTMLElement>(doc, "model-capability-summary");
  const modelChangeStatus =
    required<HTMLElement>(doc, "model-change-status");
  const permissionMode =
    required<HTMLSelectElement>(doc, "permission-mode");
  const usageDetail = required<HTMLElement>(doc, "usage-detail");
  const codexReset = required<HTMLButtonElement>(doc, "codex-reset");
  const handbackButton =
    required<HTMLButtonElement>(doc, "handback-button");
  const cancelHandbackButton =
    required<HTMLButtonElement>(doc, "cancel-handback-button");
  const toastRegion = required<HTMLElement>(doc, "toast-region");
  const attachmentInput =
    required<HTMLInputElement>(doc, "attachment-input");
  const photoInput = required<HTMLInputElement>(doc, "photo-input");
  const cameraInput = required<HTMLInputElement>(doc, "camera-input");
  const sessionEnded = required<HTMLElement>(doc, "session-ended");

  let currentLease: RemoteSessionLease | undefined;
  let currentLinkAxis: RemoteLinkAxis = "secure";
  let currentPhaseHint: string | undefined;
  let currentOperationalStatus: RemoteOperationalPresentation | undefined;
  let currentRuntimeSnapshot: unknown;
  let currentJournalEpoch: string | undefined;
  let terminalSessionEnded = false;
  let pendingHandbackCommand = uiState.pendingHandbackCommand;
  let currentProvider: RemoteProviderContext | undefined;
  let currentPermissionMode: RemotePermissionMode = "auto-safe";
  let currentUsageSnapshot: RemoteUsageSnapshot | undefined;
  let providerSwitchTarget: string | undefined;
  let reasoningChangePending = false;
  let reasoningChangeRequestId: string | undefined;
  let modelChangePendingTarget: string | undefined;
  let modelChangePreviousSelector: string | undefined;
  let confirmedModelSelector: string | undefined;
  let currentModelOptions: RemoteModelOption[] = [];
  let phaseIsBusy = false;
  let liveAssistant: HTMLElement | undefined;
  let liveTextBuffer = "";
  let streamFrame: number | undefined;
  let scrollStateFrame: number | undefined;
  let filePreviewRevealFrame: number | undefined;
  let pinnedToBottom = uiState.conversationPinnedToBottom !== false;
  let pendingScrollRestore =
    uiState.conversationPinnedToBottom === false &&
    uiState.conversationScrollTop !== undefined;
  let unseenUpdates = 0;
  let lastPrompt = "";
  let filesLoaded = false;
  let fileHierarchyPromise: Promise<void> | undefined;
  let fileHierarchy = buildFileHierarchy([]);
  let currentFolderPath = "";
  let currentFilePath = "";
  let selectedFileNodePath = "";
  let currentFileContent = "";
  let currentFilePreview: RemoteFilePreview | undefined;
  let fileViewerInteractive = false;
  let fileViewerMode: "source" | "preview" = "source";
  let selectedLineStart: number | undefined;
  let selectedLineEnd: number | undefined;
  const fileNodeMetadata = new Map<string, ListedWorkspaceNode>();
  const loadedFolders = new Set<string>();
  const loadingFolders = new Set<string>();
  const directoryLoadStatus = new Map<string, DirectoryListingStatus>();
  let fileSearchEpoch = 0;
  let suggestionEpoch = 0;
  let suggestionTimer: number | undefined;
  let currentSuggestions: Suggestion[] = [];
  let highlightedSuggestion = 0;
  let slashCommands: SlashCommand[] = [];
  let notificationsEnabled = false;
  let workflowConsentConfirmed = false;
  let ultraConsentConfirmed = false;
  let activityUnread = 0;
  let suppressActivityUnread = false;
  let serverClockOffsetMs = 0;
  let activeInteractionId: string | undefined;
  let handbackRecoveryMessage: HTMLElement | undefined;
  const pendingMessages = new Map<string, PendingLocalMessage>();
  const attachments: AttachmentRecord[] = [];
  const permissions = new Map<string, PendingPermission>();
  const questions = new Map<string, PendingQuestion>();
  const notifiedApprovals = new Set<string>();
  const activities: ActivityRecord[] = [];
  const usageSnapshots = new Map<
    RemoteProviderContext["provider"],
    RemoteUsageSnapshot
  >();
  const messageMarkdownSources = new WeakMap<HTMLElement, string>();
  const markdownRenderer = createSafeMarkdownRenderer(doc, {
    onWorkspaceFile: openChatReference,
    onWorkspaceImage: openChatReference,
    onActionError: showError,
  });
  let lastAppliedEventId = 0;
  let receivedInitialEventBatch = false;

  function listen<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    element.addEventListener(type, listener as EventListener, listenerOptions);
  }

  function setViewportHeight(): void {
    const height = view.visualViewport?.height ?? view.innerHeight;
    doc.documentElement.style.setProperty(
      "--viewport-height",
      `${Math.round(height)}px`,
    );
  }
  setViewportHeight();
  view.visualViewport?.addEventListener(
    "resize",
    setViewportHeight,
    listenerOptions,
  );
  view.addEventListener("orientationchange", setViewportHeight, listenerOptions);

  function setConnection(
    state: RemoteLinkAxis,
    label?: string,
  ): void {
    currentLinkAxis = state;
    connectionButton.dataset.state = state;
    taskHeader.dataset.connection = state;
    connectionState.textContent =
      label ??
      ({
        secure: "Secure",
        reconnecting: "Reconnecting",
        "link-lost": "Link lost",
        expired: "Expired",
        revoked: "Revoked",
        switching: "Changing route",
        paused: "Paused",
        error: "Error",
      } as const)[state];
    renderOperationalStatus();
  }

  function setPhase(
    label: string,
    options: { busy?: boolean; tone?: "normal" | "warning" | "error" } = {},
  ): void {
    taskPhase.textContent = label;
    statusRegion.textContent = label;
    phaseIsBusy = options.busy ?? false;
    taskSummary.dataset.phase =
      options.tone === "error"
        ? "error"
        : options.tone === "warning"
          ? "warning"
          : phaseIsBusy
            ? "busy"
            : "normal";
    taskHeader.dataset.phase = taskSummary.dataset.phase;
    compactPhaseLabel.textContent = label;
    promptForm.dataset.phase = taskSummary.dataset.phase;
    composerState.textContent = label;
  }

  function updateElapsed(): void {
    const elapsed = formatRemoteElapsed(
      currentLease?.turnStartedAt,
      currentLease?.turnCompletedAt,
      clock.now(),
      serverClockOffsetMs,
    );
    taskElapsed.textContent = elapsed.label;
    taskElapsed.dateTime = elapsed.dateTime;
    const operation = currentOperationalStatus?.operation;
    const operationStartedAt = operation?.requestedAt;
    const operationTime = formatRemoteElapsed(
      operationStartedAt,
      operation?.phase === "complete" || operation?.phase === "failed"
        ? operation.updatedAt
        : undefined,
      clock.now(),
      serverClockOffsetMs,
    );
    operationElapsedItem.hidden = operationStartedAt === undefined;
    turnElapsedLabel.hidden = operationStartedAt === undefined;
    operationElapsed.textContent = operationTime.label;
    operationElapsed.dateTime = operationTime.dateTime;
    const operationLabel = operationElapsedItem.querySelector("span");
    if (operationLabel) {
      operationLabel.textContent = operation?.kind === "provider-switch"
        ? "Switch"
        : "Return";
    }
  }
  updateElapsed();
  const elapsedTimer = clock.setInterval(() => {
    if (currentLease) {
      renderOperationalStatus();
    } else {
      updateElapsed();
    }
  }, 1_000);

  function activeLeaseOperation(): RemoteSessionLease["operation"] | undefined {
    const operation = currentLease?.operation;
    return operation &&
      operation.phase !== "complete" &&
      operation.phase !== "failed"
      ? operation
      : undefined;
  }

  function acceptsInput(): boolean {
    if (currentOperationalStatus?.inputBlocked) {
      return false;
    }
    if (
      providerSwitchTarget ||
      activeLeaseOperation() ||
      currentLease?.remoteInputRevokedAt !== undefined
    ) {
      return false;
    }
    return ![
      "paused-diverged",
      "handing-back",
      "stopped",
      "error",
      "switching-provider",
    ].includes(currentLease?.state ?? "");
  }

  function syncInputState(): void {
    const enabled = acceptsInput();
    const routeMutationPending =
      reasoningChangePending || modelChangePendingTarget !== undefined;
    const reasoningReady = providerReasoningState(currentProvider).ready;
    promptInput.disabled = !enabled;
    sendButton.disabled = !enabled;
    required<HTMLButtonElement>(doc, "attachment-button").disabled =
      !enabled;
    providerSelect.disabled = !enabled || routeMutationPending;
    modelSelect.disabled =
      !enabled || routeMutationPending || !reasoningReady;
    renderReasoningControls();
    const operation = activeLeaseOperation();
    if (
      !enabled &&
      (providerSwitchTarget || operation?.kind === "provider-switch")
    ) {
      promptInput.placeholder = "Switching provider…";
    } else if (
      !enabled &&
      (operation?.kind === "handback" ||
        currentLease?.state === "handing-back")
    ) {
      promptInput.placeholder = "Returning conversation to laptop…";
    } else if (
      !enabled &&
      currentLease?.remoteInputRevokedReason === "maximum-session"
    ) {
      promptInput.placeholder = "Eight-hour limit reached; finishing on your Mac…";
    } else if (
      !enabled &&
      currentLease?.remoteInputRevokedReason === "idle-timeout"
    ) {
      promptInput.placeholder = "Idle limit reached; returning to your Mac…";
    } else {
      promptInput.placeholder = "Ask Claude about this task…";
    }
  }

  function isNearBottom(): boolean {
    return (
      conversationScroll.scrollHeight -
        conversationScroll.scrollTop -
        conversationScroll.clientHeight <=
      64
    );
  }

  function scrollToBottom(animate: boolean): void {
    pinnedToBottom = true;
    unseenUpdates = 0;
    updateNewUpdatesButton();
    conversationScroll.scrollTo({
      top: conversationScroll.scrollHeight,
      behavior:
        animate &&
        !view.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "auto",
    });
  }

  function updateNewUpdatesButton(): void {
    newUpdatesButton.hidden = pinnedToBottom || unseenUpdates === 0;
    newUpdatesCount.textContent =
      unseenUpdates > 1 ? `(${unseenUpdates})` : "";
  }

  function contentChanged(increment = true): void {
    clock.requestAnimationFrame(() => {
      if (pinnedToBottom) {
        conversationScroll.scrollTop =
          conversationScroll.scrollHeight;
      } else if (increment) {
        unseenUpdates += 1;
        updateNewUpdatesButton();
      }
    });
  }

  listen(conversationScroll, "scroll", () => {
    pinnedToBottom = isNearBottom();
    if (pinnedToBottom) {
      unseenUpdates = 0;
    }
    updateNewUpdatesButton();
    if (!pendingScrollRestore && scrollStateFrame === undefined) {
      scrollStateFrame = clock.requestAnimationFrame(() => {
        scrollStateFrame = undefined;
        updateUiState({
          conversationScrollTop: conversationScroll.scrollTop,
          conversationPinnedToBottom: pinnedToBottom,
        });
      });
    }
  });
  listen(newUpdatesButton, "click", () => scrollToBottom(true));

  function setMessageMarkdown(
    target: HTMLElement,
    source: string,
  ): void {
    messageMarkdownSources.set(target, source);
    markdownRenderer.renderBlock(target, source);
  }

  function appendMessageMarkdown(
    target: HTMLElement,
    delta: string,
  ): void {
    setMessageMarkdown(
      target,
      `${messageMarkdownSources.get(target) ?? ""}${delta}`,
    );
  }

  function appendMessage(
    role: "user" | "assistant",
    content: string,
    options: {
      id?: string;
      delivery?: "queued" | "checking" | "accepted" | "failed";
      createdAt?: number;
    } = {},
  ): HTMLElement {
    const article = doc.createElement("article");
    article.className = `message message-${role}`;
    if (options.id) {
      article.dataset.messageId = options.id;
    }
    if (options.delivery) {
      article.dataset.delivery = options.delivery;
    }
    const meta = doc.createElement("div");
    meta.className = "message-meta";
    meta.textContent = role === "user" ? "You" : "Claude";
    const body = doc.createElement("div");
    body.className = "message-text markdown-body";
    setMessageMarkdown(body, content);
    article.append(meta, body);
    const footer = doc.createElement("footer");
    footer.className = "message-footer";
    const timestamp = doc.createElement("time");
    const createdAt = options.createdAt ?? clock.now();
    timestamp.dateTime = new Date(createdAt).toISOString();
    timestamp.textContent = new Date(createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    footer.append(timestamp);
    if (role === "user" && options.delivery) {
      const delivery = doc.createElement("small");
      delivery.className = "delivery-state";
      delivery.textContent =
        options.delivery === "queued"
          ? "Sending…"
          : options.delivery === "checking"
            ? "Checking Mac…"
          : options.delivery === "failed"
            ? "Not sent"
            : "✓";
      delivery.setAttribute(
        "aria-label",
        options.delivery === "queued"
          ? "Sending"
          : options.delivery === "checking"
            ? "Checking delivery with your Mac"
          : options.delivery === "failed"
            ? "Not sent"
            : "Sent",
      );
      footer.append(delivery);
    }
    article.append(footer);
    conversation.append(article);
    contentChanged();
    return article;
  }

  function setMessageDelivery(
    message: PendingLocalMessage,
    delivery: "checking" | "accepted" | "failed",
  ): void {
    message.element.dataset.delivery = delivery;
    const label =
      message.element.querySelector<HTMLElement>(".delivery-state");
    if (label) {
      label.textContent =
        delivery === "accepted"
          ? "✓"
          : delivery === "checking"
            ? "Checking Mac…"
            : "Not sent";
      label.setAttribute(
        "aria-label",
        delivery === "accepted"
          ? "Sent"
          : delivery === "checking"
            ? "Checking delivery with your Mac"
            : "Not sent",
      );
    }
  }

  function appendSystemMessage(
    content: string,
    tone: "normal" | "error" = "normal",
  ): HTMLElement {
    const article = doc.createElement("article");
    article.className = `message system-message${tone === "error" ? " error-message" : ""}`;
    const text = doc.createElement("div");
    text.className = "markdown-body system-message-text";
    markdownRenderer.renderBlock(text, content);
    article.append(text);
    conversation.append(article);
    contentChanged();
    return article;
  }

  function clearHandbackRecovery(): void {
    handbackRecoveryMessage?.remove();
    handbackRecoveryMessage = undefined;
  }

  function clearPendingHandbackCommand(commandId?: string): void {
    if (
      commandId !== undefined &&
      pendingHandbackCommand?.id !== commandId
    ) {
      return;
    }
    pendingHandbackCommand = undefined;
    updateUiState({ pendingHandbackCommand: undefined });
  }

  function setPendingHandbackCommand(
    command: NonNullable<RemoteUiStateSnapshot["pendingHandbackCommand"]>,
  ): void {
    pendingHandbackCommand = command;
    updateUiState({ pendingHandbackCommand: command });
  }

  function deliveryState(value: unknown): string | undefined {
    const direct = asRecord(value);
    const nested = asRecord(direct.data);
    const state = nested.deliveryState ?? direct.deliveryState;
    return typeof state === "string" ? state : undefined;
  }

  function showCheckingMac(notify = true): void {
    currentPhaseHint = "delivery-unknown";
    setPhase("Checking Mac", { busy: true, tone: "warning" });
    if (notify) {
      toast(
        "The Mac may already have accepted this request. ModelHop is checking without repeating the action.",
      );
    }
  }

  function sendHandback(
    strategy: "finish" | "cancel",
  ): void {
    const cancelActive = strategy === "cancel";
    const existing = pendingHandbackCommand;
    const command =
      existing?.strategy === strategy &&
      existing.cancelActive === cancelActive
        ? existing
        : {
            id: crypto.randomUUID(),
            strategy,
            cancelActive,
          };
    setPendingHandbackCommand(command);
    handbackButton.disabled = true;
    cancelHandbackButton.disabled = true;
    setPhase(
      strategy === "cancel"
        ? "Cancelling turn for hand-back"
        : "Finishing turn before hand-back",
      {
        busy: true,
        tone: strategy === "cancel" ? "warning" : "normal",
      },
    );
    syncInputState();
    void transport
      .send({
        id: command.id,
        type: "session.handback",
        strategy,
        cancelActive,
      })
      .then((response) => {
        if (deliveryState(response) === "unknown") {
          handbackButton.disabled = false;
          cancelHandbackButton.disabled = false;
          showCheckingMac();
          return;
        }
        clearPendingHandbackCommand(command.id);
        toast(
          strategy === "cancel"
            ? "Cancellation requested. This phone remains connected until the exact conversation is safe on your laptop."
            : "Hand-back requested. You may lock this phone; work continues on your Mac.",
        );
      })
      .catch((error: unknown) => {
        handbackButton.disabled = false;
        cancelHandbackButton.disabled = false;
        if (asRecord(error).authoritative === true) {
          clearPendingHandbackCommand(command.id);
          showError(error);
          return;
        }
        showCheckingMac();
      });
  }

  function showHandbackRecovery(message: string): void {
    setConnection("error", "Hand-back paused");
    setPhase("Hand-back needs your attention", { tone: "error" });
    handbackButton.disabled = false;
    cancelHandbackButton.disabled = false;

    if (!handbackRecoveryMessage) {
      const article = appendSystemMessage("", "error");
      article.classList.add("handback-recovery");
      article.dataset.testid = "handback-recovery";

      const title = doc.createElement("strong");
      title.textContent = "Conversation is still available on this phone";
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.dataset.testid = "handback-retry";
      retry.textContent = "Retry opening this exact conversation";
      listen(retry, "click", () => {
        retry.disabled = true;
        handbackButton.disabled = true;
        cancelHandbackButton.disabled = true;
        setPhase("Retrying exact-session hand-back", { busy: true });
        syncInputState();
        sendHandback("finish");
        retry.disabled = false;
      });
      article.prepend(title);
      article.append(retry);
      handbackRecoveryMessage = article;
    }

    const detail = handbackRecoveryMessage.querySelector<HTMLElement>(
      ".system-message-text",
    );
    if (detail) {
      markdownRenderer.renderBlock(
        detail,
        `${message} Remote access remains active; no conversation was closed.`,
      );
    }
    scrollToBottom(false);
  }

  function appendRetryMessage(message: string): void {
    const article = appendSystemMessage(message, "error");
    if (!lastPrompt) {
      return;
    }
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "stop-button";
    retry.textContent = "Retry last prompt";
    listen(retry, "click", () => {
      promptInput.value = lastPrompt;
      switchToChatAndFocus();
      resizeComposer();
    });
    article.append(retry);
  }

  function flushLiveText(): void {
    streamFrame = undefined;
    if (!liveAssistant || !liveTextBuffer) {
      return;
    }
    const body =
      liveAssistant.querySelector<HTMLElement>(".message-text");
    if (body) {
      appendMessageMarkdown(body, liveTextBuffer);
    }
    liveTextBuffer = "";
    contentChanged();
  }

  function appendAssistantDelta(delta: string): void {
    if (!liveAssistant) {
      liveAssistant = appendMessage("assistant", "");
      liveAssistant.dataset.live = "true";
    }
    liveTextBuffer += delta;
    if (streamFrame === undefined) {
      streamFrame = clock.requestAnimationFrame(flushLiveText);
    }
  }

  function finishLiveAssistant(): void {
    flushLiveText();
    liveAssistant?.removeAttribute("data-live");
    liveAssistant = undefined;
  }

  function addToolCard(
    element: HTMLElement,
    titleValue: string,
    input: unknown,
    options: { markdown?: boolean } = {},
  ): void {
    const details = doc.createElement("details");
    details.className = "tool-card";
    const summary = doc.createElement("summary");
    summary.textContent = titleValue;
    const body = doc.createElement(options.markdown ? "div" : "pre");
    if (options.markdown) {
      body.className = "tool-card-markdown markdown-body";
      markdownRenderer.renderBlock(
        body,
        typeof input === "string" ? input : "",
      );
    } else {
      body.textContent =
        typeof input === "string"
          ? input
          : JSON.stringify(input ?? {}, null, 2);
    }
    details.append(summary, body);
    element.append(details);
  }

  function rawMessageParts(value: unknown): {
    role?: "user" | "assistant";
    text: string;
    tools: Array<Record<string, unknown>>;
    thinking: Array<Record<string, unknown>>;
  } {
    const record = asRecord(value);
    const message = asRecord(record.message);
    const role =
      message.role === "user" || record.type === "user"
        ? "user"
        : message.role === "assistant" || record.type === "assistant"
          ? "assistant"
          : undefined;
    const content = message.content;
    if (typeof content === "string") {
      return { role, text: content, tools: [], thinking: [] };
    }
    if (!Array.isArray(content)) {
      return { role, text: "", tools: [], thinking: [] };
    }
    const blocks = content
      .filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null,
      );
    return {
      role,
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) =>
          typeof block.text === "string" ? block.text : "",
        )
        .filter(Boolean)
        .join("\n\n"),
      tools: blocks.filter(
        (block) =>
          block.type === "tool_use" ||
          block.type === "server_tool_use",
      ),
      thinking: blocks.filter(
        (block) =>
          block.type === "thinking" &&
          typeof block.thinking === "string",
      ),
    };
  }

  function messageOriginKind(...values: unknown[]): string | undefined {
    for (const value of values) {
      const record = asRecord(value);
      const origin = asRecord(record.origin);
      const kind =
        typeof origin.kind === "string"
          ? origin.kind
          : typeof record.originKind === "string"
            ? record.originKind
            : undefined;
      if (kind) {
        return kind;
      }
    }
    return undefined;
  }

  function stableLegacyMessageId(record: Record<string, unknown>): string {
    const message = asRecord(record.message);
    const explicit = webIdentifier(
      record.uuid,
      record.id,
      record.message_id,
      message.id,
    );
    return explicit || `legacy-${stableStringHash(record)}`;
  }

  function describeLegacyTool(
    tool: Record<string, unknown>,
  ): { title: string; detail?: string } {
    const name = typeof tool.name === "string" ? tool.name : "Tool";
    const input = asRecord(tool.input);
    const path = webIdentifier(
      input.file_path,
      input.path,
      input.notebook_path,
    );
    const description = webIdentifier(input.description);
    if (name === "Read" && path) {
      return { title: `Reading ${path}`, detail: "Repository file" };
    }
    if ((name === "Write" || name === "Edit") && path) {
      return {
        title: `${name === "Write" ? "Writing" : "Editing"} ${path}`,
        detail: "Workspace change",
      };
    }
    if (name === "Bash") {
      return {
        title: description || "Running a command",
        detail: description ? "Terminal command" : undefined,
      };
    }
    if (name === "Agent") {
      return {
        title: description || "Running a subagent",
        detail: "Claude Code subagent",
      };
    }
    return { title: `Running ${name}` };
  }

  function addLegacyToolActivity(
    tool: Record<string, unknown>,
    messageId: string,
    index: number,
    createdAt = clock.now(),
  ): void {
    const name = typeof tool.name === "string" ? tool.name : "Tool";
    const explicitId = webIdentifier(tool.id, tool.tool_use_id);
    const description = describeLegacyTool(tool);
    addActivity(
      {
        key: `tool-${explicitId || `${messageId}-${index}-${stableStringHash({ name, input: tool.input })}`}`,
        title: description.title,
        detail: description.detail,
        tone: "info",
        phase: `Running ${name}`,
        busy: true,
      },
      createdAt,
    );
  }

  function addSubagentActivity(
    parentToolUseId: string,
    text: string,
    options: {
      append?: boolean;
      busy?: boolean;
      createdAt?: number;
    } = {},
  ): void {
    const key = `agent-${parentToolUseId}`;
    const existing = activities.find((activity) => activity.key === key);
    addActivity(
      {
        key,
        title: "Subagent update",
        detail: options.append
          ? `${existing?.detail ?? ""}${text}`
          : text,
        tone: "info",
        phase: options.busy === false ? "Subagent complete" : "Running subagent",
        busy: options.busy !== false,
      },
      options.createdAt,
    );
  }

  function matchPendingUserMessage(text: string): boolean {
    for (const pending of [...pendingMessages.values()].reverse()) {
      if (pending.prompt === text) {
        setMessageDelivery(pending, "accepted");
        return true;
      }
    }
    return false;
  }

  function renderClaudeMessage(value: unknown): void {
    const record = asRecord(value);
    if (record.isMeta === true || record.isSynthetic === true) {
      return;
    }
    if (record.type === "stream_event") {
      const event = asRecord(record.event);
      const delta = asRecord(event.delta);
      if (
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        const parentToolUseId = webIdentifier(
          record.parent_tool_use_id,
          event.parent_tool_use_id,
        );
        if (parentToolUseId) {
          addSubagentActivity(parentToolUseId, delta.text, {
            append: true,
          });
          return;
        }
        appendAssistantDelta(delta.text);
        setPhase("Claude is responding", { busy: true });
      }
      return;
    }

    if (record.type === "result") {
      finishLiveAssistant();
      cancelButton.hidden = true;
      setPhase("Complete");
      notifyCompletionIfHidden();
      const activity = normalizeSdkActivity(record);
      if (activity) {
        addActivity(activity);
      }
      return;
    }

    if (record.type === "system") {
      updateCapabilities(record);
      const activity = normalizeSdkActivity(record);
      if (activity) {
        addActivity(activity);
        if (activity.phase) {
          setPhase(activity.phase, {
            busy: activity.busy,
            tone:
              activity.tone === "error"
                ? "error"
                : activity.tone === "warning"
                  ? "warning"
                  : "normal",
          });
        }
      }
      return;
    }

    const parts = rawMessageParts(value);
    if (!parts.role) {
      return;
    }
    if (parts.role === "user") {
      // Tool-result frames have a user role in the SDK but are not human
      // messages. They belong in Activity and must never create empty bubbles.
      const message = asRecord(record.message);
      const content = message.content;
      const toolResultFrame =
        typeof record.parent_tool_use_id === "string" ||
        Object.hasOwn(record, "tool_use_result") ||
        Object.hasOwn(record, "toolUseResult") ||
        (Array.isArray(content) &&
          content.some(
            (block) =>
              asRecord(block).type === "tool_result",
          ));
      if (Array.isArray(content)) {
        for (const blockValue of content) {
          const block = asRecord(blockValue);
          if (block.type !== "tool_result") {
            continue;
          }
          const toolUseId = webIdentifier(
            block.tool_use_id,
            record.parent_tool_use_id,
          );
          if (!toolUseId) {
            continue;
          }
          const key = `tool-${toolUseId}`;
          const existing = activities.find(
            (activity) => activity.key === key,
          );
          addActivity({
            key,
            title: existing?.title ?? "Tool completed",
            detail:
              block.is_error === true
                ? "The tool reported an error."
                : existing?.detail,
            tone: block.is_error === true ? "error" : "success",
            phase:
              block.is_error === true ? "Tool failed" : "Tool complete",
            busy: false,
          });
        }
      }
      if (
        toolResultFrame ||
        !parts.text ||
        parts.text.includes("Files attached from") ||
        isInternalClaudeConversationText(
          parts.text,
          messageOriginKind(record, record.message),
        )
      ) {
        return;
      }
      if (!matchPendingUserMessage(parts.text)) {
        const id = stableLegacyMessageId(record);
        if (
          !conversation.querySelector(
            `[data-message-id="${CSS.escape(id)}"]`,
          )
        ) {
          appendMessage("user", parts.text, {
            id,
            delivery: "accepted",
          });
        }
      }
      return;
    }

    flushLiveText();
    const messageId = stableLegacyMessageId(record);
    parts.tools.forEach((tool, index) =>
      addLegacyToolActivity(tool, messageId, index),
    );
    if (typeof record.parent_tool_use_id === "string") {
      if (parts.text) {
        addSubagentActivity(record.parent_tool_use_id, parts.text, {
          busy: true,
        });
      }
      return;
    }
    if (!parts.text && parts.thinking.length === 0) {
      return;
    }
    let element = liveAssistant ?? conversation.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!element) {
      element = appendMessage("assistant", parts.text, { id: messageId });
    } else if (parts.text) {
      element.dataset.messageId = messageId;
      const body = element.querySelector<HTMLElement>(".message-text");
      if (body) {
        setMessageMarkdown(body, parts.text);
      }
    }
    for (const thinking of parts.thinking) {
      addToolCard(element, "Thinking", thinking.thinking, {
        markdown: true,
      });
    }
    finishLiveAssistant();
    contentChanged();
  }

  function updateCapabilities(record: Record<string, unknown>): void {
    if (
      record.kind !== "session.capabilities" &&
      record.subtype !== "init" &&
      record.subtype !== "commands_changed"
    ) {
      return;
    }
    const candidates =
      Array.isArray(record.slash_commands)
        ? record.slash_commands
        : Array.isArray(record.commands)
          ? record.commands
          : Array.isArray(record.supported_commands)
            ? record.supported_commands
            : [];
    const parsed = candidates
      .map((candidate): SlashCommand | undefined => {
        if (typeof candidate === "string") {
          return {
            name: candidate.startsWith("/") ? candidate : `/${candidate}`,
          };
        }
        const item = asRecord(candidate);
        const name =
          typeof item.name === "string"
            ? item.name
            : typeof item.command === "string"
              ? item.command
              : undefined;
        return name
          ? {
              name: name.startsWith("/") ? name : `/${name}`,
              description:
                typeof item.description === "string"
                  ? item.description
                  : undefined,
            }
          : undefined;
      })
      .filter((value): value is SlashCommand => Boolean(value));
    if (parsed.length > 0) {
      slashCommands = parsed;
    }
    applyAuthoritativePermissionMode(record.permissionMode);
  }

  function applyAuthoritativePermissionMode(value: unknown): void {
    if (
      value !== "auto-safe" &&
      value !== "acceptEdits" &&
      value !== "default" &&
      value !== "plan"
    ) {
      return;
    }
    currentPermissionMode = value;
    permissionMode.value = value;
  }

  function addActivity(
    activity: ActivityPresentation,
    createdAt = clock.now(),
  ): void {
    const reconciled = reconcileActivityRecords(
      activities,
      activity,
      createdAt,
    );
    activities.splice(0, activities.length, ...reconciled.records);
    if (reconciled.inserted && !suppressActivityUnread) {
      activityUnread += 1;
    }
    renderActivities();
  }

  function renderActivities(): void {
    const renderInto = (
      target: HTMLOListElement,
      records: ActivityRecord[],
    ): void => {
      target.replaceChildren(
        ...records.map((activity) => {
          const item = doc.createElement("li");
          item.className = `activity-item activity-${activity.tone}`;
          const marker = doc.createElement("span");
          marker.className = "activity-marker";
          marker.setAttribute("aria-hidden", "true");
          const content = doc.createElement("div");
          const title = doc.createElement("strong");
          title.textContent = activity.title;
          content.append(title);
          if (activity.detail) {
            const detail = doc.createElement("p");
            detail.className = "markdown-inline";
            markdownRenderer.renderInline(detail, activity.detail);
            content.append(detail);
          }
          const time = doc.createElement("time");
          time.dateTime = new Date(activity.createdAt).toISOString();
          time.textContent = new Date(activity.createdAt).toLocaleTimeString(
            [],
            { hour: "2-digit", minute: "2-digit" },
          );
          item.append(marker, content, time);
          return item;
        }),
      );
    };
    renderInto(activityTimeline, activities.slice(-30));
    renderInto(activityTimelineFull, activities);
    activityCount.textContent = String(activityUnread);
    activityCount.hidden = activityUnread === 0;
  }

  function workAgeLabel(timestamp: number | undefined): string | undefined {
    if (timestamp === undefined) {
      return undefined;
    }
    const seconds = Math.max(
      0,
      Math.floor((clock.now() + serverClockOffsetMs - timestamp) / 1_000),
    );
    if (seconds < 60) {
      return `updated ${seconds}s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `updated ${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    return `updated ${hours}h ${minutes % 60}m ago`;
  }

  function renderWorkGraph(
    status: RemoteOperationalPresentation,
  ): void {
    const visibleWork = status.work.filter((item) => !item.terminal);
    const show = visibleWork.length > 0 || status.operation !== undefined;
    workGraph.hidden = !show;
    if (!show) {
      workGraphItems.replaceChildren();
      workGraphActions.hidden = true;
      return;
    }
    workGraphCount.textContent = String(visibleWork.length);
    workGraphSummary.textContent = status.detail ?? (
      visibleWork.length > 0
        ? "Work continues on your Mac even if this phone locks or disconnects."
        : "ModelHop is finishing the current remote operation."
    );

    const shown = visibleWork.slice(0, 5);
    const rows = shown.map((item) => renderWorkItem(item));
    if (visibleWork.length > shown.length) {
      const more = doc.createElement("li");
      more.className = "work-graph-item";
      more.textContent = `+${visibleWork.length - shown.length} more active work item${visibleWork.length - shown.length === 1 ? "" : "s"}`;
      rows.push(more);
    }
    workGraphItems.replaceChildren(...rows);

    const overdueHandback =
      status.operation?.kind === "handback" && status.operation.overdue;
    workGraphActions.hidden = !overdueHandback;
  }

  function renderWorkItem(item: RemoteWorkPresentation): HTMLLIElement {
    const row = doc.createElement("li");
    row.className = "work-graph-item";
    row.dataset.blocker = item.blocker ? "true" : "false";

    const head = doc.createElement("div");
    head.className = "work-graph-item-head";
    const title = doc.createElement("strong");
    title.textContent = item.title;
    const state = doc.createElement("span");
    state.className = "work-graph-state";
    state.textContent = ({
      active: "Running",
      running: "Running",
      settling: "Final record pending",
      "waiting-terminal-record": "Final record pending",
      "completion-unknown": "Completion unconfirmed",
    } as Record<string, string>)[item.phase] ?? readablePhase(item.phase);
    head.append(title, state);
    row.append(head);

    if (item.detail) {
      const detail = doc.createElement("p");
      markdownRenderer.renderInline(detail, item.detail);
      row.append(detail);
    }
    const metadata = [
      item.progressLabel,
      workAgeLabel(item.updatedAt),
      item.blocker && item.phase === "settling"
        ? "final record pending"
        : undefined,
    ].filter((value): value is string => Boolean(value));
    if (metadata.length > 0) {
      const meta = doc.createElement("p");
      meta.className = "work-graph-meta";
      meta.textContent = metadata.join(" · ");
      row.append(meta);
    }
    return row;
  }

  function renderOperationalStatus(): void {
    const statusLease = currentLease && currentRuntimeSnapshot !== undefined
      ? {
          ...currentLease,
          runtimeSnapshot: currentRuntimeSnapshot,
        } as RemoteSessionLease
      : currentLease;
    const status = deriveOperationalStatus({
      lease: statusLease,
      link: currentLinkAxis,
      now: clock.now() + serverClockOffsetMs,
      phaseHint: currentPhaseHint,
    });
    currentOperationalStatus = status;
    setPhase(status.headline, {
      busy: status.busy,
      tone:
        status.tone === "error"
          ? "error"
          : status.tone === "warning"
            ? "warning"
            : "normal",
    });
    renderWorkGraph(status);
    taskHeader.dataset.ownership = status.ownership;
    updateElapsed();
  }

  function setSessionEndedState(ended: boolean): void {
    if (terminalSessionEnded && !ended) {
      return;
    }
    if (ended) {
      terminalSessionEnded = true;
      clearPendingHandbackCommand();
      clearHandbackRecovery();
      const runtime = asRecord(currentRuntimeSnapshot);
      currentRuntimeSnapshot = { ...runtime, operation: undefined };
    }
    sessionEnded.hidden = !ended;
    app.dataset.sessionState = ended ? "ended" : "active";
    for (const region of [taskHeader, mainContent, bottomTabs]) {
      region.inert = ended;
      region.hidden = ended;
      if (ended) {
        region.setAttribute("aria-hidden", "true");
      } else {
        region.removeAttribute("aria-hidden");
      }
    }
    if (ended) {
      taskViewTabs.hidden = true;
      promptInput.disabled = true;
      sendButton.disabled = true;
      cancelButton.hidden = true;
      toastRegion.replaceChildren();
      chatMesh.setActive(false);
      for (const dialog of [routeDialog, usageDialog, attachmentDialog]) {
        if (dialog.open) {
          dialog.close();
        }
      }
      closeFileViewer();
      doc.title = "Conversation returned · ModelHop Remote";
    }
  }

  function updateLease(lease: RemoteSessionLease): void {
    // Stopped is terminal. A delayed journal page may still carry an older
    // handing-back state, but it must never reactivate the ended phone UI.
    if (terminalSessionEnded && lease.state !== "stopped") {
      return;
    }
    if (
      lease.operation?.kind === "provider-switch" &&
      (lease.operation.phase === "complete" ||
        lease.operation.phase === "failed")
    ) {
      providerSwitchTarget = undefined;
    }
    if (lease.operation?.kind === "handback") {
      clearPendingHandbackCommand();
    } else if (lease.operation === undefined) {
      const priorOperation = currentOperationalStatus?.operation;
      const runtime = asRecord(currentRuntimeSnapshot);
      if (runtime.operation !== undefined) {
        currentRuntimeSnapshot = { ...runtime, operation: undefined };
      }
      const embeddedRuntime = asRecord(
        asRecord(lease).runtimeSnapshot ?? asRecord(lease).runtime,
      );
      if (embeddedRuntime.operation !== undefined) {
        lease = {
          ...lease,
          runtimeSnapshot: {
            ...embeddedRuntime,
            operation: undefined,
          },
        } as RemoteSessionLease;
      }
      if (priorOperation?.kind === "handback") {
        currentPhaseHint = undefined;
      }
      if (lease.state !== "handing-back") {
        clearHandbackRecovery();
      }
    }
    // Phone and Mac wall clocks are not guaranteed to agree. A server
    // timestamp in the future would otherwise pin an active turn at 00:00.
    // Learn only a positive lead from the newest authoritative lease time;
    // stale idle leases must not make the client clock run backwards.
    const newestServerTimestamp = Math.max(
      lease.lastActivityAt,
      lease.turnCompletedAt ?? Number.NEGATIVE_INFINITY,
    );
    const observedLead = newestServerTimestamp - clock.now();
    if (Number.isFinite(observedLead) && observedLead > 1_000) {
      serverClockOffsetMs = Math.max(serverClockOffsetMs, observedLead);
    }
    currentLease = lease;
    applyAuthoritativePermissionMode(lease.permissionMode);
    updateElapsed();
    setSessionEndedState(lease.state === "stopped");
    taskTitle.textContent = lease.title || "Claude Code";
    required<HTMLElement>(doc, "session-title").textContent =
      lease.title || "Claude Code";
    required<HTMLElement>(doc, "workspace-name").textContent =
      lease.workspaceName;
    required<HTMLElement>(doc, "session-id").textContent =
      lease.activeSessionId ?? lease.sourceSessionId;

    const turnActive = [
      "running",
      "waiting-for-permission",
      "waiting-for-question",
    ].includes(lease.state);
    cancelButton.hidden = !turnActive;

    const extended = asRecord(lease);
    const transportStateValue =
      asRecord(extended.transport).state ?? extended.transportState;
    const transportState = typeof transportStateValue === "string"
      ? transportStateValue
      : "";
    if (transportState === "link-lost") {
      setConnection("link-lost");
    } else if (transportState === "reconnecting") {
      setConnection("reconnecting");
    } else if (transportState === "expired") {
      setConnection("expired");
    } else if (transportState === "revoked") {
      setConnection("revoked");
    } else if (lease.state === "paused-diverged") {
      setConnection("paused");
    } else if (lease.state === "error") {
      const normalizedError = lease.error?.toLowerCase() ?? "";
      setConnection(
        normalizedError.includes("expired")
          ? "expired"
          : normalizedError.includes("revoked")
            ? "revoked"
            : "error",
      );
    } else if (!["reconnecting", "link-lost"].includes(currentLinkAxis)) {
      setConnection("secure");
    }
    renderOperationalStatus();
    syncInputState();
    updateProvider(lease.provider);
  }

  function replaceEffortOptions(
    select: HTMLSelectElement,
    efforts: ReasoningEffortValue[],
    effectiveEffort: ReasoningEffortValue | undefined,
    emptyLabel = "Unavailable",
  ): void {
    const options = efforts.map((effort) => {
      const option = doc.createElement("option");
      option.value = effort;
      option.textContent = REASONING_EFFORT_LABELS[effort];
      return option;
    });
    if (options.length === 0) {
      const option = doc.createElement("option");
      option.value = "";
      option.textContent = emptyLabel;
      options.push(option);
    }
    const currentOptions = Array.from(select.options, (option) => ({
      value: option.value,
      label: option.textContent ?? "",
    }));
    const nextOptions = options.map((option) => ({
      value: option.value,
      label: option.textContent ?? "",
    }));
    if (
      currentOptions.length !== nextOptions.length ||
      currentOptions.some(
        (option, index) =>
          option.value !== nextOptions[index]?.value ||
          option.label !== nextOptions[index]?.label,
      )
    ) {
      select.replaceChildren(...options);
    }
    select.value =
      effectiveEffort && efforts.includes(effectiveEffort)
        ? effectiveEffort
        : efforts[0] ?? "";
  }

  function setUnavailableReason(
    element: HTMLElement,
    reason: string | undefined,
  ): void {
    element.hidden = !reason;
    element.textContent = reason ?? "";
  }

  function renderReasoningControls(): void {
    const provider = currentProvider;
    const state = providerReasoningState(provider);
    const isPrivateRoute =
      provider !== undefined && provider.provider !== "anthropic";
    const headerLabel = reasoningHeaderLabel(state, isPrivateRoute);
    const routeMutationPending =
      reasoningChangePending || modelChangePendingTarget !== undefined;
    const inputEnabled = acceptsInput() && !routeMutationPending;
    const capabilityLoading = !state.ready;
    const hasEffort = state.supportedEffortLevels.length > 0;
    const effort = state.effectiveEffort
      ? REASONING_EFFORT_LABELS[state.effectiveEffort]
      : undefined;
    const providerRequiresReasoning =
      isPrivateRoute &&
      hasEffort &&
      !state.supportedEffortLevels.includes("none");
    const pendingReason = reasoningChangePending
      ? "Applying the reasoning change to the active model…"
      : modelChangePendingTarget
        ? "Waiting for the new model to become active…"
        : !acceptsInput()
          ? "Controls are available again when the current route operation finishes."
          : undefined;
    const activeModelOption = provider
      ? matchingModelOption(currentModelOptions, provider.model)
      : undefined;
    const activeModelLabel = activeModelOption?.resolvedModel ??
      activeModelOption?.displayName ??
      provider?.model;

    reasoningSettingsModel.textContent = provider
      ? `${provider.label} · ${activeModelLabel}`
      : "Loading active model";
    thinkingToggleLabel.textContent = isPrivateRoute
      ? "Claude thinking"
      : "Thinking";
    effortLabel.textContent = isPrivateRoute
      ? "Provider reasoning effort"
      : "Claude reasoning effort";
    routeEffortLabel.textContent = effortLabel.textContent;

    reasoningStatePill.hidden = headerLabel === undefined;
    reasoningStatePill.textContent = headerLabel ?? "";
    reasoningStatePill.dataset.mode = isPrivateRoute ? "private" : "visible";
    reasoningStatePill.setAttribute(
      "aria-label",
      headerLabel
        ? `Reasoning: ${headerLabel}${isPrivateRoute ? "; provider reasoning may remain private" : ""}`
        : capabilityLoading
          ? "Reasoning capabilities are loading"
          : "Reasoning capability unavailable",
    );
    const routeText = provider
      ? `${provider.label} · ${activeModelLabel}`
      : "Loading provider…";
    compactRouteLabel.textContent = headerLabel
      ? `${routeText} · ${headerLabel}`
      : routeText;

    if (state.ultra.enabled) {
      routeReasoningTitle.textContent = "Ultra is active";
      routeReasoningDetail.textContent = state.thinkingSupported
        ? "Extra high effort with Claude thinking and Workflows"
        : "Extra high effort with Claude Workflows; provider reasoning remains private";
    } else if (capabilityLoading) {
      routeReasoningTitle.textContent = "Checking model capabilities…";
      routeReasoningDetail.textContent =
        "Waiting for Claude Code to report thinking, effort, and workflow support";
    } else if (isPrivateRoute && hasEffort && !state.thinkingEnabled) {
      routeReasoningTitle.textContent =
        `Provider reasoning${effort ? ` · ${effort} effort` : ""}`;
      routeReasoningDetail.textContent = state.thinkingSupported
        ? "Claude thinking is off; provider reasoning remains active"
        : "Provider reasoning remains active without Claude-visible thinking blocks";
    } else if (state.thinkingSupported) {
      routeReasoningTitle.textContent = state.thinkingEnabled
        ? `Thinking on${effort ? ` · ${effort} effort` : ""}`
        : isPrivateRoute
          ? "Claude thinking off"
          : "Thinking off";
      routeReasoningDetail.textContent = providerRequiresReasoning
        ? `Provider reasoning remains active${effort ? ` at ${effort.toLowerCase()} effort` : ""}`
        : isPrivateRoute
          ? "Reasoning may remain private to the provider"
          : "Matched to the active Claude model";
    } else {
      routeReasoningTitle.textContent = "Reasoning controls unavailable";
      routeReasoningDetail.textContent =
        state.thinkingUnavailableReason ??
        reasoningUnavailableCopy("thinking", provider);
    }

    reasoningSettingsCard.dataset.pending = String(routeMutationPending);
    reasoningSettingsStatus.dataset.state = capabilityLoading
      ? "checking"
      : state.thinkingSupported
      ? state.thinkingEnabled
        ? "active"
        : "limited"
      : hasEffort
        ? "active"
        : "limited";
    reasoningSettingsStatus.textContent = capabilityLoading
      ? "Checking…"
      : state.ultra.enabled
      ? "Ultra"
      : state.thinkingSupported
        ? state.thinkingEnabled
          ? "Thinking on"
          : providerRequiresReasoning
            ? "Claude thinking off"
            : "Thinking off"
        : hasEffort && effort
          ? `${effort} effort`
          : "Unavailable";
    reasoningSettingsDescription.textContent = capabilityLoading
      ? "Waiting for Claude Code to report the active model's reasoning and workflow capabilities."
      : provider?.provider === "openai-codex"
        ? "These are Claude-harness controls. Provider reasoning may stay private, and Codex-native orchestration remains a separate isolated capability."
        : isPrivateRoute
          ? "This route can use provider reasoning without exposing private reasoning text as Claude thinking blocks."
          : "Thinking blocks and effort are controlled by the capabilities reported for the active Claude model.";
    thinkingHelp.textContent = capabilityLoading
      ? "Checking whether this model can expose Claude-compatible thinking blocks."
      : providerRequiresReasoning
      ? "Controls Claude-compatible thinking blocks. Turning it off does not disable the model's required private reasoning."
      : isPrivateRoute
        ? "Let the model reason before it responds. Private reasoning may not appear as a Claude thinking block."
        : "Let Claude reason before it responds and show compatible thinking blocks.";

    thinkingToggle.checked = state.thinkingEnabled;
    thinkingToggle.disabled =
      capabilityLoading || !inputEnabled || !state.thinkingSupported;
    setUnavailableReason(
      thinkingUnavailableReason,
      capabilityLoading
        ? "Waiting for Claude Code to report thinking support."
        : pendingReason
          ? pendingReason
          : state.thinkingSupported
            ? undefined
            : hasEffort && effort
              ? `${state.thinkingUnavailableReason ?? "Claude-style thinking blocks are unavailable."} Provider reasoning remains active at ${effort.toLowerCase()} effort.`
              : state.thinkingUnavailableReason ??
                  reasoningUnavailableCopy("thinking", provider),
    );

    replaceEffortOptions(
      effortSelect,
      state.supportedEffortLevels,
      state.effectiveEffort,
      capabilityLoading ? "Checking…" : "Unavailable",
    );
    replaceEffortOptions(
      settingsEffortSelect,
      state.supportedEffortLevels,
      state.effectiveEffort,
      capabilityLoading ? "Checking…" : "Unavailable",
    );
    const effortDisabled =
      capabilityLoading ||
      !inputEnabled ||
      !hasEffort ||
      state.ultra.enabled;
    effortSelect.disabled = effortDisabled;
    settingsEffortSelect.disabled = effortDisabled;
    const effortTitle = capabilityLoading
      ? "Waiting for the active model's effort catalog."
      : pendingReason
        ? pendingReason
        : state.ultra.enabled
          ? "Ultra sets Extra high effort automatically."
          : !hasEffort
            ? "The active model did not report any compatible effort levels."
            : "";
    effortSelect.title = effortTitle;
    settingsEffortSelect.title = effortTitle;
    routeEffortHelp.textContent = effortTitle ||
      (isPrivateRoute
        ? "This controls provider reasoning even when Claude thinking is unavailable."
        : "Only effort levels supported by the active Claude model are shown.");
    setUnavailableReason(
      effortUnavailableReason,
      effortDisabled ? effortTitle : undefined,
    );

    workflowsToggle.checked = state.workflows.enabled;
    workflowsToggle.disabled =
      capabilityLoading || !inputEnabled || !state.workflows.available;
    setUnavailableReason(
      workflowsUnavailableReason,
      capabilityLoading
        ? "Waiting for Claude Code to report Workflow support."
        : pendingReason
          ? pendingReason
          : state.workflows.available
            ? undefined
            : state.workflows.unavailableReason ??
                reasoningUnavailableCopy("workflows", provider),
    );

    const ultraCanActivate = canActivateUltra(state);
    ultraToggle.checked = state.ultra.enabled;
    ultraToggle.disabled =
      capabilityLoading || !inputEnabled || !ultraCanActivate;
    setUnavailableReason(
      ultraUnavailableReason,
      capabilityLoading
        ? "Waiting for Claude Code to report Ultra eligibility."
        : pendingReason
          ? pendingReason
          : ultraCanActivate
            ? undefined
            : state.ultra.unavailableReason ??
                reasoningUnavailableCopy("ultra", provider),
    );
  }

  function requestReasoningChange(
    patch: Omit<ReasoningChangeCommand, "id" | "type">,
    successMessage: string,
  ): void {
    if (
      !currentProvider ||
      reasoningChangePending ||
      modelChangePendingTarget !== undefined
    ) {
      renderReasoningControls();
      return;
    }
    const commandId = crypto.randomUUID();
    reasoningChangePending = true;
    reasoningChangeRequestId = commandId;
    reasoningChangeStatus.textContent = "Applying to the active model…";
    reasoningChangeStatus.dataset.state = "pending";
    renderReasoningControls();
    const command: ReasoningChangeCommand = {
      id: commandId,
      type: "reasoning.change",
      ...patch,
    };
    void transport
      .send<{ provider?: RemoteProviderContext }>(
        command as unknown as RemoteWebCommand,
      )
      .then((result) => {
        if (reasoningChangeRequestId !== commandId) {
          return;
        }
        if (result.provider) {
          updateProvider(result.provider);
        }
        reasoningChangePending = false;
        reasoningChangeRequestId = undefined;
        reasoningChangeStatus.textContent = "Reasoning settings updated.";
        reasoningChangeStatus.dataset.state = "success";
        renderReasoningControls();
        syncInputState();
        toast(successMessage);
      })
      .catch((error: unknown) => {
        if (reasoningChangeRequestId !== commandId) {
          return;
        }
        reasoningChangePending = false;
        reasoningChangeRequestId = undefined;
        reasoningChangeStatus.textContent =
          "The active model kept its previous reasoning settings.";
        reasoningChangeStatus.dataset.state = "error";
        renderReasoningControls();
        syncInputState();
        showError(error);
      });
  }

  function updateProvider(provider: RemoteProviderContext): void {
    const providerUsageSnapshot = usageSnapshots.get(provider.provider);
    currentUsageSnapshot =
      providerUsageSnapshot &&
      providerUsageSnapshot.updatedAt >= provider.updatedAt
        ? providerUsageSnapshot
        : undefined;
    currentProvider =
      currentUsageSnapshot?.allowance === undefined
        ? provider
        : { ...provider, usage: currentUsageSnapshot.allowance };
    if (providerSwitchTarget === provider.provider) {
      providerSwitchTarget = undefined;
      setConnection("secure");
      setPhase("Provider switched");
    }
    providerSelect.value = provider.provider;
    const catalogModels = provider.modelCatalog?.options ?? [];
    const fallbackModels: RemoteModelOption[] = [
      provider.model,
      provider.roleModels.default,
      provider.roleModels.opus,
      provider.roleModels.sonnet,
      provider.roleModels.haiku,
      provider.roleModels.subagent,
    ]
      .filter(
        (value, index, all) =>
          Boolean(value) && all.indexOf(value) === index,
      )
      .map((selector) => ({
        selector,
        displayName: selector,
        source: "merged" as const,
      }));
    const models: RemoteModelOption[] = catalogModels.length > 0
      ? catalogModels
      : fallbackModels;
    currentModelOptions = models;
    modelSelect.replaceChildren(
      ...models.map((model) => {
        const option = doc.createElement("option");
        option.value = model.selector;
        option.textContent =
          model.resolvedModel &&
          model.resolvedModel !== model.displayName
            ? `${model.displayName} · ${model.resolvedModel}`
            : model.displayName;
        return option;
      }),
    );
    const activeModel = matchingModelOption(models, provider.model);
    const activeSelector = activeModel?.selector ?? provider.model;
    const pendingModel = modelChangePendingTarget
      ? matchingModelOption(models, modelChangePendingTarget)
      : undefined;
    const pendingWasConfirmed = modelChangePendingTarget !== undefined &&
      (activeSelector === modelChangePendingTarget ||
        (pendingModel !== undefined &&
          (activeModel?.selector === pendingModel.selector ||
            modelOptionRepresents(pendingModel, provider.model))));
    if (pendingWasConfirmed) {
      confirmedModelSelector = activeSelector;
      modelChangePendingTarget = undefined;
      modelChangePreviousSelector = undefined;
      modelChangeStatus.textContent = "Active model updated.";
      modelChangeStatus.dataset.state = "success";
    } else if (!modelChangePendingTarget) {
      confirmedModelSelector = activeSelector;
    }
    if (!activeModel && !modelChangePendingTarget) {
      const unavailable = doc.createElement("option");
      unavailable.value = provider.model;
      unavailable.textContent = `${provider.model} · unavailable — choose another model`;
      unavailable.disabled = true;
      modelSelect.prepend(unavailable);
    }
    modelSelect.value = modelChangePendingTarget ?? activeSelector;
    const presentedModel = matchingModelOption(models, modelSelect.value);
    if (!provider.reasoning) {
      modelCapabilitySummary.textContent =
        "Loading current model capabilities…";
      if (!modelChangePendingTarget) {
        modelChangeStatus.textContent =
          "Loading current models and capabilities…";
        modelChangeStatus.dataset.state = "pending";
      }
    } else if (presentedModel) {
      const capabilityParts: string[] = [];
      const canonicalModel =
        presentedModel.resolvedModel ?? presentedModel.displayName;
      if (canonicalModel !== presentedModel.displayName) {
        capabilityParts.push(canonicalModel);
      }
      const efforts = presentedModel.supportedEffortLevels?.filter(
        isReasoningEffort,
      );
      if (efforts && efforts.length > 0) {
        capabilityParts.push(
          `Effort: ${efforts.map((value) => REASONING_EFFORT_LABELS[value]).join(", ")}`,
        );
      } else if (presentedModel.supportsEffort === false) {
        capabilityParts.push("Fixed provider reasoning");
      }
      if (presentedModel.supportsAdaptiveThinking === true) {
        capabilityParts.push("Claude thinking supported");
      } else if (presentedModel.supportsAdaptiveThinking === false) {
        capabilityParts.push("No Claude-visible thinking blocks");
      }
      if (presentedModel.contextWindow) {
        capabilityParts.push(
          `${new Intl.NumberFormat("en", { notation: "compact" }).format(presentedModel.contextWindow)} context`,
        );
      }
      modelCapabilitySummary.textContent = capabilityParts.length > 0
        ? capabilityParts.join(" · ")
        : "Capability details were not reported for this model.";
    } else {
      modelCapabilitySummary.textContent =
        "This configured model is no longer available. Choose another model.";
    }
    if (
      provider.reasoning &&
      !modelChangePendingTarget &&
      modelChangeStatus.textContent ===
        "Loading current models and capabilities…"
    ) {
      modelChangeStatus.textContent = "";
      delete modelChangeStatus.dataset.state;
    }
    const routeModel =
      activeModel?.resolvedModel ??
      activeModel?.displayName ??
      provider.model;
    const routeText = `${provider.label} · ${routeModel}`;
    routeLabel.textContent = routeText;
    renderReasoningControls();
    renderUsageSummary();
    renderUsageDetail();
    syncInputState();
  }

  function snapshotUsageSummary(
    snapshot: RemoteUsageSnapshot | undefined,
  ): string | undefined {
    if (!snapshot) {
      return undefined;
    }
    const sessionSummary =
      snapshot.session &&
      (snapshot.session.totalTokens > 0 ||
        (snapshot.session.requests ?? 0) > 0)
        ? `${new Intl.NumberFormat().format(snapshot.session.totalTokens)} tok${snapshot.session.requests === undefined ? "" : ` · ${snapshot.session.requests} req`}`
        : undefined;
    const contextSummary =
      snapshot.context && snapshot.context.maxTokens > 0
        ? `${snapshot.context.percentage.toFixed(1)}% context`
        : undefined;
    const observed = [sessionSummary, contextSummary].filter(
      (value): value is string => Boolean(value),
    );
    return observed.length > 0 ? observed.join(" · ") : undefined;
  }

  function renderUsageSummary(): void {
    const allowanceSummary = formatProviderUsage(currentProvider);
    const snapshot = currentUsageSnapshot;
    const observedSummary = snapshotUsageSummary(snapshot);
    let summary = allowanceSummary;
    if (currentProvider?.provider === "anthropic") {
      summary = observedSummary ?? allowanceSummary;
    } else if (snapshot?.status === "updating") {
      summary = observedSummary ?? "Updating…";
    } else if (snapshot?.status === "unavailable") {
      summary = observedSummary ?? "Usage unavailable";
    } else if (
      allowanceSummary.startsWith("Waiting") ||
      allowanceSummary === "Usage unavailable"
    ) {
      summary = observedSummary ?? allowanceSummary;
    }
    usageValue.textContent = summary;
    usageLabel.textContent = summary;
  }

  function renderUsageDetail(): void {
    const rows = providerUsageDetails(currentProvider);
    const snapshot = currentUsageSnapshot;
    if (snapshot?.session) {
      rows.push(
        `This session: ${new Intl.NumberFormat().format(snapshot.session.totalTokens)} tokens`,
        snapshot.session.requests === undefined
          ? `Input ${new Intl.NumberFormat().format(snapshot.session.inputTokens)} · output ${new Intl.NumberFormat().format(snapshot.session.outputTokens)}`
          : `Input ${new Intl.NumberFormat().format(snapshot.session.inputTokens)} · output ${new Intl.NumberFormat().format(snapshot.session.outputTokens)} · ${snapshot.session.requests} requests`,
      );
    }
    if (snapshot?.context) {
      rows.push(
        `Context: ${snapshot.context.percentage.toFixed(1)}% · ${new Intl.NumberFormat().format(snapshot.context.usedTokens)} / ${new Intl.NumberFormat().format(snapshot.context.maxTokens)} tokens`,
      );
    }
    if (snapshot?.status === "updating") {
      rows.push("Provider allowance is updating…");
    } else if (snapshot?.status === "unavailable" && snapshot.error) {
      rows.push(`Provider allowance unavailable: ${snapshot.error}`);
    }
    usageDetail.textContent = rows.join("\n");
    const credit = availableCodexResetCredit();
    codexReset.hidden = !credit || credit.count < 1;
  }

  function applyUsageSnapshot(snapshot: RemoteUsageSnapshot): void {
    const previous = usageSnapshots.get(snapshot.provider);
    if (
      (previous && snapshot.updatedAt < previous.updatedAt) ||
      (currentProvider?.provider === snapshot.provider &&
        snapshot.updatedAt < currentProvider.updatedAt)
    ) {
      return;
    }
    const merged = mergeUsageSnapshots(previous, snapshot);
    usageSnapshots.set(snapshot.provider, merged);
    if (
      !shouldPresentUsageSnapshot(
        currentProvider?.provider,
        previous,
        snapshot,
      )
    ) {
      return;
    }
    currentUsageSnapshot = merged;
    if (currentProvider && snapshot.allowance !== undefined) {
      // Usage can enrich the active route but it is never authoritative for
      // provider/model identity or the provider context revision.
      currentProvider = {
        ...currentProvider,
        usage: snapshot.allowance,
      };
    }
    renderUsageSummary();
    renderUsageDetail();
  }

  function availableCodexResetCredit():
    | { id?: string; count: number }
    | undefined {
    if (currentProvider?.provider !== "openai-codex") {
      return undefined;
    }
    const limits = asRecord(
      asRecord(currentProvider.usage).codex,
    );
    const credits = asRecord(
      asRecord(limits.rateLimits).rateLimitResetCredits,
    );
    const rows = Array.isArray(credits.credits)
      ? credits.credits.map(asRecord)
      : [];
    const available = rows.find(
      (credit) => credit.status === "available",
    );
    return {
      count:
        typeof credits.availableCount === "number"
          ? credits.availableCount
          : 0,
      id:
        typeof available?.id === "string"
          ? available.id
          : undefined,
    };
  }

  function renderEvent(
    event: RemoteJournalEvent,
    options: { presentTransient: boolean },
  ): void {
    const type = String(event.type);
    switch (type) {
      case "session.state":
        updateLease(event.payload as RemoteSessionLease);
        break;
      case "provider.context":
        updateProvider(event.payload as RemoteProviderContext);
        break;
      case "usage.snapshot":
        applyUsageSnapshot(event.payload as RemoteUsageSnapshot);
        break;
      case "claude.message":
        renderClaudeMessage(event.payload);
        break;
      case "conversation.item":
        renderConversationItem(event.payload);
        break;
      case "activity.event": {
        const payload = asRecord(event.payload);
        const phase =
          typeof payload.phase === "string"
            ? payload.phase
            : undefined;
        const busy = phase
          ? [
              "queued",
              "counting",
              "compacting",
              "requesting",
              "streaming",
              "running-tool",
              "running-task",
              "switching-provider",
              "handing-back",
            ].includes(phase)
          : false;
        const category =
          typeof payload.category === "string"
            ? payload.category
            : "information";
        addActivity(
          {
            key:
              typeof payload.id === "string"
                ? payload.id
                : `activity-${event.id}`,
            title:
              typeof payload.title === "string"
                ? payload.title
                : "Task update",
            detail:
              typeof payload.detail === "string"
                ? payload.detail
                : undefined,
            tone:
              category === "error" || phase === "failed"
                ? "error"
                : category === "retry" ||
                    category === "permission" ||
                    category === "question"
                  ? "warning"
                  : phase === "complete"
                    ? "success"
                    : "info",
            phase: phase ? readablePhase(phase) : undefined,
            busy,
          },
          event.createdAt,
        );
        if (phase) {
          currentPhaseHint = phase;
          renderOperationalStatus();
        }
        break;
      }
      case "session.capabilities":
        updateCapabilities(asRecord(event.payload));
        break;
      case "permission.request":
        queuePermission(event.payload as PendingPermission);
        break;
      case "permission.resolved":
        removePermission(
          webIdentifier(asRecord(event.payload).requestId),
        );
        break;
      case "question.request":
        queueQuestion(event.payload as PendingQuestion);
        break;
      case "question.resolved":
        removeQuestion(
          webIdentifier(asRecord(event.payload).requestId),
        );
        break;
      case "notification": {
        const payload = asRecord(event.payload);
        const message = payload.message;
        if (payload.terminal === true || payload.ended === true) {
          setSessionEndedState(true);
        }
        if (
          options.presentTransient &&
          typeof message === "string"
        ) {
          toast(message);
        }
        break;
      }
      case "error": {
        const message = asRecord(event.payload).message;
        const text =
          typeof message === "string"
            ? message
            : "Remote session error.";
        if (options.presentTransient) {
          showError(text);
        }
        appendRetryMessage(text);
        addActivity({
          key: `error-${event.id}`,
          title: "Remote operation failed",
          detail: text,
          tone: "error",
          phase: "Remote error",
        });
        break;
      }
      case "host.action":
      case "host.action.state": {
        const payload = asRecord(event.payload);
        const state =
          typeof payload.state === "string"
            ? payload.state
            : "waiting";
        addActivity({
          key: `host-${webIdentifier(payload.id, event.id)}`,
          title:
            state === "waiting"
              ? "Waiting for ModelHop on your Mac"
              : `Desktop action ${state}`,
          detail:
            typeof payload.message === "string"
              ? payload.message
              : undefined,
          tone: state === "failed" ? "error" : "info",
          phase: state === "waiting" ? "Waiting for laptop" : undefined,
          busy: state === "waiting",
        });
        break;
      }
      case "operation.state":
      case "handoff.state": {
        const payload = asRecord(event.payload);
        const nestedOperation = asRecord(payload.operation);
        const operation =
          Object.keys(nestedOperation).length > 0
            ? nestedOperation
            : payload;
        const operationKind =
          typeof operation.kind === "string"
            ? operation.kind
            : type === "handoff.state"
              ? "handback"
              : "provider-switch";
        const isHandback = operationKind === "handback";
        if (isHandback && operation.phase !== "failed") {
          clearPendingHandbackCommand();
        }
        const phase =
          typeof operation.phase === "string"
            ? operation.phase
            : typeof payload.phase === "string"
              ? payload.phase
              : "working";
        const failed = phase === "failed";
        const detail =
          typeof operation.error === "string"
            ? operation.error
            : typeof operation.lastError === "string"
              ? operation.lastError
              : typeof payload.error === "string"
                ? payload.error
                : typeof payload.lastError === "string"
                  ? payload.lastError
                  : undefined;
        addActivity({
          key: `operation-${webIdentifier(payload.id, operation.id, event.id)}`,
          title:
            isHandback
              ? `Hand-back: ${readablePhase(phase)}`
              : `Provider switch: ${readablePhase(phase)}`,
          detail,
          tone: failed ? "error" : phase === "complete" ? "success" : "info",
          phase: readablePhase(phase),
          busy: !failed && phase !== "complete",
        });
        currentRuntimeSnapshot = {
          ...asRecord(currentRuntimeSnapshot),
          operation: {
            ...operation,
            id: webIdentifier(payload.id, operation.id),
            kind: operationKind,
            phase,
            updatedAt:
              typeof operation.updatedAt === "number"
                ? operation.updatedAt
                : event.createdAt,
          },
        };
        renderOperationalStatus();
        if (isHandback) {
          if (failed) {
            showHandbackRecovery(
              detail ?? "Claude Code has not reopened the session yet.",
            );
          } else if (phase === "complete") {
            clearHandbackRecovery();
          }
        }
        break;
      }
      case "runtime.snapshot": {
        applyRuntimeSnapshot(event.payload);
        break;
      }
      case "work.state": {
        const payload = asRecord(event.payload);
        const runtime = asRecord(currentRuntimeSnapshot);
        const existing = operationalWorkItems(runtime.workItems);
        const incoming = operationalWorkItems(
          payload.workItem ?? payload.item ?? event.payload,
        );
        const byId = new Map(existing.map((item) => [item.id, item]));
        for (const item of incoming) {
          byId.set(item.id, item);
        }
        currentRuntimeSnapshot = {
          ...runtime,
          workItems: [...byId.values()],
        };
        renderOperationalStatus();
        break;
      }
      case "command.receipt": {
        const payload = asRecord(event.payload);
        const commandId = webIdentifier(
          payload.commandId,
          payload.requestId,
          payload.id,
        );
        const stateValue = payload.state ?? payload.status;
        const state = typeof stateValue === "string" ? stateValue : "";
        const pending = pendingMessages.get(commandId);
        if (pending) {
          if (state === "completed" || state === "accepted" || state === "executing") {
            setMessageDelivery(pending, "accepted");
          } else if (state === "failed") {
            setMessageDelivery(pending, "failed");
          } else if (state === "delivery-unknown" || state === "checking") {
            setMessageDelivery(pending, "checking");
          }
        }
        if (state === "delivery-unknown" || state === "checking") {
          currentPhaseHint = "delivery-unknown";
          setPhase("Checking Mac", { busy: true, tone: "warning" });
        }
        if (pendingHandbackCommand?.id === commandId) {
          if (state === "completed") {
            clearPendingHandbackCommand(commandId);
          } else if (state === "failed") {
            clearPendingHandbackCommand(commandId);
            handbackButton.disabled = false;
            cancelHandbackButton.disabled = false;
            const error =
              typeof payload.error === "string"
                ? payload.error
                : "The Mac rejected the hand-back request.";
            showError(error);
          } else {
            showCheckingMac(false);
          }
        }
        break;
      }
      case "journal.gap": {
        setConnection("reconnecting", "Restoring history");
        addActivity({
          key: `journal-gap-${event.id}`,
          title: "Restoring the encrypted journal",
          detail: "ModelHop detected a history gap and requested an authoritative Mac snapshot before continuing.",
          tone: "warning",
          phase: "Reconnecting",
          busy: true,
        });
        break;
      }
    }
  }

  function renderJournalEvent(
    event: RemoteJournalEvent,
    options: {
      presentTransient: boolean;
      markActivityUnread: boolean;
    },
  ): void {
    const previousSuppression = suppressActivityUnread;
    suppressActivityUnread = !options.markActivityUnread;
    try {
      renderEvent(event, {
        presentTransient: options.presentTransient,
      });
    } finally {
      suppressActivityUnread = previousSuppression;
    }
  }

  function applyEvent(event: RemoteJournalEvent): void {
    const ordered = orderedUnseenEvents(
      [event],
      lastAppliedEventId,
    );
    for (const nextEvent of ordered) {
      renderJournalEvent(nextEvent, {
        presentTransient: true,
        markActivityUnread: true,
      });
      lastAppliedEventId = nextEvent.id;
    }
  }

  function renderConversationItem(value: unknown): void {
    const wrapper = asRecord(value);
    const normalized =
      wrapper.kind === "conversation.item" &&
      typeof wrapper.operation === "string"
        ? (value as RemoteConversationEvent)
        : undefined;
    const item = normalized
      ? asRecord(normalized.item)
      : wrapper;
    const id =
      typeof item.id === "string" ? item.id : undefined;
    if (normalized?.operation === "remove") {
      if (id) {
        conversation
          .querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(id)}"]`,
          )
          ?.remove();
      }
      return;
    }
    const role =
      item.role === "user" || item.role === "assistant"
        ? item.role
        : undefined;
    if (!role) {
      return;
    }

    const parentToolUseId = webIdentifier(
      item.parentToolUseId,
      item.parent_tool_use_id,
    );
    const itemCreatedAt =
      typeof item.createdAt === "number" ? item.createdAt : clock.now();

    if (normalized?.operation === "delta" && normalized.delta) {
      if (!id) {
        return;
      }
      if (normalized.delta.kind === "input-json") {
        addActivity(
          {
            key: `tool-input-${parentToolUseId || id}-${normalized.delta.contentBlockIndex ?? 0}`,
            title: "Preparing tool input",
            detail: "Claude is preparing the next workspace operation.",
            tone: "info",
            phase: "Preparing tool",
            busy: true,
          },
          itemCreatedAt,
        );
        return;
      }
      if (parentToolUseId && normalized.delta.kind === "text") {
        addSubagentActivity(parentToolUseId, normalized.delta.text, {
          append: true,
          createdAt: itemCreatedAt,
        });
        return;
      }
      let element = conversation.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(id)}"]`,
      );
      if (!element) {
        element = appendMessage("assistant", "", { id });
        element.dataset.live = "true";
      }
      if (normalized.delta.kind === "text") {
        const body = element.querySelector<HTMLElement>(".message-text");
        if (body) {
          appendMessageMarkdown(body, normalized.delta.text);
        }
      } else {
        const selector = `[data-delta-kind="${normalized.delta.kind}"][data-block-index="${normalized.delta.contentBlockIndex ?? 0}"]`;
        let details = element.querySelector<HTMLDetailsElement>(selector);
        if (!details) {
          details = doc.createElement("details");
          details.className = "tool-card";
          details.dataset.deltaKind = normalized.delta.kind;
          details.dataset.blockIndex = String(
            normalized.delta.contentBlockIndex ?? 0,
          );
          const summary = doc.createElement("summary");
          summary.textContent =
            normalized.delta.kind === "thinking"
              ? "Thinking"
              : "Preparing tool input";
          const pre = doc.createElement("pre");
          details.append(summary, pre);
          element.append(details);
        }
        const pre = details.querySelector("pre");
        if (pre) {
          pre.textContent += normalized.delta.text;
        }
      }
      contentChanged();
      return;
    }

    const parts = conversationContent(item.content ?? item.text);
    const text = parts.text;
    const toolBlocks = parts.blocks.filter(
      (block) =>
        block.type === "tool_use" ||
        block.type === "server_tool_use",
    );
    toolBlocks.forEach((tool, index) =>
      addLegacyToolActivity(tool, id ?? "conversation", index, itemCreatedAt),
    );
    const visibleBlocks = parts.blocks.filter(
      (block) => block.type === "thinking",
    );
    if (
      role === "user" &&
      isInternalClaudeConversationText(
        text,
        messageOriginKind(item, wrapper),
      )
    ) {
      return;
    }
    if (parentToolUseId) {
      if (text) {
        addSubagentActivity(parentToolUseId, text, {
          busy: item.status !== "complete" && item.status !== "failed",
          createdAt: itemCreatedAt,
        });
      }
      return;
    }
    const existing = id
      ? conversation.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(id)}"]`,
        )
      : undefined;
    if (existing) {
      if (!text && visibleBlocks.length === 0) {
        existing.remove();
        return;
      }
      const body = existing.querySelector<HTMLElement>(".message-text");
      if (body) {
        setMessageMarkdown(body, text);
      }
      existing.dataset.delivery =
        typeof item.status === "string" ? item.status : "accepted";
      existing.removeAttribute("data-live");
      existing
        .querySelectorAll<HTMLElement>(".tool-card")
        .forEach((card) => card.remove());
      appendStructuredBlocks(existing, visibleBlocks);
      contentChanged();
      return;
    }
    if (role === "user" && matchPendingUserMessage(text)) {
      return;
    }
    if (!text && visibleBlocks.length === 0) {
      return;
    }
    const element = appendMessage(role, text, {
      id,
      createdAt:
        typeof item.createdAt === "number" ? item.createdAt : undefined,
      delivery:
        role === "user"
          ? item.status === "failed"
            ? "failed"
            : item.status === "queued"
              ? "queued"
              : "accepted"
          : undefined,
    });
    appendStructuredBlocks(element, visibleBlocks);
  }

  function conversationContent(value: unknown): {
    text: string;
    blocks: Array<Record<string, unknown>>;
  } {
    if (typeof value === "string") {
      return { text: value, blocks: [] };
    }
    if (!Array.isArray(value)) {
      return { text: "", blocks: [] };
    }
    const blocks = value.filter(
      (block): block is Record<string, unknown> =>
        typeof block === "object" && block !== null,
    );
    return {
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) =>
          typeof block.text === "string" ? block.text : "",
        )
        .filter(Boolean)
        .join("\n\n"),
      blocks,
    };
  }

  function appendStructuredBlocks(
    element: HTMLElement,
    blocks: Array<Record<string, unknown>>,
  ): void {
    for (const block of blocks) {
      if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        addToolCard(element, "Thinking", block.thinking, {
          markdown: true,
        });
      }
    }
  }

  function readablePhase(value: string): string {
    const text = value.replaceAll("_", " ").replaceAll("-", " ");
    return text[0]?.toUpperCase() + text.slice(1);
  }

  function applyRuntimeSnapshot(snapshot: unknown): void {
    currentRuntimeSnapshot = snapshot;
    const runtime = asRecord(snapshot);
    const routeProvider = asRecord(runtime.route).provider;
    if (routeProvider) {
      updateProvider(routeProvider as RemoteProviderContext);
    } else if (runtime.provider) {
      updateProvider(runtime.provider as RemoteProviderContext);
    }
    if (runtime.lease) {
      updateLease(runtime.lease as RemoteSessionLease);
    }
    const transportState = asRecord(runtime.transport).state;
    if (transportState === "connected") {
      setConnection("secure");
    } else if (transportState === "recovering") {
      setConnection("reconnecting");
    } else if (transportState === "link-lost") {
      setConnection("link-lost");
    }
    renderOperationalStatus();
  }

  function applyBatch(batch: RemoteEventBatch): void {
    const batchEpoch = batch.epoch ?? batch.journalEpoch;
    const batchSnapshot = batch.snapshot ?? batch.runtimeSnapshot;
    const epochChanged =
      batchEpoch !== undefined &&
      currentJournalEpoch !== undefined &&
      batchEpoch !== currentJournalEpoch;
    if (batchEpoch !== undefined) {
      currentJournalEpoch = batchEpoch;
    }
    if (epochChanged) {
      lastAppliedEventId = batch.snapshotCursor ?? Math.max(
        0,
        (batch.earliestEventId ?? 1) - 1,
      );
    }
    if (batch.gap) {
      setConnection("reconnecting", "Restoring history");
      if (batchSnapshot !== undefined) {
        applyRuntimeSnapshot(batchSnapshot);
        // A gap snapshot already includes journal state through this cursor.
        // Advance before applying deltas so reconstructed actions/messages are
        // never rendered or executed a second time.
        lastAppliedEventId = Math.max(
          lastAppliedEventId,
          batch.snapshotCursor ?? 0,
        );
      } else {
        addActivity({
          key: `journal-gap-${batchEpoch ?? "unknown"}`,
          title: "Waiting for the Mac snapshot",
          detail: "New remote commands remain locked until the encrypted journal is complete.",
          tone: "warning",
          phase: "Restoring history",
          busy: true,
        });
      }
    } else if (batchSnapshot !== undefined) {
      applyRuntimeSnapshot(batchSnapshot);
    }
    const initialReplay = !receivedInitialEventBatch;
    for (const event of orderedUnseenEvents(
      batch.events,
      lastAppliedEventId,
    )) {
      // Reconstruct durable conversation/activity state on first load without
      // replaying historical toast side effects. A later retry can replay an
      // acknowledged event ID, which is filtered by the cursor above.
      const presentTransient =
        batch.replayThroughEventId === undefined
          ? !initialReplay && event.createdAt >= clock.now() - 10_000
          : event.id > batch.replayThroughEventId;
      renderJournalEvent(event, {
        presentTransient,
        markActivityUnread: shouldMarkActivityUnread(
          initialReplay,
          presentTransient,
        ),
      });
      lastAppliedEventId = event.id;
    }
    receivedInitialEventBatch = true;
    // The batch snapshots represent state after every included event. Apply
    // them last so an older status event cannot regress the visible phase.
    if (batch.provider) {
      updateProvider(batch.provider);
    }
    if (batch.lease) {
      updateLease(batch.lease);
    }
    if (batch.gap && batchSnapshot !== undefined) {
      renderOperationalStatus();
    }
    if (pendingScrollRestore) {
      const requestedTop = uiState.conversationScrollTop ?? 0;
      clock.requestAnimationFrame(() => {
        conversationScroll.scrollTop = Math.min(
          requestedTop,
          Math.max(
            0,
            conversationScroll.scrollHeight -
              conversationScroll.clientHeight,
          ),
        );
        pendingScrollRestore = false;
        pinnedToBottom = isNearBottom();
        updateNewUpdatesButton();
        updateUiState({
          conversationScrollTop: conversationScroll.scrollTop,
          conversationPinnedToBottom: pinnedToBottom,
        });
      });
    }
  }

  function setupTabs(): void {
    const tabs = Array.from(
      doc.querySelectorAll<HTMLButtonElement>(
        ".bottom-tabs [role='tab']",
      ),
    );
    const selectTab = (tab: HTMLButtonElement): void => {
      for (const candidate of tabs) {
        const selected = candidate === tab;
        candidate.classList.toggle("active", selected);
        candidate.setAttribute(
          "aria-selected",
          selected ? "true" : "false",
        );
        candidate.tabIndex = selected ? 0 : -1;
        const panelId = candidate.dataset.panel;
        if (panelId) {
          required<HTMLElement>(doc, panelId).hidden = !selected;
        }
      }
      if (tab.id === "tab-files" && !filesLoaded) {
        void ensureFileHierarchyLoaded();
      }
      if (tab.id === "tab-activity") {
        activityUnread = 0;
        renderActivities();
        void refreshChanges();
      }
      const panelId = tab.dataset.panel;
      taskViewTabs.hidden = panelId !== "chat-panel";
      chatMesh.setActive(panelId === "chat-panel");
      if (
        panelId === "chat-panel" ||
        panelId === "files-panel" ||
        panelId === "activity-panel" ||
        panelId === "settings-panel"
      ) {
        updateUiState({ activePanel: panelId });
      }
    };
    tabs.forEach((tab, index) => {
      listen(tab, "click", () => selectTab(tab));
      listen(tab, "keydown", (event) => {
        if (
          event.key !== "ArrowLeft" &&
          event.key !== "ArrowRight" &&
          event.key !== "Home" &&
          event.key !== "End"
        ) {
          return;
        }
        event.preventDefault();
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
        const next = tabs[nextIndex];
        if (next) {
          selectTab(next);
          next.focus();
        }
      });
    });
    const restoredTab = tabs.find(
      (tab) => tab.dataset.panel === uiState.activePanel,
    );
    if (restoredTab) {
      selectTab(restoredTab);
    }
  }

  function setupHeaderViewControls(): void {
    const setHeaderCollapsed = (
      collapsed: boolean,
      persist = true,
    ): void => {
      app.dataset.header = collapsed ? "compact" : "expanded";
      taskHeader.classList.toggle("is-compact", collapsed);
      headerCollapseButton.setAttribute(
        "aria-expanded",
        collapsed ? "false" : "true",
      );
      const label = collapsed ? "Expand header" : "Minimise header";
      headerCollapseButton.setAttribute("aria-label", label);
      headerCollapseButton.title = label;
      if (persist) {
        updateUiState({ headerCollapsed: collapsed });
      }
      clock.requestAnimationFrame(() => {
        setViewportHeight();
      });
    };

    listen(headerCollapseButton, "click", () => {
      setHeaderCollapsed(app.dataset.header !== "compact");
    });
    listen(compactRouteButton, "click", () => routeDialog.showModal());
    setHeaderCollapsed(uiState.headerCollapsed === true, false);

    const fullscreenSupported =
      doc.fullscreenEnabled &&
      typeof app.requestFullscreen === "function" &&
      typeof doc.exitFullscreen === "function";
    app.dataset.fullscreenSupported = fullscreenSupported
      ? "true"
      : "false";
    fullscreenButton.hidden = !fullscreenSupported;

    const syncFullscreenState = (): void => {
      const active = doc.fullscreenElement === app;
      app.dataset.fullscreen = active ? "true" : "false";
      fullscreenButton.setAttribute(
        "aria-pressed",
        active ? "true" : "false",
      );
      const label = active ? "Exit fullscreen" : "Enter fullscreen";
      fullscreenButton.setAttribute("aria-label", label);
      fullscreenButton.title = label;
      setViewportHeight();
    };

    if (fullscreenSupported) {
      doc.addEventListener("fullscreenchange", syncFullscreenState, {
        signal: abortController.signal,
      });
      listen(fullscreenButton, "click", () => {
        void (async () => {
          try {
            if (doc.fullscreenElement) {
              await doc.exitFullscreen();
            } else {
              await app.requestFullscreen();
            }
          } catch {
            toast(
              "Fullscreen is unavailable here. Minimise the header for more room.",
            );
            syncFullscreenState();
          }
        })();
      });
      syncFullscreenState();
    }
  }

  function setupTaskViews(): void {
    const tabs = [
      required<HTMLButtonElement>(doc, "view-conversation"),
      required<HTMLButtonElement>(doc, "view-activity"),
    ];
    const views = [
      required<HTMLElement>(doc, "conversation-view"),
      required<HTMLElement>(doc, "activity-view"),
    ];
    const selectView = (index: number): void => {
      tabs.forEach((candidate, candidateIndex) => {
        const selected = candidateIndex === index;
        candidate.classList.toggle("active", selected);
        candidate.setAttribute(
          "aria-selected",
          selected ? "true" : "false",
        );
        candidate.tabIndex = selected ? 0 : -1;
        const target = views[candidateIndex];
        if (target) {
          target.hidden = !selected;
        }
      });
      updateUiState({
        taskView: index === 1 ? "activity" : "conversation",
      });
      if (index === 1) {
        activityUnread = 0;
        renderActivities();
      }
    };
    tabs.forEach((tab, index) => {
      listen(tab, "click", () => selectView(index));
      listen(tab, "keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        event.preventDefault();
        const target = tabs[index === 0 ? 1 : 0];
        target?.click();
        target?.focus();
      });
    });
    selectView(uiState.taskView === "activity" ? 1 : 0);
  }

  function resizeComposer(): void {
    promptInput.style.height = "auto";
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
  }

  function setupChat(): void {
    listen(promptForm, "submit", (event) => {
      event.preventDefault();
      const prompt = promptInput.value.trim();
      if (!prompt && attachments.length === 0) {
        return;
      }
      if (!acceptsInput()) {
        toast("Wait for the current remote operation to finish.");
        return;
      }
      const id = crypto.randomUUID();
      const displayText =
        prompt ||
        `Sent ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
      const element = appendMessage("user", displayText, {
        id,
        delivery: "queued",
      });
      const pending: PendingLocalMessage = {
        id,
        prompt: displayText,
        element,
        createdAt: clock.now(),
      };
      pendingMessages.set(id, pending);
      if (pendingMessages.size > 100) {
        const oldest = pendingMessages.keys().next().value;
        if (oldest) {
          pendingMessages.delete(oldest);
        }
      }
      lastPrompt = prompt;
      promptInput.value = "";
      resizeComposer();
      hideSuggestions();
      const sendingAttachments = attachments.splice(0);
      renderAttachments();
      setPhase("Sending message", { busy: true });
      void transport
        .send({
          id,
          type: "prompt.send",
          prompt,
          attachmentIds: sendingAttachments.map(
            (attachment) => attachment.id,
          ),
        })
        .then(() => {
          setMessageDelivery(pending, "accepted");
          setPhase("Waiting for Claude", { busy: true });
        })
        .catch((error: unknown) => {
          if (asRecord(error).authoritative === true) {
            setMessageDelivery(pending, "failed");
            setPhase("Message was not sent", { tone: "error" });
            showError(error);
            return;
          }
          setMessageDelivery(pending, "checking");
          currentPhaseHint = "delivery-unknown";
          setPhase("Checking Mac", { busy: true, tone: "warning" });
          addActivity({
            key: `delivery-${id}`,
            title: "Checking message delivery",
            detail: "The phone did not receive a receipt. ModelHop is asking the Mac before retrying anything.",
            tone: "warning",
            phase: "Checking Mac",
            busy: true,
          });
          if (error instanceof Error && error.message) {
            console.warn("Prompt receipt unavailable", error.message);
          }
        });
    });
    listen(promptInput, "input", () => {
      resizeComposer();
      updateSuggestions();
    });
    listen(promptInput, "keydown", (event) => {
      if (suggestionsElement.hidden) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideSuggestions();
      } else if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp"
      ) {
        event.preventDefault();
        highlightedSuggestion =
          (highlightedSuggestion +
            (event.key === "ArrowDown" ? 1 : -1) +
            currentSuggestions.length) %
          currentSuggestions.length;
        renderSuggestions();
      } else if (event.key === "Enter" && !event.shiftKey) {
        const suggestion = currentSuggestions[highlightedSuggestion];
        if (suggestion) {
          event.preventDefault();
          insertSuggestion(suggestion);
        }
      }
    });
    listen(cancelButton, "click", () => {
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "turn.cancel",
        })
        .catch(showError);
    });
  }

  function updateSuggestions(): void {
    const beforeCursor = promptInput.value.slice(
      0,
      promptInput.selectionStart,
    );
    const slashMatch = beforeCursor.match(/(?:^|\s)(\/[\w-]*)$/u);
    if (slashMatch?.[1]) {
      const token = slashMatch[1].toLowerCase();
      currentSuggestions = slashCommands
        .filter((command) =>
          command.name.toLowerCase().startsWith(token),
        )
        .slice(0, 10)
        .map((command) => ({
          kind: "command",
          label: command.name,
          detail: command.description,
          value: `${command.name} `,
        }));
      highlightedSuggestion = 0;
      renderSuggestions();
      return;
    }

    const fileMatch = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/u);
    if (fileMatch) {
      const query = fileMatch[1] ?? "";
      if (suggestionTimer !== undefined) {
        clock.clearTimeout(suggestionTimer);
      }
      const epoch = ++suggestionEpoch;
      suggestionTimer = clock.setTimeout(() => {
        void transport
          .send<{ files: string[] }>({
            id: crypto.randomUUID(),
            type: "files.search",
            query,
          })
          .then((result) => {
            if (epoch !== suggestionEpoch) {
              return;
            }
            currentSuggestions = result.files.slice(0, 10).map((path) => ({
              kind: "file",
              label: path.split("/").at(-1) ?? path,
              detail: path,
              value: `@${path} `,
            }));
            highlightedSuggestion = 0;
            renderSuggestions();
          })
          .catch(() => hideSuggestions());
      }, 180);
      return;
    }
    hideSuggestions();
  }

  function renderSuggestions(): void {
    if (currentSuggestions.length === 0) {
      hideSuggestions();
      return;
    }
    suggestionsElement.hidden = false;
    suggestionsElement.replaceChildren(
      ...currentSuggestions.map((suggestion, index) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("role", "option");
        button.setAttribute(
          "aria-selected",
          index === highlightedSuggestion ? "true" : "false",
        );
        const label = doc.createElement("strong");
        label.textContent = suggestion.label;
        button.append(label);
        if (suggestion.detail) {
          const detail = doc.createElement("small");
          detail.className = "markdown-inline";
          markdownRenderer.renderInline(detail, suggestion.detail);
          button.append(detail);
        }
        listen(button, "click", () => insertSuggestion(suggestion));
        return button;
      }),
    );
  }

  function hideSuggestions(): void {
    currentSuggestions = [];
    suggestionsElement.hidden = true;
    suggestionsElement.replaceChildren();
  }

  function insertSuggestion(suggestion: Suggestion): void {
    const cursor = promptInput.selectionStart;
    const before = promptInput.value.slice(0, cursor);
    const after = promptInput.value.slice(promptInput.selectionEnd);
    const pattern =
      suggestion.kind === "command"
        ? /\/[\w-]*$/u
        : /@[^\s@]*$/u;
    const updatedBefore = before.replace(pattern, suggestion.value);
    promptInput.value = `${updatedBefore}${after}`;
    promptInput.setSelectionRange(
      updatedBefore.length,
      updatedBefore.length,
    );
    hideSuggestions();
    resizeComposer();
    promptInput.focus();
  }

  function setupDialogsAndRoute(): void {
    listen(required(doc, "route-button"), "click", () =>
      routeDialog.showModal(),
    );
    listen(required(doc, "usage-button"), "click", () =>
      usageDialog.showModal(),
    );
    listen(required(doc, "open-usage-from-route"), "click", () => {
      routeDialog.close();
      usageDialog.showModal();
    });
    listen(routeReasoningSummary, "click", () => {
      routeDialog.close();
      required<HTMLButtonElement>(doc, "tab-settings").click();
      reasoningSettingsCard.scrollIntoView({ block: "start" });
      reasoningSettingsCard.focus({ preventScroll: true });
    });
    listen(required(doc, "refresh-usage"), "click", () => {
      usageValue.textContent = "Updating…";
      usageLabel.textContent = "Updating…";
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "usage.refresh",
        })
        .then(() => toast("Refreshing provider usage on your Mac…"))
        .catch(showError);
    });
    listen(codexReset, "click", () => {
      if (
        !view.confirm(
          "Use one available Codex reset credit? This cannot be undone.",
        )
      ) {
        return;
      }
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "codex.reset",
          creditId: availableCodexResetCredit()?.id,
        })
        .then(() => {
          toast("Reset credit request sent to your Mac.");
          usageDialog.close();
        })
        .catch(showError);
    });

    listen(providerSelect, "change", () => {
      const provider = currentProvider;
      const previous = provider?.provider;
      const next = providerSelect.value as RemoteProviderContext["provider"];
      if (!provider || !previous || next === previous) {
        return;
      }
      if (
        !view.confirm(
          `Switch this conversation from ${provider.label} to ${providerSelect.selectedOptions[0]?.textContent ?? next}? The current response will finish first.`,
        )
      ) {
        providerSelect.value = previous;
        return;
      }
      providerSwitchTarget = next;
      setConnection("secure");
      setPhase("Switching provider", { busy: true });
      syncInputState();
      routeDialog.close();
      addActivity({
        key: `provider-${clock.now()}`,
        title: `Switching to ${providerSelect.selectedOptions[0]?.textContent ?? next}`,
        detail: "The current turn will finish before ModelHop changes the route.",
        tone: "info",
        phase: "Switching provider",
        busy: true,
      });
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "provider.change",
          provider: next,
        })
        .catch((error: unknown) => {
          providerSwitchTarget = undefined;
          providerSelect.value = previous;
          setConnection("error", "Switch failed");
          setPhase("Provider switch failed", { tone: "error" });
          syncInputState();
          showError(error);
        });
    });

    const updateModel = (): void => {
      const provider = currentProvider;
      const target = modelSelect.value;
      const selectedModel = matchingModelOption(currentModelOptions, target);
      if (!provider || !target || !selectedModel) {
        modelSelect.value = confirmedModelSelector ?? provider?.model ?? "";
        return;
      }
      if (modelChangePendingTarget || reasoningChangePending) {
        modelSelect.value = confirmedModelSelector ?? provider.model;
        return;
      }
      const previousSelector = confirmedModelSelector ??
        matchingModelOption(currentModelOptions, provider.model)?.selector ??
        provider.model;
      if (target === previousSelector) {
        return;
      }
      const selectedEfforts = selectedModel.supportedEffortLevels?.filter(
        isReasoningEffort,
      );
      const effort = isReasoningEffort(effortSelect.value) &&
        (selectedEfforts === undefined ||
          selectedEfforts.includes(effortSelect.value))
        ? effortSelect.value
        : undefined;
      modelChangePendingTarget = target;
      modelChangePreviousSelector = previousSelector;
      modelChangeStatus.textContent =
        `Applying ${selectedModel.resolvedModel ?? selectedModel.displayName}…`;
      modelChangeStatus.dataset.state = "pending";
      updateProvider(provider);
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "model.change",
          model: target,
          reasoningEffort: effort,
        })
        .then(() => {
          if (modelChangePendingTarget === target) {
            modelChangeStatus.textContent =
              "Change accepted. Waiting for the active model to confirm…";
            modelChangeStatus.dataset.state = "pending";
          }
          toast(
            `Changing to ${selectedModel.resolvedModel ?? selectedModel.displayName}…`,
          );
        })
        .catch((error: unknown) => {
          if (modelChangePendingTarget !== target) {
            return;
          }
          modelChangePendingTarget = undefined;
          const restore = modelChangePreviousSelector ?? previousSelector;
          modelChangePreviousSelector = undefined;
          confirmedModelSelector = restore;
          modelChangeStatus.textContent =
            "The active model kept its previous selection.";
          modelChangeStatus.dataset.state = "error";
          updateProvider(provider);
          modelSelect.value = restore;
          syncInputState();
          showError(error);
        });
    };
    listen(modelSelect, "change", updateModel);
    const effortChange = (
      effort: ReasoningEffortValue,
    ): Omit<ReasoningChangeCommand, "id" | "type"> => ({
      effort,
      ...(effort !== "none" &&
      providerReasoningState(currentProvider).thinkingSupported
        ? { thinkingEnabled: true }
        : {}),
    });
    listen(effortSelect, "change", () => {
      if (!isReasoningEffort(effortSelect.value)) {
        return;
      }
      settingsEffortSelect.value = effortSelect.value;
      requestReasoningChange(
        effortChange(effortSelect.value),
        `Changing effort to ${REASONING_EFFORT_LABELS[effortSelect.value]}…`,
      );
    });
    listen(settingsEffortSelect, "change", () => {
      if (!isReasoningEffort(settingsEffortSelect.value)) {
        return;
      }
      effortSelect.value = settingsEffortSelect.value;
      requestReasoningChange(
        effortChange(settingsEffortSelect.value),
        `Changing effort to ${REASONING_EFFORT_LABELS[settingsEffortSelect.value]}…`,
      );
    });
    listen(thinkingToggle, "change", () => {
      requestReasoningChange(
        {
          thinkingEnabled: thinkingToggle.checked,
          ...(thinkingToggle.checked
            ? {}
            : { ultraEnabled: false }),
        },
        thinkingToggle.checked
          ? "Turning thinking on…"
          : "Turning thinking off…",
      );
    });
    listen(workflowsToggle, "change", () => {
      if (
        workflowsToggle.checked &&
        !workflowConsentConfirmed
      ) {
        const confirmed = view.confirm(
          "Enable Experimental Claude Workflows for this remote session? A workflow may run several provider calls or subagents and use more allowance. The first Workflow will still require approval on your phone.",
        );
        if (!confirmed) {
          renderReasoningControls();
          return;
        }
        workflowConsentConfirmed = true;
      }
      requestReasoningChange(
        {
          workflowsEnabled: workflowsToggle.checked,
          ...(workflowsToggle.checked
            ? {}
            : { ultraEnabled: false }),
        },
        workflowsToggle.checked
          ? "Turning Claude workflows on…"
          : "Turning Claude workflows off…",
      );
    });
    listen(ultraToggle, "change", () => {
      if (ultraToggle.checked && !ultraConsentConfirmed) {
        const confirmed = view.confirm(
          "Enable Experimental Ultra for this remote session? Ultra turns on Extra high (xhigh) reasoning and Claude Workflows together, plus Claude thinking where the active model supports it. It may run several provider calls or subagents and use more allowance. The first Workflow will still require approval on your phone.",
        );
        if (!confirmed) {
          renderReasoningControls();
          return;
        }
        ultraConsentConfirmed = true;
        workflowConsentConfirmed = true;
      }
      requestReasoningChange(
        ultraToggle.checked
          ? {
              ultraEnabled: true,
              workflowsEnabled: true,
              effort: "xhigh",
              ...(providerReasoningState(currentProvider).thinkingSupported
                ? { thinkingEnabled: true }
                : {}),
            }
          : { ultraEnabled: false },
        ultraToggle.checked
          ? "Starting Ultra with thinking and workflows…"
          : "Turning Ultra off…",
      );
    });

    listen(permissionMode, "change", () => {
      const mode = permissionMode.value as RemotePermissionMode;
      permissionMode.disabled = true;
      void (async () => {
        try {
          await transport.send({
            id: crypto.randomUUID(),
            type: "permission.mode.set",
            mode,
          });
          // The successful encrypted response is authoritative: the daemon
          // returns it only after the SDK, lease, journal, and runtime store
          // have committed the selected mode.
          applyAuthoritativePermissionMode(mode);
          toast(
            mode === "auto-safe"
              ? "Auto-safe will handle routine work and ask before sensitive actions."
              : "Remote permission mode updated.",
          );
        } catch (error) {
          permissionMode.value = currentPermissionMode;
          showError(error);
        } finally {
          permissionMode.disabled = false;
        }
      })();
    });
  }

  function setupAttachments(): void {
    listen(required(doc, "attachment-button"), "click", () =>
      attachmentDialog.showModal(),
    );
    listen(required(doc, "attach-repository"), "click", () => {
      attachmentDialog.close();
      required<HTMLButtonElement>(doc, "tab-files").click();
    });
    const bindInput = (input: HTMLInputElement): void => {
      listen(input, "change", () => {
        void uploadAttachments(Array.from(input.files ?? []));
        input.value = "";
        attachmentDialog.close();
      });
    };
    bindInput(attachmentInput);
    bindInput(photoInput);
    bindInput(cameraInput);
  }

  async function uploadAttachments(files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        toast(`${file.name} is larger than 10 MB.`);
        continue;
      }
      const id = crypto.randomUUID();
      const placeholder = { id, name: `${file.name} · Uploading…` };
      attachments.push(placeholder);
      renderAttachments();
      try {
        const contentBase64 = bytesToBase64(
          new Uint8Array(await file.arrayBuffer()),
        );
        await transport.send({
          id,
          type: "attachment.upload",
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          contentBase64,
        });
        placeholder.name = file.name;
        renderAttachments();
      } catch (error) {
        const index = attachments.findIndex(
          (attachment) => attachment.id === id,
        );
        if (index >= 0) {
          attachments.splice(index, 1);
        }
        renderAttachments();
        showError(error);
      }
    }
  }

  function renderAttachments(): void {
    attachmentsElement.replaceChildren(
      ...attachments.map((attachment) => {
        const chip = doc.createElement("span");
        chip.className = "attachment-chip";
        chip.setAttribute("role", "listitem");
        chip.dataset.attachmentId = attachment.id;
        const label = doc.createElement("span");
        label.textContent = attachment.name;
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.setAttribute(
          "aria-label",
          `Remove ${attachment.name}`,
        );
        remove.textContent = "×";
        listen(remove, "click", () => {
          const index = attachments.findIndex(
            (candidate) => candidate.id === attachment.id,
          );
          if (index >= 0) {
            attachments.splice(index, 1);
          }
          renderAttachments();
        });
        chip.append(label, remove);
        return chip;
      }),
    );
  }

  function setupFiles(): void {
    listen(
      required<HTMLFormElement>(doc, "file-search-form"),
      "submit",
      (event) => {
        event.preventDefault();
        const query = required<HTMLInputElement>(doc, "file-search").value;
        const scope = required<HTMLSelectElement>(
          doc,
          "file-search-scope",
        ).value;
        if (scope === "symbols") {
          void searchSymbols(query);
        } else {
          void searchFiles(query);
        }
      },
    );
    listen(required(doc, "constellation-view-button"), "click", () =>
      setFileView("constellation"),
    );
    listen(required(doc, "tree-view-button"), "click", () =>
      setFileView("tree"),
    );
    listen(required(doc, "mention-file"), "click", () =>
      mentionCurrentFile(),
    );
    listen(required(doc, "ask-file-lines"), "click", () =>
      askAboutSelectedLines(),
    );
    listen(required(doc, "clear-file-lines"), "click", () =>
      clearFileLineSelection(),
    );
    listen(required(doc, "copy-file-path"), "click", () => {
      if (!currentFilePath) {
        return;
      }
      void view.navigator.clipboard
        ?.writeText(currentFilePath)
        .then(() => toast("File path copied."))
        .catch(() => toast("Copy is unavailable in this browser."));
    });
    listen(required(doc, "open-file-viewer"), "click", () => {
      openFileViewer();
    });
    listen(required(doc, "close-file-viewer"), "click", () => {
      closeFileViewer();
    });
    listen(required(doc, "file-viewer-source"), "click", () => {
      renderFileViewer("source");
    });
    listen(required(doc, "file-viewer-preview"), "click", () => {
      renderFileViewer("preview");
    });
    listen(required(doc, "file-viewer-interactions"), "click", () => {
      if (!fileViewerInteractive && !previewScriptNonce) {
        toast("Interactive preview is unavailable in this session.");
        return;
      }
      fileViewerInteractive = !fileViewerInteractive;
      renderFileViewer("preview");
    });
    listen(fileViewerDialog, "close", () => {
      stopFileViewerRuntime();
    });
    setFileView(uiState.fileView ?? "constellation");
  }

  function supportsInteractiveFilePreview(
    preview: RemoteFilePreview | undefined,
  ): boolean {
    return Boolean(
      preview &&
        preview.encoding === "utf8" &&
        (preview.language === "html" || preview.language === "htm"),
    );
  }

  function safePreviewDocument(
    source: string,
    interactive: boolean,
    scriptNonce: string | undefined,
  ): string {
    const parsed = new DOMParser().parseFromString(source, "text/html");
    parsed
      .querySelectorAll("base, frame, frameset, iframe, object, embed")
      .forEach((element) => element.remove());
    parsed
      .querySelectorAll('meta[http-equiv="refresh" i]')
      .forEach((element) => element.remove());
    const safeInlineResource = (value: string): boolean =>
      value === "" ||
      value.startsWith("#") ||
      /^data:/iu.test(value) ||
      /^blob:/iu.test(value);
    parsed.querySelectorAll("*").forEach((element) => {
      element.removeAttribute("srcset");
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
        }
      }
      for (const attribute of [
        "action",
        "formaction",
        "href",
        "poster",
        "src",
      ]) {
        const value = element.getAttribute(attribute)?.trim();
        if (value !== undefined && !safeInlineResource(value)) {
          element.removeAttribute(attribute);
        }
      }
      element.removeAttribute("target");
    });
    const scriptsEnabled = Boolean(interactive && scriptNonce);
    parsed.querySelectorAll("script").forEach((script) => {
      script.removeAttribute("src");
      script.removeAttribute("integrity");
      script.removeAttribute("crossorigin");
      script.removeAttribute("nonce");
      if (!scriptsEnabled || !scriptNonce) {
        script.remove();
        return;
      }
      script.setAttribute("nonce", scriptNonce);
    });
    const scriptPolicy = scriptsEnabled && scriptNonce
      ? `'nonce-${scriptNonce}'`
      : "'none'";
    const policy = [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'none'",
      "font-src data:",
      "form-action 'none'",
      "frame-src 'none'",
      "img-src data: blob:",
      "manifest-src 'none'",
      "media-src data: blob:",
      "object-src 'none'",
      `script-src ${scriptPolicy}`,
      "script-src-attr 'none'",
      `script-src-elem ${scriptPolicy}`,
      "style-src 'unsafe-inline'",
      "worker-src 'none'",
    ].join("; ");
    const contentPolicy = parsed.createElement("meta");
    contentPolicy.httpEquiv = "Content-Security-Policy";
    contentPolicy.content = policy;
    parsed.head.prepend(contentPolicy);
    return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
  }

  function stopFileViewerRuntime(): void {
    const frame = required<HTMLIFrameElement>(doc, "file-viewer-frame");
    frame.removeAttribute("src");
    frame.srcdoc = "";
    frame.setAttribute("sandbox", "");
    fileViewerInteractive = false;
  }

  function replaceFileViewerFrame(
    sandbox: "" | "allow-scripts",
  ): HTMLIFrameElement {
    const current = required<HTMLIFrameElement>(doc, "file-viewer-frame");
    const replacement = doc.createElement("iframe");
    replacement.id = "file-viewer-frame";
    replacement.title = current.title;
    replacement.referrerPolicy = "no-referrer";
    replacement.setAttribute("sandbox", sandbox);
    replacement.hidden = current.hidden;
    current.replaceWith(replacement);
    return replacement;
  }

  function closeFileViewer(): void {
    stopFileViewerRuntime();
    if (fileViewerDialog.open) {
      fileViewerDialog.close();
    }
  }

  function openFileViewer(): void {
    if (!currentFilePreview) {
      toast("Choose a file before opening the full-screen preview.");
      return;
    }
    fileViewerInteractive = false;
    renderFileViewer("source");
    if (!fileViewerDialog.open) {
      fileViewerDialog.showModal();
    }
  }

  function renderFileViewer(mode: "source" | "preview"): void {
    const preview = currentFilePreview;
    if (!preview) {
      return;
    }
    const canPreview = supportsInteractiveFilePreview(preview);
    fileViewerMode = mode === "preview" && canPreview ? "preview" : "source";
    const sourceButton = required<HTMLButtonElement>(
      doc,
      "file-viewer-source",
    );
    const previewButton = required<HTMLButtonElement>(
      doc,
      "file-viewer-preview",
    );
    const interactionsButton = required<HTMLButtonElement>(
      doc,
      "file-viewer-interactions",
    );
    const note = required<HTMLElement>(doc, "file-viewer-note");
    const image = required<HTMLImageElement>(doc, "file-viewer-image");
    const codeWrap = required<HTMLElement>(doc, "file-viewer-code-wrap");
    const code = required<HTMLElement>(doc, "file-viewer-code");
    let frame = required<HTMLIFrameElement>(doc, "file-viewer-frame");

    required<HTMLElement>(doc, "file-viewer-title").textContent = preview.path;
    previewButton.hidden = !canPreview;
    sourceButton.classList.toggle("active", fileViewerMode === "source");
    previewButton.classList.toggle("active", fileViewerMode === "preview");
    sourceButton.setAttribute(
      "aria-pressed",
      String(fileViewerMode === "source"),
    );
    previewButton.setAttribute(
      "aria-pressed",
      String(fileViewerMode === "preview"),
    );
    interactionsButton.hidden = fileViewerMode !== "preview";
    interactionsButton.setAttribute(
      "aria-pressed",
      String(fileViewerInteractive),
    );
    interactionsButton.textContent = fileViewerInteractive
      ? "Interactions on"
      : "Enable interactions";
    note.hidden = fileViewerMode !== "preview";

    if (fileViewerMode === "preview") {
      image.hidden = true;
      codeWrap.hidden = true;
      frame = replaceFileViewerFrame(
        fileViewerInteractive ? "allow-scripts" : "",
      );
      frame.hidden = false;
      const previewDocument = safePreviewDocument(
        preview.content,
        fileViewerInteractive,
        previewScriptNonce,
      );
      // The opaque-origin frame inherits the app CSP. A per-page nonce lets
      // only scripts explicitly sanitized by ModelHop run, without granting
      // same-origin, form, popup, or top-navigation capabilities.
      frame.srcdoc = previewDocument;
      return;
    }

    stopFileViewerRuntime();
    interactionsButton.setAttribute("aria-pressed", "false");
    interactionsButton.textContent = "Enable interactions";
    frame.hidden = true;
    if (
      preview.encoding === "base64" &&
      preview.mediaType !== undefined &&
      SAFE_REMOTE_IMAGE_MEDIA_TYPES.has(preview.mediaType)
    ) {
      image.src = `data:${preview.mediaType};base64,${preview.content}`;
      image.alt = preview.path;
      image.hidden = false;
      codeWrap.hidden = true;
      return;
    }
    image.removeAttribute("src");
    image.hidden = true;
    codeWrap.hidden = false;
    highlightCode(code, preview.content, preview.language, false);
    codeWrap.scrollTop = 0;
    codeWrap.scrollLeft = 0;
  }

  function setFileView(viewMode: "constellation" | "tree"): void {
    const constellation = required<HTMLElement>(
      doc,
      "constellation-view",
    );
    const tree = required<HTMLElement>(doc, "file-tree");
    const constellationButton = required<HTMLButtonElement>(
      doc,
      "constellation-view-button",
    );
    const treeButton = required<HTMLButtonElement>(
      doc,
      "tree-view-button",
    );
    const isConstellation = viewMode === "constellation";
    constellation.hidden = !isConstellation;
    tree.hidden = isConstellation;
    constellationButton.classList.toggle("active", isConstellation);
    treeButton.classList.toggle("active", !isConstellation);
    updateUiState({ fileView: viewMode });
  }

  function ensureFileHierarchyLoaded(): Promise<void> {
    if (filesLoaded) {
      return Promise.resolve();
    }
    fileHierarchyPromise ??= loadFileHierarchy().finally(() => {
      if (!filesLoaded) {
        fileHierarchyPromise = undefined;
      }
    });
    return fileHierarchyPromise;
  }

  async function loadFileHierarchy(): Promise<void> {
    const restoredFolderPath = uiState.currentFolderPath;
    const epoch = ++fileSearchEpoch;
    const result = await transport
      .send<DirectoryListResponse>({
        id: crypto.randomUUID(),
        type: "files.list",
        path: "",
        pageSize: 64,
      })
      .catch((error: unknown) => {
        showError(error);
        return undefined;
      });
    if (epoch !== fileSearchEpoch || !result) {
      return;
    }
    fileHierarchy = buildFileHierarchy([]);
    fileNodeMetadata.clear();
    loadedFolders.clear();
    directoryLoadStatus.clear();
    const roots =
      result.roots.length > 0 ? result.roots : [result.page.root];
    for (const root of roots) {
      fileHierarchy.children.push({
        name: root.label,
        path: rootUiPath(root.id),
        kind: "folder",
        children: [],
      });
    }
    const loaded = await loadDirectoryPage(
      result.page.root.id,
      "",
      result,
      epoch,
    );
    if (!loaded) {
      return;
    }
    filesLoaded = true;
    currentFolderPath =
      roots.length === 1 ? rootUiPath(roots[0]?.id ?? "primary") : "";
    renderFileNavigator();
    if (
      restoredFolderPath !== undefined &&
      restoredFolderPath !== currentFolderPath
    ) {
      await restoreFolderSelection(restoredFolderPath);
    } else {
      updateUiState({ currentFolderPath });
    }
  }

  function rootUiPath(rootId: string): string {
    return `@${rootId}`;
  }

  function directoryUiPath(rootId: string, path: string): string {
    return path ? `${rootUiPath(rootId)}/${path}` : rootUiPath(rootId);
  }

  async function navigateToFolder(path: string): Promise<void> {
    const target = findHierarchyNode(fileHierarchy, path);
    if (!target || target.kind !== "folder") {
      return;
    }
    currentFolderPath = path;
    updateUiState({ currentFolderPath });
    renderFileNavigator();
    if (path === "" || loadedFolders.has(path) || loadingFolders.has(path)) {
      return;
    }
    const metadata = fileNodeMetadata.get(path);
    const rootId =
      metadata?.rootId ?? path.slice(1).split("/")[0] ?? "primary";
    const directoryPath =
      metadata?.path ?? path.split("/").slice(1).join("/");
    await loadDirectoryPage(rootId, directoryPath);
    renderFileNavigator();
  }

  async function restoreFolderSelection(path: string): Promise<void> {
    if (path === "") {
      await navigateToFolder("");
      return;
    }
    const segments = path.split("/").filter(Boolean);
    const rootPath = segments.shift();
    if (!rootPath?.startsWith("@")) {
      updateUiState({ currentFolderPath });
      return;
    }
    let candidatePath = rootPath;
    if (!findHierarchyNode(fileHierarchy, candidatePath)) {
      updateUiState({ currentFolderPath });
      return;
    }
    await navigateToFolder(candidatePath);
    for (const segment of segments) {
      candidatePath = `${candidatePath}/${segment}`;
      if (!findHierarchyNode(fileHierarchy, candidatePath)) {
        updateUiState({ currentFolderPath });
        return;
      }
      await navigateToFolder(candidatePath);
    }
  }

  async function loadDirectoryPage(
    rootId: string,
    path: string,
    initial?: DirectoryListResponse,
    epoch = fileSearchEpoch,
  ): Promise<boolean> {
    const uiPath = directoryUiPath(rootId, path);
    if (loadedFolders.has(uiPath)) {
      return true;
    }
    if (loadingFolders.has(uiPath)) {
      return false;
    }
    loadingFolders.add(uiPath);
    addActivity({
      key: `files-${rootId}-${path}`,
      title: path ? `Opening ${path}` : `Opening ${rootId}`,
      detail: "Loading repository hierarchy from your Mac.",
      tone: "info",
    });
    try {
      const firstResponse =
        initial ??
        (await transport.send<DirectoryListResponse>({
          id: crypto.randomUUID(),
          type: "files.list",
          rootId,
          path,
          pageSize: 64,
        }));
      const listing = await collectDirectoryListing(
        firstResponse.page,
        async (cursor) => {
          const response = await transport.send<DirectoryListResponse>({
            id: crypto.randomUUID(),
            type: "files.list",
            rootId,
            path,
            cursor,
            pageSize: 64,
          });
          if (epoch !== fileSearchEpoch) {
            throw new Error("The directory load was superseded.");
          }
          return response.page;
        },
        { rootId, path },
      );
      if (epoch !== fileSearchEpoch) {
        return false;
      }
      const nodes = listing.nodes;

      let folder = findHierarchyNode(fileHierarchy, uiPath);
      if (!folder) {
        const root = findHierarchyNode(
          fileHierarchy,
          rootUiPath(rootId),
        );
        folder = {
          name: path.split("/").at(-1) ?? path,
          path: uiPath,
          kind: "folder",
          children: [],
        };
        root?.children.push(folder);
      }
      if (!folder) {
        return false;
      }
      folder.children = nodes.map((node) => {
        const nodePath = directoryUiPath(rootId, node.path);
        fileNodeMetadata.set(nodePath, node);
        return {
          name: node.name,
          path: nodePath,
          kind: node.kind === "directory" ? "folder" : "file",
          children: [],
        };
      });
      loadedFolders.add(uiPath);
      directoryLoadStatus.set(uiPath, {
        loaded: nodes.length,
        totalEntries: listing.totalEntries,
        omittedEntries: listing.omittedEntries,
      });
      return true;
    } catch (error) {
      if (epoch === fileSearchEpoch) {
        showError(error);
      }
      return false;
    } finally {
      loadingFolders.delete(uiPath);
    }
  }

  function renderFileNavigator(): void {
    renderBreadcrumbs();
    renderConstellation();
    renderFileTree();
    renderFileBrowserStatus();
  }

  function renderFileBrowserStatus(): void {
    const status = required<HTMLElement>(doc, "file-browser-status");
    if (currentFolderPath === "") {
      status.textContent = `${String(fileHierarchy.children.length)} workspace root${fileHierarchy.children.length === 1 ? "" : "s"}. Choose one to browse its files.`;
      return;
    }
    if (loadingFolders.has(currentFolderPath)) {
      status.textContent = "Loading every item in this folder…";
      return;
    }
    const folder = findHierarchyNode(fileHierarchy, currentFolderPath);
    const load = directoryLoadStatus.get(currentFolderPath);
    if (!folder || !load) {
      status.textContent = "Open this folder to load its complete contents.";
      return;
    }
    status.textContent = describeDirectoryListing(
      load,
      folder.children.length > 6,
    );
  }

  function renderBreadcrumbs(): void {
    const target = required<HTMLElement>(doc, "file-breadcrumbs");
    const segments = currentFolderPath
      ? currentFolderPath.split("/")
      : [];
    const paths = [""];
    for (let index = 0; index < segments.length; index += 1) {
      paths.push(segments.slice(0, index + 1).join("/"));
    }
    target.replaceChildren(
      ...paths.map((path, index) => {
        const button = doc.createElement("button");
        button.type = "button";
        const hierarchyNode = findHierarchyNode(fileHierarchy, path);
        button.textContent =
          index === 0
            ? "Workspace"
            : hierarchyNode?.name ?? segments[index - 1] ?? path;
        if (path === currentFolderPath) {
          button.setAttribute("aria-current", "location");
        }
        listen(button, "click", () => {
          void navigateToFolder(path);
        });
        return button;
      }),
    );
  }

  function renderConstellation(): void {
    const constellationCard = required<HTMLElement>(
      doc,
      "constellation-view",
    );
    const nodeContainer =
      required<HTMLElement>(doc, "constellation-nodes");
    const lines = required<SVGSVGElement>(
      doc,
      "constellation-lines",
    );
    const nodes = constellationLayout(
      fileHierarchy,
      currentFolderPath,
    );
    const current = nodes.find(
      (entry) => entry.relation === "current",
    );
    const svgNamespace = "http://www.w3.org/2000/svg";
    lines.replaceChildren(
      ...nodes
        .filter((entry) => entry.relation !== "current" && current)
        .map((entry) => {
          const line = doc.createElementNS(svgNamespace, "line");
          line.setAttribute("x1", `${current?.x ?? 50}%`);
          line.setAttribute("y1", `${current?.y ?? 50}%`);
          line.setAttribute("x2", `${entry.x}%`);
          line.setAttribute("y2", `${entry.y}%`);
          return line;
        }),
    );
    nodeContainer.replaceChildren(
      ...nodes.map((entry) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "constellation-node";
        button.dataset.kind = entry.node.kind;
        button.dataset.relation = entry.relation;
        button.dataset.fileType =
          entry.node.kind === "folder"
            ? "folder"
            : fileVisualType(entry.node.name);
        if (
          entry.node.kind === "file" &&
          entry.node.path === selectedFileNodePath
        ) {
          button.dataset.selected = "true";
          button.setAttribute("aria-current", "true");
        }
        const nodeSize = constellationNodeSize(
          entry.node.name,
          entry.node.kind,
          entry.relation,
          constellationCard.clientWidth,
        );
        button.style.setProperty("--node-size", `${nodeSize}px`);
        button.style.setProperty(
          "--node-font-size",
          `${nodeSize >= 116 ? 12.5 : nodeSize >= 98 ? 12 : 11.5}px`,
        );
        button.style.left = `${entry.x}%`;
        button.style.top = `${entry.y}%`;
        button.title = entry.node.name;
        button.setAttribute(
          "aria-label",
          `${entry.node.kind === "folder" ? "Folder" : "File"} ${entry.node.name}${entry.relation === "current" ? ", current location" : ""}${entry.node.path === selectedFileNodePath ? ", selected" : ""}`,
        );
        const icon = createConstellationIcon(entry.node.kind);
        const label = doc.createElement("span");
        label.className = "node-label";
        label.textContent = bubbleLabel(entry.node.name);
        button.append(icon, label);
        listen(button, "click", () => {
          if (entry.node.kind === "folder") {
            void navigateToFolder(entry.node.path);
          } else {
            void openFile(entry.node.path, undefined, {
              revealPreview: true,
            });
          }
        });
        return button;
      }),
    );
    const currentNode = findHierarchyNode(
      fileHierarchy,
      currentFolderPath,
    );
    const parentNodePath = parentPath(currentFolderPath);
    const parentNode =
      parentNodePath === undefined
        ? undefined
        : findHierarchyNode(fileHierarchy, parentNodePath);
    const visiblePaths = new Set(nodes.map((entry) => entry.node.path));
    const hiddenPaths = new Set(
      [
        ...(currentNode?.children ?? []),
        ...(parentNode?.children ?? []).filter(
          (node) => node.path !== currentFolderPath,
        ),
      ]
        .filter((node) => !visiblePaths.has(node.path))
        .map((node) => node.path),
    );
    if (hiddenPaths.size > 0) {
      const more = doc.createElement("button");
      more.type = "button";
      more.className = "constellation-node constellation-more";
      more.dataset.kind = "folder";
      more.dataset.relation = "child";
      more.setAttribute(
        "aria-label",
        `More ${String(hiddenPaths.size)} items; show the complete accessible list`,
      );
      const label = doc.createElement("span");
      label.className = "more-label";
      label.setAttribute("aria-hidden", "true");
      label.textContent = "More";
      const count = doc.createElement("span");
      count.className = "more-count";
      count.setAttribute("aria-hidden", "true");
      count.textContent = `+${String(hiddenPaths.size)}`;
      const content = doc.createElement("span");
      content.className = "constellation-more-content";
      content.append(label, count);
      more.append(content);
      listen(more, "click", () => setFileView("tree"));
      nodeContainer.append(more);
    }
  }

  function constellationNodeSize(
    name: string,
    kind: FileHierarchyNode["kind"],
    relation: "parent" | "current" | "sibling" | "child",
    viewportWidth: number,
  ): number {
    const length = Array.from(name).length;
    const base =
      relation === "current"
        ? 112
        : relation === "parent"
          ? 84
          : kind === "folder"
            ? 88
            : 88;
    const maximum =
      relation === "current"
        ? Math.min(132, Math.max(116, Math.floor(viewportWidth * 0.34)))
        : relation === "parent"
          ? 92
          : Math.min(120, Math.max(96, Math.floor(viewportWidth * 0.3)));
    const extra = Math.ceil(Math.max(0, length - 8) * 5.5);
    return Math.min(maximum, base + extra);
  }

  function bubbleLabel(name: string): string {
    const separated = name.replace(/([._-])/gu, "$1\u200B");
    return Array.from(name).length > 14
      ? separated.replace(/([a-z0-9])([A-Z])/gu, "$1\u200B$2")
      : separated;
  }

  function fileVisualType(name: string): string {
    const extension = name.split(".").at(-1)?.toLowerCase();
    if (
      [
        "avif",
        "bmp",
        "gif",
        "ico",
        "jpeg",
        "jpg",
        "png",
        "svg",
        "webp",
      ].includes(extension ?? "")
    ) {
      return "image";
    }
    if (["ts", "tsx", "js", "jsx", "py", "rs", "go"].includes(extension ?? "")) {
      return "code";
    }
    if (["md", "txt", "log"].includes(extension ?? "")) {
      return "document";
    }
    return "other";
  }

  function createConstellationIcon(
    kind: FileHierarchyNode["kind"],
  ): HTMLSpanElement {
    const span = doc.createElement("span");
    span.className = "node-icon";
    span.setAttribute("aria-hidden", "true");
    const namespace = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    const outline = doc.createElementNS(namespace, "path");
    outline.setAttribute(
      "d",
      kind === "folder"
        ? "M3.5 7.25c0-1.1.9-2 2-2h4.1l2.15 2.25h6.75c1.1 0 2 .9 2 2v8.25c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.25Z"
        : "M6 3.75h7.25L18 8.5v11.75H6V3.75Z",
    );
    svg.append(outline);
    if (kind === "file") {
      const fold = doc.createElementNS(namespace, "path");
      fold.setAttribute("d", "M13.25 3.75V8.5H18");
      svg.append(fold);
    }
    span.append(svg);
    return span;
  }

  function fileIcon(name: string): string {
    const extension = name.split(".").at(-1)?.toLowerCase();
    if (
      [
        "avif",
        "bmp",
        "gif",
        "ico",
        "jpeg",
        "jpg",
        "png",
        "svg",
        "webp",
      ].includes(extension ?? "")
    ) {
      return "▧";
    }
    if (["ts", "tsx", "js", "jsx", "py", "rs", "go"].includes(extension ?? "")) {
      return "⌘";
    }
    if (["md", "txt", "log"].includes(extension ?? "")) {
      return "▤";
    }
    return "•";
  }

  function renderFileTree(): void {
    const target = required<HTMLElement>(doc, "file-tree");
    target.setAttribute("role", "tree");
    const rootList = doc.createElement("ul");
    rootList.append(renderTreeNode(fileHierarchy, 1));
    target.replaceChildren(rootList);
  }

  function renderTreeNode(
    node: FileHierarchyNode,
    level: number,
  ): HTMLLIElement {
    const item = doc.createElement("li");
    item.setAttribute("role", "none");
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "tree-row";
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-level", String(level));
    if (node.path === currentFolderPath) {
      button.setAttribute("aria-current", "true");
    }
    button.textContent = `${node.kind === "folder" ? "□" : fileIcon(node.name)} ${node.name}`;
    if (node.kind === "folder") {
      button.setAttribute(
        "aria-expanded",
        loadedFolders.has(node.path) ? "true" : "false",
      );
    }
    listen(button, "click", () => {
      if (node.kind === "folder") {
        void navigateToFolder(node.path);
      } else {
        void openFile(node.path);
      }
    });
    item.append(button);
    if (node.children.length > 0) {
      const list = doc.createElement("ul");
      list.setAttribute("role", "group");
      node.children.forEach((child) =>
        list.append(renderTreeNode(child, level + 1)),
      );
      item.append(list);
    }
    return item;
  }

  async function searchFiles(query: string): Promise<void> {
    const result = await transport
      .send<{ files: string[] }>({
        id: crypto.randomUUID(),
        type: "files.search",
        query,
      })
      .catch((error: unknown) => {
        showError(error);
        return { files: [] };
      });
    renderFileResults(
      result.files.map((path) => ({
        label: path,
        path,
      })),
    );
  }

  async function searchSymbols(query: string): Promise<void> {
    const result = await transport
      .send<{
        symbols: Array<{
          name: string;
          kind: string;
          path: string;
          line: number;
          preview: string;
        }>;
      }>({
        id: crypto.randomUUID(),
        type: "symbols.search",
        query,
      })
      .catch((error: unknown) => {
        showError(error);
        return { symbols: [] };
      });
    renderFileResults(
      result.symbols.map((symbol) => ({
        label: `${symbol.kind} ${symbol.name} · ${symbol.path}:${symbol.line}`,
        path: symbol.path,
        line: symbol.line,
        detail: symbol.preview,
      })),
    );
  }

  function renderFileResults(
    results: Array<{
      label: string;
      path: string;
      line?: number;
      detail?: string;
    }>,
  ): void {
    const target = required<HTMLElement>(doc, "file-results");
    target.hidden = false;
    target.replaceChildren(
      ...results.map((result) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.textContent = result.label;
        if (result.detail) {
          button.title = result.detail;
        }
        listen(button, "click", () =>
          void openFile(result.path, result.line),
        );
        return button;
      }),
    );
    if (results.length === 0) {
      const empty = doc.createElement("p");
      empty.className = "security-note";
      empty.textContent = "No matching tracked or unignored files.";
      target.append(empty);
    }
  }

  async function openFile(
    file: string,
    line?: number,
    options: { revealPreview?: boolean } = {},
  ): Promise<void> {
    const listedNode = fileNodeMetadata.get(file);
    const readablePath = listedNode?.displayPath ?? file;
    const result = await transport
      .send<RemoteFilePreview>({
        id: crypto.randomUUID(),
        type: "file.read",
        path: readablePath,
      })
      .catch((error: unknown) => {
        showError(error);
        return undefined;
      });
    if (!result) {
      return;
    }
    renderFilePreview(result, file, line, options);
  }

  async function openChatReference(
    reference: MarkdownWorkspaceReference,
  ): Promise<void> {
    required<HTMLButtonElement>(doc, "tab-files").click();
    // A direct chat reference should not wait for a large hierarchy to finish
    // loading. The navigator can catch up independently after the viewer opens.
    void ensureFileHierarchyLoaded().catch(showError);
    const lineSuffix =
      reference.line === undefined
        ? ""
        : `#L${reference.line}${reference.endLine === undefined ? "" : `-L${reference.endLine}`}`;
    const result = await transport.send<RemoteFileReferencePreview>({
      id: crypto.randomUUID(),
      type: "file.reference.read",
      reference: `${reference.path}${lineSuffix}`,
    });
    const knownNode = [...fileNodeMetadata.entries()].find(
      ([, metadata]) => metadata.displayPath === result.path,
    )?.[0];
    const selectedPath =
      knownNode ?? directoryUiPath(result.rootId, result.relativePath);
    renderFilePreview(
      result,
      selectedPath,
      result.line ?? reference.line,
      {
        revealPreview: true,
        endLine: result.endLine ?? reference.endLine,
      },
    );
    openFileViewer();
  }

  function renderFilePreview(
    result: RemoteFilePreview,
    selectedPath: string,
    line?: number,
    options: { revealPreview?: boolean; endLine?: number } = {},
  ): void {
    currentFilePreview = result;
    currentFilePath = result.path;
    selectedFileNodePath = selectedPath;
    currentFileContent =
      result.encoding === "utf8" ? result.content : "";
    clearFileLineSelection();
    const folder = parentPath(selectedPath);
    if (folder !== undefined && findHierarchyNode(fileHierarchy, folder)) {
      currentFolderPath = folder;
      renderFileNavigator();
    }
    const requestedEndLine =
      line !== undefined &&
      options.endLine !== undefined &&
      options.endLine >= line
        ? options.endLine
        : undefined;
    required<HTMLElement>(doc, "file-title").textContent = line
      ? `${result.path}:${line}${requestedEndLine === undefined ? "" : `–${requestedEndLine}`}`
      : result.path;
    const image = required<HTMLImageElement>(doc, "file-image");
    const codeWrap = required<HTMLElement>(doc, "file-code-wrap");
    if (
      result.encoding === "base64" &&
      result.mediaType !== undefined &&
      SAFE_REMOTE_IMAGE_MEDIA_TYPES.has(result.mediaType)
    ) {
      image.src = `data:${result.mediaType};base64,${result.content}`;
      image.alt = result.path;
      image.hidden = false;
      codeWrap.hidden = true;
    } else {
      image.removeAttribute("src");
      image.hidden = true;
      codeWrap.hidden = false;
      highlightCode(
        required<HTMLElement>(doc, "file-content"),
        result.content,
        result.language,
      );
      const totalLines = result.content.split("\n").length;
      if (line !== undefined && line <= totalLines) {
        selectedLineStart = line;
        selectedLineEnd = Math.min(
          requestedEndLine ?? line,
          totalLines,
        );
        renderFileLineSelection();
      }
      codeWrap.scrollTop = line ? Math.max(0, (line - 4) * 18.6) : 0;
    }
    required<HTMLButtonElement>(doc, "mention-file").hidden = false;
    required<HTMLButtonElement>(doc, "copy-file-path").hidden = false;
    required<HTMLButtonElement>(doc, "open-file-viewer").hidden = false;
    if (fileViewerDialog.open) {
      renderFileViewer(fileViewerMode);
    }
    if (options.revealPreview) {
      revealFilePreview();
    }
  }

  function revealFilePreview(): void {
    if (filePreviewRevealFrame !== undefined) {
      clock.cancelAnimationFrame(filePreviewRevealFrame);
    }
    filePreviewRevealFrame = clock.requestAnimationFrame(() => {
      filePreviewRevealFrame = undefined;
      const panelBounds = filesPanel.getBoundingClientRect();
      const previewBounds = filePreview.getBoundingClientRect();
      const constellationBounds = required<HTMLElement>(
        doc,
        "constellation-view",
      ).getBoundingClientRect();
      const inset = 12;
      const stacked =
        previewBounds.top >= constellationBounds.bottom - 1;
      const previewHeaderVisible =
        previewBounds.top >= panelBounds.top + inset &&
        previewBounds.top + Math.min(56, previewBounds.height) <=
          panelBounds.bottom - inset;
      if (!stacked && previewHeaderVisible) {
        return;
      }
      const top = Math.min(
        Math.max(
          0,
          filesPanel.scrollTop +
            previewBounds.top -
            panelBounds.top -
            inset,
        ),
        Math.max(0, filesPanel.scrollHeight - filesPanel.clientHeight),
      );
      filesPanel.scrollTo({
        top,
        behavior: view.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }

  function mentionCurrentFile(): void {
    if (!currentFilePath) {
      return;
    }
    const selection = doc.getSelection()?.toString().trim();
    promptInput.value = selection
      ? `In @${currentFilePath}, regarding:\n\n${selection.slice(0, 4_000)}\n\n`
      : `In @${currentFilePath}, `;
    switchToChatAndFocus();
    resizeComposer();
  }

  function selectFileLine(line: number): void {
    if (
      selectedLineStart === undefined ||
      selectedLineEnd === undefined ||
      selectedLineStart !== selectedLineEnd
    ) {
      selectedLineStart = line;
      selectedLineEnd = line;
    } else {
      selectedLineStart = Math.min(selectedLineStart, line);
      selectedLineEnd = Math.max(selectedLineEnd, line);
    }
    renderFileLineSelection();
  }

  function clearFileLineSelection(): void {
    selectedLineStart = undefined;
    selectedLineEnd = undefined;
    renderFileLineSelection();
  }

  function renderFileLineSelection(): void {
    const actions = required<HTMLElement>(doc, "file-line-actions");
    const selection = required<HTMLElement>(
      doc,
      "file-line-selection",
    );
    const start = selectedLineStart;
    const end = selectedLineEnd;
    const hasSelection =
      start !== undefined && end !== undefined;
    actions.hidden = !hasSelection;
    selection.textContent = hasSelection
      ? start === end
        ? `Line ${start} selected`
        : `Lines ${start}–${end} selected`
      : "No lines selected";
    required<HTMLElement>(doc, "file-content")
      .querySelectorAll<HTMLButtonElement>(".code-line")
      .forEach((lineElement) => {
        const line = Number(lineElement.dataset.line);
        lineElement.setAttribute(
          "aria-pressed",
          String(
            hasSelection &&
              line >= (start ?? Number.POSITIVE_INFINITY) &&
              line <= (end ?? Number.NEGATIVE_INFINITY),
          ),
        );
      });
  }

  function askAboutSelectedLines(): void {
    if (
      !currentFilePath ||
      selectedLineStart === undefined ||
      selectedLineEnd === undefined
    ) {
      return;
    }
    const excerpt = currentFileContent
      .split("\n")
      .slice(selectedLineStart - 1, selectedLineEnd)
      .join("\n")
      .slice(0, 4_000);
    const lineLabel =
      selectedLineStart === selectedLineEnd
        ? `line ${selectedLineStart}`
        : `lines ${selectedLineStart}-${selectedLineEnd}`;
    promptInput.value =
      `In @${currentFilePath} ${lineLabel}, please review:\n\n${excerpt}\n\n`;
    switchToChatAndFocus();
    resizeComposer();
  }

  function highlightCode(
    element: HTMLElement,
    source: string,
    language: string,
    selectable = true,
  ): void {
    element.replaceChildren();
    element.dataset.language = language;
    element.className = "code-lines";
    const lines = source.split("\n");
    if (
      source.length > LARGE_SOURCE_RENDER_BYTES ||
      lines.length > LARGE_SOURCE_RENDER_LINES
    ) {
      // Keep multi-megabyte logs and generated files usable on a phone. A
      // single selectable text node avoids constructing tens of thousands of
      // buttons while preserving the entire bounded preview for search/copy.
      element.classList.add("code-lines-large");
      element.dataset.renderMode = "performance";
      element.setAttribute(
        "aria-label",
        `Large ${language || "text"} file in performance view; line selection is unavailable`,
      );
      element.textContent = source;
      return;
    }
    delete element.dataset.renderMode;
    element.removeAttribute("aria-label");
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const lineElement = doc.createElement(
        selectable ? "button" : "span",
      );
      if (lineElement instanceof HTMLButtonElement) {
        lineElement.type = "button";
      }
      lineElement.className = "code-line";
      lineElement.dataset.line = String(lineNumber);
      lineElement.setAttribute(
        "aria-label",
        `Line ${lineNumber}: ${line || "blank"}`,
      );
      if (selectable) {
        lineElement.setAttribute("aria-pressed", "false");
      }
      highlightLine(lineElement, line);
      if (selectable) {
        listen(lineElement, "click", () => selectFileLine(lineNumber));
      }
      element.append(lineElement);
    });
  }

  function highlightLine(element: HTMLElement, source: string): void {
    const keywords = new Set([
      "async",
      "await",
      "break",
      "case",
      "class",
      "const",
      "continue",
      "def",
      "else",
      "export",
      "false",
      "for",
      "from",
      "function",
      "if",
      "import",
      "in",
      "interface",
      "let",
      "new",
      "null",
      "public",
      "return",
      "switch",
      "true",
      "type",
      "undefined",
      "while",
    ]);
    const token =
      /\/\/.*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b/gu;
    let offset = 0;
    for (const match of source.matchAll(token)) {
      const index = match.index;
      if (index > offset) {
        element.append(doc.createTextNode(source.slice(offset, index)));
      }
      const value = match[0];
      const span = doc.createElement("span");
      span.className =
        value.startsWith("//") || value.startsWith("/*")
          ? "syntax-comment"
          : value.startsWith('"') ||
              value.startsWith("'") ||
              value.startsWith("`")
            ? "syntax-string"
            : keywords.has(value)
              ? "syntax-keyword"
              : /^\d/u.test(value)
                ? "syntax-number"
                : "syntax-identifier";
      span.textContent = value;
      element.append(span);
      offset = index + value.length;
    }
    if (offset < source.length) {
      element.append(doc.createTextNode(source.slice(offset)));
    }
  }

  function setupChanges(): void {
    listen(required(doc, "refresh-changes"), "click", () =>
      void refreshChanges(),
    );
    listen(required(doc, "staged-toggle-label"), "click", (event) =>
      event.stopPropagation(),
    );
    listen(required(doc, "staged-toggle"), "change", () =>
      void refreshChanges(),
    );
  }

  async function refreshChanges(): Promise<void> {
    const staged = required<HTMLInputElement>(doc, "staged-toggle").checked;
    const [status, diff] = await Promise.all([
      transport.send<{ content: string }>({
        id: crypto.randomUUID(),
        type: "git.status",
      }),
      transport.send<{ content: string }>({
        id: crypto.randomUUID(),
        type: "git.diff",
        staged,
      }),
    ]).catch((error: unknown) => {
      showError(error);
      return [
        { content: "Unable to load status." },
        { content: "Unable to load diff." },
      ];
    });
    required<HTMLElement>(doc, "git-status").textContent =
      status.content || "Working tree clean.";
    required<HTMLElement>(doc, "git-diff").textContent =
      diff.content || "No matching changes.";
  }

  function setupPermissionsAndQuestions(): void {
    const openApprovalButton =
      required<HTMLButtonElement>(doc, "open-approval");
    listen(openApprovalButton, "click", () => {
      openPendingInteraction();
    });
    listen(permissionLayer, "click", (event) => {
      if (event.target === permissionLayer) {
        permissionLayer.hidden = true;
        openApprovalButton.focus();
      }
    });
    listen(permissionLayer, "keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        permissionLayer.hidden = true;
        openApprovalButton.focus();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(
        permissionLayer.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function openPendingInteraction(requestId?: string): void {
    if (
      requestId &&
      (permissions.has(requestId) || questions.has(requestId))
    ) {
      activeInteractionId = requestId;
    } else if (
      !activeInteractionId ||
      (!permissions.has(activeInteractionId) &&
        !questions.has(activeInteractionId))
    ) {
      activeInteractionId =
        permissions.keys().next().value ??
        questions.keys().next().value;
    }
    renderPendingInteraction();
    permissionLayer.hidden = false;
    permissionLayer
      .querySelector<HTMLButtonElement>("button")
      ?.focus();
  }

  function queuePermission(permission: PendingPermission): void {
    if (permissions.has(permission.requestId)) {
      return;
    }
    permissions.set(permission.requestId, permission);
    activeInteractionId ??= permission.requestId;
    setPhase("Waiting for your approval", {
      tone: "warning",
    });
    renderPendingInteraction();
    notifyApproval(permission.requestId);
  }

  function queueQuestion(question: PendingQuestion): void {
    if (
      questions.has(question.requestId) ||
      question.questions.length === 0
    ) {
      return;
    }
    questions.set(question.requestId, question);
    activeInteractionId ??= question.requestId;
    setPhase("Waiting for your answer", {
      tone: "warning",
    });
    renderPendingInteraction();
    notifyApproval(question.requestId);
  }

  function renderPendingInteraction(): void {
    const count = permissions.size + questions.size;
    approvalAlert.hidden = count === 0;
    if (count === 0) {
      activeInteractionId = undefined;
      permissionLayer.hidden = true;
      permissionLayer.replaceChildren();
      return;
    }
    if (
      !activeInteractionId ||
      (!permissions.has(activeInteractionId) &&
        !questions.has(activeInteractionId))
    ) {
      activeInteractionId =
        permissions.keys().next().value ??
        questions.keys().next().value;
    }
    const permission = activeInteractionId
      ? permissions.get(activeInteractionId)
      : undefined;
    const question = activeInteractionId
      ? questions.get(activeInteractionId)
      : undefined;
    permissionLayer.hidden = false;
    if (permission) {
      renderPermissionSheet(permission);
    } else if (question) {
      renderQuestionSheet(question);
    }
  }

  function renderPermissionSheet(permission: PendingPermission): void {
    const article = doc.createElement("article");
    article.className = "permission-card";
    article.dataset.requestId = permission.requestId;
    article.setAttribute("role", "dialog");
    article.setAttribute("aria-modal", "true");
    article.setAttribute("aria-labelledby", "approval-title");
    const impact = doc.createElement("p");
    impact.className = "impact-label";
    impact.textContent = "Approval required";
    const heading = doc.createElement("h3");
    heading.id = "approval-title";
    heading.textContent =
      permission.title ??
      `${permission.displayName ?? permission.toolName} needs approval`;
    const description = doc.createElement("p");
    description.className = "markdown-inline";
    markdownRenderer.renderInline(
      description,
      permission.description ??
      permission.autoSafeReason ??
      permission.decisionReason ??
      "Review the impact before allowing this action on your Mac.",
    );
    const raw = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent = "View command and raw details";
    const details = doc.createElement("pre");
    details.textContent = JSON.stringify(permission.input, null, 2);
    raw.append(summary, details);
    const actions = doc.createElement("div");
    actions.className = "permission-actions";
    const deny = doc.createElement("button");
    deny.type = "button";
    deny.className = "deny-button";
    deny.textContent = "Deny";
    const allow = doc.createElement("button");
    allow.type = "button";
    allow.className = "allow-button";
    allow.textContent = "Allow once";
    listen(deny, "click", () =>
      resolvePermission(permission.requestId, "deny"),
    );
    listen(allow, "click", () =>
      resolvePermission(permission.requestId, "allow"),
    );
    actions.append(deny, allow);
    if ((permission.sessionSuggestions?.length ?? 0) > 0) {
      const allowSession = doc.createElement("button");
      allowSession.type = "button";
      allowSession.className = "allow-button allow-session-button";
      allowSession.textContent = "Allow for this session";
      listen(allowSession, "click", () =>
        resolvePermission(permission.requestId, "allow-session"),
      );
      actions.append(allowSession);
    }
    article.append(impact, heading, description, raw, actions);
    permissionLayer.replaceChildren(article);
    allow.focus();
  }

  function resolvePermission(
    requestId: string,
    decision: "allow" | "allow-session" | "deny",
  ): void {
    void transport
      .send({
        id: crypto.randomUUID(),
        type: "permission.resolve",
        requestId,
        decision,
      })
      .then(() => removePermission(requestId))
      .catch(showError);
  }

  function removePermission(requestId: string): void {
    if (!requestId) {
      return;
    }
    permissions.delete(requestId);
    notifiedApprovals.delete(requestId);
    if (activeInteractionId === requestId) {
      activeInteractionId = undefined;
    }
    renderPendingInteraction();
  }

  function renderQuestionSheet(request: PendingQuestion): void {
    const form = doc.createElement("form");
    form.className = "permission-card question-card";
    form.dataset.questionRequestId = request.requestId;
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    const impact = doc.createElement("p");
    impact.className = "impact-label";
    impact.textContent = "Input required";
    const heading = doc.createElement("h3");
    heading.textContent = "Claude needs your input";
    form.append(impact, heading);

    request.questions.forEach((question, questionIndex) => {
      const fieldset = doc.createElement("fieldset");
      fieldset.className = "question-fieldset";
      const legend = doc.createElement("legend");
      legend.className = "markdown-inline";
      markdownRenderer.renderInline(
        legend,
        question.header
          ? `**${question.header}:** ${question.question}`
          : question.question,
      );
      fieldset.append(legend);
      question.options.forEach((option, optionIndex) => {
        const label = doc.createElement("label");
        label.className = "question-option";
        const input = doc.createElement("input");
        input.type = question.multiSelect ? "checkbox" : "radio";
        input.name = `question-${questionIndex}`;
        input.value = option.label;
        input.id = `question-${questionIndex}-${optionIndex}`;
        const copy = doc.createElement("span");
        const optionLabel = doc.createElement("strong");
        optionLabel.textContent = option.label;
        copy.append(optionLabel);
        if (option.description) {
          const description = doc.createElement("small");
          description.className = "markdown-inline";
          markdownRenderer.renderInline(
            description,
            option.description,
          );
          copy.append(description);
        }
        label.append(input, copy);
        fieldset.append(label);
      });
      const custom = doc.createElement("input");
      custom.className = "question-custom";
      custom.name = `question-${questionIndex}-custom`;
      custom.placeholder =
        question.options.length > 0
          ? "Or type another answer"
          : "Type your answer";
      custom.maxLength = 4_000;
      fieldset.append(custom);
      form.append(fieldset);
    });

    const actions = doc.createElement("div");
    actions.className = "permission-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "deny-button";
    cancel.textContent = "Cancel turn";
    listen(cancel, "click", () => {
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "turn.cancel",
        })
        .catch(showError);
    });
    const submit = doc.createElement("button");
    submit.type = "submit";
    submit.className = "allow-button";
    submit.textContent = "Answer";
    actions.append(cancel, submit);
    form.append(actions);
    listen(form, "submit", (event) => {
      event.preventDefault();
      const answers: Record<string, string> = {};
      for (const [questionIndex, question] of request.questions.entries()) {
        const selected = Array.from(
          form.querySelectorAll<HTMLInputElement>(
            `[name="question-${questionIndex}"]:checked`,
          ),
          (input) => input.value,
        );
        const custom = form
          .querySelector<HTMLInputElement>(
            `[name="question-${questionIndex}-custom"]`,
          )
          ?.value.trim();
        if (custom) {
          selected.push(custom);
        }
        if (selected.length === 0) {
          toast(
            `Answer “${question.header ?? question.question}” first.`,
          );
          return;
        }
        answers[question.question] = selected.join(", ");
      }
      submit.disabled = true;
      void transport
        .send({
          id: crypto.randomUUID(),
          type: "question.resolve",
          requestId: request.requestId,
          answers,
        })
        .then(() => removeQuestion(request.requestId))
        .catch((error: unknown) => {
          submit.disabled = false;
          showError(error);
        });
    });
    permissionLayer.replaceChildren(form);
    form.querySelector<HTMLInputElement>("input")?.focus();
  }

  function removeQuestion(requestId: string): void {
    if (!requestId) {
      return;
    }
    questions.delete(requestId);
    notifiedApprovals.delete(requestId);
    if (activeInteractionId === requestId) {
      activeInteractionId = undefined;
    }
    renderPendingInteraction();
  }

  function setupSettings(): void {
    const notificationButton = required<HTMLButtonElement>(
      doc,
      "notification-button",
    );
    listen(notificationButton, "click", () => {
      void (async () => {
        if (!notifications?.supported()) {
          toast("Approval alerts are not supported by this browser.");
          return;
        }
        const permission = await notifications.requestPermission();
        notificationsEnabled = permission === "granted";
        notificationButton.textContent = notificationsEnabled
          ? "Approval alerts enabled"
          : "Enable approval alerts";
        toast(
          notificationsEnabled
            ? "Approval alerts enabled for this remote session."
            : "Approval alerts were not enabled.",
        );
      })();
    });
    listen(handbackButton, "click", () => {
      if (
        !view.confirm(
          "Finish the active turn, verify this exact conversation, and return it to the laptop?",
        )
      ) {
        return;
      }
      sendHandback("finish");
    });
    listen(cancelHandbackButton, "click", () => {
      if (
        !view.confirm(
          "Cancel the active Claude turn and return this conversation immediately? Unsaved response progress may be lost.",
        )
      ) {
        return;
      }
      sendHandback("cancel");
    });
    const sendHandbackControl = (
      type:
        | "session.handback.continue"
        | "session.handback.cancel-request",
    ): void => {
      const operationId = currentOperationalStatus?.operation?.id;
      if (!operationId) {
        showError(new Error("The Mac has not supplied the active hand-back operation yet. Please try again when its status appears."));
        return;
      }
      for (const button of [
        handbackContinueWaiting,
        handbackCancelRequest,
        handbackCancelWork,
      ]) {
        button.disabled = true;
      }
      void transport.send({
        id: crypto.randomUUID(),
        type,
        operationId,
      }).then(() => {
        toast(
          type === "session.handback.continue"
            ? "ModelHop will keep waiting for durable completion."
            : "Hand-back cancelled. Remote input will resume when the Mac confirms it.",
        );
      }).catch((error: unknown) => {
        showError(error);
      }).finally(() => {
        for (const button of [
          handbackContinueWaiting,
          handbackCancelRequest,
          handbackCancelWork,
        ]) {
          button.disabled = false;
        }
      });
    };
    listen(handbackContinueWaiting, "click", () => {
      sendHandbackControl("session.handback.continue");
    });
    listen(handbackCancelRequest, "click", () => {
      if (
        view.confirm(
          "Cancel the hand-back request and keep this conversation on your phone? Running work will continue.",
        )
      ) {
        sendHandbackControl("session.handback.cancel-request");
      }
    });
    listen(handbackCancelWork, "click", () => {
      if (
        !view.confirm(
          "Explicitly cancel all active Claude work and return now? Unfinished workflow output may be lost.",
        )
      ) {
        return;
      }
      sendHandback("cancel");
    });
  }

  function notifyApproval(id: string): void {
    if (notifiedApprovals.has(id)) {
      return;
    }
    notifiedApprovals.add(id);
    notifications?.vibrate?.([120, 80, 120]);
    if (
      notificationsEnabled &&
      notifications?.permission() === "granted"
    ) {
      notifications.notify({
        id,
        title: "ModelHop needs your approval",
        body: "Open ModelHop Remote to continue.",
        onClick: () => {
          view.focus();
          openPendingInteraction(id);
        },
      });
    }
  }

  function notifyCompletionIfHidden(): void {
    if (
      doc.hidden &&
      notificationsEnabled &&
      notifications?.permission() === "granted"
    ) {
      notifications.notify({
        id: `complete-${clock.now()}`,
        title: "ModelHop task finished",
        body: "Open ModelHop Remote to review the result.",
        onClick: () => view.focus(),
      });
    }
  }

  function switchToChatAndFocus(): void {
    required<HTMLButtonElement>(doc, "tab-chat").click();
    required<HTMLButtonElement>(doc, "view-conversation").click();
    promptInput.focus();
  }

  function toast(message: string): void {
    if (currentLease?.state === "stopped") {
      return;
    }
    const element = doc.createElement("div");
    element.className = "toast";
    const text = doc.createElement("span");
    text.textContent = message;
    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.textContent = "×";
    listen(dismiss, "click", () => element.remove());
    element.append(text, dismiss);
    toastRegion.append(element);
    const timer = clock.setTimeout(() => element.remove(), 6_000);
    listen(element, "mouseenter", () => clock.clearTimeout(timer));
    listen(element, "focusin", () => clock.clearTimeout(timer));
  }

  function showError(error: unknown): void {
    const message =
      error instanceof Error ? error.message : String(error);
    toast(message);
  }

  setupTabs();
  setupTaskViews();
  setupHeaderViewControls();
  setupChat();
  setupDialogsAndRoute();
  setupAttachments();
  setupFiles();
  setupChanges();
  setupPermissionsAndQuestions();
  setupSettings();
  listen(connectionButton, "click", () => {
    toast(
      connectionButton.dataset.state === "secure"
        ? "End-to-end encrypted and connected to your Mac."
        : `Remote connection: ${connectionState.textContent ?? "unknown"}.`,
    );
  });
  app.hidden = false;
  setPhase("Waiting for session", { busy: true });
  if (!pendingScrollRestore) {
    clock.requestAnimationFrame(() => scrollToBottom(false));
  }

  return {
    applyBatch,
    applyEvent,
    updateLease,
    updateProvider,
    setConnection,
    destroy: () => {
      abortController.abort();
      chatMesh.destroy();
      clock.clearInterval(elapsedTimer);
      if (streamFrame !== undefined) {
        clock.cancelAnimationFrame(streamFrame);
      }
      if (scrollStateFrame !== undefined) {
        clock.cancelAnimationFrame(scrollStateFrame);
      }
      if (filePreviewRevealFrame !== undefined) {
        clock.cancelAnimationFrame(filePreviewRevealFrame);
      }
      if (suggestionTimer !== undefined) {
        clock.clearTimeout(suggestionTimer);
      }
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 16_384;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + chunkSize),
    );
  }
  return btoa(binary);
}

function webIdentifier(...values: unknown[]): string {
  const value = values.find(
    (candidate) =>
      typeof candidate === "string" ||
      typeof candidate === "number",
  );
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function stableStringHash(value: unknown): string {
  let source: string;
  try {
    source = JSON.stringify(value, (_key, candidate: unknown) => {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        Array.isArray(candidate)
      ) {
        return candidate;
      }
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      );
    });
  } catch {
    source = String(value);
  }
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
