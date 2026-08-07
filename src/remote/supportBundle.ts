import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  RemoteDaemonStatus,
  RemoteHandoffRecord,
  RemoteOperation,
  RemoteWorkItem,
} from "./types.js";

const SUPPORT_BUNDLE_VERSION = 1;

export interface RemoteSupportTransition {
  at: number;
  axis:
    | "transport"
    | "execution"
    | "ownership"
    | "route"
    | "journal"
    | "operation"
    | "handoff";
  state: string;
  correlationId?: string;
}

export interface RemoteSupportBundleInput {
  extensionVersion: string;
  generatedAt?: number;
  status?: RemoteDaemonStatus;
  handoff?: RemoteHandoffRecord;
  workItems?: readonly RemoteWorkItem[];
  transitions?: readonly RemoteSupportTransition[];
}

export interface RemoteSupportBundleResult {
  path: string;
  generatedAt: number;
  correlationId: string;
}

interface SafeOperation {
  correlationId: string;
  kind: RemoteOperation["kind"];
  phase: RemoteOperation["phase"];
  requestedAt: number;
  updatedAt: number;
  attentionAt?: number;
  blockerCount: number;
  lastProgressAt?: number;
  attempt?: number;
  fencingGeneration?: number;
  rollbackResult?: RemoteOperation["rollbackResult"];
  availableActions: NonNullable<RemoteOperation["availableActions"]>;
  targetProvider?: RemoteOperation["targetProvider"];
  previousProvider?: RemoteOperation["previousProvider"];
  hasError: boolean;
}

interface SafeWorkItem {
  correlationId: string;
  parentCorrelationId?: string;
  kind: RemoteWorkItem["kind"];
  phase: RemoteWorkItem["phase"];
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  cancellable: boolean;
  progress?: RemoteWorkItem["progress"];
  outputReferenceCount: number;
  terminalEvidence?: {
    source: NonNullable<RemoteWorkItem["terminalEvidence"]>["source"];
    status: string;
    recordedAt: number;
  };
}

interface Correlator {
  id(value: string | undefined): string | undefined;
}

function correlator(salt = randomBytes(32)): Correlator {
  return {
    id(value) {
      if (!value) {
        return undefined;
      }
      return createHash("sha256")
        .update(salt)
        .update("\0")
        .update(value)
        .digest("hex")
        .slice(0, 20);
    },
  };
}

function safeState(value: string): string {
  // State fields are protocol vocabulary, not arbitrary diagnostics. Use a
  // closed vocabulary so a token-shaped prompt, path segment, or argument
  // cannot pass merely because it contains no whitespace.
  const states = new Set([
    "accepted",
    "active",
    "applying",
    "cancelled",
    "complete",
    "completed",
    "completion-unknown",
    "connected",
    "desktop-confirmed",
    "error",
    "executing",
    "failed",
    "handing-back",
    "idle",
    "link-lost",
    "open-command-sent",
    "opening-session",
    "paired",
    "paused-diverged",
    "pending-reload",
    "phone-terminal-acked",
    "preparing",
    "queued",
    "quiescing",
    "reconciling-final-record",
    "recovering",
    "reloading",
    "requested",
    "restarting",
    "rolling-back",
    "running",
    "session-opened",
    "settling",
    "stabilizing-transcript",
    "starting",
    "stopped",
    "success",
    "succeeded",
    "unknown",
    "waiting-for-device",
    "waiting-for-permission",
    "waiting-for-question",
    "waiting-for-turn",
    "waiting-for-work",
  ]);
  return states.has(value) ? value : "unrecognized";
}

function safeVersion(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return /^\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/iu.test(value)
    ? value
    : "unrecognized";
}

function safeOperation(
  operation: RemoteOperation | undefined,
  ids: Correlator,
): SafeOperation | undefined {
  if (!operation) {
    return undefined;
  }
  return {
    correlationId: ids.id(operation.id) ?? "missing",
    kind: operation.kind,
    phase: operation.phase,
    requestedAt: operation.requestedAt,
    updatedAt: operation.updatedAt,
    ...(operation.attentionAt === undefined
      ? {}
      : { attentionAt: operation.attentionAt }),
    blockerCount: operation.blockerIds?.length ?? 0,
    ...(operation.lastProgressAt === undefined
      ? {}
      : { lastProgressAt: operation.lastProgressAt }),
    ...(operation.attempt === undefined
      ? {}
      : { attempt: operation.attempt }),
    ...(operation.fencingGeneration === undefined
      ? {}
      : { fencingGeneration: operation.fencingGeneration }),
    ...(operation.rollbackResult === undefined
      ? {}
      : { rollbackResult: operation.rollbackResult }),
    availableActions: [...(operation.availableActions ?? [])],
    ...(operation.targetProvider === undefined
      ? {}
      : { targetProvider: operation.targetProvider }),
    ...(operation.previousProvider === undefined
      ? {}
      : { previousProvider: operation.previousProvider }),
    hasError: Boolean(operation.error),
  };
}

function safeWorkItem(
  item: RemoteWorkItem,
  ids: Correlator,
): SafeWorkItem {
  return {
    correlationId: ids.id(item.id) ?? "missing",
    ...(item.parentId === undefined
      ? {}
      : { parentCorrelationId: ids.id(item.parentId) }),
    kind: item.kind,
    phase: item.phase,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastProgressAt: item.lastProgressAt,
    cancellable: item.cancellable,
    ...(item.progress === undefined
      ? {}
      : {
          progress: {
            ...(item.progress.current === undefined
              ? {}
              : { current: item.progress.current }),
            ...(item.progress.total === undefined
              ? {}
              : { total: item.progress.total }),
            ...(item.progress.elapsedMs === undefined
              ? {}
              : { elapsedMs: item.progress.elapsedMs }),
          },
        }),
    outputReferenceCount: item.outputReferences?.length ?? 0,
    ...(item.terminalEvidence === undefined
      ? {}
      : {
          terminalEvidence: {
            source: item.terminalEvidence.source,
            status: safeState(item.terminalEvidence.status),
            recordedAt: item.terminalEvidence.recordedAt,
          },
        }),
  };
}

/**
 * Build a deliberately allow-listed diagnostic object. This function never
 * serializes arbitrary status payloads, error messages, usage objects, tool
 * arguments, conversation content, credentials, URLs, or filesystem paths.
 */
export function buildRemoteSupportBundle(
  input: RemoteSupportBundleInput,
): Record<string, unknown> {
  const generatedAt = input.generatedAt ?? Date.now();
  const ids = correlator();
  const status = input.status;
  const lease = status?.lease;
  const operation = lease?.operation;
  const handoff = input.handoff;
  const bundleCorrelationId =
    ids.id(
      [
        lease?.id,
        handoff?.leaseId,
        String(generatedAt),
        randomUUID(),
      ]
        .filter(Boolean)
        .join("\0"),
    ) ?? "missing";

  return {
    schema: "modelhop.remote.support",
    version: SUPPORT_BUNDLE_VERSION,
    generatedAt,
    correlationId: bundleCorrelationId,
    product: {
      extensionVersion:
        safeVersion(input.extensionVersion) ?? "unknown",
      protocolVersion: safeVersion(status?.version),
      buildVersion: safeVersion(status?.buildVersion),
    },
    health: {
      daemonReady: status?.ready ?? false,
      configured: status?.configured ?? false,
      leaseState: lease?.state,
      turnPhase: lease?.turnPhase,
      transportState:
        status?.transport?.state ??
        (status?.tunnel ? "connected" : "unknown"),
      executionState: status?.query?.state ?? "unknown",
      recoveryState: status?.recovery?.state ?? "none",
      transcriptRecoverable:
        status?.recovery?.transcriptRecoverable ?? false,
      pendingPairingCount: status?.pendingPairings.length ?? 0,
      pairedDeviceCount: status?.pairedDevices.length ?? 0,
      activeDeviceCount:
        status?.pairedDevices.filter((device) => !device.revokedAt)
          .length ?? 0,
      hostActionCount: status?.hostActions.length ?? 0,
    },
    correlations: {
      lease: ids.id(lease?.id),
      sourceSession: ids.id(lease?.sourceSessionId),
      activeSession: ids.id(lease?.activeSessionId),
      ownerDevice: ids.id(lease?.ownerDeviceId),
      workspaceOwner: ids.id(status?.ownership?.workspaceOwnerId),
      journalEpoch: ids.id(status?.journal?.epoch),
    },
    timing: {
      leaseCreatedAt: lease?.createdAt,
      lastActivityAt: lease?.lastActivityAt,
      turnStartedAt: lease?.turnStartedAt,
      turnCompletedAt: lease?.turnCompletedAt,
      queryLastProgressAt: status?.query?.lastProgressAt,
      transportUpdatedAt: status?.transport?.updatedAt,
    },
    route: lease
      ? {
          provider: lease.provider.provider,
          modelCorrelationId: ids.id(lease.provider.model),
          reasoningEffort: lease.provider.reasoningEffort,
          routeUpdatedAt: lease.provider.updatedAt,
          providerChanged: lease.providerChanged,
        }
      : undefined,
    journal: status?.journal
      ? {
          earliestEventId: status.journal.earliestEventId,
          latestEventId: status.journal.latestEventId,
          snapshotCursor: status.journal.snapshotCursor,
        }
      : undefined,
    ownership: status?.ownership
      ? {
          fencingGeneration: status.ownership.fencingGeneration,
          hasDeviceOwner: Boolean(status.ownership.deviceId),
        }
      : undefined,
    operation: safeOperation(operation, ids),
    handoff: handoff
      ? {
          correlationId: ids.id(handoff.actionId ?? handoff.leaseId),
          phase: handoff.phase,
          createdAt: handoff.createdAt,
          updatedAt: handoff.updatedAt,
          openedAt: handoff.openedAt,
          actionAcknowledgedAt: handoff.actionAcknowledgedAt,
          hasError: Boolean(handoff.lastError),
        }
      : undefined,
    work: (input.workItems ?? []).map((item) =>
      safeWorkItem(item, ids),
    ),
    transitions: (input.transitions ?? []).map((transition) => ({
      at: transition.at,
      axis: transition.axis,
      state: safeState(transition.state),
      correlationId: ids.id(transition.correlationId),
    })),
    privacy: {
      allowListOnly: true,
      excluded: [
        "conversation and prompt text",
        "credentials and tokens",
        "raw tool names and arguments",
        "provider usage payloads",
        "URLs and tunnel secrets",
        "filesystem paths and filenames",
        "raw error messages and logs",
      ],
    },
  };
}

export async function writeRemoteSupportBundle(
  outputDirectory: string,
  input: RemoteSupportBundleInput,
): Promise<RemoteSupportBundleResult> {
  const generatedAt = input.generatedAt ?? Date.now();
  const bundle = buildRemoteSupportBundle({
    ...input,
    generatedAt,
  });
  const correlationId = String(bundle.correlationId);
  const timestamp = new Date(generatedAt)
    .toISOString()
    .replace(/[:.]/gu, "-");
  const outputPath = path.join(
    outputDirectory,
    `modelhop-remote-support-${timestamp}-${correlationId.slice(0, 8)}.json`,
  );
  const temporaryPath = `${outputPath}.${process.pid}-${randomUUID()}.tmp`;
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(bundle, undefined, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporaryPath, outputPath);
  await chmod(outputPath, 0o600);
  return { path: outputPath, generatedAt, correlationId };
}
