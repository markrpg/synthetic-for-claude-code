import type { RemoteSessionLease } from "../types.js";

export type RemoteLinkAxis =
  | "secure"
  | "reconnecting"
  | "link-lost"
  | "expired"
  | "revoked"
  | "switching"
  | "paused"
  | "error";

export type RemoteOwnershipAxis =
  | "phone"
  | "laptop"
  | "transferring"
  | "non-owner";

export interface RemoteWorkPresentation {
  id: string;
  title: string;
  kind: string;
  phase: string;
  detail?: string;
  progressLabel?: string;
  startedAt?: number;
  updatedAt?: number;
  terminal: boolean;
  blocker: boolean;
  terminalEvidence?: string;
}

export interface RemoteOperationPresentation {
  id?: string;
  kind?: string;
  phase?: string;
  requestedAt?: number;
  updatedAt?: number;
  attentionAt?: number;
  waitReason?: string;
  blockerIds: string[];
  availableActions: string[];
  overdue: boolean;
  rollbackResult?: string;
}

export interface RemoteOperationalPresentation {
  headline: string;
  detail?: string;
  tone: "normal" | "busy" | "warning" | "error";
  busy: boolean;
  inputBlocked: boolean;
  ownership: RemoteOwnershipAxis;
  work: RemoteWorkPresentation[];
  blockers: RemoteWorkPresentation[];
  operation?: RemoteOperationPresentation;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function text(...values: unknown[]): string | undefined {
  const value = values.find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
  return typeof value === "string" ? value : undefined;
}

function number(...values: unknown[]): number | undefined {
  const value = values.find(
    (candidate) => typeof candidate === "number" && Number.isFinite(candidate),
  );
  return typeof value === "number" ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
}

function sentence(value: string): string {
  const normalized = value.replaceAll("_", " ").replaceAll("-", " ");
  return normalized.length > 0
    ? `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`
    : "Working";
}

function terminalPhase(phase: string): boolean {
  return [
    "complete",
    "completed",
    "failed",
    "cancelled",
    "canceled",
    "stopped",
  ].includes(phase.toLowerCase());
}

function progressLabel(value: Record<string, unknown>): string | undefined {
  const progress = record(value.progress);
  const current = number(progress.current, value.current);
  const total = number(progress.total, value.total);
  const percent = number(progress.percent, value.percent);
  if (current !== undefined && total !== undefined && total > 0) {
    return `${new Intl.NumberFormat().format(current)} of ${new Intl.NumberFormat().format(total)}`;
  }
  if (percent !== undefined) {
    return `${Math.max(0, Math.min(100, percent)).toFixed(0)}%`;
  }
  return text(progress.label, value.progressLabel);
}

/**
 * Accept both the protocol work-ledger shape and older activity-shaped data.
 * This keeps an upgraded phone UI useful while the detached daemon is still
 * running an earlier build during a full-window reload.
 */
export function operationalWorkItems(value: unknown): RemoteWorkPresentation[] {
  const source = Array.isArray(value)
    ? value
    : Object.values(record(value));
  return source.flatMap((candidate, index) => {
    const item = record(candidate);
    if (Object.keys(item).length === 0) {
      return [];
    }
    const phase = text(item.phase, item.state, item.status) ?? "running";
    const evidence = text(
      item.terminalEvidence,
      record(item.terminalEvidence).kind,
      record(item.terminalEvidence).source,
      record(item.terminalEvidence).status,
      item.completionEvidence,
    );
    const terminal = item.terminal === true || (
      terminalPhase(phase) && evidence !== undefined
    );
    return [{
      id: text(item.id, item.taskId, item.toolUseId) ?? `work-${index}`,
      title: text(item.title, item.name, item.description, item.summary) ?? sentence(text(item.kind, item.type) ?? "work"),
      kind: text(item.kind, item.type, item.category) ?? "work",
      phase,
      detail: text(item.detail, item.waitReason, item.lastAction),
      progressLabel: progressLabel(item),
      startedAt: number(item.startedAt, item.createdAt),
      updatedAt: number(item.updatedAt, item.lastProgressAt),
      terminal,
      blocker: item.blocker === true || item.blocksQuiescence === true || [
        "settling",
        "completion-unknown",
        "waiting-terminal-record",
      ].includes(phase),
      terminalEvidence: evidence,
    }];
  });
}

export function operationalOperation(
  value: unknown,
  now: number,
): RemoteOperationPresentation | undefined {
  const operation = record(value);
  if (Object.keys(operation).length === 0) {
    return undefined;
  }
  const phase = text(operation.phase);
  if (phase === "complete" || phase === "failed") {
    return {
      id: text(operation.id),
      kind: text(operation.kind),
      phase,
      requestedAt: number(operation.requestedAt),
      updatedAt: number(operation.updatedAt, operation.lastProgressAt),
      attentionAt: number(operation.attentionAt),
      waitReason: text(operation.waitReason),
      blockerIds: strings(operation.blockerIds),
      availableActions: strings(operation.availableActions),
      overdue: false,
      rollbackResult: text(operation.rollbackResult),
    };
  }
  const attentionAt = number(operation.attentionAt);
  return {
    id: text(operation.id),
    kind: text(operation.kind),
    phase,
    requestedAt: number(operation.requestedAt),
    updatedAt: number(operation.updatedAt, operation.lastProgressAt),
    attentionAt,
    waitReason: text(operation.waitReason),
    blockerIds: strings(operation.blockerIds),
    availableActions: strings(operation.availableActions),
    overdue: attentionAt !== undefined && now >= attentionAt,
    rollbackResult: text(operation.rollbackResult),
  };
}

function ownershipAxis(lease: RemoteSessionLease): RemoteOwnershipAxis {
  const extended = record(lease);
  const runtime = record(extended.runtimeSnapshot ?? extended.runtime);
  const ownership = {
    ...record(runtime.ownership),
    ...record(extended.ownership),
  };
  const owner = text(ownership.owner, ownership.state, extended.ownershipState);
  if (owner === "non-owner" || ownership.canMutate === false) {
    return "non-owner";
  }
  if (
    typeof ownership.deviceId === "string" &&
    lease.ownerDeviceId !== undefined &&
    ownership.deviceId !== lease.ownerDeviceId
  ) {
    return "non-owner";
  }
  if (owner === "laptop" || lease.state === "stopped") {
    return "laptop";
  }
  if (owner === "transferring" || lease.state === "handing-back") {
    return "transferring";
  }
  return "phone";
}

function workFromLease(lease: RemoteSessionLease): RemoteWorkPresentation[] {
  const extended = record(lease);
  const runtime = record(extended.runtimeSnapshot ?? extended.runtime);
  const execution = record(runtime.execution);
  return operationalWorkItems(
    extended.workItems ?? execution.workItems ?? runtime.workItems ?? runtime.work,
  );
}

export function deriveOperationalStatus(input: {
  lease?: RemoteSessionLease;
  link: RemoteLinkAxis;
  now: number;
  phaseHint?: string;
}): RemoteOperationalPresentation {
  const lease = input.lease;
  if (!lease) {
    return {
      headline: input.link === "reconnecting" ? "Reconnecting securely" : "Starting remote session",
      tone: input.link === "reconnecting" ? "warning" : "busy",
      busy: true,
      inputBlocked: true,
      ownership: "phone",
      work: [],
      blockers: [],
    };
  }

  const extended = record(lease);
  const runtime = record(extended.runtimeSnapshot ?? extended.runtime);
  const work = workFromLease(lease);
  const observedOperation = operationalOperation(
    extended.operation ?? runtime.operation,
    input.now,
  );
  const operation = observedOperation?.phase === "complete"
    ? undefined
    : observedOperation;
  const explicitBlockers = new Set(operation?.blockerIds ?? []);
  const blockers = work.filter(
    (item) => item.blocker || (!item.terminal && explicitBlockers.has(item.id)),
  );
  const active = work.filter((item) => !item.terminal);
  const ownership = ownershipAxis(lease);
  const turnPhase = text(
    record(runtime.execution).state,
    record(runtime.execution).phase,
    extended.turnPhase,
    input.phaseHint,
  ) ?? "idle";

  if (input.link === "expired") {
    return status("This phone link has expired", "Create a new private link on your Mac. Running work was not cancelled.", "error", false, true, ownership, work, blockers, operation);
  }
  if (input.link === "revoked") {
    return status("This phone was revoked", "Remote input is disabled. Work on your Mac was not cancelled.", "error", false, true, ownership, work, blockers, operation);
  }
  if (ownership === "non-owner") {
    return status("Viewing another device’s session", "Only the owning phone can send commands. You can safely monitor progress here.", "warning", active.length > 0, true, ownership, work, blockers, operation);
  }
  if (ownership === "laptop") {
    return status("Conversation returned to laptop", "This phone is read-only and the private link is closing.", "normal", false, true, ownership, work, blockers, operation);
  }

  if (operation?.kind === "handback" && operation.phase === "failed") {
    return status(
      "Hand-back needs your attention",
      operation.waitReason ?? "The exact Claude conversation has not opened on your laptop. This phone remains connected for recovery.",
      "error",
      false,
      true,
      ownership,
      work,
      blockers,
      operation,
    );
  }

  if (operation?.kind === "handback") {
    const count = blockers.length || active.length;
    const named = blockers[0] ?? active[0];
    const waiting = count > 0
      ? `Returning after ${count} ${count === 1 ? "workflow finishes" : "work items finish"}`
      : operation.phase === "reconciling-final-record"
        ? "Verifying the final workflow record"
        : "Returning conversation to laptop";
    const detail = operation.overdue
      ? `${named?.title ?? "Claude"} is still working. You may lock this phone; work continues on your Mac.`
      : operation.waitReason ?? named?.detail ?? "ModelHop will open the exact conversation after durable completion is confirmed.";
    return status(waiting, detail, operation.overdue ? "warning" : "busy", true, true, ownership, work, blockers, operation);
  }

  if (operation?.kind === "provider-switch") {
    if (operation.phase === "failed" && operation.rollbackResult) {
      const rollbackDetail = operation.rollbackResult === "succeeded"
        ? `${lease.provider.label} · ${lease.provider.model} is active again. You can continue this conversation.`
        : operation.rollbackResult;
      return status("Previous provider restored", rollbackDetail, "warning", false, false, ownership, work, blockers, operation);
    }
    const providerUnavailable =
      lease.state === "error" ||
      (turnPhase === "failed" && Boolean(lease.error));
    if (
      providerUnavailable &&
      (operation.phase === "waiting-for-turn" ||
        operation.phase === "waiting-for-work")
    ) {
      const stillSettling = blockers[0] ?? active[0];
      return status(
        "Provider unavailable · switch queued",
        stillSettling
          ? `${stillSettling.title} still needs terminal evidence before ModelHop can change route.`
          : lease.error ??
              "The failed provider turn is settled. ModelHop is preparing the requested route.",
        "warning",
        true,
        true,
        ownership,
        work,
        blockers,
        operation,
      );
    }
    return status(
      operation.phase === "waiting-for-turn" ? "Switching provider after this response" : "Switching provider",
      operation.waitReason ?? "Your conversation and work remain on the Mac during the route change.",
      "busy",
      true,
      true,
      ownership,
      work,
      blockers,
      operation,
    );
  }

  if (turnPhase === "waiting-approval" || lease.state === "waiting-for-permission") {
    return status("Your approval is needed", "Claude is paused at a protected action.", "warning", false, false, ownership, work, blockers, operation);
  }
  if (turnPhase === "waiting-question" || lease.state === "waiting-for-question") {
    return status("Claude needs your answer", "Reply to continue this turn.", "warning", false, false, ownership, work, blockers, operation);
  }
  if (lease.remoteInputRevokedAt !== undefined) {
    const stillWorking = active.length > 0 || [
      "running",
      "requesting",
      "streaming",
      "running-tool",
      "running-task",
      "compacting",
      "counting",
    ].includes(turnPhase);
    return status(
      stillWorking
        ? "Remote limit reached · Claude is still working"
        : "Remote limit reached · returning to laptop",
      "New phone commands are disabled. Existing work continues on your Mac.",
      "warning",
      stillWorking,
      true,
      ownership,
      work,
      blockers,
      operation,
    );
  }
  if (blockers.some((item) => item.phase === "completion-unknown")) {
    return status("Waiting for durable completion", blockers[0]?.detail ?? "The work may be finished, but its final record has not arrived. ModelHop is keeping the session alive.", "warning", true, true, ownership, work, blockers, operation);
  }
  if (blockers.some((item) => item.phase === "settling" || item.phase === "waiting-terminal-record")) {
    return status("Final workflow record pending", blockers[0]?.title, "busy", true, true, ownership, work, blockers, operation);
  }
  if (input.link === "link-lost") {
    return status(
      active.length > 0 ? "Phone link lost · work continues" : "Phone link lost",
      active.length > 0 ? "Claude is still running and journaling on your Mac." : "Recreate the private phone link from ModelHop on your Mac.",
      "warning",
      active.length > 0,
      true,
      ownership,
      work,
      blockers,
      operation,
    );
  }
  if (input.link === "reconnecting") {
    return status("Reconnecting securely", active.length > 0 ? "Work continues on your Mac while the encrypted journal catches up." : "Restoring the encrypted session journal.", "warning", active.length > 0, true, ownership, work, blockers, operation);
  }
  if (input.phaseHint === "delivery-unknown" || turnPhase === "delivery-unknown") {
    return status("Checking Mac", "The phone did not receive a delivery receipt. ModelHop will not repeat the command until the Mac confirms its state.", "warning", true, true, ownership, work, blockers, operation);
  }
  if (input.link === "error") {
    return status("Remote connection needs attention", lease.error, "error", active.length > 0, true, ownership, work, blockers, operation);
  }
  if (active.length > 0 || ["running", "requesting", "streaming", "running-tool", "running-task", "compacting", "counting"].includes(turnPhase)) {
    const item = active[0];
    const phaseLabel = ({
      queued: "Queued on your Mac",
      counting: "Counting context",
      compacting: "Compacting conversation",
      requesting: "Requesting the model",
      streaming: "Claude is responding",
      "running-tool": "Running a tool",
      "running-task": "Running background work",
      running: "Claude is working",
      active: "Claude is working",
    } as Record<string, string>)[item?.phase ?? turnPhase] ??
      (item ? sentence(item.phase) : "Claude is working");
    return status(phaseLabel, item?.title, "busy", true, false, ownership, work, blockers, operation);
  }
  if (lease.state === "paused-diverged" || input.link === "paused") {
    return status("Paused after laptop activity", "Mobile input is locked to prevent two writable conversation owners.", "warning", false, true, ownership, work, blockers, operation);
  }
  if (lease.state === "error") {
    return status(lease.error ?? "Remote session needs attention", undefined, "error", false, true, ownership, work, blockers, operation);
  }
  return status("Ready", undefined, "normal", false, false, ownership, work, blockers, operation);
}

function status(
  headline: string,
  detail: string | undefined,
  tone: RemoteOperationalPresentation["tone"],
  busy: boolean,
  inputBlocked: boolean,
  ownership: RemoteOwnershipAxis,
  work: RemoteWorkPresentation[],
  blockers: RemoteWorkPresentation[],
  operation: RemoteOperationPresentation | undefined,
): RemoteOperationalPresentation {
  return { headline, detail, tone, busy, inputBlocked, ownership, work, blockers, operation };
}
