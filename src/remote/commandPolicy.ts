import type {
  RemoteClientCommand,
  RemoteHostAction,
  RemoteOperation,
} from "./types.js";

export type RemoteCommandAdmission =
  | { allowed: true }
  | {
      allowed: false;
      code: "operation-conflict" | "handback-operation-mismatch";
      reason: string;
    };

export type RemoteCommandAdmissionOperation = Pick<
  RemoteOperation,
  "id" | "kind" | "phase"
>;

type ProviderSwitchHostAction = Pick<
  RemoteHostAction,
  "id" | "type" | "operationId"
>;

export interface RemoteMutationOwnershipFence {
  ownerDeviceId?: string;
  fencingGeneration: number;
}

export interface RemoteConnectionOwnershipClaim {
  deviceId: string;
  fencingGeneration?: number;
}

const ALLOWED = { allowed: true } as const;

function operationConflict(
  operation: RemoteCommandAdmissionOperation,
): RemoteCommandAdmission {
  return {
    allowed: false,
    code: "operation-conflict",
    reason:
      operation.kind === "handback"
        ? "ModelHop is returning this conversation to the laptop."
        : "ModelHop is switching the active provider.",
  };
}

/**
 * A hand-back may replace a provider switch only while the switch is still a
 * completely unclaimed queue item. Claiming the desktop action is the first
 * point at which the editor may capture its encrypted rollback checkpoint, so
 * even an expired claim is durable evidence that route mutation might have
 * begun and must keep the normal operation barrier in place.
 */
export function canSupersedeUnstartedProviderSwitch(
  operation: RemoteCommandAdmissionOperation,
  hostActions: readonly ProviderSwitchHostAction[],
  claimedActionIds: ReadonlySet<string>,
): boolean {
  if (
    operation.kind !== "provider-switch" ||
    operation.phase !== "waiting-for-turn"
  ) {
    return false;
  }
  const relatedActions = hostActions.filter(
    (action) =>
      action.type === "provider.change" &&
      action.operationId === operation.id,
  );
  return (
    relatedActions.length > 0 &&
    relatedActions.every(
      (action) => !claimedActionIds.has(action.id),
    )
  );
}

/**
 * Classifies commands which may be issued by a paired observer and commands
 * which must carry the current writable-device ownership fence.
 *
 * The observer-safe surface is deliberately limited to read-only repository,
 * source-control, and usage inspection. Everything which can mutate the
 * conversation, route, permissions, credentials, quota, or session lifecycle
 * requires the active owner.
 */
export function remoteCommandRequiresOwnershipFence(
  command: RemoteClientCommand,
): boolean {
  switch (command.type) {
    case "files.search":
    case "files.list":
    case "symbols.search":
    case "file.read":
    case "file.reference.read":
    case "git.status":
    case "git.diff":
    case "usage.refresh":
      return false;
    case "prompt.send":
    case "turn.cancel":
    case "session.handback":
    case "session.handback.continue":
    case "session.handback.cancel-request":
    case "session.terminal.ack":
    case "permission.mode.set":
    case "permission.resolve":
    case "question.resolve":
    case "provider.change":
    case "model.change":
    case "reasoning.change":
    case "attachment.upload":
    case "codex.reset":
      return true;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

/**
 * A paired device is not automatically a writer. It may mutate the remote
 * session only when both its device identity and the generation captured at
 * ownership grant still match the controller's current fence.
 */
export function connectionHoldsRemoteMutationFence(
  connection: RemoteConnectionOwnershipClaim,
  ownership: RemoteMutationOwnershipFence,
): boolean {
  return (
    ownership.ownerDeviceId !== undefined &&
    connection.deviceId === ownership.ownerDeviceId &&
    connection.fencingGeneration === ownership.fencingGeneration
  );
}

/**
 * Applies the operation barrier after authentication and ownership checks.
 * An active operation admits monitoring and the controls needed to settle
 * already-running work, but never admits new work or a second operation.
 */
export function evaluateRemoteCommandAdmission(
  command: RemoteClientCommand,
  operation?: RemoteCommandAdmissionOperation,
): RemoteCommandAdmission {
  if (!operation) {
    return ALLOWED;
  }

  switch (command.type) {
    // Read-only monitoring remains available throughout either operation.
    case "files.search":
    case "files.list":
    case "symbols.search":
    case "file.read":
    case "file.reference.read":
    case "git.status":
    case "git.diff":
    case "usage.refresh":
      return ALLOWED;

    // These settle work which began before the operation barrier.
    case "turn.cancel":
    case "permission.resolve":
    case "question.resolve":
      return ALLOWED;

    // A terminal acknowledgement is part of completing hand-back, not a new
    // operation. Its terminal event identity is validated by the server.
    case "session.terminal.ack":
      return operation.kind === "handback"
        ? ALLOWED
        : operationConflict(operation);

    // Attention controls may affect only the hand-back operation named by the
    // phone. They cannot control a provider switch or a stale hand-back.
    case "session.handback.continue":
    case "session.handback.cancel-request":
      if (
        operation.kind === "handback" &&
        command.operationId === operation.id
      ) {
        return ALLOWED;
      }
      return {
        allowed: false,
        code: "handback-operation-mismatch",
        reason:
          "That hand-back control does not match the active operation.",
      };

    // A repeated hand-back command is how the phone monotonically escalates
    // an existing finish request to explicit cancellation. A provider switch
    // which has not left `waiting-for-turn` is also admissible here, but the
    // daemon must still atomically prove its desktop action was never claimed
    // before replacing it. Later switch phases remain mutually exclusive.
    case "session.handback":
      return operation.kind === "handback" ||
        (operation.kind === "provider-switch" &&
          operation.phase === "waiting-for-turn")
        ? ALLOWED
        : operationConflict(operation);

    // These start work, mutate routing/settings/quota, or request another
    // lifecycle operation. They must wait for the active operation to finish.
    case "prompt.send":
    case "permission.mode.set":
    case "provider.change":
    case "model.change":
    case "reasoning.change":
    case "attachment.upload":
    case "codex.reset":
      return operationConflict(operation);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
