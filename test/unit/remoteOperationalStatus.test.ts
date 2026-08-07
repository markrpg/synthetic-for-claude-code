import { describe, expect, it } from "vitest";
import type {
  RemoteProviderContext,
  RemoteSessionLease,
} from "../../src/remote/types.js";
import {
  deriveOperationalStatus,
  operationalWorkItems,
} from "../../src/remote/web/operationalStatus.js";

const now = Date.UTC(2026, 7, 3, 12, 0, 0);

const provider: RemoteProviderContext = {
  provider: "openai-codex",
  label: "OpenAI via Codex",
  model: "gpt-5.6-sol",
  roleModels: {
    default: "gpt-5.6-sol",
    opus: "gpt-5.6-sol",
    sonnet: "gpt-5.6-terra",
    haiku: "gpt-5.6-luna",
    subagent: "gpt-5.6-terra",
  },
  updatedAt: now,
};

function lease(
  operational: Record<string, unknown> = {},
): RemoteSessionLease {
  return {
    id: "lease",
    sourceSessionId: "source",
    activeSessionId: "active",
    sourceTranscriptPath: "/tmp/source.jsonl",
    workspacePath: "/tmp/workspace",
    workspaceName: "Workspace",
    title: "Reliability audit",
    ownerDeviceId: "phone",
    state: "running",
    provider,
    createdAt: now - 60_000,
    lastActivityAt: now,
    providerChanged: false,
    ...operational,
  } as unknown as RemoteSessionLease;
}

describe("remote operational status", () => {
it("missing live membership remains settling without terminal evidence", () => {
  const items = operationalWorkItems([{
    id: "workflow",
    kind: "workflow",
    title: "Audit GNM rights evidence",
    phase: "settling",
    blocksQuiescence: true,
  }]);

  expect(items[0]?.terminal).toBe(false);
  expect(items[0]?.blocker).toBe(true);
});

it("hand-back names its blocker and becomes overdue without cancelling", () => {
  const status = deriveOperationalStatus({
    lease: lease({
      state: "handing-back",
      operation: {
        id: "handoff",
        kind: "handback",
        phase: "waiting-for-work",
        requestedAt: now - 3_600_000,
        updatedAt: now - 8_000,
        attentionAt: now - 1_000,
        blockerIds: ["workflow"],
      },
      workItems: [{
        id: "workflow",
        kind: "workflow",
        title: "Audit GNM rights evidence",
        phase: "running",
        updatedAt: now - 8_000,
        blocksQuiescence: true,
      }],
    }),
    link: "secure",
    now,
  });

  expect(status.headline).toBe("Returning after 1 workflow finishes");
  expect(status.detail).toMatch(/lock this phone/i);
  expect(status.operation?.overdue).toBe(true);
  expect(status.blockers[0]?.title).toBe("Audit GNM rights evidence");
  expect(status.inputBlocked).toBe(true);
});

it("link loss never implies active Mac-side work was cancelled", () => {
  const status = deriveOperationalStatus({
    lease: lease({
      turnPhase: "running-task",
      workItems: [{
        id: "task",
        kind: "workflow",
        title: "Reliability gate",
        phase: "running",
      }],
    }),
    link: "link-lost",
    now,
  });

  expect(status.headline).toBe("Phone link lost · work continues");
  expect(status.detail).toMatch(/still running/i);
  expect(status.busy).toBe(true);
  expect(status.inputBlocked).toBe(true);
});

it("non-owner windows remain read-only while showing progress", () => {
  const status = deriveOperationalStatus({
    lease: lease({
      ownership: { owner: "non-owner", canMutate: false },
      workItems: [{
        id: "task",
        title: "Owned workflow",
        phase: "running",
      }],
    }),
    link: "secure",
    now,
  });

  expect(status.ownership).toBe("non-owner");
  expect(status.inputBlocked).toBe(true);
  expect(status.headline).toMatch(/another device/i);
});

it("provider rollback keeps the restored route usable", () => {
  const status = deriveOperationalStatus({
    lease: lease({
      operation: {
        id: "switch",
        kind: "provider-switch",
        phase: "failed",
        requestedAt: now - 30_000,
        updatedAt: now,
        rollbackResult: "Synthetic · Kimi K3 is active again.",
      },
    }),
    link: "secure",
    now,
  });

  expect(status.headline).toBe("Previous provider restored");
  expect(status.inputBlocked).toBe(false);
});

it("does not describe an exhausted provider as a response still running", () => {
  const status = deriveOperationalStatus({
    lease: lease({
      state: "error",
      turnPhase: "failed",
      error: "Anthropic usage is exhausted until the next reset.",
      operation: {
        id: "switch-after-limit",
        kind: "provider-switch",
        phase: "waiting-for-turn",
        requestedAt: now - 5_000,
        updatedAt: now,
        targetProvider: "synthetic",
      },
      workItems: [],
    }),
    link: "secure",
    now,
  });

  expect(status.headline).toBe("Provider unavailable · switch queued");
  expect(status.detail).toMatch(/usage is exhausted/i);
  expect(status.headline).not.toMatch(/response/i);
  expect(status.inputBlocked).toBe(true);
});
});
