import { describe, expect, it } from "vitest";
import {
  canSupersedeUnstartedProviderSwitch,
  connectionHoldsRemoteMutationFence,
  evaluateRemoteCommandAdmission,
  remoteCommandRequiresOwnershipFence,
} from "../../src/remote/commandPolicy.js";
import type {
  RemoteClientCommand,
  RemoteOperationKind,
} from "../../src/remote/types.js";

type CommandType = RemoteClientCommand["type"];
type CommandsByType = {
  [Type in CommandType]: Extract<RemoteClientCommand, { type: Type }>;
};

const ACTIVE_OPERATION_ID = "active-operation";

// `satisfies` makes protocol growth fail this test at compile time until the
// ownership and operation tables below receive an explicit policy decision.
const COMMANDS = {
  "prompt.send": {
    id: "prompt",
    type: "prompt.send",
    prompt: "Continue",
  },
  "turn.cancel": { id: "cancel", type: "turn.cancel" },
  "session.handback": {
    id: "handback",
    type: "session.handback",
    strategy: "finish",
  },
  "session.handback.continue": {
    id: "handback-continue",
    type: "session.handback.continue",
    operationId: ACTIVE_OPERATION_ID,
  },
  "session.handback.cancel-request": {
    id: "handback-cancel-request",
    type: "session.handback.cancel-request",
    operationId: ACTIVE_OPERATION_ID,
  },
  "session.terminal.ack": {
    id: "terminal-ack",
    type: "session.terminal.ack",
    terminalEventId: 42,
  },
  "permission.mode.set": {
    id: "permission-mode",
    type: "permission.mode.set",
    mode: "auto-safe",
  },
  "permission.resolve": {
    id: "permission",
    type: "permission.resolve",
    requestId: "permission-request",
    decision: "allow",
  },
  "question.resolve": {
    id: "question",
    type: "question.resolve",
    requestId: "question-request",
    answers: { Choice: "Continue" },
  },
  "provider.change": {
    id: "provider",
    type: "provider.change",
    provider: "anthropic",
  },
  "model.change": {
    id: "model",
    type: "model.change",
    model: "claude-opus",
  },
  "reasoning.change": {
    id: "reasoning",
    type: "reasoning.change",
    effort: "high",
  },
  "files.search": {
    id: "files-search",
    type: "files.search",
    query: "policy",
  },
  "files.list": { id: "files-list", type: "files.list" },
  "symbols.search": {
    id: "symbols",
    type: "symbols.search",
    query: "admission",
  },
  "file.read": {
    id: "file-read",
    type: "file.read",
    path: "src/remote/server.ts",
  },
  "file.reference.read": {
    id: "file-reference",
    type: "file.reference.read",
    reference: "src/remote/server.ts:1",
  },
  "git.status": { id: "git-status", type: "git.status" },
  "git.diff": { id: "git-diff", type: "git.diff", staged: false },
  "attachment.upload": {
    id: "attachment",
    type: "attachment.upload",
    name: "example.txt",
    mediaType: "text/plain",
    contentBase64: "ZXhhbXBsZQ==",
  },
  "usage.refresh": { id: "usage", type: "usage.refresh" },
  "codex.reset": { id: "reset", type: "codex.reset" },
} satisfies CommandsByType;

const OWNERSHIP_REQUIRED = {
  "prompt.send": true,
  "turn.cancel": true,
  "session.handback": true,
  "session.handback.continue": true,
  "session.handback.cancel-request": true,
  "session.terminal.ack": true,
  "permission.mode.set": true,
  "permission.resolve": true,
  "question.resolve": true,
  "provider.change": true,
  "model.change": true,
  "reasoning.change": true,
  "files.search": false,
  "files.list": false,
  "symbols.search": false,
  "file.read": false,
  "file.reference.read": false,
  "git.status": false,
  "git.diff": false,
  "attachment.upload": true,
  "usage.refresh": false,
  "codex.reset": true,
} satisfies Record<CommandType, boolean>;

const ALLOWED_DURING_OPERATION = {
  handback: {
    "prompt.send": false,
    "turn.cancel": true,
    "session.handback": true,
    "session.handback.continue": true,
    "session.handback.cancel-request": true,
    "session.terminal.ack": true,
    "permission.mode.set": false,
    "permission.resolve": true,
    "question.resolve": true,
    "provider.change": false,
    "model.change": false,
    "reasoning.change": false,
    "files.search": true,
    "files.list": true,
    "symbols.search": true,
    "file.read": true,
    "file.reference.read": true,
    "git.status": true,
    "git.diff": true,
    "attachment.upload": false,
    "usage.refresh": true,
    "codex.reset": false,
  },
  "provider-switch": {
    "prompt.send": false,
    "turn.cancel": true,
    "session.handback": false,
    "session.handback.continue": false,
    "session.handback.cancel-request": false,
    "session.terminal.ack": false,
    "permission.mode.set": false,
    "permission.resolve": true,
    "question.resolve": true,
    "provider.change": false,
    "model.change": false,
    "reasoning.change": false,
    "files.search": true,
    "files.list": true,
    "symbols.search": true,
    "file.read": true,
    "file.reference.read": true,
    "git.status": true,
    "git.diff": true,
    "attachment.upload": false,
    "usage.refresh": true,
    "codex.reset": false,
  },
} satisfies Record<
  RemoteOperationKind,
  Record<CommandType, boolean>
>;

function commands(): RemoteClientCommand[] {
  return Object.values(COMMANDS);
}

describe("remote command admission policy", () => {
  it("requires both the owning device and its current fencing generation", () => {
    const ownership = {
      ownerDeviceId: "phone-a",
      fencingGeneration: 7,
    };
    expect(
      connectionHoldsRemoteMutationFence(
        { deviceId: "phone-a", fencingGeneration: 7 },
        ownership,
      ),
    ).toBe(true);
    expect(
      connectionHoldsRemoteMutationFence(
        { deviceId: "phone-b", fencingGeneration: 7 },
        ownership,
      ),
    ).toBe(false);
    expect(
      connectionHoldsRemoteMutationFence(
        { deviceId: "phone-a", fencingGeneration: 6 },
        ownership,
      ),
    ).toBe(false);
    expect(
      connectionHoldsRemoteMutationFence(
        { deviceId: "phone-a" },
        ownership,
      ),
    ).toBe(false);
    expect(
      connectionHoldsRemoteMutationFence(
        { deviceId: "phone-a", fencingGeneration: 7 },
        { fencingGeneration: 7 },
      ),
    ).toBe(false);
  });

  it("exhaustively classifies ownership-fenced and observer-safe commands", () => {
    for (const command of commands()) {
      expect(
        remoteCommandRequiresOwnershipFence(command),
        command.type,
      ).toBe(OWNERSHIP_REQUIRED[command.type]);
    }
  });

  it("admits every command when no operation barrier is active", () => {
    for (const command of commands()) {
      expect(
        evaluateRemoteCommandAdmission(command).allowed,
        command.type,
      ).toBe(true);
    }
  });

  for (const kind of ["handback", "provider-switch"] as const) {
    it(`exhaustively applies the ${kind} operation barrier`, () => {
      const operation = {
        id: ACTIVE_OPERATION_ID,
        kind,
        phase:
          kind === "handback"
            ? ("waiting-for-work" as const)
            : ("applying" as const),
      };
      for (const command of commands()) {
        expect(
          evaluateRemoteCommandAdmission(command, operation).allowed,
          command.type,
        ).toBe(ALLOWED_DURING_OPERATION[kind][command.type]);
      }
    });
  }

  it("rejects stale or cross-operation hand-back controls", () => {
    const operation = {
      id: ACTIVE_OPERATION_ID,
      kind: "handback" as const,
      phase: "waiting-for-work" as const,
    };
    for (const command of [
      {
        ...COMMANDS["session.handback.continue"],
        operationId: "stale-operation",
      },
      {
        ...COMMANDS["session.handback.cancel-request"],
        operationId: "stale-operation",
      },
    ]) {
      expect(evaluateRemoteCommandAdmission(command, operation)).toEqual({
        allowed: false,
        code: "handback-operation-mismatch",
        reason:
          "That hand-back control does not match the active operation.",
      });
    }
  });

  it("admits a new-ID finish-to-cancel escalation only during hand-back", () => {
    const escalation = {
      ...COMMANDS["session.handback"],
      id: "new-force-escalation-command",
      strategy: "cancel" as const,
      cancelActive: true,
    };
    expect(
      evaluateRemoteCommandAdmission(escalation, {
        id: ACTIVE_OPERATION_ID,
        kind: "handback",
        phase: "waiting-for-work",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateRemoteCommandAdmission(escalation, {
        id: ACTIVE_OPERATION_ID,
        kind: "provider-switch",
        phase: "applying",
      }).allowed,
    ).toBe(false);
  });

  it("admits hand-back only while a provider switch is still waiting for the active turn", () => {
    for (const phase of [
      "applying",
      "reloading",
      "restarting",
      "rolling-back",
    ] as const) {
      expect(
        evaluateRemoteCommandAdmission(COMMANDS["session.handback"], {
          id: ACTIVE_OPERATION_ID,
          kind: "provider-switch",
          phase,
        }).allowed,
        phase,
      ).toBe(false);
    }
    expect(
      evaluateRemoteCommandAdmission(COMMANDS["session.handback"], {
        id: ACTIVE_OPERATION_ID,
        kind: "provider-switch",
        phase: "waiting-for-turn",
      }).allowed,
    ).toBe(true);
  });

  it("requires an unclaimed matching provider action before supersession", () => {
    const operation = {
      id: ACTIVE_OPERATION_ID,
      kind: "provider-switch" as const,
      phase: "waiting-for-turn" as const,
    };
    const action = {
      id: "provider-action",
      type: "provider.change" as const,
      operationId: ACTIVE_OPERATION_ID,
    };

    expect(
      canSupersedeUnstartedProviderSwitch(
        operation,
        [action],
        new Set(),
      ),
    ).toBe(true);
    expect(
      canSupersedeUnstartedProviderSwitch(
        operation,
        [action],
        new Set([action.id]),
      ),
    ).toBe(false);
    expect(
      canSupersedeUnstartedProviderSwitch(
        operation,
        [],
        new Set(),
      ),
    ).toBe(false);
    expect(
      canSupersedeUnstartedProviderSwitch(
        { ...operation, phase: "applying" },
        [action],
        new Set(),
      ),
    ).toBe(false);
    expect(
      canSupersedeUnstartedProviderSwitch(
        operation,
        [{ ...action, operationId: "different-operation" }],
        new Set(),
      ),
    ).toBe(false);
  });
});
