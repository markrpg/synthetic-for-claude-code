import { createHash } from "node:crypto";
import type {
  RemoteHostAction,
  RemoteJournalEvent,
  RemoteOperationKind,
} from "./types.js";

export interface RemoteHostActionCommandReference {
  commandId: string;
  requestHash: string;
}

export interface RemoteHostActionTerminal {
  id: string;
  state: "complete" | "failed";
  completedAt: number;
  message?: string;
  leaseId?: string;
  operationId?: string;
  commandId?: string;
  requestHash?: string;
}

interface HostActionIdentityInput
  extends RemoteHostActionCommandReference {
  type: RemoteHostAction["type"];
  leaseId?: string;
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 40);
}

/**
 * A phone command always resolves to the same host action, including after a
 * daemon or extension-host restart. The request hash prevents a reused
 * command ID from aliasing a different authenticated request.
 */
export function deterministicHostActionId(
  input: HostActionIdentityInput,
): string {
  return `action-${digest([
    "modelhop-host-action-v1",
    input.leaseId ?? "unconfigured",
    input.type,
    input.commandId,
    input.requestHash,
  ])}`;
}

/** Operations and their host actions share one deterministic intent. */
export function deterministicRemoteOperationId(
  kind: RemoteOperationKind,
  actionId: string,
): string {
  return `operation-${digest([
    "modelhop-operation-v1",
    kind,
    actionId,
  ])}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function hostActionTerminalFromEvent(
  event: RemoteJournalEvent,
): RemoteHostActionTerminal | undefined {
  if (event.type !== "host.action.state") {
    return undefined;
  }
  const payload = record(event.payload);
  if (
    !payload ||
    typeof payload.id !== "string" ||
    (payload.state !== "complete" && payload.state !== "failed")
  ) {
    return undefined;
  }
  return {
    id: payload.id,
    state: payload.state,
    completedAt:
      typeof payload.completedAt === "number"
        ? payload.completedAt
        : event.createdAt,
    message:
      typeof payload.message === "string"
        ? payload.message
        : undefined,
    leaseId:
      typeof payload.leaseId === "string"
        ? payload.leaseId
        : undefined,
    operationId:
      typeof payload.operationId === "string"
        ? payload.operationId
        : undefined,
    commandId:
      typeof payload.commandId === "string"
        ? payload.commandId
        : undefined,
    requestHash:
      typeof payload.requestHash === "string"
        ? payload.requestHash
        : undefined,
  };
}

export interface HydratedHostActionState {
  actions: Map<string, RemoteHostAction>;
  terminals: Map<string, RemoteHostActionTerminal>;
}

/**
 * Rebuild pending actions and terminal tombstones in journal order. A late or
 * duplicated `host.action` can never resurrect an action whose terminal
 * record is already durable.
 */
export function hydrateHostActionState(
  events: readonly RemoteJournalEvent[],
  persistedActions: readonly RemoteHostAction[] = [],
  persistedTerminals: readonly RemoteHostActionTerminal[] = [],
): HydratedHostActionState {
  const actions = new Map<string, RemoteHostAction>();
  const terminals = new Map<string, RemoteHostActionTerminal>();
  for (const terminal of persistedTerminals) {
    terminals.set(terminal.id, structuredClone(terminal));
  }
  for (const action of persistedActions) {
    if (!terminals.has(action.id)) {
      actions.set(action.id, structuredClone(action));
    }
  }
  for (const event of events) {
    const terminal = hostActionTerminalFromEvent(event);
    if (terminal) {
      terminals.set(terminal.id, terminal);
      actions.delete(terminal.id);
      continue;
    }
    if (event.type !== "host.action") {
      continue;
    }
    const payload = record(event.payload);
    if (
      !payload ||
      typeof payload.id !== "string" ||
      typeof payload.type !== "string" ||
      terminals.has(payload.id)
    ) {
      continue;
    }
    actions.set(
      payload.id,
      structuredClone(payload as unknown as RemoteHostAction),
    );
  }
  return { actions, terminals };
}

export function boundedHostActionTerminals(
  terminals: Iterable<RemoteHostActionTerminal>,
  maximum = 512,
): RemoteHostActionTerminal[] {
  return [...terminals]
    .sort((left, right) => left.completedAt - right.completedAt)
    .slice(-Math.max(1, maximum))
    .map((terminal) => structuredClone(terminal));
}
