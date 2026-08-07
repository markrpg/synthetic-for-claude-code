import { createHash, randomUUID } from "node:crypto";
import type {
  CanUseTool,
  EffortLevel,
  ModelInfo,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  Settings,
  ThinkingConfig,
  query as createSdkQuery,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type {
  PendingPermission,
  PendingQuestion,
  RemoteActivityEvent,
  RemoteConversationEvent,
  RemoteQuestion,
  RemoteDaemonConfiguration,
  RemoteOperation,
  RemoteModelCatalog,
  RemoteModelCatalogSource,
  RemoteModelOption,
  RemotePermissionMode,
  RemoteProviderContext,
  RemoteReasoningChange,
  RemoteRuntimeSnapshot,
  RemoteSessionPermissionSuggestion,
  RemoteSessionLease,
  RemoteSessionCapabilities,
  RemoteUsageSnapshot,
  RemoteWorkItem,
  RemoteWorkItemKind,
  RemoteWorkItemPhase,
} from "./types.js";
import type { RemoteEventJournal } from "./eventJournal.js";
import {
  activeTranscriptPath,
  repairModelHopTranscriptVisibility,
} from "./transcriptIntegrity.js";
import {
  assertRemoteRuntimeModel,
  findUniqueRemoteModelOption,
  normaliseAnthropicModelSelector,
  RemoteProviderModelMismatchError,
  resolveRemoteRuntimeModelObservation,
  sdkModelForProvider,
} from "./providerRuntime.js";
import {
  assertSupportedRemoteEffort,
  isRemoteReasoningEffort,
  remoteEffortRequiresClaudeThinking,
  resolveRemoteReasoningContext,
  type RemoteReasoningSettingsSnapshot,
} from "./reasoningCapabilities.js";
import {
  classifyTranscriptFrame,
  transcriptFrameHasToolResult,
  transcriptTextFromContent,
} from "./transcriptFrameClassifier.js";
import { classifyAutoSafeTool } from "./autoSafePolicy.js";

interface PendingPermissionResolver {
  resolve: (result: PermissionResult) => void;
  abort: () => void;
  sessionSuggestions: PermissionUpdate[];
}

interface PendingQuestionResolver {
  resolve: (result: PermissionResult) => void;
  abort: () => void;
  input: Record<string, unknown>;
  toolUseId: string;
}

type QueryFactory = typeof createSdkQuery;

interface ActiveRemoteQuery {
  generation: number;
  query: Query;
  provider: RemoteProviderContext;
  initialized: boolean;
  closing: boolean;
  runner?: Promise<void>;
  startupFailure: Promise<never>;
  rejectStartup: (error: Error) => void;
  normalisationState: SdkMessageNormalisationState;
  modelCatalog: ModelInfo[];
  reasoningSettings: RemoteReasoningSettingsSnapshot;
  restoreReasoningFlags: boolean;
  runtimeThinkingEnabled?: boolean;
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<SDKUserMessage>) => void
  > = [];
  private ended = false;

  public push(value: SDKUserMessage): void {
    if (this.ended) {
      throw new Error("The remote Claude input stream is closed.");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  public end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        const value = this.values.shift();
        if (value) {
          return { value, done: false };
        }
        if (this.ended) {
          return { value: undefined, done: true };
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function cloneForRemote(value: unknown): unknown {
  const serialised = JSON.stringify(
    value,
    (key, candidate: unknown) => {
      const normalised = key.toLowerCase().replaceAll("_", "");
      if (
        [
          "apikey",
          "accesstoken",
          "refreshtoken",
          "authtoken",
          "authorization",
          "credentials",
          "environment",
          "env",
        ].includes(normalised)
      ) {
        return "[REDACTED]";
      }
      return candidate;
    },
  );
  return serialised === undefined
    ? undefined
    : (JSON.parse(serialised) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function remoteReasoningSettingsSnapshot(
  value: unknown,
): RemoteReasoningSettingsSnapshot {
  if (!isRecord(value)) {
    return {};
  }
  return {
    ...(typeof value.alwaysThinkingEnabled === "boolean"
      ? { alwaysThinkingEnabled: value.alwaysThinkingEnabled }
      : {}),
    ...(isRemoteReasoningEffort(value.effortLevel)
      ? { effortLevel: value.effortLevel }
      : {}),
    ...(typeof value.enableWorkflows === "boolean"
      ? { enableWorkflows: value.enableWorkflows }
      : {}),
    ...(typeof value.disableWorkflows === "boolean"
      ? { disableWorkflows: value.disableWorkflows }
      : {}),
    ...(typeof value.ultracode === "boolean"
      ? { ultracode: value.ultracode }
      : {}),
  };
}

function environmentDisablesWorkflows(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment.CLAUDE_CODE_DISABLE_WORKFLOWS === "1";
}

function settingsFromReasoningContext(
  provider: RemoteProviderContext,
): RemoteReasoningSettingsSnapshot {
  const reasoning = provider.reasoning;
  if (!reasoning) {
    return {};
  }
  return {
    alwaysThinkingEnabled: reasoning.thinkingEnabled,
    ...(reasoning.effectiveEffort
      ? { effortLevel: reasoning.effectiveEffort }
      : {}),
    enableWorkflows: reasoning.workflows.enabled,
    ultracode: reasoning.ultra.enabled,
  };
}

type QueryFlagSettings = Parameters<Query["applyFlagSettings"]>[0];

const CLAUDE_ADAPTIVE_THINKING_TOKENS = 31_999;

type QueryWithSettingsReadback = Query & {
  getSettings?: () => Promise<unknown>;
};

function activeSdkEffort(
  effort: RemoteReasoningSettingsSnapshot["effortLevel"],
): EffortLevel | undefined {
  return effort && effort !== "none" ? effort : undefined;
}

function usesClaudeRuntimeThinking(
  provider: RemoteProviderContext["provider"],
): boolean {
  return provider === "anthropic" || provider === "synthetic";
}

function normaliseReasoningSettingsForLaunch(
  provider: RemoteProviderContext,
  settings: RemoteReasoningSettingsSnapshot,
  modelHopOwned: boolean,
): {
  settings: RemoteReasoningSettingsSnapshot;
  repairedInvalidAnthropicPair: boolean;
} {
  const next = { ...settings };
  const effort = activeSdkEffort(next.effortLevel);
  let repairedInvalidAnthropicPair = false;
  if (
    remoteEffortRequiresClaudeThinking(provider.provider, effort) &&
    next.alwaysThinkingEnabled !== true
  ) {
    // Retained capability metadata can be stale after a Claude Code/model
    // upgrade. Repair the unsafe pair for launch, then let the fresh SDK
    // initialization catalog validate support before accepting prompts.
    next.alwaysThinkingEnabled = true;
    repairedInvalidAnthropicPair = true;
  }
  if (provider.provider === "synthetic" && modelHopOwned && effort) {
    const reasoning = provider.reasoning;
    if (
      !reasoning ||
      reasoning.effortAuthority === undefined ||
      reasoning.effortAuthority === "unavailable" ||
      !reasoning.supportedEffortLevels.includes(effort)
    ) {
      throw new Error(
        `${provider.model} did not authoritatively advertise ${effort} reasoning through Synthetic. ModelHop will not guess or silently substitute an effort.`,
      );
    }
  }
  return { settings: next, repairedInvalidAnthropicPair };
}

function sdkReasoningLaunchOptions(
  settings: RemoteReasoningSettingsSnapshot,
): {
  thinking: ThinkingConfig;
  effort?: EffortLevel;
  settings: Settings;
} {
  const effort = activeSdkEffort(settings.effortLevel);
  const launchSettings: Settings = {
    alwaysThinkingEnabled:
      settings.alwaysThinkingEnabled === true,
    ...(typeof settings.enableWorkflows === "boolean"
      ? { enableWorkflows: settings.enableWorkflows }
      : {}),
    ...(settings.enableWorkflows === true
      ? { workflowSizeGuideline: "small" as const }
      : {}),
    ...(typeof settings.ultracode === "boolean"
      ? { ultracode: settings.ultracode }
      : {}),
  };
  if (effort && effort !== "max") {
    launchSettings.effortLevel = effort;
  }
  return {
    thinking:
      settings.alwaysThinkingEnabled === true
        ? { type: "adaptive", display: "summarized" }
        : { type: "disabled" },
    ...(effort ? { effort } : {}),
    settings: launchSettings,
  };
}

/**
 * `applyFlagSettings` shallow-merges into a session-owned flag layer. A
 * failed control request is not documented as atomic, so compensating writes
 * must explicitly restore every key ModelHop can mutate. `null` clears a key
 * back to the lower-precedence Claude setting.
 */
function restoringReasoningFlags(
  settings: RemoteReasoningSettingsSnapshot,
): QueryFlagSettings {
  return {
    alwaysThinkingEnabled:
      settings.alwaysThinkingEnabled ?? null,
    effortLevel:
      settings.effortLevel && settings.effortLevel !== "none"
        ? settings.effortLevel
        : null,
    enableWorkflows: settings.enableWorkflows ?? null,
    workflowSizeGuideline:
      settings.enableWorkflows === true ? "small" : null,
    ultracode: settings.ultracode ?? null,
  };
}

function catalogSourceForProvider(
  provider: RemoteProviderContext["provider"],
): RemoteModelCatalogSource {
  switch (provider) {
    case "synthetic":
      return "synthetic-api";
    case "openai-api":
      return "openai-api";
    case "openai-codex":
      return "codex-model-list";
    case "anthropic":
      return "claude-sdk";
  }
}

function serialiseModelCatalog(
  provider: RemoteProviderContext,
  models: readonly ModelInfo[],
  now = Date.now(),
): RemoteModelCatalog | undefined {
  if (models.length === 0 && !provider.modelCatalog) {
    return undefined;
  }
  const source = catalogSourceForProvider(provider.provider);
  const options = new Map<string, RemoteModelOption>();
  for (const existing of provider.modelCatalog?.options ?? []) {
    options.set(existing.selector, structuredClone(existing));
  }
  for (const model of models) {
    const selector =
      provider.provider === "anthropic"
        ? normaliseAnthropicModelSelector(model.value)
        : model.value.trim();
    if (!selector) {
      continue;
    }
    const existing = options.get(selector);
    const efforts = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter(isRemoteReasoningEffort)
      : undefined;
    const sdkDisplayName = model.displayName?.trim();
    const displayName =
      sdkDisplayName &&
      (sdkDisplayName !== selector || !existing?.displayName)
        ? sdkDisplayName
        : existing?.displayName ?? selector;
    options.set(selector, {
      selector,
      ...(model.resolvedModel ?? existing?.resolvedModel
        ? { resolvedModel: model.resolvedModel ?? existing?.resolvedModel }
        : {}),
      displayName,
      ...(model.description?.trim() || existing?.description
        ? { description: model.description?.trim() || existing?.description }
        : {}),
      source,
      isDefault: selector === "default",
      supportsEffort: model.supportsEffort ?? existing?.supportsEffort,
      ...(efforts && efforts.length > 0
        ? { supportedEffortLevels: efforts }
        : existing?.supportedEffortLevels
          ? { supportedEffortLevels: existing.supportedEffortLevels }
        : {}),
      supportsAdaptiveThinking:
        model.supportsAdaptiveThinking ??
        existing?.supportsAdaptiveThinking,
      ...(existing?.contextWindow
        ? { contextWindow: existing.contextWindow }
        : {}),
    });
  }
  return {
    source,
    authoritative: models.length > 0,
    options: [...options.values()],
    updatedAt: now,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function providerResetDetail(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // Claude currently reports epoch seconds. Also accept milliseconds so a
  // future SDK change cannot produce a misleading date in 1970.
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  const reset = new Date(milliseconds);
  return Number.isNaN(reset.getTime())
    ? undefined
    : `Resets at ${reset.toISOString()}`;
}

function remotePermissionMode(
  value: unknown,
): RemotePermissionMode {
  return value === "acceptEdits" ||
    value === "plan" ||
    value === "default"
    ? value
    : "auto-safe";
}

type NormalisedJournalEvent =
  | {
      type: "conversation.item";
      payload: RemoteConversationEvent;
    }
  | {
      type: "activity.event";
      payload: RemoteActivityEvent;
    }
  | {
      type: "usage.snapshot";
      payload: RemoteUsageSnapshot;
    }
  | {
      type: "session.capabilities";
      payload: RemoteSessionCapabilities;
    };

type ActivityJournalEvent = {
  type: "activity.event";
  payload: RemoteActivityEvent;
};

/**
 * Per-query state used to collapse the SDK's many partial-message UUIDs into
 * one durable conversation item for the current user turn.
 */
export interface SdkMessageNormalisationState {
  assistantStreams?: Map<string, AssistantMessageState>;
  tools?: Map<string, ToolOperationState>;
  toolBlockIds?: Map<string, string>;
  tasks?: Map<string, TaskOperationState>;
  backgroundTaskIds?: Set<string>;
  agentText?: Map<string, string>;
  /** Last authoritative permission mode for capability-only SDK updates. */
  permissionMode?: RemotePermissionMode;
}

interface AssistantMessageState {
  itemId?: string;
  sdkMessageId?: string;
  createdAt?: number;
  contentBlocks?: Array<Record<string, unknown>>;
}

interface ToolOperationState {
  id: string;
  name: string;
  title: string;
  streamKey: string;
  createdAt: number;
  input?: unknown;
}

interface TaskOperationState {
  id: string;
  title: string;
  createdAt: number;
  phase?: "active" | "settling" | "terminal";
}

const ROOT_ASSISTANT_STREAM = "main";

function assistantStreamKey(
  value: Record<string, unknown>,
): string {
  return typeof value.parent_tool_use_id === "string" &&
    value.parent_tool_use_id
    ? `nested:${value.parent_tool_use_id}`
    : ROOT_ASSISTANT_STREAM;
}

function assistantStreamState(
  state: SdkMessageNormalisationState,
  key: string,
): AssistantMessageState {
  state.assistantStreams ??= new Map();
  let stream = state.assistantStreams.get(key);
  if (!stream) {
    stream = {};
    state.assistantStreams.set(key, stream);
  }
  return stream;
}

function resetAssistantMessageNormalisationState(
  state: SdkMessageNormalisationState,
  key?: string,
): void {
  if (key) {
    state.assistantStreams?.delete(key);
    return;
  }
  state.assistantStreams?.clear();
}

export function resetSdkMessageNormalisationState(
  state: SdkMessageNormalisationState,
): void {
  resetAssistantMessageNormalisationState(state);
  state.tools?.clear();
  state.toolBlockIds?.clear();
  state.tasks?.clear();
  state.backgroundTaskIds?.clear();
  state.agentText?.clear();
}

function assistantIdentity(
  value: Record<string, unknown>,
  sdkId: string,
  now: number,
  state?: AssistantMessageState,
): {
  itemId: string;
  sdkMessageId: string;
  createdAt: number;
} {
  const message = isRecord(value.message) ? value.message : undefined;
  const streamEvent = isRecord(value.event) ? value.event : undefined;
  const streamMessage =
    streamEvent?.type === "message_start" &&
    isRecord(streamEvent.message)
      ? streamEvent.message
      : undefined;
  const canonicalSdkMessageId =
    typeof message?.id === "string"
      ? message.id
      : typeof streamMessage?.id === "string"
        ? streamMessage.id
        : undefined;

  if (!state) {
    const identity = canonicalSdkMessageId ?? sdkId;
    return {
      itemId: identity,
      sdkMessageId: identity,
      createdAt: now,
    };
  }

  if (canonicalSdkMessageId && state.sdkMessageId !== canonicalSdkMessageId) {
    state.itemId = undefined;
    state.sdkMessageId = undefined;
    state.createdAt = undefined;
    state.contentBlocks = undefined;
  }

  state.itemId ??= canonicalSdkMessageId ?? sdkId;
  state.sdkMessageId ??= canonicalSdkMessageId ?? sdkId;
  state.createdAt ??= now;
  return {
    itemId: state.itemId,
    sdkMessageId: state.sdkMessageId,
    createdAt: state.createdAt,
  };
}

function blockString(
  block: Record<string, unknown>,
  key: "text" | "thinking",
): string | undefined {
  return typeof block[key] === "string" ? block[key] : undefined;
}

function replaceOrAppendAssistantBlock(
  blocks: Array<Record<string, unknown>>,
  incoming: Record<string, unknown>,
): void {
  const type = typeof incoming.type === "string" ? incoming.type : "";
  const id =
    typeof incoming.id === "string"
      ? incoming.id
      : typeof incoming.tool_use_id === "string"
        ? incoming.tool_use_id
        : undefined;
  if (id) {
    const existingIndex = blocks.findIndex(
      (block) =>
        block.type === type &&
        (block.id === id || block.tool_use_id === id),
    );
    if (existingIndex >= 0) {
      blocks[existingIndex] = incoming;
      return;
    }
  }

  const textKey =
    type === "text"
      ? "text"
      : type === "thinking"
        ? "thinking"
        : undefined;
  if (textKey) {
    const incomingText = blockString(incoming, textKey);
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const existing = blocks[index];
      if (existing?.type !== type) {
        continue;
      }
      const existingText = blockString(existing, textKey);
      if (
        incomingText !== undefined &&
        existingText !== undefined
      ) {
        if (
          incomingText === existingText ||
          existingText.startsWith(incomingText)
        ) {
          return;
        }
        if (incomingText.startsWith(existingText)) {
          blocks[index] = incoming;
          return;
        }
      }
      break;
    }
  }

  const serialised = JSON.stringify(incoming);
  if (blocks.some((block) => JSON.stringify(block) === serialised)) {
    return;
  }
  blocks.push(incoming);
}

function assistantContent(
  content: unknown,
  state?: AssistantMessageState,
): unknown {
  const cloned = cloneForRemote(content);
  if (!state || !Array.isArray(cloned)) {
    return cloned;
  }
  state.contentBlocks ??= [];
  for (const block of cloned) {
    if (isRecord(block)) {
      replaceOrAppendAssistantBlock(
        state.contentBlocks,
        block,
      );
    }
  }
  return cloneForRemote(state.contentBlocks);
}

function isToolResultUserFrame(
  value: Record<string, unknown>,
  content: unknown,
): boolean {
  return transcriptFrameHasToolResult({
    ...value,
    message: { content },
  });
}

function sdkEventTimestamp(
  value: Record<string, unknown>,
  fallback = Date.now(),
): number {
  if (typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) {
    return value.timestamp;
  }
  if (typeof value.timestamp === "string") {
    const parsed = Date.parse(value.timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function stableSdkEventId(value: Record<string, unknown>): string {
  if (typeof value.uuid === "string" && value.uuid) {
    return value.uuid;
  }
  return `sdk-${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24)}`;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function narrativeAssistantBlocks(
  content: unknown,
): Array<Record<string, unknown>> {
  return contentBlocks(content).filter(
    (block) => block.type === "text" || block.type === "thinking",
  );
}

function toolUseBlocks(content: unknown): Array<Record<string, unknown>> {
  return contentBlocks(content).filter(
    (block) =>
      block.type === "tool_use" || block.type === "server_tool_use",
  );
}

function conciseOperationValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > 88 ? `${compact.slice(0, 85)}…` : compact;
}

function xmlEnvelopeValue(
  text: string,
  tag: string,
): string | undefined {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`,
    "iu",
  ).exec(text);
  const value = match?.[1]?.replace(/\s+/gu, " ").trim();
  return value || undefined;
}

function taskNotificationActivity(
  value: Record<string, unknown>,
  text: string,
  now: number,
  sdkId: string,
  state?: SdkMessageNormalisationState,
): ActivityJournalEvent {
  const taskId = xmlEnvelopeValue(text, "task-id") ?? sdkId;
  const status = xmlEnvelopeValue(text, "status")?.toLowerCase();
  const summary = xmlEnvelopeValue(text, "summary");
  const existing = state?.tasks?.get(taskId);
  const title =
    status === "failed"
      ? "Background task failed"
      : status === "stopped"
        ? "Background task stopped"
        : summary && summary.length <= 120
          ? summary
          : "Background task complete";
  const createdAt = existing?.createdAt ?? now;
  if (state) {
    state.tasks ??= new Map();
    state.tasks.set(taskId, {
      id: taskId,
      title,
      createdAt,
      phase: "terminal",
    });
    state.backgroundTaskIds?.delete(taskId);
  }
  const detail = summary
    ? summary.length > 420
      ? `${summary.slice(0, 417)}…`
      : summary
    : undefined;
  const event = activity(
    `task:${taskId}`,
    "task",
    status === "failed" ? "failed" : "complete",
    title,
    { taskId, status, summary },
    detail === title ? undefined : detail,
    now,
    createdAt,
  );
  event.payload.taskId = taskId;
  return event;
}

function toolPresentation(
  name: string,
  input: unknown,
): { title: string; detail?: string } {
  const record = isRecord(input) ? input : {};
  const path =
    conciseOperationValue(record.file_path) ??
    conciseOperationValue(record.path) ??
    conciseOperationValue(record.notebook_path);
  const description = conciseOperationValue(record.description);
  const command = conciseOperationValue(record.command);
  const query =
    conciseOperationValue(record.query) ??
    conciseOperationValue(record.pattern);
  switch (name.toLowerCase()) {
    case "read":
      return { title: path ? `Reading ${path}` : "Reading a file", detail: path };
    case "write":
      return { title: path ? `Writing ${path}` : "Writing a file", detail: path };
    case "edit":
    case "multiedit":
      return { title: path ? `Editing ${path}` : "Editing a file", detail: path };
    case "bash":
      return {
        title: description ?? "Running a command",
        detail: command,
      };
    case "agent":
    case "task":
      return {
        title: description ?? "Delegating focused work",
        detail: conciseOperationValue(record.prompt),
      };
    case "glob":
    case "grep":
    case "search":
      return {
        title: query ? `Searching for ${query}` : "Searching the workspace",
        detail: path,
      };
    default:
      return {
        title: `${name || "Tool"} is running`,
        detail: description ?? path ?? command ?? query,
      };
  }
}

function toolOperation(
  state: SdkMessageNormalisationState | undefined,
  block: Record<string, unknown>,
  streamKey: string,
  now: number,
): ToolOperationState | undefined {
  const toolUseId =
    typeof block.id === "string"
      ? block.id
      : typeof block.tool_use_id === "string"
        ? block.tool_use_id
        : undefined;
  if (!toolUseId) {
    return undefined;
  }
  const existing = state?.tools?.get(toolUseId);
  const name =
    typeof block.name === "string"
      ? block.name
      : existing?.name ?? "Tool";
  const input = Object.hasOwn(block, "input") ? block.input : existing?.input;
  const presentation = toolPresentation(name, input);
  const operation: ToolOperationState = {
    id: toolUseId,
    name,
    title: presentation.title,
    streamKey,
    createdAt: existing?.createdAt ?? now,
    input,
  };
  if (state) {
    state.tools ??= new Map();
    state.tools.set(toolUseId, operation);
  }
  return operation;
}

function toolActivity(
  operation: ToolOperationState,
  phase: RemoteActivityEvent["phase"],
  data: unknown,
  updatedAt: number,
  detail?: string,
): ActivityJournalEvent {
  const presentation = toolPresentation(operation.name, operation.input);
  return {
    type: "activity.event",
    payload: {
      kind: "activity.event",
      id: `tool:${operation.id}`,
      category: "tool",
      phase,
      title:
        phase === "complete"
          ? presentation.title.replace(/ is running$/, " complete")
          : phase === "failed"
            ? `${operation.name} failed`
            : presentation.title,
      detail: detail ?? presentation.detail,
      createdAt: operation.createdAt,
      updatedAt,
      toolUseId: operation.id,
      data: cloneForRemote(data),
    },
  };
}

function activity(
  id: string,
  category: RemoteActivityEvent["category"],
  phase: RemoteActivityEvent["phase"],
  title: string,
  data: unknown,
  detail?: string,
  timestamp = Date.now(),
  createdAt = timestamp,
): ActivityJournalEvent {
  return {
    type: "activity.event",
    payload: {
      kind: "activity.event",
      id,
      category,
      phase,
      title,
      detail,
      createdAt,
      updatedAt: timestamp,
      data: cloneForRemote(data),
    },
  };
}

/**
 * Converts the broad Claude SDK event union into the small, stable protocol
 * understood by ModelHop clients. Unknown SDK events remain visible as
 * activity instead of being rendered as empty chat messages.
 */
export function normaliseSdkMessage(
  message: SDKMessage,
  provider: RemoteProviderContext,
  outgoingPromptIds: ReadonlyMap<
    string,
    string | { id: string; content: string }
  > = new Map(),
  state?: SdkMessageNormalisationState,
): NormalisedJournalEvent[] {
  const value = message as unknown as Record<string, unknown>;
  const now = sdkEventTimestamp(value);
  const sdkId = stableSdkEventId(value);
  const sessionId =
    typeof value.session_id === "string"
      ? value.session_id
      : undefined;

  // These SDK transport acknowledgements carry no user-facing information.
  // Rendering them during transcript bootstrap made old "Request sent"
  // entries appear late and interleave with the current turn's real phases.
  if (
    value.type === "system" &&
    (value.subtype === "request_sent" ||
      value.subtype === "request_started")
  ) {
    return [];
  }

  if (value.type === "user" && isRecord(value.message)) {
    const content = value.message.content;
    if (isToolResultUserFrame(value, content)) {
      if (state) {
        resetAssistantMessageNormalisationState(
          state,
          ROOT_ASSISTANT_STREAM,
        );
      }
      const blocks = contentBlocks(content).filter(
        (block) => block.type === "tool_result",
      );
      const resultBlocks = blocks.length > 0 ? blocks : [{}];
      return resultBlocks.map((block, index) => {
        const toolUseId =
          typeof block.tool_use_id === "string"
            ? block.tool_use_id
            : typeof value.parent_tool_use_id === "string"
              ? value.parent_tool_use_id
              : `${sdkId}:${String(index)}`;
        const known = state?.tools?.get(toolUseId);
        const operation: ToolOperationState =
          known ?? {
            id: toolUseId,
            name: "Tool",
            title: "Tool operation",
            streamKey: ROOT_ASSISTANT_STREAM,
            createdAt: now,
          };
        const failed = block.is_error === true;
        return toolActivity(
          operation,
          failed ? "failed" : "complete",
          Object.keys(block).length > 0
            ? block
            : value.tool_use_result ?? value.toolUseResult ?? content,
          now,
          failed ? "Claude Code reported a tool error." : undefined,
        );
      });
    }
    const originKind = isRecord(value.origin)
      ? value.origin.kind
      : undefined;
    const envelopeText = transcriptTextFromContent(content);
    if (
      originKind === "task-notification" &&
      envelopeText
    ) {
      return [
        taskNotificationActivity(
          value,
          envelopeText,
          now,
          sdkId,
          state,
        ),
      ];
    }
    if (classifyTranscriptFrame(value) !== "human-narrative") {
      return [];
    }
    const text = transcriptTextFromContent(content);
    if (!text) {
      return [];
    }
    const outgoing = outgoingPromptIds.get(sdkId);
    const itemId =
      typeof outgoing === "string"
        ? outgoing
        : outgoing?.id ?? sdkId;
    return [
      {
        type: "conversation.item",
        payload: {
          kind: "conversation.item",
          operation: "upsert",
          item: {
            id: itemId,
            sdkMessageId: sdkId,
            turnId: sessionId,
            role: "user",
            status: "accepted",
            content:
              typeof outgoing === "object"
                ? outgoing.content
                : text,
            createdAt: now,
            updatedAt: now,
            synthetic: false,
          },
        },
      },
    ];
  }

  if (value.type === "assistant" && isRecord(value.message)) {
    const streamKey = assistantStreamKey(value);
    const streamState = state
      ? assistantStreamState(state, streamKey)
      : undefined;
    const identity = assistantIdentity(
      value,
      sdkId,
      now,
      streamState,
    );
    const tools = toolUseBlocks(value.message.content).flatMap((block) => {
      const operation = toolOperation(state, block, streamKey, now);
      return operation
        ? [toolActivity(operation, "running-tool", block, now)]
        : [];
    });
    const narrative = narrativeAssistantBlocks(value.message.content);
    const parentToolUseId =
      typeof value.parent_tool_use_id === "string"
        ? value.parent_tool_use_id
        : undefined;
    if (parentToolUseId) {
      const text = transcriptTextFromContent(narrative);
      if (!text) {
        return tools;
      }
      const previous = state?.agentText?.get(parentToolUseId);
      const completeText =
        previous && !text.startsWith(previous) ? `${previous}\n${text}` : text;
      if (state) {
        state.agentText ??= new Map();
        state.agentText.set(parentToolUseId, completeText);
      }
      const parent = state?.tools?.get(parentToolUseId);
      return [
        activity(
          `agent:${parentToolUseId}`,
          "task",
          value.error ? "failed" : "running-task",
          parent?.title ?? "Subagent is working",
          value,
          completeText,
          now,
          parent?.createdAt ?? now,
        ),
        ...tools,
      ];
    }
    if (narrative.length === 0) {
      return tools;
    }
    return [
      {
        type: "conversation.item",
        payload: {
          kind: "conversation.item",
          operation: "upsert",
          item: {
            id: identity.itemId,
            sdkMessageId: identity.sdkMessageId,
            turnId: sessionId,
            role: "assistant",
            status: value.error ? "failed" : "complete",
            content: assistantContent(narrative, streamState),
            createdAt: identity.createdAt,
            updatedAt: now,
            error:
              typeof value.error === "string"
                ? value.error
                : undefined,
          },
        },
      },
      ...tools,
    ];
  }

  if (value.type === "stream_event" && isRecord(value.event)) {
    const streamEvent = value.event;
    const streamKey = assistantStreamKey(value);
    const streamState = state
      ? assistantStreamState(state, streamKey)
      : undefined;
    const identity = assistantIdentity(
      value,
      sdkId,
      now,
      streamState,
    );
    const blockIndex =
      typeof streamEvent.index === "number" ? streamEvent.index : undefined;
    if (
      streamEvent.type === "content_block_start" &&
      isRecord(streamEvent.content_block) &&
      (streamEvent.content_block.type === "tool_use" ||
        streamEvent.content_block.type === "server_tool_use")
    ) {
      const operation = toolOperation(
        state,
        streamEvent.content_block,
        streamKey,
        now,
      );
      if (!operation) {
        return [];
      }
      if (state && blockIndex !== undefined) {
        state.toolBlockIds ??= new Map();
        state.toolBlockIds.set(
          `${streamKey}:${String(blockIndex)}`,
          operation.id,
        );
      }
      return [toolActivity(operation, "running-tool", streamEvent, now)];
    }
    const delta = isRecord(streamEvent.delta)
      ? streamEvent.delta
      : undefined;
    const deltaText =
      delta &&
      (typeof delta.text === "string"
        ? delta.text
        : typeof delta.partial_json === "string"
          ? delta.partial_json
          : typeof delta.thinking === "string"
            ? delta.thinking
            : undefined);
    if (deltaText) {
      const deltaKind =
        delta?.type === "thinking_delta"
          ? "thinking"
          : delta?.type === "input_json_delta"
            ? "input-json"
            : "text";
      if (deltaKind === "input-json") {
        const toolUseId =
          state && blockIndex !== undefined
            ? state.toolBlockIds?.get(
                `${streamKey}:${String(blockIndex)}`,
              )
            : undefined;
        const operation = toolUseId
          ? state?.tools?.get(toolUseId)
          : undefined;
        return operation
          ? [
              toolActivity(
                operation,
                "running-tool",
                streamEvent,
                now,
                "Preparing tool input…",
              ),
            ]
          : [];
      }
      const parentToolUseId =
        typeof value.parent_tool_use_id === "string"
          ? value.parent_tool_use_id
          : undefined;
      if (parentToolUseId) {
        const previous = state?.agentText?.get(parentToolUseId) ?? "";
        const text = `${previous}${deltaText}`;
        if (state) {
          state.agentText ??= new Map();
          state.agentText.set(parentToolUseId, text);
        }
        const parent = state?.tools?.get(parentToolUseId);
        return [
          activity(
            `agent:${parentToolUseId}`,
            "task",
            "running-task",
            parent?.title ?? "Subagent is working",
            streamEvent,
            text,
            now,
            parent?.createdAt ?? now,
          ),
        ];
      }
      return [
        {
          type: "conversation.item",
          payload: {
            kind: "conversation.item",
            operation: "delta",
            item: {
              id: identity.itemId,
              sdkMessageId: identity.sdkMessageId,
              turnId: sessionId,
              role: "assistant",
              status: "streaming",
              content: "",
              createdAt: identity.createdAt,
              updatedAt: now,
              parentToolUseId:
                typeof value.parent_tool_use_id === "string"
                  ? value.parent_tool_use_id
                  : undefined,
            },
            delta: {
              kind: deltaKind,
              text: deltaText,
              contentBlockIndex:
                typeof streamEvent.index === "number"
                  ? streamEvent.index
                  : undefined,
            },
          },
        },
      ];
    }
    return [];
  }

  if (value.type === "rate_limit_event" && isRecord(value.rate_limit_info)) {
    const info = value.rate_limit_info;
    const status =
      typeof info.status === "string" ? info.status : "allowed";
    const overageStatus =
      typeof info.overageStatus === "string"
        ? info.overageStatus
        : undefined;
    const rejected =
      status === "rejected" || overageStatus === "rejected";
    const warning =
      status === "allowed_warning" || overageStatus === "allowed_warning";
    return [
      activity(
        sdkId,
        rejected ? "error" : "information",
        rejected ? "failed" : warning ? "requesting" : "idle",
        rejected
          ? "Provider allowance exhausted"
          : warning
            ? "Provider allowance is running low"
            : "Provider allowance available",
        value,
        providerResetDetail(info.resetsAt ?? info.overageResetsAt),
      ),
    ];
  }

  if (value.type === "result") {
    const usage = isRecord(value.usage) ? value.usage : {};
    const inputTokens =
      numberValue(usage.input_tokens) +
      numberValue(usage.cache_creation_input_tokens) +
      numberValue(usage.cache_read_input_tokens);
    const outputTokens = numberValue(usage.output_tokens);
    return [
      activity(
        sdkId,
        value.is_error === true ? "error" : "lifecycle",
        value.is_error === true ? "failed" : "complete",
        value.is_error === true ? "Turn failed" : "Turn complete",
        value,
        typeof value.stop_reason === "string"
          ? value.stop_reason
          : undefined,
      ),
      {
        type: "usage.snapshot",
        payload: {
          kind: "usage.snapshot",
          provider: provider.provider,
          status: "available",
          model: provider.model,
          updatedAt: now,
          session: {
            inputTokens,
            outputTokens,
            cacheReadTokens: numberValue(
              usage.cache_read_input_tokens,
            ),
            cacheCreationTokens: numberValue(
              usage.cache_creation_input_tokens,
            ),
            totalTokens: inputTokens + outputTokens,
            costUsd: numberValue(value.total_cost_usd),
            requests: Math.max(1, numberValue(value.num_turns)),
          },
          allowance: cloneForRemote(provider.usage),
        },
      },
    ];
  }

  if (value.type === "system" && value.subtype === "init") {
    const permissionMode = remotePermissionMode(value.permissionMode);
    if (state) {
      state.permissionMode = permissionMode;
    }
    return [
      {
        type: "session.capabilities",
        payload: {
          kind: "session.capabilities",
          model: provider.model,
          permissionMode,
          tools: Array.isArray(value.tools)
            ? value.tools.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
          commands: Array.isArray(value.slash_commands)
            ? value.slash_commands.flatMap((entry) =>
                typeof entry === "string"
                  ? [{ name: entry.replace(/^\//, "") }]
                  : [],
              )
            : [],
          skills: Array.isArray(value.skills)
            ? value.skills.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
          protocolCapabilities: Array.isArray(value.capabilities)
            ? value.capabilities.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
          reasoning: provider.reasoning,
          updatedAt: now,
        },
      },
      activity(
        sdkId,
        "lifecycle",
        "idle",
        "Claude Code is ready",
        {
          model: value.model,
          version: value.claude_code_version,
        },
      ),
    ];
  }

  if (value.type === "system" && value.subtype === "status") {
    const status = value.status;
    return [
      activity(
        sdkId,
        status === "compacting" ? "compaction" : "status",
        status === "compacting"
          ? "compacting"
          : status === "requesting"
            ? "requesting"
            : "streaming",
        status === "compacting"
          ? "Compressing conversation"
          : status === "requesting"
            ? "Requesting model response"
            : value.compact_result === "failed"
              ? "Conversation compression failed"
              : "Model response started",
        value,
        typeof value.compact_error === "string"
          ? value.compact_error
          : undefined,
      ),
    ];
  }

  if (value.type === "system" && value.subtype === "compact_boundary") {
    return [
      activity(
        sdkId,
        "compaction",
        "streaming",
        "Conversation compressed",
        value.compact_metadata,
      ),
    ];
  }

  if (
    value.type === "system" &&
    (value.subtype === "task_started" ||
      value.subtype === "task_progress" ||
      value.subtype === "task_notification" ||
      value.subtype === "task_updated")
  ) {
    const taskId =
      typeof value.task_id === "string" ? value.task_id : sdkId;
    const existing = state?.tasks?.get(taskId);
    const title =
      typeof value.description === "string" && value.description.trim()
        ? value.description.trim()
        : existing?.title ??
          (value.subtype === "task_started"
        ? "Background task started"
        : value.subtype === "task_progress"
          ? "Background task in progress"
          : value.subtype === "task_updated"
            ? "Background task updated"
            : value.status === "failed"
              ? "Background task failed"
              : value.status === "stopped"
                ? "Background task stopped"
                : "Background task complete");
    const createdAt = existing?.createdAt ?? now;
    const normalisedStatus =
      typeof value.status === "string"
        ? value.status.toLowerCase()
        : undefined;
    const terminal =
      value.subtype === "task_notification" ||
      (value.subtype === "task_updated" &&
        normalisedStatus !== undefined &&
        [
          "complete",
          "completed",
          "success",
          "succeeded",
          "failed",
          "stopped",
          "cancelled",
          "canceled",
        ].includes(normalisedStatus));
    if (state) {
      state.tasks ??= new Map();
      state.tasks.set(taskId, {
        id: taskId,
        title,
        createdAt,
        phase: terminal ? "terminal" : "active",
      });
      if (terminal) {
        state.backgroundTaskIds?.delete(taskId);
      }
    }
    const event = activity(
      `task:${taskId}`,
      "task",
      terminal
        ? value.status === "failed"
          ? "failed"
          : "complete"
        : "running-task",
      title,
      value,
      typeof value.summary === "string"
          ? value.summary
          : typeof value.last_tool_name === "string"
            ? `Using ${value.last_tool_name}`
            : undefined,
      now,
      createdAt,
    );
    event.payload.taskId = taskId;
    return [event];
  }

  if (
    value.type === "system" &&
    value.subtype === "background_tasks_changed"
  ) {
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    const currentIds = new Set<string>();
    const events = tasks.flatMap((candidate, index) => {
      if (!isRecord(candidate)) {
        return [];
      }
      const taskId =
        typeof candidate.task_id === "string"
          ? candidate.task_id
          : typeof candidate.id === "string"
            ? candidate.id
            : `${sdkId}:${String(index)}`;
      currentIds.add(taskId);
      const existing = state?.tasks?.get(taskId);
      const title =
        typeof candidate.description === "string" &&
        candidate.description.trim()
          ? candidate.description.trim()
          : existing?.title ?? "Background task";
      const createdAt = existing?.createdAt ?? now;
      if (state) {
        state.tasks ??= new Map();
        state.tasks.set(taskId, {
          id: taskId,
          title,
          createdAt,
          phase: "active",
        });
      }
      const event = activity(
        `task:${taskId}`,
        "task",
        "running-task",
        title,
        candidate,
        undefined,
        now,
        createdAt,
      );
      event.payload.taskId = taskId;
      return [event];
    });
    if (state) {
      state.backgroundTaskIds ??= new Set();
      for (const priorId of state.backgroundTaskIds) {
        if (currentIds.has(priorId)) {
          continue;
        }
        const prior = state.tasks?.get(priorId);
        if (prior?.phase === "terminal") {
          continue;
        }
        if (prior) {
          prior.phase = "settling";
        }
        const event = activity(
          `task:${priorId}`,
          "task",
          "settling",
          prior?.title ?? "Background task is finishing",
          { task_id: priorId, status: "settling" },
          "Final workflow record pending",
          now,
          prior?.createdAt ?? now,
        );
        event.payload.taskId = priorId;
        events.push(event);
      }
      state.backgroundTaskIds = currentIds;
    }
    return events;
  }

  if (value.type === "tool_progress") {
    const toolUseId =
      typeof value.tool_use_id === "string" ? value.tool_use_id : sdkId;
    const known = state?.tools?.get(toolUseId);
    const operation: ToolOperationState =
      known ?? {
        id: toolUseId,
        name:
          typeof value.tool_name === "string" ? value.tool_name : "Tool",
        title: "Tool is running",
        streamKey: ROOT_ASSISTANT_STREAM,
        createdAt: now,
      };
    if (state && !known) {
      state.tools ??= new Map();
      state.tools.set(toolUseId, operation);
    }
    const event = toolActivity(operation, "running-tool", value, now);
    event.payload.progress = {
      elapsedMs: numberValue(value.elapsed_time_seconds) * 1_000,
    };
    return [event];
  }

  if (value.type === "system" && value.subtype === "api_retry") {
    return [
      activity(
        sdkId,
        "retry",
        "requesting",
        "Retrying model request",
        value,
        `Attempt ${numberValue(value.attempt)} of ${numberValue(
          value.max_retries,
        )}`,
      ),
    ];
  }

  if (value.type === "system" && value.subtype === "thinking_tokens") {
    return [
      activity(
        sdkId,
        "status",
        "streaming",
        "Thinking",
        value,
        `${numberValue(value.estimated_tokens)} estimated tokens`,
      ),
    ];
  }

  if (
    value.type === "system" &&
    value.subtype === "session_state_changed"
  ) {
    return [
      activity(
        sdkId,
        "status",
        value.state === "idle"
          ? "idle"
          : value.state === "requires_action"
            ? "waiting-approval"
            : "streaming",
        value.state === "idle"
          ? "Ready"
          : value.state === "requires_action"
            ? "Action required"
            : "Working",
        value,
      ),
    ];
  }

  if (value.type === "system" && value.subtype === "commands_changed") {
    const commands = Array.isArray(value.commands)
      ? value.commands.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string") {
            return [];
          }
          return [
            {
              name: entry.name,
              description:
                typeof entry.description === "string"
                  ? entry.description
                  : undefined,
              argumentHint:
                typeof entry.argumentHint === "string"
                  ? entry.argumentHint
                  : undefined,
              aliases: Array.isArray(entry.aliases)
                ? entry.aliases.filter(
                    (alias): alias is string =>
                      typeof alias === "string",
                  )
                : undefined,
            },
          ];
        })
      : [];
    return [
      {
        type: "session.capabilities",
        payload: {
          kind: "session.capabilities",
          model: provider.model,
          permissionMode: state?.permissionMode ?? "auto-safe",
          tools: [],
          commands,
          skills: [],
          protocolCapabilities: [],
          reasoning: provider.reasoning,
          updatedAt: now,
        },
      },
    ];
  }

  const subtype =
    typeof value.subtype === "string"
      ? value.subtype.replaceAll("_", " ")
      : typeof value.type === "string"
        ? value.type.replaceAll("_", " ")
        : "Claude activity";
  return [
    activity(
      sdkId,
      value.type === "system" ? "information" : "status",
      "streaming",
      subtype.charAt(0).toUpperCase() + subtype.slice(1),
      value,
      typeof value.content === "string"
        ? value.content
        : typeof value.text === "string"
          ? value.text
          : undefined,
    ),
  ];
}

function highRiskAskRules(): string[] {
  return [
    "Bash(git push *)",
    "Bash(gh release *)",
    "Bash(rm *)",
    "Bash(sudo *)",
    "Bash(su *)",
    "Bash(chmod *)",
    "Bash(chown *)",
    "Bash(ssh *)",
    "Bash(scp *)",
    "Bash(rsync *)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.config/gh/**)",
    "Read(**/.env)",
    "Write(~/**)",
    "Edit(~/**)",
  ];
}

function safeSessionPermissionSuggestions(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
  sessionRememberable: boolean,
  ruleForced: boolean,
): RemoteSessionPermissionSuggestion[] {
  if (!sessionRememberable || ruleForced) {
    return [];
  }
  const safe = (suggestions ?? []).flatMap((suggestion) => {
    if (
      suggestion.type !== "addRules" ||
      suggestion.behavior !== "allow"
    ) {
      return [];
    }
    const rules = suggestion.rules.filter(
      (rule) =>
        rule.toolName.toLowerCase() === toolName.toLowerCase() &&
        rule.ruleContent === undefined,
    ).map((rule) => ({ toolName: rule.toolName }));
    return rules.length > 0
      ? [
          {
            type: "addRules" as const,
            rules,
            behavior: "allow" as const,
            destination: "session" as const,
          },
        ]
      : [];
  });
  if (safe.length > 0) {
    return safe;
  }
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

export function normaliseRemoteQuestions(
  input: Record<string, unknown>,
): RemoteQuestion[] {
  if (!Array.isArray(input.questions)) {
    return [];
  }
  return input.questions.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    const rawQuestion = record.question;
    if (typeof rawQuestion !== "string") {
      return [];
    }
    const question = rawQuestion.trim().slice(0, 2_000);
    if (!question) {
      return [];
    }
    const options = Array.isArray(record.options)
      ? record.options.slice(0, 20).flatMap((option) => {
          if (typeof option !== "object" || option === null) {
            return [];
          }
          const optionRecord = option as Record<string, unknown>;
          const rawLabel = optionRecord.label;
          if (typeof rawLabel !== "string") {
            return [];
          }
          const label = rawLabel.trim().slice(0, 300);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description:
                typeof optionRecord.description === "string"
                  ? optionRecord.description.slice(0, 1_000)
                  : undefined,
            },
          ];
        })
      : [];
    return [
      {
        question,
        header:
          typeof record.header === "string"
            ? record.header.slice(0, 100)
            : undefined,
        options,
        multiSelect: record.multiSelect === true,
      },
    ];
  });
}

export class RemoteSessionController {
  private input = new AsyncMessageQueue();
  private activeQuery: ActiveRemoteQuery | undefined;
  private queryGeneration = 0;
  private readonly permissions = new Map<
    string,
    PendingPermissionResolver
  >();
  private readonly questions = new Map<
    string,
    PendingQuestionResolver
  >();
  private lease: RemoteSessionLease;
  private busy = false;
  private foregroundTurnActive = false;
  private readonly backgroundTasks = new Map<
    string,
    {
      taskType: string;
      description: string;
      phase: "active" | "settling" | "completion-unknown";
    }
  >();
  private readonly workItems = new Map<string, RemoteWorkItem>();
  private readonly responseWorkByPrompt = new Map<string, string>();
  private currentForegroundWorkId: string | undefined;
  private pendingTurnResult: { isError: boolean } | undefined;
  /**
   * A root assistant API error is terminal evidence even when the SDK omits
   * its usual result frame. A later result is metering-only until the SDK
   * accepts the next queued prompt.
   */
  private ignoreResultsUntilPromptAccepted = false;
  private terminalProviderFailure:
    | { code: string; recordedAt: number; queryGeneration: number }
    | undefined;
  private stopping = false;
  private idleWaiters = new Set<() => void>();
  private readonly outgoingPromptIds = new Map<
    string,
    { id: string; content: string }
  >();
  private routeMutationTail: Promise<void> = Promise.resolve();
  private handbackPreparation:
    | {
        strategy: "finish" | "cancel";
        promise: Promise<RemoteSessionLease>;
        cancelRequested: Promise<void>;
        signalCancel: () => void;
        abortRequested: Promise<void>;
        signalAbort: () => void;
        aborted: boolean;
      }
    | undefined;
  private handbackCancellationInFlight: Promise<void> | undefined;
  private closeInFlight: Promise<void> | undefined;
  private runtimeRevision = 1;
  private routeRevision = 1;
  private ownershipFencingGeneration = 1;
  private readonly journalEpoch = randomUUID();

  public constructor(
    private configuration: RemoteDaemonConfiguration,
    private readonly journal: RemoteEventJournal,
    private readonly onTurnComplete?: () => void | Promise<void>,
    private readonly queryFactory?: QueryFactory,
    private readonly timing: {
      initializationTimeoutMs?: number;
      closeGraceMs?: number;
      cancellationGraceMs?: number;
    } = {},
  ) {
    const permissionMode =
      configuration.lease.permissionMode ??
      remotePermissionMode(configuration.permissionMode);
    configuration.lease.permissionMode = permissionMode;
    configuration.permissionMode =
      permissionMode === "auto-safe" ? "auto" : permissionMode;
    this.lease = configuration.lease;
  }

  public getLease(): RemoteSessionLease {
    return structuredClone(this.lease);
  }

  public isBusy(): boolean {
    return !this.isAuthoritativelyQuiescent();
  }

  public getTerminalProviderFailure():
    | { code: string; recordedAt: number; queryGeneration: number }
    | undefined {
    return this.terminalProviderFailure
      ? { ...this.terminalProviderFailure }
      : undefined;
  }

  public getRuntimeSnapshot(): RemoteRuntimeSnapshot {
    const workItems = [...this.workItems.values()]
      .map((item) => structuredClone(item))
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      );
    const outstanding = workItems.filter(
      (item) => !this.isTerminalWorkPhase(item.phase),
    );
    const quiescent = this.isAuthoritativelyQuiescent();
    let executionState: RemoteRuntimeSnapshot["execution"]["state"];
    if (outstanding.some((item) => item.phase === "completion-unknown")) {
      executionState = "completion-unknown";
    } else if (outstanding.some((item) => item.phase === "settling")) {
      executionState = "settling";
    } else if (outstanding.some((item) => item.phase === "active")) {
      executionState = "running";
    } else if (outstanding.some((item) => item.phase === "queued")) {
      executionState = "queued";
    } else if (this.pendingTurnResult !== undefined) {
      executionState = "settling";
    } else if (this.foregroundTurnActive) {
      executionState = "running";
    } else if (this.outgoingPromptIds.size > 0) {
      executionState = "queued";
    } else if (this.permissions.size > 0 || this.questions.size > 0) {
      executionState = "running";
    } else if (this.lease.state === "error") {
      executionState = "error";
    } else {
      executionState = quiescent ? "idle" : "running";
    }
    const lastProgressAt = workItems.reduce<number | undefined>(
      (latest, item) =>
        latest === undefined
          ? item.lastProgressAt
          : Math.max(latest, item.lastProgressAt),
      undefined,
    );
    const latestEventId = this.journal.latestId();
    return {
      version: 1,
      revision: this.runtimeRevision,
      capturedAt: Date.now(),
      lease: this.getLease(),
      transport: {
        state: "unknown",
        updatedAt: this.lease.lastActivityAt,
      },
      execution: {
        state: executionState,
        queryGeneration: this.queryGeneration,
        workItems,
        foregroundActive: this.foregroundTurnActive,
        quiescent,
        pendingResult: this.pendingTurnResult !== undefined,
        pendingPromptCount: this.outgoingPromptIds.size,
        pendingApprovalCount: this.permissions.size,
        pendingQuestionCount: this.questions.size,
        ...(this.terminalProviderFailure
          ? {
              terminalProviderFailure: {
                ...this.terminalProviderFailure,
              },
            }
          : {}),
        ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
      },
      ownership: {
        workspaceOwnerId: this.configuration.workspaceOwnerId,
        ...(this.lease.ownerDeviceId
          ? { deviceId: this.lease.ownerDeviceId }
          : {}),
        fencingGeneration: this.ownershipFencingGeneration,
      },
      route: {
        revision: this.routeRevision,
        provider: structuredClone(this.lease.provider),
      },
      usage: structuredClone(this.lease.provider.usage),
      journal: {
        epoch: this.journalEpoch,
        latestEventId,
        snapshotCursor: latestEventId,
      },
      pendingInteractions: {
        approvalIds: [...this.permissions.keys()].sort(),
        questionIds: [...this.questions.keys()].sort(),
      },
      ...(this.lease.operation
        ? { operation: structuredClone(this.lease.operation) }
        : {}),
    };
  }

  public async touchRemoteActivity(now = Date.now()): Promise<void> {
    if (this.lease.state === "stopped") {
      return;
    }
    this.lease.lastActivityAt = Math.max(
      this.lease.lastActivityAt,
      now,
    );
    await this.publishState();
  }

  public async revokeRemoteInput(
    reason:
      | "maximum-session"
      | "idle-timeout"
      | "desktop-diverged",
    revokedAt = Date.now(),
  ): Promise<void> {
    if (this.lease.remoteInputRevokedAt !== undefined) {
      return;
    }
    this.lease.remoteInputRevokedAt = revokedAt;
    this.lease.remoteInputRevokedReason = reason;
    const activeTurnContinues = this.isBusy();
    const event = activity(
      `remote-input-${reason}`,
      "lifecycle",
      activeTurnContinues ? this.lease.turnPhase ?? "streaming" : "complete",
      reason === "maximum-session"
        ? "Remote session reached its eight-hour limit"
        : reason === "idle-timeout"
          ? "Remote session reached its idle limit"
          : "Desktop conversation changed",
      { reason, activeTurnContinues },
      reason === "desktop-diverged"
        ? "New phone prompts are disabled to protect transcript ordering. Any active Claude turn continues unless you explicitly cancel it."
        : activeTurnContinues
          ? "New prompts are disabled. The active Claude turn will continue and return to the laptop when it finishes."
          : "New prompts are disabled while ModelHop returns this conversation to the laptop.",
    );
    await this.journal.append(event.type, event.payload);
    await this.publishState();
  }

  public async claimDevice(
    deviceId: string,
    advanceFence = false,
  ): Promise<void> {
    if (this.lease.ownerDeviceId !== deviceId || advanceFence) {
      this.ownershipFencingGeneration += 1;
    }
    this.lease.ownerDeviceId = deviceId;
    this.lease.state =
      this.lease.remoteInputRevokedReason === "desktop-diverged"
        ? "paused-diverged"
        : this.isBusy()
          ? "running"
          : "paired";
    this.lease.lastActivityAt = Date.now();
    await this.publishState();
  }

  public async releaseDeviceOwnership(deviceId: string): Promise<void> {
    if (this.lease.ownerDeviceId !== deviceId) {
      return;
    }
    this.ownershipFencingGeneration += 1;
    this.lease.ownerDeviceId = undefined;
    if (this.lease.operation?.kind === "handback") {
      this.lease.state = "handing-back";
      this.lease.turnPhase = "handing-back";
    } else if (this.isBusy()) {
      this.lease.state = "running";
    } else if (this.lease.state !== "stopped") {
      this.lease.state = "waiting-for-device";
      this.lease.turnPhase = "idle";
    }
    this.lease.lastActivityAt = Date.now();
    await this.publishState();
  }

  public async start(options: {
    resumeSessionId?: string;
    forkSession: boolean;
  }): Promise<void> {
    if (this.activeQuery) {
      return;
    }
    // A new query is a new cancellation/close generation. Resolved promises
    // from the previous query must never suppress work against this one.
    this.handbackPreparation = undefined;
    this.handbackCancellationInFlight = undefined;
    this.closeInFlight = undefined;
    this.stopping = false;
    this.backgroundTasks.clear();
    this.workItems.clear();
    this.responseWorkByPrompt.clear();
    this.currentForegroundWorkId = undefined;
    this.outgoingPromptIds.clear();
    this.pendingTurnResult = undefined;
    this.ignoreResultsUntilPromptAccepted = false;
    this.terminalProviderFailure = undefined;
    this.foregroundTurnActive = false;
    this.lease.backgroundTaskCount = 0;
    this.input = new AsyncMessageQueue();
    if (this.lease.state !== "switching-provider") {
      this.lease.state = this.lease.ownerDeviceId
        ? "paired"
        : "waiting-for-device";
    }
    this.lease.turnPhase =
      this.lease.state === "switching-provider"
        ? "switching-provider"
        : "idle";
    await this.publishState();
    const canUseTool: CanUseTool = async (
      toolName,
      input,
      permission,
    ) => {
      if (toolName === "AskUserQuestion") {
        const questions = normaliseRemoteQuestions(input);
        if (questions.length === 0) {
          return {
            behavior: "deny",
            message:
              "ModelHop Remote received an invalid question payload.",
            toolUseID: permission.toolUseID,
          };
        }
        const request: PendingQuestion = {
          requestId: permission.requestId,
          toolUseId: permission.toolUseID,
          questions,
          createdAt: Date.now(),
        };
        this.upsertWorkItem({
          id: `question:${permission.requestId}`,
          kind: "question",
          parentId: `tool:${permission.toolUseID}`,
          title: "Waiting for your answer",
          phase: "active",
          createdAt: request.createdAt,
          updatedAt: request.createdAt,
          lastProgressAt: request.createdAt,
          cancellable: true,
        });
        this.refreshBusyFromLedger();
        this.lease.state = "waiting-for-question";
        this.lease.turnPhase = "waiting-question";
        await this.journal.append(
          "activity.event",
          activity(
            permission.requestId,
            "question",
            "waiting-question",
            "Claude needs your answer",
            request,
          ).payload,
        );
        await this.journal.append("question.request", request);
        await this.publishState();
        return new Promise<PermissionResult>((resolve) => {
          const abort = (): void => {
            this.questions.delete(permission.requestId);
            this.finishWorkItem(
              `question:${permission.requestId}`,
              "cancelled",
              "explicit-cancellation",
              "question-cancelled",
            );
            this.refreshBusyFromLedger();
            void this.journal
              .append("question.resolved", {
                requestId: permission.requestId,
                cancelled: true,
              })
              .catch(() => undefined);
            resolve({
              behavior: "deny",
              message: "Remote question was cancelled.",
              interrupt: true,
              toolUseID: permission.toolUseID,
              decisionClassification: "user_reject",
            });
          };
          permission.signal.addEventListener("abort", abort, {
            once: true,
          });
          this.questions.set(permission.requestId, {
            input,
            toolUseId: permission.toolUseID,
            resolve: (result) => {
              permission.signal.removeEventListener("abort", abort);
              resolve(result);
            },
            abort,
          });
        });
      }
      const autoSafeDecision =
        this.configuration.permissionMode === "auto" &&
        !permission.matchedAskRule
          ? await classifyAutoSafeTool(toolName, input, {
              workspacePath: this.configuration.lease.workspacePath,
              workspacePaths:
                this.configuration.lease.workspacePaths,
            })
          : undefined;
      if (autoSafeDecision?.behavior === "allow") {
        return {
          behavior: "allow",
          toolUseID: permission.toolUseID,
        };
      }
      const sessionSuggestions = safeSessionPermissionSuggestions(
        toolName,
        permission.suggestions,
        autoSafeDecision?.behavior === "ask" &&
          autoSafeDecision.sessionRememberable === true,
        Boolean(permission.matchedAskRule),
      );
      const request: PendingPermission = {
        requestId: permission.requestId,
        toolUseId: permission.toolUseID,
        toolName,
        input: cloneForRemote(input) as Record<string, unknown>,
        title: permission.title,
        displayName: permission.displayName,
        description: permission.description,
        blockedPath: permission.blockedPath,
        decisionReason: permission.decisionReason,
        autoSafeReason:
          autoSafeDecision?.behavior === "ask"
            ? autoSafeDecision.reason
            : undefined,
        matchedAskRule: permission.matchedAskRule,
        sessionSuggestions,
        createdAt: Date.now(),
      };
      this.upsertWorkItem({
        id: `approval:${permission.requestId}`,
        kind: "approval",
        parentId: `tool:${permission.toolUseID}`,
        title: `${toolName} needs approval`,
        phase: "active",
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        lastProgressAt: request.createdAt,
        cancellable: true,
      });
      this.refreshBusyFromLedger();
      this.lease.state = "waiting-for-permission";
      this.lease.turnPhase = "waiting-approval";
      await this.journal.append(
        "activity.event",
        activity(
          permission.requestId,
          "permission",
          "waiting-approval",
          `${toolName} needs approval`,
          request,
          permission.description,
        ).payload,
      );
      await this.journal.append("permission.request", request);
      await this.publishState();
      return new Promise<PermissionResult>((resolve) => {
        const abort = (): void => {
          this.permissions.delete(permission.requestId);
          this.finishWorkItem(
            `approval:${permission.requestId}`,
            "cancelled",
            "explicit-cancellation",
            "approval-cancelled",
          );
          this.refreshBusyFromLedger();
          void this.journal
            .append("permission.resolved", {
              requestId: permission.requestId,
              decision: "cancelled",
            })
            .catch(() => undefined);
          resolve({
            behavior: "deny",
            message: "Remote permission request was cancelled.",
            interrupt: true,
            toolUseID: permission.toolUseID,
            decisionClassification: "user_reject",
          });
        };
        permission.signal.addEventListener("abort", abort, {
          once: true,
        });
        this.permissions.set(permission.requestId, {
          resolve: (result) => {
            permission.signal.removeEventListener("abort", abort);
            resolve(result);
          },
          abort,
          sessionSuggestions,
        });
      });
    };

    const sdkModule = this.queryFactory
      ? undefined
      : await import("@anthropic-ai/claude-agent-sdk");
    const query = this.queryFactory ?? sdkModule?.query;
    if (!query) {
      throw new Error("Claude Code SDK is unavailable.");
    }
    const modelHopOwnsReasoning = Boolean(this.lease.provider.reasoning);
    const resolvedReasoningSettings = modelHopOwnsReasoning
      ? settingsFromReasoningContext(this.lease.provider)
      : await sdkModule
          ?.resolveSettings({
            cwd: this.configuration.lease.workspacePath,
            settingSources: ["user", "project", "local"],
          })
          .then((resolved) =>
            remoteReasoningSettingsSnapshot(resolved.effective),
          )
          .catch(() => ({})) ?? {};
    const normalisedLaunchReasoning =
      normaliseReasoningSettingsForLaunch(
        this.lease.provider,
        resolvedReasoningSettings,
        modelHopOwnsReasoning,
      );
    const reasoningSettings = normalisedLaunchReasoning.settings;
    // A stale false+xhigh/max settings pair is unsafe even when it predates
    // ModelHop ownership. Repair it for this session before the first prompt.
    const restoreReasoningFlags =
      modelHopOwnsReasoning ||
      normalisedLaunchReasoning.repairedInvalidAnthropicPair;
    const launchReasoningOptions = restoreReasoningFlags
      ? sdkReasoningLaunchOptions(reasoningSettings)
      : {};
    const sdkQuery = query({
      prompt: this.input,
      options: {
        cwd: this.configuration.lease.workspacePath,
        additionalDirectories: (
          this.configuration.lease.workspacePaths ?? []
        ).filter(
          (workspacePath) =>
            workspacePath !==
            this.configuration.lease.workspacePath,
        ),
        pathToClaudeCodeExecutable:
          this.configuration.claudeExecutable,
        env: {
          ...process.env,
          ...this.configuration.environment,
          CLAUDE_AGENT_SDK_CLIENT_APP: "modelhop-remote/1.0.0",
          CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
        },
        resume:
          options.resumeSessionId ??
          this.configuration.lease.sourceSessionId,
        forkSession: options.forkSession,
        settingSources: ["user", "project", "local"],
        permissionMode: this.configuration.permissionMode,
        // Resumed Claude sessions retain their previous explicit model unless
        // the SDK caller overrides it. Pin the target route so switching away
        // from Kimi/GPT cannot silently resume that model under an Anthropic
        // label (and vice versa).
        model: sdkModelForProvider(this.lease.provider),
        ...launchReasoningOptions,
        canUseTool,
        includePartialMessages: true,
        forwardSubagentText: true,
        enableFileCheckpointing: true,
        agentProgressSummaries: true,
        managedSettings: {
          permissions: {
            ask: highRiskAskRules(),
            disableBypassPermissionsMode: "disable",
          },
        },
      },
    });
    let rejectStartup!: (error: Error) => void;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    const activeQuery: ActiveRemoteQuery = {
      generation: ++this.queryGeneration,
      query: sdkQuery,
      provider: structuredClone(this.lease.provider),
      initialized: false,
      closing: false,
      startupFailure,
      rejectStartup,
      normalisationState: {
        permissionMode:
          this.lease.permissionMode ??
          remotePermissionMode(this.configuration.permissionMode),
      },
      modelCatalog: [],
      reasoningSettings,
      restoreReasoningFlags,
      runtimeThinkingEnabled:
        usesClaudeRuntimeThinking(this.lease.provider.provider)
          ? reasoningSettings.alwaysThinkingEnabled
          : undefined,
    };
    this.activeQuery = activeQuery;
    activeQuery.runner = this.consume(activeQuery);
    try {
      const initialization =
        await this.waitForInitialization(activeQuery);
      if (!this.isCurrent(activeQuery)) {
        throw new Error(
          "The remote Claude session was replaced during initialization.",
        );
      }
      await this.markInitialized(activeQuery, initialization);
    } catch (error) {
      this.input.end();
      await this.closeActiveQuery(activeQuery);
      throw error;
    }
  }

  public sendPrompt(
    prompt: string,
    attachmentPaths: readonly string[] = [],
    clientMessageId: string = randomUUID(),
  ): Promise<void> {
    return this.withRouteMutation(() =>
      this.sendPromptSerial(
        prompt,
        attachmentPaths,
        clientMessageId,
      ),
    );
  }

  private async sendPromptSerial(
    prompt: string,
    attachmentPaths: readonly string[],
    clientMessageId: string,
  ): Promise<void> {
    const activeQuery = this.activeQuery;
    if (!activeQuery || this.stopping || activeQuery.closing) {
      throw new Error("The remote Claude session is not accepting prompts.");
    }
    const reasoning = this.lease.provider.reasoning;
    const effort =
      reasoning?.effectiveEffort ??
      this.lease.provider.reasoningEffort;
    if (
      remoteEffortRequiresClaudeThinking(
        this.lease.provider.provider,
        effort,
      ) &&
      activeQuery.runtimeThinkingEnabled !== true
    ) {
      throw new Error(
        `${effort} reasoning requires Thinking on ${this.lease.provider.model}. ModelHop blocked the prompt before it could produce an API error; enable Thinking or select High or below.`,
      );
    }
    const trimmed = prompt.trim();
    if (!trimmed && attachmentPaths.length === 0) {
      throw new Error("Enter a prompt before sending.");
    }
    const attachmentNote =
      attachmentPaths.length === 0
        ? ""
        : `\n\nFiles attached from the paired phone are stored locally at:\n${attachmentPaths
            .map((filePath) => `- ${filePath}`)
            .join("\n")}`;
    const sdkMessageId = randomUUID();
    const now = Date.now();
    const wasBusy = this.isBusy();
    const wasForegroundTurnActive = this.foregroundTurnActive;
    this.outgoingPromptIds.set(sdkMessageId, {
      id: clientMessageId,
      content: trimmed,
    });
    const promptWorkId = `prompt:${sdkMessageId}`;
    const responseWorkId = `response:${sdkMessageId}`;
    this.responseWorkByPrompt.set(sdkMessageId, responseWorkId);
    this.upsertWorkItem({
      id: promptWorkId,
      kind: "prompt",
      title: "Submitting prompt",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      cancellable: true,
    });
    this.upsertWorkItem({
      id: responseWorkId,
      kind: "foreground-response",
      parentId: promptWorkId,
      title: "Claude response",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      cancellable: true,
    });
    const queued: RemoteConversationEvent = {
      kind: "conversation.item",
      operation: "upsert",
      item: {
        id: clientMessageId,
        sdkMessageId,
        turnId: this.lease.activeSessionId,
        role: "user",
        status: "queued",
        content: trimmed,
        createdAt: now,
        updatedAt: now,
      },
    };
    // Durability is deliberately established before the SDK input queue is
    // touched. A reconnect can therefore show/retry a prompt even if the
    // process stops between acknowledgement and submission.
    await this.journal.append("conversation.item", queued);
    try {
      this.busy = true;
      this.foregroundTurnActive = true;
      if (!wasBusy) {
        resetSdkMessageNormalisationState(
          activeQuery.normalisationState,
        );
        this.beginTurn(now);
        this.lease.state = "running";
        this.lease.turnPhase = "queued";
      }
      this.lease.lastActivityAt = now;
      await this.publishState();
      this.input.push({
        type: "user",
        message: {
          role: "user",
          content: `${trimmed}${attachmentNote}`,
        },
        parent_tool_use_id: null,
        origin: { kind: "human" },
        uuid: sdkMessageId,
        session_id: this.lease.activeSessionId ?? "",
      });
    } catch (error) {
      this.foregroundTurnActive = wasForegroundTurnActive;
      this.outgoingPromptIds.delete(sdkMessageId);
      this.finishWorkItem(
        promptWorkId,
        "failed",
        "controller-failure",
        "prompt-submission-failed",
      );
      this.finishWorkItem(
        responseWorkId,
        "failed",
        "controller-failure",
        "prompt-submission-failed",
      );
      this.responseWorkByPrompt.delete(sdkMessageId);
      if (!wasBusy) {
        this.busy = false;
        this.completeTurn();
        this.lease.state = this.lease.ownerDeviceId
          ? "paired"
          : "waiting-for-device";
        this.lease.turnPhase = "failed";
        this.notifyIdle();
      }
      await this.journal.append("conversation.item", {
        ...queued,
        item: {
          ...queued.item,
          status: "failed",
          updatedAt: Date.now(),
          error:
            error instanceof Error
              ? error.message
              : "The prompt could not be submitted.",
        },
      } satisfies RemoteConversationEvent);
      await this.publishState();
      throw error;
    }
  }

  public async cancel(): Promise<void> {
    if (!this.activeQuery) {
      return;
    }
    const activeQuery = this.activeQuery;
    const cancellationResults = await this.sendCancellationSignals(
      activeQuery,
    );
    await this.reportCancellationSignalFailures(cancellationResults);
    if (this.isBusy()) {
      this.lease.lastActivityAt = Date.now();
      await this.publishState();
    }
  }

  /**
   * Escalates an existing hand-back to explicit cancellation. Unlike the
   * ordinary Stop button, this operation has a bounded grace period: once the
   * user has explicitly chosen "cancel work and return", absent SDK terminal
   * events may not keep the query alive forever.
   */
  public requestHandbackCancellation(): Promise<void> {
    const preparation = this.handbackPreparation;
    if (preparation) {
      preparation.strategy = "cancel";
      preparation.signalCancel();
    }
    if (this.handbackCancellationInFlight) {
      return this.handbackCancellationInFlight;
    }
    const pending = this.cancelForHandbackOnce();
    const managed = pending.finally(() => {
      if (this.handbackCancellationInFlight === managed) {
        this.handbackCancellationInFlight = undefined;
      }
    });
    this.handbackCancellationInFlight = managed;
    return managed;
  }

  private async cancelForHandbackOnce(): Promise<void> {
    if (!this.isBusy()) {
      return;
    }
    const graceMs = Math.max(
      0,
      this.timing.cancellationGraceMs ?? 5_000,
    );
    const deadline = Date.now() + graceMs;
    const activeQuery = this.activeQuery;
    if (activeQuery) {
      const signals = this.sendCancellationSignals(activeQuery);
      let graceTimer: number | undefined;
      const observed = await Promise.race([
        signals.then((results) => ({ results })),
        new Promise<undefined>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
        }),
      ]).finally(() => {
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
      });
      if (observed) {
        await this.reportCancellationSignalFailures(
          observed.results,
        ).catch(() => undefined);
      }
    }

    if (this.isBusy()) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs > 0) {
        await this.waitUntilIdle(remainingMs).catch(() => undefined);
      }
    }
    if (!this.isBusy()) {
      return;
    }

    // No authoritative terminal evidence arrived within the explicit
    // cancellation grace. close() writes terminal cancellation evidence for
    // every unresolved item before waking any hand-back waiter.
    await this.close();
    if (this.lease.operation?.kind === "handback") {
      this.lease.state = "handing-back";
      this.lease.turnPhase = "handing-back";
      this.lease.lastActivityAt = Date.now();
      await this.publishState();
    }
  }

  private sendCancellationSignals(
    activeQuery: ActiveRemoteQuery,
  ): Promise<PromiseSettledResult<unknown>[]> {
    const stopRequests = [...this.backgroundTasks.keys()].map(
      (taskId) =>
        Promise.resolve().then(() =>
          activeQuery.query.stopTask(taskId),
        ),
    );
    return Promise.allSettled([
      ...stopRequests,
      Promise.resolve().then(() => activeQuery.query.interrupt()),
    ]);
  }

  private async reportCancellationSignalFailures(
    results: readonly PromiseSettledResult<unknown>[],
  ): Promise<void> {
    const failedStops = results.filter(
      (result) => result.status === "rejected",
    ).length;
    if (failedStops > 0) {
      const now = Date.now();
      await this.journal.append("activity.event", {
        kind: "activity.event",
        id: randomUUID(),
        category: "error",
        phase: "running-task",
        title: "Some cancellation requests raced completion",
        detail: `${failedStops} cancellation ${failedStops === 1 ? "request" : "requests"} did not complete; ModelHop still preserved the explicit cancellation boundary.`,
        createdAt: now,
        updatedAt: now,
      } satisfies RemoteActivityEvent);
    }
  }

  public setModel(
    model: string,
    reasoningEffort?: string,
  ): Promise<void> {
    const generation = this.activeQuery?.generation;
    return this.withRouteMutation(() => {
      if (
        generation === undefined ||
        this.activeQuery?.generation !== generation
      ) {
        throw new Error(
          "The remote Claude session changed before the model update could start.",
        );
      }
      return this.setModelSerial(model, reasoningEffort);
    });
  }

  private async setModelSerial(
    model: string,
    reasoningEffort?: string,
  ): Promise<void> {
    const activeQuery = this.activeQuery;
    if (!activeQuery || activeQuery.closing) {
      throw new Error("The remote Claude session is not running.");
    }
    if (this.isBusy()) {
      throw new Error(
        "Wait for the current response before changing model.",
      );
    }
    const requestedModel =
      this.lease.provider.provider === "anthropic"
        ? normaliseAnthropicModelSelector(model)
        : model.trim();
    const catalog = this.lease.provider.modelCatalog;
    const matchedModel = findUniqueRemoteModelOption(
      catalog?.options ?? [],
      requestedModel,
    );
    if (
      catalog?.authoritative === true &&
      (!matchedModel || matchedModel.matchedBy !== "selector")
    ) {
      throw new Error(
        `Model ${model} is not available for ${this.lease.provider.label}. Choose one of the current provider models.`,
      );
    }
    const selectedModel = matchedModel?.option.selector ?? requestedModel;
    if (!selectedModel) {
      throw new Error("Choose a model before applying the change.");
    }
    const selectedEffort = isRemoteReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : this.lease.provider.reasoning?.effectiveEffort ??
        this.lease.provider.reasoningEffort;
    const previousModel = sdkModelForProvider(activeQuery.provider);
    const previousSettings = structuredClone(
      activeQuery.reasoningSettings,
    );
    const candidateProvider: RemoteProviderContext = {
      ...this.lease.provider,
      model: selectedModel,
      reasoning: undefined,
      reasoningEffort: selectedEffort,
      roleModels: {
        ...this.lease.provider.roleModels,
        default: selectedModel,
      },
      updatedAt: Date.now(),
    };
    let candidateSettings: RemoteReasoningSettingsSnapshot = {
      ...previousSettings,
      ...settingsFromReasoningContext(this.lease.provider),
      ...(selectedEffort ? { effortLevel: selectedEffort } : {}),
      ...(reasoningEffort &&
      remoteEffortRequiresClaudeThinking(
        this.lease.provider.provider,
        selectedEffort,
      )
        ? { alwaysThinkingEnabled: true }
        : reasoningEffort === "none"
          ? { alwaysThinkingEnabled: false }
          : {}),
    };
    candidateSettings = normaliseReasoningSettingsForLaunch(
      candidateProvider,
      candidateSettings,
      true,
    ).settings;
    if (
      candidateSettings.ultracode === true &&
      selectedEffort !== undefined &&
      !["xhigh", "max"].includes(selectedEffort)
    ) {
      candidateSettings.ultracode = false;
    }
    const nextReasoning = resolveRemoteReasoningContext(
      candidateProvider,
      activeQuery.modelCatalog,
      candidateSettings,
      {
        workflowsAdministrativelyDisabled:
          environmentDisablesWorkflows(
            this.configuration.environment,
          ),
        workflowBridgeReady: true,
      },
    );
    // `none` is ModelHop's explicit "disable reasoning" control state, not
    // an effort value that Claude models advertise in their capability list.
    if (selectedEffort && selectedEffort !== "none") {
      assertSupportedRemoteEffort(
        nextReasoning,
        selectedEffort,
        selectedModel,
      );
    }
    const modelFlagSettings: QueryFlagSettings = {};
    if (reasoningEffort === "none") {
      modelFlagSettings.alwaysThinkingEnabled = false;
      modelFlagSettings.effortLevel = null;
    } else if (
      reasoningEffort &&
      ["low", "medium", "high", "xhigh", "max"].includes(
        reasoningEffort,
      )
    ) {
      if (
        nextReasoning.thinkingSupported &&
        remoteEffortRequiresClaudeThinking(
          this.lease.provider.provider,
          selectedEffort,
        )
      ) {
        modelFlagSettings.alwaysThinkingEnabled = true;
      }
      modelFlagSettings.effortLevel = reasoningEffort as
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max";
    }
    if (
      this.lease.provider.reasoning?.ultra.enabled === true &&
      (!nextReasoning.ultra.enabled ||
        candidateSettings.ultracode === false)
    ) {
      modelFlagSettings.ultracode = false;
    }
    const previousRuntimeThinking =
      activeQuery.runtimeThinkingEnabled;
    const shouldEnableRuntimeThinking =
      usesClaudeRuntimeThinking(this.lease.provider.provider) &&
      nextReasoning.thinkingSupported &&
      nextReasoning.thinkingEnabled &&
      (activeQuery.runtimeThinkingEnabled !== true ||
        remoteEffortRequiresClaudeThinking(
          this.lease.provider.provider,
          selectedEffort,
        ));
    const shouldDisableRuntimeThinking =
      usesClaudeRuntimeThinking(this.lease.provider.provider) &&
      !nextReasoning.thinkingEnabled &&
      activeQuery.runtimeThinkingEnabled !== false;
    let modelApplied = false;
    try {
      await activeQuery.query.setModel(selectedModel);
      modelApplied = true;
      if (!this.isCurrent(activeQuery) || activeQuery.closing) {
        throw new Error(
          "The remote Claude session changed while the model was being applied.",
        );
      }
      if (shouldEnableRuntimeThinking) {
        await this.setRuntimeThinking(activeQuery, true);
      }
      if (Object.keys(modelFlagSettings).length > 0) {
        await activeQuery.query.applyFlagSettings(modelFlagSettings);
      }
      await this.verifyEffectiveReasoningSettings(
        activeQuery,
        nextReasoning,
      );
      if (shouldDisableRuntimeThinking) {
        await this.setRuntimeThinking(activeQuery, false);
      }
    } catch (error) {
      if (modelApplied && this.isCurrent(activeQuery)) {
        const rollbackFailure = await this.rollbackRouteRuntime(
          activeQuery,
          previousSettings,
          previousModel,
          { thinkingEnabled: previousRuntimeThinking },
        );
        if (rollbackFailure) {
          await this.failClosedRouteMutation(
            activeQuery,
            error,
            rollbackFailure,
          );
        }
      }
      throw error;
    }
    if (!this.isCurrent(activeQuery) || activeQuery.closing) {
      throw new Error(
        "The remote Claude session changed before the model update could be committed.",
      );
    }
    const nextProvider: RemoteProviderContext = {
      ...candidateProvider,
      reasoning: nextReasoning,
      reasoningEffort: selectedEffort,
    };
    activeQuery.reasoningSettings = {
      ...candidateSettings,
      alwaysThinkingEnabled: nextReasoning.thinkingEnabled,
      enableWorkflows: nextReasoning.workflows.enabled,
      ultracode: nextReasoning.ultra.enabled,
    };
    this.replaceProviderContext(nextProvider, activeQuery);
    if (this.lease.provider.provider !== "anthropic") {
      this.lease.providerChanged = true;
    }
    await this.journal.append(
      "provider.context",
      this.lease.provider,
    );
    await this.publishState();
  }

  public setReasoning(
    change: RemoteReasoningChange,
  ): Promise<RemoteProviderContext> {
    const generation = this.activeQuery?.generation;
    return this.withRouteMutation(() => {
      if (
        generation === undefined ||
        this.activeQuery?.generation !== generation
      ) {
        throw new Error(
          "The remote Claude session changed before the reasoning update could start.",
        );
      }
      return this.setReasoningSerial(change);
    });
  }

  private async setReasoningSerial(
    change: RemoteReasoningChange,
  ): Promise<RemoteProviderContext> {
    const activeQuery = this.activeQuery;
    const current = this.lease.provider.reasoning;
    if (!activeQuery || activeQuery.closing || !current) {
      throw new Error(
        "Reasoning controls are unavailable until the remote Claude session has initialized.",
      );
    }
    if (this.isBusy()) {
      throw new Error(
        "Wait for the current response before changing reasoning settings.",
      );
    }
    if (
      change.thinkingEnabled !== undefined &&
      !current.thinkingSupported
    ) {
      throw new Error(
        current.thinkingUnavailableReason ??
          `${this.lease.provider.model} does not support the Thinking toggle.`,
      );
    }
    if (change.effort) {
      assertSupportedRemoteEffort(
        current,
        change.effort,
        this.lease.provider.model,
      );
    }
    if (
      change.workflowsEnabled === true &&
      !current.workflows.available
    ) {
      throw new Error(
        current.workflows.unavailableReason ??
          "Workflows are unavailable for this remote session.",
      );
    }
    const canPrepareUltra =
      current.ultra.available ||
      (current.workflows.available &&
        current.supportedEffortLevels.includes("xhigh"));
    if (change.ultraEnabled === true && !canPrepareUltra) {
      throw new Error(
        current.ultra.unavailableReason ??
          "Ultra is unavailable for this remote session.",
      );
    }
    if (
      change.thinkingEnabled === false &&
      change.effort !== undefined &&
      change.effort !== "none"
    ) {
      throw new Error(
        "A non-none effort cannot be selected while Thinking is being turned off.",
      );
    }
    if (
      change.ultraEnabled === true &&
      change.workflowsEnabled === false
    ) {
      throw new Error(
        "Ultra cannot be enabled while Workflows are being turned off.",
      );
    }
    if (
      change.ultraEnabled === true &&
      change.thinkingEnabled === false &&
      current.thinkingSupported
    ) {
      throw new Error(
        "Ultra cannot be enabled while adaptive Thinking is being turned off.",
      );
    }
    if (
      change.ultraEnabled === true &&
      change.effort !== undefined &&
      change.effort !== "xhigh"
    ) {
      throw new Error(
        "Enabling Ultra selects xhigh reasoning; apply a different effort afterward.",
      );
    }
    const selectingActiveEffort =
      change.effort !== undefined && change.effort !== "none";
    const selectedEffortRequiresThinking =
      remoteEffortRequiresClaudeThinking(
        this.lease.provider.provider,
        change.effort,
      );
    let nextThinking =
      selectedEffortRequiresThinking && current.thinkingSupported
        ? true
        : change.thinkingEnabled ?? current.thinkingEnabled;
    let nextWorkflows =
      change.workflowsEnabled ?? current.workflows.enabled;
    let nextUltra = change.ultraEnabled ?? current.ultra.enabled;
    let effectiveEffort = change.effort ?? current.effectiveEffort;
    if (change.ultraEnabled === true) {
      nextWorkflows = true;
      effectiveEffort = "xhigh";
      if (
        this.lease.provider.provider === "anthropic" &&
        current.thinkingSupported
      ) {
        nextThinking = true;
      }
    } else {
      if (
        change.effort !== undefined &&
        !["xhigh", "max"].includes(change.effort)
      ) {
        nextUltra = false;
      }
      if (
        change.workflowsEnabled === false ||
        change.thinkingEnabled === false
      ) {
        nextUltra = false;
      }
    }
    if (effectiveEffort) {
      assertSupportedRemoteEffort(
        current,
        effectiveEffort,
        this.lease.provider.model,
      );
    }
    if (
      remoteEffortRequiresClaudeThinking(
        this.lease.provider.provider,
        effectiveEffort,
      ) &&
      !nextThinking
    ) {
      throw new Error(
        `${effectiveEffort} reasoning requires Thinking on ${this.lease.provider.model}. Turn Thinking on, or select High or below first.`,
      );
    }
    const flagSettings: QueryFlagSettings = {};
    if (change.thinkingEnabled !== undefined) {
      flagSettings.alwaysThinkingEnabled = change.thinkingEnabled;
    }
    if (
      change.ultraEnabled === true &&
      this.lease.provider.provider === "anthropic" &&
      current.thinkingSupported
    ) {
      flagSettings.alwaysThinkingEnabled = true;
    }
    if (
      selectingActiveEffort &&
      selectedEffortRequiresThinking &&
      current.thinkingSupported &&
      change.thinkingEnabled === undefined
    ) {
      flagSettings.alwaysThinkingEnabled = true;
    }
    if (
      change.effort !== undefined ||
      change.ultraEnabled === true
    ) {
      flagSettings.effortLevel =
        effectiveEffort === "none" ? null : effectiveEffort;
    }
    if (
      change.workflowsEnabled !== undefined ||
      change.ultraEnabled === true
    ) {
      flagSettings.enableWorkflows = nextWorkflows;
      flagSettings.workflowSizeGuideline = nextWorkflows
        ? "small"
        : null;
    }
    if (
      change.ultraEnabled !== undefined ||
      nextUltra !== current.ultra.enabled
    ) {
      flagSettings.ultracode = nextUltra;
      if (nextUltra) {
        flagSettings.workflowSizeGuideline = "small";
      }
    }
    if (Object.keys(flagSettings).length === 0) {
      throw new Error("No reasoning setting was changed.");
    }
    const previousSettings = structuredClone(
      activeQuery.reasoningSettings,
    );
    const previousRuntimeThinking =
      activeQuery.runtimeThinkingEnabled;
    const settings: RemoteReasoningSettingsSnapshot = {
      ...previousSettings,
      alwaysThinkingEnabled: nextThinking,
      ...(effectiveEffort ? { effortLevel: effectiveEffort } : {}),
      enableWorkflows: nextWorkflows,
      ultracode: nextUltra,
    };
    const providerWithoutReasoning: RemoteProviderContext = {
      ...this.lease.provider,
      reasoning: undefined,
      reasoningEffort: effectiveEffort,
    };
    const reasoning = resolveRemoteReasoningContext(
      providerWithoutReasoning,
      activeQuery.modelCatalog,
      settings,
      {
        workflowsAdministrativelyDisabled:
          environmentDisablesWorkflows(
            this.configuration.environment,
          ),
        workflowBridgeReady: true,
      },
    );
    const shouldEnableRuntimeThinking =
      usesClaudeRuntimeThinking(this.lease.provider.provider) &&
      reasoning.thinkingSupported &&
      reasoning.thinkingEnabled &&
      (activeQuery.runtimeThinkingEnabled !== true ||
        change.thinkingEnabled === true ||
        change.ultraEnabled === true ||
        remoteEffortRequiresClaudeThinking(
          this.lease.provider.provider,
          effectiveEffort,
        ));
    const shouldDisableRuntimeThinking =
      usesClaudeRuntimeThinking(this.lease.provider.provider) &&
      !reasoning.thinkingEnabled &&
      activeQuery.runtimeThinkingEnabled !== false;
    try {
      // Anthropic validates xhigh/max against the query's runtime thinking
      // mode, which is separate from the settings layer. Enable the runtime
      // first so no transient invalid request can escape this mutation.
      if (shouldEnableRuntimeThinking) {
        await this.setRuntimeThinking(activeQuery, true);
      }
      await activeQuery.query.applyFlagSettings(flagSettings);
      await this.verifyEffectiveReasoningSettings(
        activeQuery,
        reasoning,
      );
      // When disabling, lower/clear incompatible effort in the settings layer
      // before turning the query runtime off.
      if (shouldDisableRuntimeThinking) {
        await this.setRuntimeThinking(activeQuery, false);
      }
    } catch (error) {
      if (this.isCurrent(activeQuery)) {
        const rollbackFailure = await this.rollbackRouteRuntime(
          activeQuery,
          previousSettings,
          undefined,
          { thinkingEnabled: previousRuntimeThinking },
        );
        if (rollbackFailure) {
          await this.failClosedRouteMutation(
            activeQuery,
            error,
            rollbackFailure,
          );
        }
      }
      throw error;
    }
    if (!this.isCurrent(activeQuery) || activeQuery.closing) {
      throw new Error(
        "The remote Claude session changed before the reasoning update could be committed.",
      );
    }
    const provider: RemoteProviderContext = {
      ...providerWithoutReasoning,
      reasoning,
      updatedAt: Date.now(),
    };
    activeQuery.reasoningSettings = settings;
    activeQuery.restoreReasoningFlags = true;
    this.replaceProviderContext(provider, activeQuery);
    await this.journal.append("provider.context", provider);
    await this.journal.append("session.capabilities", {
      kind: "session.capabilities",
      model: provider.model,
      permissionMode: remotePermissionMode(
        this.configuration.permissionMode,
      ),
      tools: [],
      commands: [],
      skills: [],
      protocolCapabilities: [],
      reasoning,
      updatedAt: Date.now(),
    } satisfies RemoteSessionCapabilities);
    await this.publishState();
    return structuredClone(provider);
  }

  public async setPermissionMode(
    mode: RemotePermissionMode,
  ): Promise<void> {
    const activeQuery = this.activeQuery;
    if (!activeQuery || activeQuery.closing) {
      throw new Error("The remote Claude session is not running.");
    }
    const sdkMode =
      mode === "auto-safe" ? "auto" : mode;
    await activeQuery.query.setPermissionMode(sdkMode);
    this.configuration.permissionMode = sdkMode;
    this.configuration.lease.permissionMode = mode;
    this.lease.permissionMode = mode;
    activeQuery.normalisationState.permissionMode = mode;
    await this.journal.append("session.capabilities", {
      kind: "session.capabilities",
      model: this.lease.provider.model,
      permissionMode: mode,
      tools: [],
      commands: [],
      skills: [],
      protocolCapabilities: [],
      reasoning: this.lease.provider.reasoning,
      updatedAt: Date.now(),
    } satisfies RemoteSessionCapabilities);
    await this.journal.append("activity.event", {
      kind: "activity.event",
      id: randomUUID(),
      category: "permission",
      phase: this.lease.turnPhase ?? "idle",
      title: `Permission mode changed to ${mode}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies RemoteActivityEvent);
    await this.publishState();
  }

  public async resolvePermission(
    requestId: string,
    decision: "allow" | "allow-session" | "deny",
    message?: string,
  ): Promise<void> {
    const pending = this.permissions.get(requestId);
    if (!pending) {
      throw new Error(
        "That permission request is no longer pending.",
      );
    }
    if (
      decision === "allow-session" &&
      pending.sessionSuggestions.length === 0
    ) {
      throw new Error(
        "That action cannot be remembered safely for this session.",
      );
    }
    this.permissions.delete(requestId);
    this.finishWorkItem(
      `approval:${requestId}`,
      decision !== "deny" ? "complete" : "cancelled",
      "user-decision",
      decision,
    );
    this.refreshBusyFromLedger();
    pending.resolve(
      decision !== "deny"
        ? {
            behavior: "allow",
            ...(decision === "allow-session"
              ? { updatedPermissions: pending.sessionSuggestions }
              : {}),
            decisionClassification: "user_temporary",
          }
        : {
            behavior: "deny",
            message: message?.trim() || "Denied from ModelHop Remote.",
            decisionClassification: "user_reject",
          },
    );
    this.lease.state = this.isBusy() ? "running" : "paired";
    this.lease.turnPhase = this.isBusy() ? "streaming" : "idle";
    await this.journal.append("permission.resolved", {
      requestId,
      decision,
    });
    const finished = this.activeQuery
      ? await this.maybeFinishTurn(this.activeQuery)
      : false;
    if (!finished) {
      await this.publishState();
    }
  }

  public async resolveQuestion(
    requestId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const pending = this.questions.get(requestId);
    if (!pending) {
      throw new Error("That question is no longer pending.");
    }
    this.questions.delete(requestId);
    this.finishWorkItem(
      `question:${requestId}`,
      "complete",
      "user-decision",
      "answered",
    );
    this.refreshBusyFromLedger();
    pending.resolve({
      behavior: "allow",
      updatedInput: {
        ...pending.input,
        answers,
      },
      toolUseID: pending.toolUseId,
      decisionClassification: "user_temporary",
    });
    this.lease.state = this.isBusy() ? "running" : "paired";
    this.lease.turnPhase = this.isBusy() ? "streaming" : "idle";
    await this.journal.append("question.resolved", {
      requestId,
    });
    const finished = this.activeQuery
      ? await this.maybeFinishTurn(this.activeQuery)
      : false;
    if (!finished) {
      await this.publishState();
    }
  }

  public async reconfigure(
    configuration: RemoteDaemonConfiguration,
  ): Promise<void> {
    if (this.isBusy()) {
      throw new Error(
        "Wait for the current turn to finish before switching provider.",
      );
    }
    const activeSessionId =
      this.lease.activeSessionId ?? this.lease.sourceSessionId;
    await this.close();
    this.configuration = configuration;
    this.lease = {
      ...configuration.lease,
      activeSessionId,
      providerChanged: true,
      state: "switching-provider",
      turnPhase: "switching-provider",
    };
    await this.publishState();
    await this.start({
      resumeSessionId: activeSessionId,
      forkSession: false,
    });
  }

  public async setOperation(
    operation: RemoteOperation | undefined,
  ): Promise<void> {
    const currentOperation = this.lease.operation;
    if (
      currentOperation &&
      currentOperation.phase !== "complete" &&
      currentOperation.phase !== "failed" &&
      operation &&
      (operation.id !== currentOperation.id ||
        operation.kind !== currentOperation.kind)
    ) {
      throw new Error(
        `Cannot replace active ${currentOperation.kind} operation ${currentOperation.id} with ${operation.kind} operation ${operation.id}. Clear or terminalize the active operation first.`,
      );
    }
    this.lease.operation = operation
      ? {
          ...operation,
          ...(operation.kind === "handback"
            ? { attentionAt: operation.attentionAt ?? operation.deadlineAt }
            : {}),
        }
      : undefined;
    operation = this.lease.operation;
    const busy = this.isBusy();
    if (operation?.kind === "provider-switch") {
      this.lease.turnPhase = "switching-provider";
      if (!busy) {
        this.lease.state = "switching-provider";
      }
    } else if (operation?.kind === "handback") {
      this.lease.turnPhase = "handing-back";
      if (!busy) {
        this.lease.state = "handing-back";
      }
    } else if (!busy && this.lease.state !== "stopped") {
      this.lease.turnPhase = "idle";
      this.lease.state = this.lease.ownerDeviceId ? "paired" : "waiting-for-device";
    }
    if (operation) {
      await this.journal.append("operation.state", operation);
    }
    await this.publishState();
  }

  public async waitUntilIdle(timeoutMs?: number): Promise<void> {
    if (this.isAuthoritativelyQuiescent()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.idleWaiters.delete(onIdle);
              reject(
                new Error(
                  "The current Claude turn needs continued attention while ModelHop waits for terminal evidence.",
                ),
              );
            }, Math.max(0, timeoutMs));
      const onIdle = (): void => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve();
      };
      this.idleWaiters.add(onIdle);
    });
  }

  /**
   * Turns an overdue ambiguous settlement into an explicit attention state.
   * It never cancels work and is safe to call repeatedly from the detached
   * supervisor before an editor has claimed the hand-back action.
   */
  public async evaluateOperationAttention(
    now = Date.now(),
  ): Promise<void> {
    const operation = this.lease.operation;
    if (
      operation?.kind !== "handback" ||
      operation.attentionAt === undefined ||
      now < operation.attentionAt ||
      !this.isBusy()
    ) {
      return;
    }
    await this.markSettlingWorkUnknown();
  }

  public prepareHandback(
    strategy: "finish" | "cancel",
    timeoutMs = 15 * 60 * 1000,
  ): Promise<RemoteSessionLease> {
    const current = this.handbackPreparation;
    if (current) {
      if (strategy === "cancel") {
        // Escalation is monotonic. Repeated finish requests can never undo an
        // explicit cancel, and repeated cancels share the same actuator.
        current.strategy = "cancel";
        current.signalCancel();
        return this.requestHandbackCancellation().then(
          () => current.promise,
        );
      }
      return current.promise;
    }

    let signalCancel!: () => void;
    let signalAbortPromise!: () => void;
    const cancelRequested = new Promise<void>((resolve) => {
      signalCancel = resolve;
    });
    const abortRequested = new Promise<void>((resolve) => {
      signalAbortPromise = resolve;
    });
    const preparation = {
      strategy,
      promise: Promise.resolve(this.getLease()),
      cancelRequested,
      signalCancel,
      abortRequested,
      signalAbort: (): void => {
        preparation.aborted = true;
        signalAbortPromise();
      },
      aborted: false,
    };
    if (strategy === "cancel") {
      preparation.signalCancel();
    }
    const pending = Promise.resolve().then(() =>
      this.prepareHandbackOnce(preparation, timeoutMs),
    );
    const managed = pending.catch((error: unknown) => {
      if (this.handbackPreparation?.promise === managed) {
        this.handbackPreparation = undefined;
      }
      throw error;
    });
    preparation.promise = managed;
    this.handbackPreparation = preparation;
    return managed;
  }

  private async prepareHandbackOnce(
    preparation: {
      strategy: "finish" | "cancel";
      promise: Promise<RemoteSessionLease>;
      cancelRequested: Promise<void>;
      signalCancel: () => void;
      abortRequested: Promise<void>;
      signalAbort: () => void;
      aborted: boolean;
    },
    timeoutMs: number,
  ): Promise<RemoteSessionLease> {
    const cancellationRequested = (): boolean =>
      preparation.strategy === "cancel";
    const waitForIdleOrCancellation = (
      waitTimeoutMs?: number,
    ): Promise<"idle" | "attention" | "cancel" | "abort"> =>
      Promise.race([
        this.waitUntilIdle(waitTimeoutMs).then(
          () => "idle" as const,
          () => "attention" as const,
        ),
        preparation.cancelRequested.then(() => "cancel" as const),
        preparation.abortRequested.then(() => "abort" as const),
      ]);

    let settlement: "idle" | "attention" | "cancel" | "abort" =
      cancellationRequested()
        ? "cancel"
        : await waitForIdleOrCancellation(timeoutMs);
    if (settlement === "attention") {
      if (cancellationRequested()) {
        settlement = "cancel";
      } else {
        // The threshold requests attention; it is never a cancellation
        // deadline. Preserve the query and continue waiting for
        // authoritative terminal evidence, while keeping this wait directly
        // preemptible by a later explicit cancellation.
        await this.markSettlingWorkUnknown();
        settlement = await waitForIdleOrCancellation();
      }
    }
    if (settlement === "abort" || preparation.aborted) {
      throw new Error(
        "The hand-back request was cancelled; remote work remains active.",
      );
    }
    if (settlement === "cancel" || cancellationRequested()) {
      await this.requestHandbackCancellation();
    }
    if (preparation.aborted) {
      throw new Error(
        "The hand-back request was cancelled; remote work remains active.",
      );
    }
    this.lease.state = "handing-back";
    this.lease.turnPhase = "handing-back";
    await this.publishState();
    if (preparation.aborted) {
      throw new Error(
        "The hand-back request was cancelled; remote work remains active.",
      );
    }
    await this.close();
    const activeSessionId = this.lease.activeSessionId;
    if (
      activeSessionId &&
      activeSessionId !== this.lease.sourceSessionId
    ) {
      await repairModelHopTranscriptVisibility(
        activeTranscriptPath(
          this.lease.sourceTranscriptPath,
          activeSessionId,
        ),
        activeSessionId,
      );
    }
    // close() intentionally does not mark this lease stopped. The phone and
    // tunnel stay available until the editor confirms the exact transcript
    // was reopened.
    this.lease.state = "handing-back";
    this.lease.turnPhase = "handing-back";
    await this.publishState();
    return this.getLease();
  }

  public cancelHandbackRequest(): boolean {
    const preparation = this.handbackPreparation;
    if (
      preparation?.strategy === "cancel" ||
      this.closeInFlight !== undefined
    ) {
      return false;
    }
    preparation?.signalAbort();
    return true;
  }

  public close(): Promise<void> {
    if (this.closeInFlight) {
      return this.closeInFlight;
    }
    const pending = this.closeOnce();
    const managed = pending.catch((error: unknown) => {
      if (this.closeInFlight === managed) {
        this.closeInFlight = undefined;
      }
      throw error;
    });
    this.closeInFlight = managed;
    return managed;
  }

  private async closeOnce(): Promise<void> {
    this.stopping = true;
    this.input.end();
    for (const pending of this.permissions.values()) {
      pending.abort();
    }
    this.permissions.clear();
    for (const pending of this.questions.values()) {
      pending.abort();
    }
    this.questions.clear();
    const activeQuery = this.activeQuery;
    if (activeQuery) {
      await this.closeActiveQuery(activeQuery);
    }
    if (this.isBusy()) {
      this.completeTurn();
    }
    const closedAt = Date.now();
    for (const [id, item] of this.workItems) {
      if (!this.isTerminalWorkPhase(item.phase)) {
        const cancelled: RemoteWorkItem = {
          ...item,
          phase: "cancelled",
          updatedAt: closedAt,
          lastProgressAt: Math.max(item.lastProgressAt, closedAt),
          terminalEvidence: {
            source: "explicit-cancellation",
            status: "query-closed",
            recordedAt: closedAt,
          },
        };
        // Write terminal evidence before changing the in-memory ledger or
        // waking waiters. A crash can therefore never turn a forced close into
        // an apparently successful but non-durable hand-back.
        await this.journal.append("work.state", {
          workItem: cancelled,
        });
        this.workItems.set(id, cancelled);
      }
    }
    this.foregroundTurnActive = false;
    this.currentForegroundWorkId = undefined;
    this.backgroundTasks.clear();
    this.outgoingPromptIds.clear();
    this.pendingTurnResult = undefined;
    this.ignoreResultsUntilPromptAccepted = false;
    this.terminalProviderFailure = undefined;
    this.lease.backgroundTaskCount = 0;
    this.busy = false;
    this.notifyIdle();
  }

  public async markDiverged(): Promise<void> {
    if (this.lease.state === "stopped") {
      return;
    }
    this.lease.state = "paused-diverged";
    if (!this.isBusy()) {
      this.lease.turnPhase = "failed";
    }
    await this.publishState();
    await this.journal.append("notification", {
      level: "warning",
      message:
        "The original desktop conversation changed during remote control. Mobile input is paused, but the active Claude turn was not cancelled.",
    });
  }

  public async stop(): Promise<RemoteSessionLease> {
    this.lease.state = "handing-back";
    this.lease.turnPhase = "handing-back";
    await this.publishState();
    await this.close();
    this.lease.state = "stopped";
    this.lease.turnPhase = "idle";
    this.lease.lastActivityAt = Date.now();
    await this.publishState();
    return this.getLease();
  }

  public updateProviderContext(
    provider: RemoteProviderContext,
  ): Promise<void> {
    this.replaceProviderContext(provider, this.activeQuery);
    this.lease.lastActivityAt = Date.now();
    return this.journal
      .append("provider.context", provider)
      .then(() => this.publishState());
  }

  private async consume(activeQuery: ActiveRemoteQuery): Promise<void> {
    let consumeFailure: Error | undefined;
    try {
      for await (const message of activeQuery.query) {
        if (!this.isCurrent(activeQuery)) {
          return;
        }
        this.captureSessionId(message);
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          typeof message.model === "string"
        ) {
          await this.observeRuntimeModel(activeQuery, message.model);
        }
        const backgroundTasksChanged =
          message.type === "system" &&
          message.subtype === "background_tasks_changed";
        if (backgroundTasksChanged) {
          this.replaceBackgroundTasks(message.tasks);
        }
        const acceptsQueuedPrompt =
          message.type === "user" &&
          typeof message.uuid === "string" &&
          this.outgoingPromptIds.has(message.uuid);
        if (acceptsQueuedPrompt) {
          this.ignoreResultsUntilPromptAccepted = false;
          this.terminalProviderFailure = undefined;
        }
        const beginsQueuedTurn =
          acceptsQueuedPrompt &&
          (!this.isBusy() || this.lease.turnCompletedAt !== undefined);
        if (beginsQueuedTurn) {
          resetSdkMessageNormalisationState(
            activeQuery.normalisationState,
          );
          this.busy = true;
          this.foregroundTurnActive = true;
          this.beginTurn();
          this.lease.state = "running";
          this.lease.turnPhase = "queued";
          await this.publishState();
        }
        for (const event of normaliseSdkMessage(
          message,
          activeQuery.provider,
          this.outgoingPromptIds,
          activeQuery.normalisationState,
        )) {
          if (!this.isCurrent(activeQuery)) {
            return;
          }
          this.observeNormalisedWork(event);
          await this.journal.append(event.type, event.payload);
        }
        if (!this.isCurrent(activeQuery)) {
          return;
        }
        if (message.type === "user" && message.uuid) {
          if (this.outgoingPromptIds.has(message.uuid)) {
            this.finishWorkItem(
              `prompt:${message.uuid}`,
              "complete",
              "sdk-prompt-accepted",
              "accepted",
            );
            const responseWorkId =
              this.responseWorkByPrompt.get(message.uuid) ??
              `response:${message.uuid}`;
            this.activateWorkItem(
              responseWorkId,
              "foreground-response",
              "Claude response",
              `prompt:${message.uuid}`,
            );
            this.currentForegroundWorkId = responseWorkId;
            this.foregroundTurnActive = true;
          }
          this.outgoingPromptIds.delete(message.uuid);
        }
        if (
          message.type === "system" &&
          message.subtype === "init"
        ) {
          await this.markInitialized(activeQuery);
        }
        if (!this.isCurrent(activeQuery)) {
          return;
        }
        if (
          message.type === "system" &&
          message.subtype === "status"
        ) {
          this.lease.turnPhase =
            this.backgroundTasks.size > 0
              ? "running-task"
              : message.status === "compacting"
                ? "compacting"
                : message.status === "requesting"
                  ? "requesting"
                  : "streaming";
          await this.publishState();
        }
        let recordedTerminalAssistantError = false;
        if (
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          message.error !== undefined &&
          // This error is an intermediate frame when Claude successfully
          // resumes a truncated thinking block. Its eventual result remains
          // the authoritative terminal signal.
          message.error !== "max_output_tokens" &&
          !this.ignoreResultsUntilPromptAccepted &&
          this.hasOpenTurnForTerminalAssistantError()
        ) {
          const failedAt = Date.now();
          this.ignoreResultsUntilPromptAccepted = true;
          this.terminalProviderFailure = {
            code: message.error,
            recordedAt: failedAt,
            queryGeneration: activeQuery.generation,
          };
          this.recordForegroundTerminalEvidence(
            "sdk-assistant-error",
            true,
            message.error,
            failedAt,
          );
          recordedTerminalAssistantError = true;
        }
        if (message.type === "result") {
          const duplicateAfterCompletedTurn =
            this.lease.turnCompletedAt !== undefined &&
            !this.hasOpenTurnForTerminalAssistantError();
          if (
            !this.ignoreResultsUntilPromptAccepted &&
            !duplicateAfterCompletedTurn
          ) {
            this.recordForegroundTerminalEvidence(
              "sdk-result",
              message.is_error,
              message.is_error ? "error" : "success",
            );
          }
        }
        const finished = await this.maybeFinishTurn(activeQuery);
        if (
          !finished &&
          (backgroundTasksChanged ||
            message.type === "result" ||
            recordedTerminalAssistantError)
        ) {
          await this.publishState();
        }
      }
    } catch (error) {
      consumeFailure =
        error instanceof Error
          ? error
          : new Error("The remote Claude process stopped unexpectedly.");
      if (
        this.stopping ||
        activeQuery.closing ||
        !this.isCurrent(activeQuery)
      ) {
        return;
      }
      activeQuery.rejectStartup(consumeFailure);
      await this.settleFailedTurn(
        activeQuery,
        consumeFailure.message,
      );
    } finally {
      if (
        this.isCurrent(activeQuery) &&
        !activeQuery.closing &&
        !this.stopping
      ) {
        if (!activeQuery.initialized) {
          activeQuery.rejectStartup(
            consumeFailure ??
              new Error(
                "Claude Code stopped before initializing the remote session.",
              ),
          );
        } else if (!consumeFailure) {
          const message =
            "The remote Claude process stopped unexpectedly.";
          await this.settleFailedTurn(activeQuery, message);
        }
      }
      if (this.isCurrent(activeQuery)) {
        this.activeQuery = undefined;
      }
    }
  }

  private captureSessionId(message: SDKMessage): void {
    if (
      "session_id" in message &&
      typeof message.session_id === "string" &&
      message.session_id
    ) {
      this.lease.activeSessionId = message.session_id;
    }
  }

  private async waitForInitialization(
    activeQuery: ActiveRemoteQuery,
  ): Promise<SDKControlInitializeResponse> {
    const timeoutMs =
      this.timing.initializationTimeoutMs ?? 60_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(
            `Claude Code did not initialize the remote session in time (${Math.ceil(
              timeoutMs / 1_000,
            )} seconds).`,
          ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        activeQuery.query.initializationResult(),
        activeQuery.startupFailure,
        timedOut,
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async markInitialized(
    activeQuery: ActiveRemoteQuery,
    initialization?: SDKControlInitializeResponse,
  ): Promise<void> {
    if (!this.isCurrent(activeQuery)) {
      return;
    }
    // `initializationResult()` is the authoritative, cached control reply.
    // A streamed init frame can arrive concurrently while its reasoning flags
    // are still being restored; it must not publish a half-initialized lease.
    if (!initialization) {
      return;
    }
    const firstInitialization = !activeQuery.initialized;
    activeQuery.modelCatalog = [...initialization.models];
    const modelCatalog = serialiseModelCatalog(
      activeQuery.provider,
      activeQuery.modelCatalog,
    );
    const providerWithCatalog: RemoteProviderContext = {
      ...activeQuery.provider,
      ...(modelCatalog ? { modelCatalog } : {}),
    };
    const reasoning = resolveRemoteReasoningContext(
      providerWithCatalog,
      activeQuery.modelCatalog,
      activeQuery.reasoningSettings,
      {
        workflowsAdministrativelyDisabled:
          environmentDisablesWorkflows(
            this.configuration.environment,
          ),
        // Claude-harness workflows use the ordinary canUseTool approval
        // path. Their authoritative background-task level signal keeps
        // hand-back and provider switching from racing child work.
        workflowBridgeReady: true,
      },
    );
    const requestedEffort =
      activeQuery.provider.reasoning?.effectiveEffort ??
      activeQuery.provider.reasoningEffort ??
      activeQuery.reasoningSettings.effortLevel;
    if (requestedEffort) {
      assertSupportedRemoteEffort(
        reasoning,
        requestedEffort,
        activeQuery.provider.model,
      );
    }
    const provider: RemoteProviderContext = {
      ...providerWithCatalog,
      reasoning,
      reasoningEffort:
        reasoning.effectiveEffort ??
        activeQuery.provider.reasoningEffort,
      updatedAt: Date.now(),
    };
    if (activeQuery.restoreReasoningFlags) {
      await this.applyReasoningFlags(activeQuery, reasoning);
    } else if (reasoning.workflows.enabled) {
      await activeQuery.query.applyFlagSettings({
        workflowSizeGuideline: "small",
      });
    }
    if (!this.isCurrent(activeQuery) || activeQuery.closing) {
      return;
    }
    this.replaceProviderContext(provider, activeQuery);
    await this.journal.append("provider.context", provider);
    await this.journal.append("session.capabilities", {
      kind: "session.capabilities",
      model: activeQuery.provider.model,
      permissionMode: remotePermissionMode(
        this.configuration.permissionMode,
      ),
      tools: [],
      commands: initialization.commands.map((command) => ({
        name: command.name.replace(/^\//u, ""),
        description: command.description,
        argumentHint: command.argumentHint,
        aliases: command.aliases,
      })),
      skills: [],
      protocolCapabilities: [],
      reasoning,
      updatedAt: Date.now(),
    } satisfies RemoteSessionCapabilities);
    activeQuery.initialized = true;
    if (!firstInitialization || !this.isCurrent(activeQuery)) {
      return;
    }
    this.lease.error = undefined;
    if (!this.lease.operation) {
      this.lease.state = this.lease.ownerDeviceId
        ? "paired"
        : "waiting-for-device";
      this.lease.turnPhase = "idle";
    }
    await this.publishContextUsage(
      activeQuery.query,
      activeQuery,
    );
    if (this.isCurrent(activeQuery)) {
      await this.publishState();
    }
  }

  private async applyReasoningFlags(
    activeQuery: ActiveRemoteQuery,
    reasoning: NonNullable<RemoteProviderContext["reasoning"]>,
  ): Promise<void> {
    const settings: Parameters<Query["applyFlagSettings"]>[0] = {
      alwaysThinkingEnabled: reasoning.thinkingEnabled,
      enableWorkflows: reasoning.workflows.enabled,
      ultracode: reasoning.ultra.enabled,
      ...(reasoning.workflows.enabled
        ? { workflowSizeGuideline: "small" }
        : {}),
    };
    if (!reasoning.thinkingSupported) {
      delete settings.alwaysThinkingEnabled;
    }
    if (reasoning.effectiveEffort) {
      settings.effortLevel =
        reasoning.effectiveEffort === "none"
          ? null
          : reasoning.effectiveEffort;
    }
    const shouldEnableRuntimeThinking =
      usesClaudeRuntimeThinking(activeQuery.provider.provider) &&
      reasoning.thinkingSupported &&
      reasoning.thinkingEnabled &&
      activeQuery.runtimeThinkingEnabled !== true;
    const shouldDisableRuntimeThinking =
      usesClaudeRuntimeThinking(activeQuery.provider.provider) &&
      !reasoning.thinkingEnabled &&
      activeQuery.runtimeThinkingEnabled !== false;
    if (shouldEnableRuntimeThinking) {
      await this.setRuntimeThinking(activeQuery, true);
    }
    await activeQuery.query.applyFlagSettings(settings);
    await this.verifyEffectiveReasoningSettings(
      activeQuery,
      reasoning,
    );
    if (shouldDisableRuntimeThinking) {
      await this.setRuntimeThinking(activeQuery, false);
    }
  }

  private isTerminalWorkPhase(phase: RemoteWorkItemPhase): boolean {
    return phase === "complete" || phase === "failed" || phase === "cancelled";
  }

  private upsertWorkItem(item: RemoteWorkItem): RemoteWorkItem {
    const existing = this.workItems.get(item.id);
    if (existing && this.isTerminalWorkPhase(existing.phase) && !this.isTerminalWorkPhase(item.phase)) {
      return existing;
    }
    const next: RemoteWorkItem = existing
      ? {
          ...existing,
          ...item,
          createdAt: existing.createdAt,
          lastProgressAt: Math.max(existing.lastProgressAt, item.lastProgressAt),
          terminalEvidence: item.terminalEvidence ?? existing.terminalEvidence,
        }
      : item;
    this.workItems.set(next.id, next);
    return next;
  }

  private activateWorkItem(
    id: string,
    kind: RemoteWorkItemKind,
    title: string,
    parentId?: string,
  ): void {
    const now = Date.now();
    const existing = this.workItems.get(id);
    this.upsertWorkItem({
      id,
      kind,
      ...(parentId ? { parentId } : {}),
      title,
      phase: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastProgressAt: now,
      cancellable: true,
    });
  }

  private markWorkItemPhase(
    id: string,
    phase: "settling" | "completion-unknown",
    now = Date.now(),
  ): void {
    const existing = this.workItems.get(id);
    if (!existing || this.isTerminalWorkPhase(existing.phase)) {
      return;
    }
    this.workItems.set(id, {
      ...existing,
      phase,
      updatedAt: now,
      lastProgressAt: existing.lastProgressAt,
    });
  }

  private finishWorkItem(
    id: string,
    phase: "complete" | "failed" | "cancelled",
    source: NonNullable<RemoteWorkItem["terminalEvidence"]>["source"],
    status: string,
    now = Date.now(),
  ): void {
    const existing = this.workItems.get(id);
    if (!existing || this.isTerminalWorkPhase(existing.phase)) {
      return;
    }
    this.workItems.set(id, {
      ...existing,
      phase,
      updatedAt: now,
      lastProgressAt: Math.max(existing.lastProgressAt, now),
      terminalEvidence: { source, status, recordedAt: now },
    });
  }

  private hasOpenTurnForTerminalAssistantError(): boolean {
    return this.foregroundTurnActive ||
      this.currentForegroundWorkId !== undefined ||
      this.outgoingPromptIds.size > 0 ||
      (this.lease.turnStartedAt !== undefined &&
        this.lease.turnCompletedAt === undefined);
  }

  private recordForegroundTerminalEvidence(
    source: "sdk-result" | "sdk-assistant-error",
    isError: boolean,
    status: string,
    now = Date.now(),
  ): void {
    this.foregroundTurnActive = false;
    // A root terminal response proves that foreground tools cannot continue.
    // Background workflows and subagents are independent work items and keep
    // waiting for their own terminal task notification.
    for (const item of this.workItems.values()) {
      if (item.kind === "tool" && !this.isTerminalWorkPhase(item.phase)) {
        this.finishWorkItem(
          item.id,
          isError ? "failed" : "complete",
          source,
          isError ? "turn-error" : "turn-complete",
          now,
        );
      }
    }
    const unacknowledgedPromptId = this.outgoingPromptIds.keys().next().value;
    if (unacknowledgedPromptId) {
      this.finishWorkItem(
        `prompt:${unacknowledgedPromptId}`,
        "complete",
        source,
        "accepted-before-terminal-response",
        now,
      );
      this.outgoingPromptIds.delete(unacknowledgedPromptId);
    }
    const responseWorkId =
      this.currentForegroundWorkId ??
      (unacknowledgedPromptId
        ? this.responseWorkByPrompt.get(unacknowledgedPromptId)
        : undefined) ??
      [...this.workItems.values()].find(
        (item) =>
          item.kind === "foreground-response" &&
          !this.isTerminalWorkPhase(item.phase),
      )?.id;
    if (responseWorkId) {
      this.finishWorkItem(
        responseWorkId,
        isError ? "failed" : "complete",
        source,
        status,
        now,
      );
    }
    this.currentForegroundWorkId = undefined;
    this.pendingTurnResult = {
      isError: isError || this.pendingTurnResult?.isError === true,
    };
  }

  private taskKind(taskType: string): RemoteWorkItemKind {
    return /workflow/iu.test(taskType) ? "workflow" : "subagent";
  }

  private observeNormalisedWork(event: NormalisedJournalEvent): void {
    if (event.type !== "activity.event") {
      return;
    }
    const payload = event.payload;
    const now = payload.updatedAt;
    if (payload.category === "task" && payload.taskId) {
      const id = `task:${payload.taskId}`;
      const tracked = this.backgroundTasks.get(payload.taskId);
      if (payload.phase === "complete" || payload.phase === "failed") {
        if (!this.workItems.has(id)) {
          this.activateWorkItem(
            id,
            this.taskKind(tracked?.taskType ?? "agent"),
            payload.title,
          );
        }
        const terminalSource =
          isRecord(payload.data) && payload.data.subtype === "task_updated"
            ? "sdk-task-update"
            : "sdk-task-notification";
        this.finishWorkItem(
          id,
          payload.phase,
          terminalSource,
          payload.phase,
          now,
        );
        this.backgroundTasks.delete(payload.taskId);
      } else if (payload.phase === "settling") {
        this.markWorkItemPhase(id, "settling", now);
        if (tracked) {
          tracked.phase = "settling";
        }
      } else if (payload.phase === "running-task") {
        const taskType = tracked?.taskType ?? "agent";
        this.activateWorkItem(id, this.taskKind(taskType), payload.title);
        if (!tracked) {
          this.backgroundTasks.set(payload.taskId, {
            taskType,
            description: payload.title,
            phase: "active",
          });
        }
      }
      this.lease.backgroundTaskCount = this.backgroundTasks.size;
    }
    if (payload.category === "tool" && payload.toolUseId) {
      const id = `tool:${payload.toolUseId}`;
      if (payload.phase === "complete" || payload.phase === "failed") {
        if (!this.workItems.has(id)) {
          this.activateWorkItem(id, "tool", payload.title);
        }
        this.finishWorkItem(id, payload.phase, "sdk-tool-result", payload.phase, now);
      } else if (payload.phase === "running-tool") {
        this.activateWorkItem(id, "tool", payload.title);
      }
    }
    this.refreshBusyFromLedger();
  }

  private hasNonTerminalWork(): boolean {
    return [...this.workItems.values()].some((item) => !this.isTerminalWorkPhase(item.phase));
  }

  private canAuthoritativelyFinishTurn(): boolean {
    return !this.foregroundTurnActive && this.outgoingPromptIds.size === 0 &&
      this.permissions.size === 0 && this.questions.size === 0 && !this.hasNonTerminalWork();
  }

  private isAuthoritativelyQuiescent(): boolean {
    return this.canAuthoritativelyFinishTurn() && this.pendingTurnResult === undefined;
  }

  private refreshBusyFromLedger(): void {
    this.busy = !this.isAuthoritativelyQuiescent();
  }

  private async maybeFinishTurn(activeQuery: ActiveRemoteQuery): Promise<boolean> {
    if (!this.canAuthoritativelyFinishTurn()) {
      this.refreshBusyFromLedger();
      const phases = [...this.workItems.values()].map((item) => item.phase);
      if (phases.includes("completion-unknown")) {
        this.lease.turnPhase = "completion-unknown";
      } else if (phases.includes("settling")) {
        this.lease.turnPhase = "settling";
      }
      return false;
    }
    if (this.lease.turnStartedAt === undefined || this.lease.turnCompletedAt !== undefined) {
      this.refreshBusyFromLedger();
      return false;
    }
    const isError = this.pendingTurnResult?.isError === true ||
      [...this.workItems.values()].some((item) => item.phase === "failed");
    await this.finishTurn(activeQuery, isError);
    return true;
  }

  private async markSettlingWorkUnknown(): Promise<void> {
    const now = Date.now();
    const changed: RemoteWorkItem[] = [];
    for (const item of this.workItems.values()) {
      if (item.phase !== "settling") {
        continue;
      }
      this.markWorkItemPhase(item.id, "completion-unknown", now);
      const updated = this.workItems.get(item.id);
      if (updated) {
        changed.push(updated);
      }
    }
    for (const tracked of this.backgroundTasks.values()) {
      if (tracked.phase === "settling") {
        tracked.phase = "completion-unknown";
      }
    }
    if (changed.length === 0) {
      return;
    }
    this.lease.turnPhase = "completion-unknown";
    this.lease.lastActivityAt = now;
    if (this.lease.operation?.kind === "handback") {
      this.lease.operation = {
        ...this.lease.operation,
        blockerIds: changed.map((item) => item.id),
        waitReason: "Final workflow record pending",
        lastProgressAt: Math.max(...changed.map((item) => item.lastProgressAt)),
        attentionAt: this.lease.operation.attentionAt ?? now,
        availableActions: ["continue-waiting", "cancel-handback", "cancel-work-and-return"],
        updatedAt: now,
      };
    }
    this.refreshBusyFromLedger();
    await this.journal.append("activity.event", {
      kind: "activity.event",
      id: `completion-unknown:${this.lease.id}`,
      category: "task",
      phase: "completion-unknown",
      title: "Final workflow record is still pending",
      detail: "Work remains active on this Mac. ModelHop will not close the conversation without terminal evidence.",
      createdAt: now,
      updatedAt: now,
      data: { blockerIds: changed.map((item) => item.id) },
    } satisfies RemoteActivityEvent);
    await this.publishState();
  }

  private replaceBackgroundTasks(
    tasks: readonly {
      task_id: string;
      task_type: string;
      description: string;
    }[],
  ): void {
    const currentIds = new Set(tasks.map((task) => task.task_id));
    const now = Date.now();
    for (const [taskId, tracked] of this.backgroundTasks) {
      if (currentIds.has(taskId)) {
        continue;
      }
      const item = this.workItems.get(`task:${taskId}`);
      if (item && this.isTerminalWorkPhase(item.phase)) {
        this.backgroundTasks.delete(taskId);
        continue;
      }
      tracked.phase = "settling";
      this.markWorkItemPhase(`task:${taskId}`, "settling", now);
    }
    for (const task of tasks) {
      const workId = `task:${task.task_id}`;
      const knownWork = this.workItems.get(workId);
      // A late/stale live-list frame cannot undo authoritative terminal
      // evidence already recorded for this task.
      if (knownWork && this.isTerminalWorkPhase(knownWork.phase)) {
        this.backgroundTasks.delete(task.task_id);
        continue;
      }
      this.backgroundTasks.set(task.task_id, {
        taskType: task.task_type,
        description: task.description,
        phase: "active",
      });
      this.activateWorkItem(
        workId,
        this.taskKind(task.task_type),
        task.description || "Background task",
      );
    }
    this.lease.backgroundTaskCount = this.backgroundTasks.size;
    if (this.backgroundTasks.size > 0) {
      if (!this.busy) {
        this.beginTurn();
      }
      this.busy = true;
      this.lease.state = "running";
      this.lease.turnPhase = "running-task";
      this.lease.lastActivityAt = now;
    } else if (this.foregroundTurnActive) {
      this.lease.turnPhase = "streaming";
    }
    this.refreshBusyFromLedger();
  }

  private async finishTurn(
    activeQuery: ActiveRemoteQuery,
    isError: boolean,
  ): Promise<void> {
    this.pendingTurnResult = undefined;
    this.foregroundTurnActive = false;
    this.currentForegroundWorkId = undefined;
    this.responseWorkByPrompt.clear();
    this.busy = false;
    this.completeTurn();
    resetSdkMessageNormalisationState(
      activeQuery.normalisationState,
    );
    const desktopDiverged =
      this.lease.remoteInputRevokedReason === "desktop-diverged";
    this.lease.state = this.lease.operation
      ? this.lease.operation.kind === "provider-switch"
        ? "switching-provider"
        : "handing-back"
      : desktopDiverged
        ? "paused-diverged"
        : "paired";
    this.lease.turnPhase = this.lease.operation
      ? this.lease.operation.kind === "provider-switch"
        ? "switching-provider"
        : "handing-back"
      : desktopDiverged
        ? "failed"
        : isError
          ? "failed"
          : "complete";
    this.lease.lastActivityAt = Date.now();
    this.notifyIdle();
    await this.publishContextUsage(activeQuery.query, activeQuery);
    if (!this.isCurrent(activeQuery)) {
      return;
    }
    await this.publishState();
    await this.onTurnComplete?.();
  }

  private async settleFailedTurn(
    activeQuery: ActiveRemoteQuery,
    message: string,
  ): Promise<void> {
    const wasBusy = this.isBusy();
    this.foregroundTurnActive = false;
    this.backgroundTasks.clear();
    const failedAt = Date.now();
    for (const item of this.workItems.values()) {
      if (!this.isTerminalWorkPhase(item.phase)) {
        this.finishWorkItem(
          item.id,
          "failed",
          "controller-failure",
          "query-failed",
          failedAt,
        );
      }
    }
    this.outgoingPromptIds.clear();
    this.currentForegroundWorkId = undefined;
    this.pendingTurnResult = undefined;
    this.ignoreResultsUntilPromptAccepted = false;
    this.terminalProviderFailure = undefined;
    this.lease.backgroundTaskCount = 0;
    this.busy = false;
    if (wasBusy) {
      this.completeTurn();
    }
    resetSdkMessageNormalisationState(
      activeQuery.normalisationState,
    );
    this.lease.state = "error";
    this.lease.turnPhase = "failed";
    this.lease.error = message;
    try {
      await this.journal.append("error", { message });
      await this.publishState();
    } finally {
      if (wasBusy) {
        this.notifyIdle();
      }
    }
  }

  private async withRouteMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.routeMutationTail;
    let release!: () => void;
    this.routeMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async setRuntimeThinking(
    activeQuery: ActiveRemoteQuery,
    enabled: boolean | undefined,
  ): Promise<void> {
    if (!usesClaudeRuntimeThinking(activeQuery.provider.provider)) {
      return;
    }
    await activeQuery.query.setMaxThinkingTokens(
      enabled === undefined
        ? null
        : enabled
          ? CLAUDE_ADAPTIVE_THINKING_TOKENS
          : 0,
      enabled === true ? "summarized" : undefined,
    );
    activeQuery.runtimeThinkingEnabled = enabled;
  }

  private async verifyEffectiveReasoningSettings(
    activeQuery: ActiveRemoteQuery,
    reasoning: NonNullable<RemoteProviderContext["reasoning"]>,
  ): Promise<void> {
    if (!usesClaudeRuntimeThinking(activeQuery.provider.provider)) {
      return;
    }
    if (
      remoteEffortRequiresClaudeThinking(
        activeQuery.provider.provider,
        reasoning.effectiveEffort,
      ) &&
      !reasoning.thinkingSupported
    ) {
      throw new Error(
        `${reasoning.effectiveEffort} reasoning cannot run because ${activeQuery.provider.model} does not advertise adaptive Thinking.`,
      );
    }
    if (
      remoteEffortRequiresClaudeThinking(
        activeQuery.provider.provider,
        reasoning.effectiveEffort,
      ) &&
      activeQuery.runtimeThinkingEnabled !== true
    ) {
      throw new Error(
        `${reasoning.effectiveEffort} reasoning was not applied because the active Claude query still has Thinking disabled.`,
      );
    }
    const getSettings = (activeQuery.query as QueryWithSettingsReadback)
      .getSettings;
    if (!getSettings) {
      return;
    }
    const readback = await getSettings.call(activeQuery.query);
    const effective =
      isRecord(readback) && isRecord(readback.effective)
        ? readback.effective
        : readback;
    const snapshot = remoteReasoningSettingsSnapshot(effective);
    if (
      reasoning.thinkingEnabled &&
      snapshot.alwaysThinkingEnabled === false
    ) {
      throw new Error(
        "Claude policy kept Thinking disabled, so ModelHop did not apply the requested reasoning level.",
      );
    }
    if (
      reasoning.effectiveEffort &&
      reasoning.effectiveEffort !== "none" &&
      snapshot.effortLevel !== undefined &&
      snapshot.effortLevel !== reasoning.effectiveEffort
    ) {
      throw new Error(
        `Claude applied ${snapshot.effortLevel} reasoning instead of ${reasoning.effectiveEffort}. ModelHop kept the previous route settings.`,
      );
    }
  }

  private async rollbackRouteRuntime(
    activeQuery: ActiveRemoteQuery,
    settings: RemoteReasoningSettingsSnapshot,
    model?: string,
    runtimeThinking?: { thinkingEnabled: boolean | undefined },
  ): Promise<Error | undefined> {
    const failures: Error[] = [];
    if (model !== undefined) {
      // A failed target mutation may have partially left xhigh/Ultra active.
      // Neutralize those flags while the target model is still selected so a
      // high-only previous model can be restored safely.
      try {
        await activeQuery.query.applyFlagSettings({
          effortLevel: null,
          workflowSizeGuideline: null,
          ultracode: false,
        });
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      try {
        await activeQuery.query.setModel(model);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (runtimeThinking?.thinkingEnabled === true) {
      try {
        await this.setRuntimeThinking(activeQuery, true);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    try {
      await activeQuery.query.applyFlagSettings(
        restoringReasoningFlags(settings),
      );
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (
      runtimeThinking &&
      runtimeThinking.thinkingEnabled !== true
    ) {
      try {
        await this.setRuntimeThinking(
          activeQuery,
          runtimeThinking.thinkingEnabled,
        );
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (failures.length === 0) {
      return undefined;
    }
    return new Error(
      failures.map((failure) => failure.message).join("; "),
    );
  }

  private async failClosedRouteMutation(
    activeQuery: ActiveRemoteQuery,
    originalFailure: unknown,
    rollbackFailure: Error,
  ): Promise<never> {
    const originalMessage =
      originalFailure instanceof Error
        ? originalFailure.message
        : String(originalFailure);
    const message =
      `The route update failed (${originalMessage}) and ModelHop could not restore the prior Claude runtime settings (${rollbackFailure.message}). ` +
      "Remote input has been paused so the provider and model cannot be misreported.";
    if (this.isCurrent(activeQuery)) {
      await this.closeActiveQuery(activeQuery);
    }
    this.lease.state = "error";
    this.lease.turnPhase = "failed";
    this.lease.error = message;
    this.lease.lastActivityAt = Date.now();
    await this.journal
      .append("error", { message })
      .catch(() => undefined);
    await this.publishState().catch(() => undefined);
    throw new Error(message);
  }

  private isCurrent(activeQuery: ActiveRemoteQuery): boolean {
    return (
      this.activeQuery === activeQuery &&
      this.activeQuery.generation === activeQuery.generation
    );
  }

  private async closeActiveQuery(
    activeQuery: ActiveRemoteQuery,
  ): Promise<void> {
    activeQuery.closing = true;
    if (this.isCurrent(activeQuery)) {
      this.activeQuery = undefined;
    }
    activeQuery.query.close();
    if (activeQuery.runner) {
      await Promise.race([
        activeQuery.runner.catch(() => undefined),
        new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            this.timing.closeGraceMs ?? 5_000,
          ),
        ),
      ]);
    }
  }

  private notifyIdle(): void {
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }

  private beginTurn(now = Date.now()): void {
    this.lease.turnStartedAt = now;
    this.lease.turnCompletedAt = undefined;
  }

  private completeTurn(now = Date.now()): void {
    if (
      this.lease.turnStartedAt !== undefined &&
      this.lease.turnCompletedAt === undefined
    ) {
      this.lease.turnCompletedAt = Math.max(
        now,
        this.lease.turnStartedAt,
      );
    }
  }

  private async publishContextUsage(
    activeQuery: Query,
    queryState?: ActiveRemoteQuery,
  ): Promise<void> {
    if (queryState && !this.isCurrent(queryState)) {
      return;
    }
    try {
      const context = await activeQuery.getContextUsage();
      if (queryState && !this.isCurrent(queryState)) {
        return;
      }
      await this.journal.append("usage.snapshot", {
        kind: "usage.snapshot",
        provider: this.lease.provider.provider,
        status: "available",
        // Context usage is metering data, not a model-selection authority.
        // Some Claude runtimes return presentation text here (for example
        // "Default Claude model"), which must never become an SDK selector.
        model: this.lease.provider.model,
        updatedAt: Date.now(),
        context: {
          usedTokens: context.totalTokens,
          maxTokens: context.maxTokens,
          percentage: context.percentage,
        },
        allowance: cloneForRemote(this.lease.provider.usage),
      } satisfies RemoteUsageSnapshot);
    } catch (error) {
      if (error instanceof RemoteProviderModelMismatchError) {
        throw error;
      }
      // Older Claude Code runtimes may not implement getContextUsage.
    }
  }

  private async publishState(): Promise<void> {
    this.runtimeRevision += 1;
    await this.journal.append("session.state", this.getLease());
  }

  private replaceProviderContext(
    provider: RemoteProviderContext,
    activeQuery?: ActiveRemoteQuery,
  ): void {
    this.routeRevision += 1;
    const leaseProvider = structuredClone(provider);
    this.lease.provider = leaseProvider;
    this.configuration.lease.provider = structuredClone(leaseProvider);
    if (activeQuery && this.isCurrent(activeQuery)) {
      activeQuery.provider = structuredClone(leaseProvider);
    }
  }

  private async observeRuntimeModel(
    activeQuery: ActiveRemoteQuery,
    observedModel: string,
  ): Promise<void> {
    const observed = observedModel.trim();
    if (!observed || !this.isCurrent(activeQuery)) {
      return;
    }
    assertRemoteRuntimeModel(this.lease.provider.provider, observed);
    const resolution = resolveRemoteRuntimeModelObservation(
      this.lease.provider.provider,
      this.lease.provider.model,
      observed,
      this.lease.provider.modelCatalog?.options ?? [],
    );
    const model = resolution.selector;
    if (this.lease.provider.model === model) {
      return;
    }
    const providerWithoutReasoning: RemoteProviderContext = {
      ...this.lease.provider,
      model,
      reasoning: undefined,
      roleModels: { ...this.lease.provider.roleModels },
      updatedAt: Date.now(),
    };
    const reasoning = resolveRemoteReasoningContext(
      providerWithoutReasoning,
      activeQuery.modelCatalog,
      activeQuery.reasoningSettings,
      {
        workflowsAdministrativelyDisabled:
          environmentDisablesWorkflows(
            this.configuration.environment,
          ),
        workflowBridgeReady: true,
      },
    );
    const selectedEffort =
      providerWithoutReasoning.reasoningEffort ??
      activeQuery.reasoningSettings.effortLevel;
    if (selectedEffort) {
      assertSupportedRemoteEffort(reasoning, selectedEffort, model);
    }
    const provider: RemoteProviderContext = {
      ...providerWithoutReasoning,
      reasoning,
      reasoningEffort:
        reasoning.effectiveEffort ??
        providerWithoutReasoning.reasoningEffort,
    };
    this.replaceProviderContext(provider, activeQuery);
    await this.journal.append("provider.context", provider);
    await this.journal.append("session.capabilities", {
      kind: "session.capabilities",
      model,
      permissionMode: remotePermissionMode(
        this.configuration.permissionMode,
      ),
      tools: [],
      commands: [],
      skills: [],
      protocolCapabilities: [],
      reasoning,
      updatedAt: Date.now(),
    } satisfies RemoteSessionCapabilities);
  }
}
