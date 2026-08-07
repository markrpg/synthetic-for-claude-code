import { describe, expect, it } from "vitest";
import {
  boundedHostActionTerminals,
  deterministicHostActionId,
  deterministicRemoteOperationId,
  hydrateHostActionState,
} from "../../src/remote/hostActionDurability.js";
import type {
  RemoteHostAction,
  RemoteJournalEvent,
} from "../../src/remote/types.js";

function action(
  overrides: Partial<RemoteHostAction> = {},
): RemoteHostAction {
  return {
    id: "action-1",
    type: "session.handback",
    payload: { strategy: "finish" },
    createdAt: 100,
    leaseId: "lease-1",
    operationId: "operation-1",
    commandId: "command-1",
    requestHash: "hash-1",
    ...overrides,
  };
}

function event(
  id: number,
  type: RemoteJournalEvent["type"],
  payload: unknown,
): RemoteJournalEvent {
  return { id, type, payload, createdAt: id * 100 };
}

describe("durable remote host actions", () => {
  it("derives stable action and operation identities from an authenticated command", () => {
    const first = deterministicHostActionId({
      type: "session.handback",
      leaseId: "lease-1",
      commandId: "command-1",
      requestHash: "hash-1",
    });
    const repeated = deterministicHostActionId({
      type: "session.handback",
      leaseId: "lease-1",
      commandId: "command-1",
      requestHash: "hash-1",
    });
    const changedRequest = deterministicHostActionId({
      type: "session.handback",
      leaseId: "lease-1",
      commandId: "command-1",
      requestHash: "hash-2",
    });

    expect(repeated).toBe(first);
    expect(changedRequest).not.toBe(first);
    expect(deterministicRemoteOperationId("handback", first)).toBe(
      deterministicRemoteOperationId("handback", repeated),
    );
  });

  it("keeps a terminal tombstone authoritative over duplicate or late action records", () => {
    const pending = action();
    const hydrated = hydrateHostActionState([
      event(1, "host.action", pending),
      event(2, "host.action.state", {
        id: pending.id,
        state: "complete",
        completedAt: 200,
        leaseId: pending.leaseId,
        operationId: pending.operationId,
        commandId: pending.commandId,
        requestHash: pending.requestHash,
      }),
      event(3, "host.action", pending),
    ]);

    expect(hydrated.actions.has(pending.id)).toBe(false);
    expect(hydrated.terminals.get(pending.id)).toEqual(
      expect.objectContaining({
        state: "complete",
        commandId: "command-1",
        requestHash: "hash-1",
      }),
    );
  });

  it("does not resurrect a persisted terminal action when the manifest still contains its stale pending copy", () => {
    const pending = action();
    const hydrated = hydrateHostActionState(
      [],
      [pending],
      [
        {
          id: pending.id,
          state: "complete",
          completedAt: 250,
          commandId: pending.commandId,
          requestHash: pending.requestHash,
        },
      ],
    );

    expect(hydrated.actions.size).toBe(0);
    expect(hydrated.terminals.has(pending.id)).toBe(true);
  });

  it("retains only the newest bounded terminal receipts", () => {
    const retained = boundedHostActionTerminals(
      [1, 2, 3].map((completedAt) => ({
        id: `action-${completedAt}`,
        state: "complete" as const,
        completedAt,
      })),
      2,
    );

    expect(retained.map((terminal) => terminal.id)).toEqual([
      "action-2",
      "action-3",
    ]);
  });
});
