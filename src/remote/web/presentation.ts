import type {
  RemoteJournalEvent,
  RemoteProviderContext,
  RemoteUsageSnapshot,
} from "../types.js";

export type ActivityTone = "info" | "warning" | "success" | "error";

export interface ActivityPresentation {
  key: string;
  title: string;
  detail?: string;
  tone: ActivityTone;
  phase?: string;
  busy?: boolean;
}

export interface FileHierarchyNode {
  name: string;
  path: string;
  kind: "folder" | "file";
  children: FileHierarchyNode[];
}

export interface ConstellationNode {
  node: FileHierarchyNode;
  relation: "parent" | "current" | "sibling" | "child";
  x: number;
  y: number;
}

/**
 * Journal IDs are the protocol's ordering authority. Network retries can
 * replay an acknowledged prefix, and a recovered journal can contain lines
 * in physical write-completion order, so clients must sort and deduplicate
 * before rendering side effects.
 */
export function orderedUnseenEvents(
  events: readonly RemoteJournalEvent[],
  lastAppliedEventId: number,
): RemoteJournalEvent[] {
  const unseen = new Map<number, RemoteJournalEvent>();
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.id) ||
      event.id <= lastAppliedEventId ||
      unseen.has(event.id)
    ) {
      continue;
    }
    unseen.set(event.id, event);
  }
  return [...unseen.values()].sort(
    (left, right) => left.id - right.id,
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function displayCount(value: unknown): string | undefined {
  const numeric = numberValue(value);
  return numeric === undefined
    ? undefined
    : new Intl.NumberFormat().format(numeric);
}

export function formatProviderUsage(
  provider: RemoteProviderContext | undefined,
): string {
  if (!provider) {
    return "Usage unavailable";
  }
  if (provider.provider === "anthropic") {
    return "Account allowance managed in Claude";
  }
  const usage = asRecord(provider.usage);
  if (Object.keys(usage).length === 0) {
    return "Usage unavailable";
  }

  // Codex allowance is authoritative for this route. Check it before the
  // generic bridge token accumulator, which can legitimately still be zero.
  if (provider.provider === "openai-codex") {
    const codex = asRecord(usage.codex);
    const rateLimits = asRecord(codex.rateLimits);
    const primary = asRecord(rateLimits.primary);
    const used = numberValue(primary.usedPercent);
    return used === undefined
      ? "Waiting for Codex usage"
      : `${Math.max(0, 100 - used).toFixed(1)}% left`;
  }

  if (provider.provider === "synthetic") {
    const fiveHour = asRecord(usage.fiveHour);
    const weekly = asRecord(usage.weekly);
    const fiveHourRemaining = numberValue(fiveHour.remainingPercent);
    const weeklyRemaining = numberValue(weekly.percentRemaining);
    const labels = [
      fiveHourRemaining === undefined
        ? undefined
        : `5h ${fiveHourRemaining.toFixed(1)}%`,
      weeklyRemaining === undefined
        ? undefined
        : `wk ${weeklyRemaining.toFixed(1)}%`,
    ].filter((value): value is string => Boolean(value));
    return labels.length > 0
      ? labels.join(" · ")
      : "Waiting for Synthetic usage";
  }

  if (provider.provider === "openai-api") {
    const tokens = asRecord(usage.tokens);
    const requestCount = numberValue(tokens.requestCount);
    const inputTokens = numberValue(tokens.inputTokens) ?? 0;
    const outputTokens = numberValue(tokens.outputTokens) ?? 0;
    if (
      requestCount === undefined ||
      (requestCount === 0 && inputTokens === 0 && outputTokens === 0)
    ) {
      return "Waiting for first request";
    }
    return `${new Intl.NumberFormat().format(inputTokens + outputTokens)} tok · ${requestCount} req`;
  }

  return "Managed by Claude";
}

export function mergeUsageSnapshots(
  previous: RemoteUsageSnapshot | undefined,
  incoming: RemoteUsageSnapshot,
): RemoteUsageSnapshot {
  if (!previous || previous.provider !== incoming.provider) {
    return incoming;
  }
  return {
    ...previous,
    ...incoming,
    session: incoming.session ?? previous.session,
    context: incoming.context ?? previous.context,
    allowance: incoming.allowance ?? previous.allowance,
  };
}

export function providerUsageDetails(
  provider: RemoteProviderContext | undefined,
): string[] {
  if (!provider) {
    return ["Usage has not been received from the provider yet."];
  }
  const usage = asRecord(provider.usage);
  const rows = [
    `Provider: ${provider.label}`,
    `Model: ${provider.model}`,
    provider.reasoningEffort
      ? `Reasoning: ${provider.reasoningEffort}`
      : undefined,
  ];

  if (provider.provider === "openai-codex") {
    const limits = asRecord(asRecord(usage.codex).rateLimits);
    const primary = asRecord(limits.primary);
    const secondary = asRecord(limits.secondary);
    const primaryUsed = numberValue(primary.usedPercent);
    const secondaryUsed = numberValue(secondary.usedPercent);
    rows.push(
      primaryUsed === undefined
        ? "Primary allowance: unavailable"
        : `Primary allowance: ${Math.max(0, 100 - primaryUsed).toFixed(1)}% remaining`,
      dateFromSeconds(primary.resetsAt)
        ? `Primary reset: ${dateFromSeconds(primary.resetsAt)}`
        : undefined,
      secondaryUsed === undefined
        ? undefined
        : `Secondary allowance: ${Math.max(0, 100 - secondaryUsed).toFixed(1)}% remaining`,
      dateFromSeconds(secondary.resetsAt)
        ? `Secondary reset: ${dateFromSeconds(secondary.resetsAt)}`
        : undefined,
    );
    return rows.filter((value): value is string => Boolean(value));
  }

  if (provider.provider === "synthetic") {
    const fiveHour = asRecord(usage.fiveHour);
    const weekly = asRecord(usage.weekly);
    const fiveHourRemaining = numberValue(fiveHour.remainingPercent);
    const weeklyRemaining = numberValue(weekly.percentRemaining);
    rows.push(
      fiveHourRemaining === undefined
        ? "Five-hour allowance: unavailable"
        : `Five-hour allowance: ${fiveHourRemaining.toFixed(1)}% remaining`,
      dateFromDateLike(fiveHour.nextTickAt)
        ? `Next five-hour regeneration: ${dateFromDateLike(fiveHour.nextTickAt)}`
        : undefined,
      weeklyRemaining === undefined
        ? "Weekly allowance: unavailable"
        : `Weekly allowance: ${weeklyRemaining.toFixed(1)}% remaining`,
      dateFromDateLike(weekly.nextRegenAt)
        ? `Next weekly regeneration: ${dateFromDateLike(weekly.nextRegenAt)}`
        : undefined,
    );
    return rows.filter((value): value is string => Boolean(value));
  }

  if (provider.provider === "openai-api") {
    const tokens = asRecord(usage.tokens);
    const limits = asRecord(usage.rateLimits);
    const input = displayCount(tokens.inputTokens);
    const output = displayCount(tokens.outputTokens);
    const requests = displayCount(tokens.requestCount);
    const cost = numberValue(tokens.estimatedCostUsd);
    rows.push(
      requests === undefined ? "Requests: waiting for data" : `Requests: ${requests}`,
      input === undefined ? "Input tokens: waiting for data" : `Input tokens: ${input}`,
      output === undefined ? "Output tokens: waiting for data" : `Output tokens: ${output}`,
      cost === undefined
        ? "Estimated cost: unavailable"
        : `Estimated cost: $${cost.toFixed(4)}`,
      numberValue(limits.remainingRequests) === undefined
        ? undefined
        : `Remaining requests: ${String(limits.remainingRequests)}`,
      numberValue(limits.remainingTokens) === undefined
        ? undefined
        : `Remaining rate-limit tokens: ${String(limits.remainingTokens)}`,
    );
    return rows.filter((value): value is string => Boolean(value));
  }

  rows.push(
    "Account allowance: managed in Claude.",
  );
  return rows.filter((value): value is string => Boolean(value));
}

function dateFromSeconds(value: unknown): string | undefined {
  const seconds = numberValue(value);
  return seconds === undefined
    ? undefined
    : new Date(seconds * 1_000).toLocaleString();
}

function dateFromDateLike(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toLocaleString();
}

export function normalizeSdkActivity(value: unknown): ActivityPresentation | undefined {
  const record = asRecord(value);
  if (record.type === "result") {
    const subtype =
      typeof record.subtype === "string" ? record.subtype : "success";
    const resultId = identifier(
      record.uuid,
      record.session_id,
      subtype,
    );
    return subtype.includes("error")
      ? {
          key: `result-${resultId}`,
          title: "Turn failed",
          detail:
            typeof record.error === "string"
              ? record.error
              : typeof record.result === "string"
                ? record.result
                : undefined,
          tone: "error",
          phase: "Turn failed",
        }
      : {
          key: `result-${resultId}`,
          title: "Task complete",
          detail: resultSummary(record),
          tone: "success",
          phase: "Complete",
        };
  }

  if (record.type !== "system") {
    return undefined;
  }

  const subtype =
    typeof record.subtype === "string" ? record.subtype : "status";
  const key = `${subtype}-${identifier(record.task_id, record.uuid, record.timestamp)}`;

  switch (subtype) {
    case "init":
      return {
        key,
        title: "Claude Code is ready",
        detail:
          typeof record.model === "string"
            ? `Running ${record.model}`
            : "Session capabilities loaded",
        tone: "success",
        phase: "Ready",
      };
    case "status": {
      const status =
        typeof record.status === "string"
          ? record.status
          : typeof record.message === "string"
            ? record.message
            : "working";
      const compacting = status.toLowerCase().includes("compact");
      return {
        key,
        title: compacting ? "Compressing context" : sentence(status),
        detail: compacting
          ? "Preserving the recent conversation and tool relationships."
          : undefined,
        tone: "info",
        phase: compacting ? "Compacting conversation" : sentence(status),
        busy: true,
      };
    }
    case "compact_boundary": {
      const trigger =
        typeof record.trigger === "string" ? record.trigger : undefined;
      return {
        key,
        title: "Conversation compacted",
        detail: trigger ? `Triggered by ${trigger}` : "Context is ready to continue.",
        tone: "success",
        phase: "Context ready",
      };
    }
    case "task_started":
      return {
        key,
        title:
          typeof record.description === "string"
            ? record.description
            : "Background task started",
        detail:
          typeof record.task_type === "string"
            ? sentence(record.task_type)
            : undefined,
        tone: "info",
        phase: "Running task",
        busy: true,
      };
    case "task_progress":
      return {
        key,
        title:
          typeof record.summary === "string"
            ? record.summary
            : "Task is making progress",
        detail:
          typeof record.last_tool_name === "string"
            ? `Using ${record.last_tool_name}`
            : undefined,
        tone: "info",
        phase: "Running task",
        busy: true,
      };
    case "task_notification": {
      const status =
        typeof record.status === "string" ? record.status : "completed";
      return {
        key,
        title:
          typeof record.summary === "string"
            ? record.summary
            : `Task ${status}`,
        detail:
          typeof record.output_file === "string"
            ? `Output: ${record.output_file}`
            : undefined,
        tone: status.includes("fail") ? "error" : "success",
        phase: status.includes("fail") ? "Task failed" : "Task complete",
      };
    }
    case "tool_progress":
      return {
        key,
        title:
          typeof record.tool_name === "string"
            ? `Running ${record.tool_name}`
            : "Running a tool",
        detail:
          numberValue(record.elapsed_time_seconds) === undefined
            ? undefined
            : `${Number(record.elapsed_time_seconds).toFixed(1)} seconds elapsed`,
        tone: "info",
        phase:
          typeof record.tool_name === "string"
            ? `Running ${record.tool_name}`
            : "Running tool",
        busy: true,
      };
    case "api_retry":
      return {
        key,
        title: "Retrying the model request",
        detail:
          typeof record.error === "string" ? record.error : "The provider did not respond.",
        tone: "warning",
        phase: "Retrying provider",
        busy: true,
      };
    case "commands_changed":
      return {
        key,
        title: "Available commands updated",
        tone: "info",
      };
    default:
      return {
        key,
        title: sentence(subtype),
        detail:
          typeof record.message === "string" ? record.message : undefined,
        tone: "info",
      };
  }
}

function identifier(...values: unknown[]): string {
  const value = values.find(
    (candidate) =>
      typeof candidate === "string" ||
      typeof candidate === "number",
  );
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function resultSummary(record: Record<string, unknown>): string | undefined {
  const duration = numberValue(record.duration_ms);
  const turns = numberValue(record.num_turns);
  const values = [
    duration === undefined ? undefined : `${(duration / 1_000).toFixed(1)}s`,
    turns === undefined ? undefined : `${turns} turn${turns === 1 ? "" : "s"}`,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
}

function sentence(value: string): string {
  const normalized = value.replaceAll("_", " ").replaceAll("-", " ");
  return normalized.length === 0
    ? "Status update"
    : normalized[0]?.toUpperCase() + normalized.slice(1);
}

export function buildFileHierarchy(paths: string[]): FileHierarchyNode {
  const root: FileHierarchyNode = {
    name: "Workspace",
    path: "",
    kind: "folder",
    children: [],
  };
  const folders = new Map<string, FileHierarchyNode>([["", root]]);

  for (const rawPath of [...new Set(paths)].sort()) {
    const normalized = rawPath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ".")
      .join("/");
    if (!normalized) {
      continue;
    }
    const parts = normalized.split("/");
    let parent = root;
    let currentPath = "";
    for (const [index, part] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      if (!isFile) {
        let folder = folders.get(currentPath);
        if (!folder) {
          folder = {
            name: part,
            path: currentPath,
            kind: "folder",
            children: [],
          };
          folders.set(currentPath, folder);
          parent.children.push(folder);
        }
        parent = folder;
        continue;
      }
      if (!parent.children.some((child) => child.path === currentPath)) {
        parent.children.push({
          name: part,
          path: currentPath,
          kind: "file",
          children: [],
        });
      }
    }
  }

  sortHierarchy(root);
  return root;
}

function sortHierarchy(node: FileHierarchyNode): void {
  node.children.sort(
    (left, right) =>
      Number(right.kind === "folder") -
        Number(left.kind === "folder") ||
      left.name.localeCompare(right.name),
  );
  node.children.forEach(sortHierarchy);
}

export function findHierarchyNode(
  root: FileHierarchyNode,
  path: string,
): FileHierarchyNode | undefined {
  if (root.path === path) {
    return root;
  }
  for (const child of root.children) {
    const result = findHierarchyNode(child, path);
    if (result) {
      return result;
    }
  }
  return undefined;
}

export function parentPath(path: string): string | undefined {
  if (!path) {
    return undefined;
  }
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

export function constellationLayout(
  root: FileHierarchyNode,
  currentPath: string,
): ConstellationNode[] {
  const current = findHierarchyNode(root, currentPath) ?? root;
  const parent = parentPath(current.path);
  const parentNode =
    parent === undefined ? undefined : findHierarchyNode(root, parent);
  const siblings = (parentNode?.children ?? [])
    .filter((node) => node.path !== current.path)
    .slice(0, 2);
  const children = current.children.slice(0, 3);
  const output: ConstellationNode[] = [
    { node: current, relation: "current", x: 50, y: 50 },
  ];
  if (parentNode) {
    output.push({ node: parentNode, relation: "parent", x: 50, y: 11 });
  }

  const siblingPositions = [
    [16, 43],
    [84, 43],
  ] as const;
  siblings.forEach((node, index) => {
    const position = siblingPositions[index];
    if (position) {
      output.push({
        node,
        relation: "sibling",
        x: position[0],
        y: position[1],
      });
    }
  });

  const childPositions = (
    {
      1: [[50, 84]],
      2: [
        [25, 82],
        [75, 82],
      ],
      3: [
        [17, 76],
        [50, 84],
        [83, 76],
      ],
    } as const
  )[children.length as 1 | 2 | 3] ?? [];
  children.forEach((node, index) => {
    const position = childPositions[index];
    if (position) {
      output.push({
        node,
        relation: "child",
        x: position[0],
        y: position[1],
      });
    }
  });
  return output;
}
