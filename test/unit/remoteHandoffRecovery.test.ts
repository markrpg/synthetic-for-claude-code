import path from "node:path";
import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RemoteDaemonStatus,
  RemoteHandoffRecord,
} from "../../src/remote/types.js";
import {
  REMOTE_BUILD_VERSION,
  REMOTE_PROTOCOL_VERSION,
} from "../../src/remote/types.js";

const recoveryMocks = vi.hoisted(() => ({
  transcriptTailSignature: vi.fn(),
  waitForStableTranscript: vi.fn(),
  requireVisibleClaudeSession: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: path.join(base.fsPath, ...parts),
    }),
  },
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: () => ({
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showErrorMessage: recoveryMocks.showErrorMessage,
    showInformationMessage: vi.fn(),
    showWarningMessage: recoveryMocks.showWarningMessage,
    tabGroups: { all: [] },
  },
  workspace: {
    workspaceFolders: [
      {
        name: "workspace",
        uri: { fsPath: "/workspace" },
      },
    ],
    getConfiguration: () => ({
      inspect: () => undefined,
    }),
  },
  commands: {
    getCommands: vi.fn(),
    executeCommand: vi.fn(),
  },
  extensions: { getExtension: vi.fn() },
  env: { openExternal: vi.fn() },
  ViewColumn: { Active: 1 },
  ProgressLocation: { Notification: 1 },
}));

vi.mock("../../src/remote/transcriptIntegrity.js", () => ({
  activeTranscriptPath: (source: string, sessionId: string) =>
    path.basename(source, path.extname(source)) === sessionId
      ? source
      : path.join(path.dirname(source), `${sessionId}.jsonl`),
  transcriptTailSignature:
    recoveryMocks.transcriptTailSignature,
  waitForStableTranscript:
    recoveryMocks.waitForStableTranscript,
}));

vi.mock("../../src/remote/claudeSessionOpener.js", () => ({
  claudeTabTitle: (title: string) => title,
  LEGACY_EXACT_SESSION_UI_CONFIRMATION_ERROR:
    "Claude Code created a panel but did not confirm that the exact remote conversation opened. ModelHop kept remote access and the recovery record active.",
  openExactClaudeSession: vi.fn(),
  requireVisibleClaudeSession:
    recoveryMocks.requireVisibleClaudeSession,
}));

import { RemoteManager } from "../../src/remote/remoteManager.js";

const PENDING_SESSION_KEY = "modelHop.remote.pendingSessionOpen";

interface TestableManager {
  openClaudeSession: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
  completeAction: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
  reconcileTunnels: ReturnType<typeof vi.fn>;
  shutdownDaemon: ReturnType<typeof vi.fn>;
  withRemoteSetupLock: ReturnType<typeof vi.fn>;
  runOpenedHandoffCleanup: () => Promise<void>;
  reconstructPendingHandoff: (
    status: RemoteDaemonStatus,
  ) => Promise<boolean>;
  scheduleHandoffFinalizationRetry: ReturnType<typeof vi.fn>;
  retireFailedHandoffSupersededBy: (
    leaseId: string,
  ) => Promise<void>;
  handBack: (
    strategy: "finish" | "cancel",
    actionId?: string,
    claimToken?: string,
  ) => Promise<void>;
  startPolling: ReturnType<typeof vi.fn>;
  pollActions: (generation: number) => Promise<void>;
  pollingGeneration: number;
  blockedHandbackActions: Set<string>;
}

function handoff(
  overrides: Partial<RemoteHandoffRecord> = {},
): RemoteHandoffRecord {
  return {
    version: 1,
    leaseId: "lease-1",
    sessionId: "session-1",
    transcriptPath: "/workspace/session-1.jsonl",
    workspacePath: "/workspace",
    title: "Exact conversation",
    transcriptSignature: "tail-signature",
    phase: "failed",
    actionId: "action-1",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function status(): RemoteDaemonStatus {
  return {
    name: "modelhop-remote",
    version: "1.3.0",
    ready: true,
    configured: true,
    lease: {
      id: "lease-1",
      sourceSessionId: "session-1",
      sourceTranscriptPath: "/workspace/session-1.jsonl",
      workspacePath: "/workspace",
      workspaceName: "workspace",
      title: "Exact conversation",
      state: "handing-back",
      provider: {
        provider: "anthropic",
        label: "Anthropic",
        model: "claude",
        roleModels: {
          default: "claude",
          opus: "claude",
          sonnet: "claude",
          haiku: "claude",
          subagent: "claude",
        },
        updatedAt: 100,
      },
      createdAt: 100,
      lastActivityAt: 100,
      providerChanged: false,
    },
    pendingPairings: [],
    pairedDevices: [],
    hostActions: [],
  };
}

function setup(initial?: RemoteHandoffRecord): {
  manager: RemoteManager;
  testable: TestableManager;
  state: Map<string, unknown>;
  clearRemoteLaunchToken: ReturnType<typeof vi.fn>;
} {
  const state = new Map<string, unknown>();
  if (initial) {
    state.set(PENDING_SESSION_KEY, initial);
  }
  const context = {
    globalStorageUri: { fsPath: "/tmp/modelhop-test" },
    globalState: {
      get<T>(key: string): T | undefined {
        return state.get(key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
          state.delete(key);
        } else {
          state.set(key, value);
        }
      },
    },
    asAbsolutePath: (value: string) => value,
  } as unknown as vscode.ExtensionContext;
  const clearRemoteLaunchToken = vi.fn().mockResolvedValue(undefined);
  const credentials = {
    clearRemoteLaunchToken,
    getOrCreateRemoteControlToken: vi
      .fn()
      .mockResolvedValue("control-token"),
  };
  const manager = new RemoteManager(
    context,
    {
      read: () => ({ effective: { variables: [] } }),
    } as never,
    {} as never,
    credentials as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      error: vi.fn(),
      safeErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
      show: vi.fn(),
    } as never,
    () => "anthropic",
  );
  const testable = manager as unknown as TestableManager;
  testable.openClaudeSession = vi.fn().mockResolvedValue(undefined);
  testable.health = vi.fn().mockResolvedValue(status());
  testable.completeAction = vi.fn().mockResolvedValue(undefined);
  testable.control = vi.fn().mockResolvedValue(undefined);
  testable.reconcileTunnels = vi.fn().mockResolvedValue(undefined);
  testable.shutdownDaemon = vi.fn().mockResolvedValue(undefined);
  testable.withRemoteSetupLock = vi.fn(
    async (action: () => Promise<unknown>) => action(),
  );
  testable.scheduleHandoffFinalizationRetry = vi.fn();
  testable.startPolling = vi.fn();
  return { manager, testable, state, clearRemoteLaunchToken };
}

describe("durable remote hand-back recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoveryMocks.transcriptTailSignature.mockResolvedValue(
      "tail-signature",
    );
    recoveryMocks.waitForStableTranscript.mockImplementation(
      async (transcriptPath: string) => ({
        size: 1,
        signature: String(
          await recoveryMocks.transcriptTailSignature(transcriptPath),
        ),
        observedAt: Date.now(),
      }),
    );
    recoveryMocks.requireVisibleClaudeSession.mockResolvedValue({
      sessionId: "session-1",
      summary: "Exact conversation",
      lastModified: 1,
      transcriptPath: "/workspace/session-1.jsonl",
    });
  });

  it("queues desktop return as one durable daemon transaction", async () => {
    const { manager, testable } = setup();
    testable.handBack = vi.fn();

    await manager.returnToLaptop();

    expect(testable.handBack).not.toHaveBeenCalled();
    const calls = testable.control.mock.calls as unknown as Array<
      [
        string,
        {
          method: string;
          body: { requestId: string; strategy: "finish" | "cancel" };
        },
      ]
    >;
    const request = calls.find(
      ([route]) => route === "/control/session/request-handback",
    );
    expect(request?.[1].method).toBe("POST");
    expect(request?.[1].body.strategy).toBe("finish");
    expect(request?.[1].body.requestId).toEqual(expect.any(String));
    expect(testable.startPolling).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("uses a new durable request to escalate desktop finish to force", async () => {
    const { manager, testable } = setup();
    testable.health.mockResolvedValue({
      ...status(),
      lease: {
        ...status().lease!,
        state: "running",
      },
    });
    recoveryMocks.showWarningMessage
      .mockResolvedValueOnce("Finish and Return")
      .mockResolvedValueOnce("Cancel and Return");

    await manager.returnToLaptop();
    await manager.returnToLaptop();

    const calls = testable.control.mock.calls as unknown as Array<
      [
        string,
        {
          body: { requestId: string; strategy: "finish" | "cancel" };
        },
      ]
    >;
    const requests = calls.filter(
      ([route]) => route === "/control/session/request-handback",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.[1]?.body).toMatchObject({
      strategy: "finish",
    });
    expect(requests[1]?.[1]?.body).toMatchObject({
      strategy: "cancel",
    });
    expect(requests[1]?.[1]?.body.requestId).not.toBe(
      requests[0]?.[1]?.body.requestId,
    );
    manager.dispose();
  });

  it("lets desktop force an active hand-back regardless of presentation state", async () => {
    const { manager, testable } = setup();
    testable.health.mockResolvedValue({
      ...status(),
      lease: {
        ...status().lease!,
        state: "paused-diverged",
        operation: {
          id: "active-handback",
          kind: "handback",
          phase: "waiting-for-work",
          leaseId: "lease-1",
          ownerWorkspacePath: "/workspace",
          requestedAt: 100,
          updatedAt: 100,
        },
      },
    });
    recoveryMocks.showWarningMessage.mockResolvedValueOnce(
      "Cancel Work and Return",
    );

    await manager.returnToLaptop();

    const request = (
      testable.control.mock.calls as unknown as Array<
        [string, { method?: string; body?: { strategy?: string } }]
      >
    ).find(
      ([route]) => route === "/control/session/request-handback",
    );
    expect(request?.[1]).toMatchObject({
      method: "POST",
      body: { strategy: "cancel" },
    });
    manager.dispose();
  });

  it("lets desktop withdraw a reversible hand-back", async () => {
    const { manager, testable } = setup();
    testable.health.mockResolvedValue({
      ...status(),
      lease: {
        ...status().lease!,
        operation: {
          id: "active-handback",
          kind: "handback",
          phase: "waiting-for-work",
          leaseId: "lease-1",
          ownerWorkspacePath: "/workspace",
          requestedAt: 100,
          updatedAt: 100,
        },
      },
    });
    recoveryMocks.showWarningMessage.mockResolvedValueOnce(
      "Keep Working Remotely",
    );

    await manager.returnToLaptop();

    expect(testable.control).toHaveBeenCalledWith(
      "/control/session/cancel-handback-request",
      expect.objectContaining({
        method: "POST",
        body: { operationId: "active-handback" },
      }),
    );
    expect(
      testable.control.mock.calls.some(
        ([route]) => route === "/control/session/request-handback",
      ),
    ).toBe(false);
    manager.dispose();
  });

  it("reconciles a lost desktop response against the durable daemon operation", async () => {
    const { manager, testable } = setup();
    testable.control.mockRejectedValueOnce(
      new Error("loopback response closed"),
    );
    testable.health
      .mockResolvedValueOnce(status())
      .mockResolvedValue({
        ...status(),
        lease: {
          ...status().lease!,
          operation: {
            id: "durable-handback",
            kind: "handback",
            phase: "waiting-for-work",
            leaseId: "lease-1",
            ownerWorkspacePath: "/workspace",
            requestedAt: 100,
            updatedAt: 100,
          },
        },
      });

    await expect(manager.returnToLaptop()).resolves.toBeUndefined();

    expect(testable.startPolling).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("blocks an editor-local provider switch while Remote owns the conversation", async () => {
    const { manager } = setup();

    await expect(manager.allowLocalProviderSwitch()).resolves.toBe(false);

    expect(recoveryMocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Change provider from the phone"),
    );
    manager.dispose();
  });

  it("hydrates a failed action without automatically reopening it", async () => {
    const { manager, testable, state } = setup(handoff());

    await expect(
      manager.recoverLastRemoteConversation({
        silentWhenMissing: true,
        retryFailed: false,
      }),
    ).resolves.toBe(false);

    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    expect(testable.blockedHandbackActions.has("action-1")).toBe(
      true,
    );
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({ phase: "failed" }),
    );
  });

  it("automatically finalizes a legacy UI-confirmation failure after revalidating its exact transcript", async () => {
    const { manager, testable, state } = setup(
      handoff({
        lastError:
          "Claude Code created a panel but did not confirm that the exact remote conversation opened. ModelHop kept remote access and the recovery record active.",
      }),
    );
    testable.health.mockResolvedValue({
      ...status(),
      configured: false,
    });

    await expect(
      manager.recoverLastRemoteConversation({
        silentWhenMissing: true,
        retryFailed: false,
      }),
    ).resolves.toBe(true);

    expect(
      recoveryMocks.requireVisibleClaudeSession,
    ).toHaveBeenCalledWith(
      "session-1",
      "/workspace",
      undefined,
      "/workspace/session-1.jsonl",
    );
    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    expect(recoveryMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({ phase: "session-opened" }),
    );
    await testable.runOpenedHandoffCleanup();
    expect(state.has(PENDING_SESSION_KEY)).toBe(false);
    manager.dispose();
  });

  it("does not treat a current attributed-tab timeout as legacy accepted success", async () => {
    const { manager, testable, state } = setup(
      handoff({
        lastError:
          "Claude Code did not confirm that the attributed tab opened the exact remote conversation before the timeout. ModelHop kept remote access and the recovery record active.",
      }),
    );

    await expect(
      manager.recoverLastRemoteConversation({
        silentWhenMissing: true,
        retryFailed: false,
        notifyOnFailure: false,
      }),
    ).resolves.toBe(false);

    expect(
      recoveryMocks.requireVisibleClaudeSession,
    ).not.toHaveBeenCalled();
    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({ phase: "failed" }),
    );
    manager.dispose();
  });

  it("hydrates the durable failure before activation starts action polling", async () => {
    const { manager, testable } = setup(handoff());
    const action = {
      id: "action-1",
      type: "session.handback" as const,
      payload: { strategy: "finish" },
      createdAt: 100,
      leaseId: "lease-1",
    };
    const liveStatus = {
      ...status(),
      version: REMOTE_PROTOCOL_VERSION,
      buildVersion: REMOTE_BUILD_VERSION,
      lease: {
        id: "lease-1",
        sourceSessionId: "session-1",
        sourceTranscriptPath: "/workspace/session-1.jsonl",
        workspacePath: "/workspace",
        workspaceName: "workspace",
        title: "Exact conversation",
        state: "stopped" as const,
        provider: {
          provider: "anthropic" as const,
          label: "Anthropic",
          model: "claude",
          roleModels: {
            default: "claude",
            opus: "claude",
            sonnet: "claude",
            haiku: "claude",
            subagent: "claude",
          },
          updatedAt: 100,
        },
        createdAt: 100,
        lastActivityAt: 100,
        providerChanged: false,
      },
      hostActions: [action],
    } satisfies RemoteDaemonStatus;
    testable.health.mockResolvedValue(liveStatus);
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> => {
        if (route.startsWith("/control/actions?")) {
          return { actions: [action] };
        }
        if (route.startsWith("/control/pairings?")) {
          return { pairings: [] };
        }
        return undefined;
      },
    );

    await manager.initialize();
    await Promise.resolve();

    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    expect(testable.blockedHandbackActions.has("action-1")).toBe(
      true,
    );
    manager.dispose();
  });

  it("retries only action finalization after the exact session opened", async () => {
    const initial = handoff({
      phase: "session-opened",
      openedAt: 200,
    });
    const { manager, testable, state } = setup(initial);
    testable.completeAction.mockRejectedValueOnce(
      new Error("controller temporarily unavailable"),
    );

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(true);

    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    await testable.runOpenedHandoffCleanup();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({
        phase: "cleanup-pending",
        openedAt: 200,
        lastError: "controller temporarily unavailable",
      }),
    );

    const liveStatus = status();
    testable.health.mockResolvedValue(liveStatus);
    testable.completeAction.mockImplementationOnce(async () => {
      // Avoid the terminal-state delay; the daemon is already gone after the
      // successful acknowledgement in this recovery scenario.
      liveStatus.configured = false;
    });

    await testable.runOpenedHandoffCleanup();

    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    expect(testable.completeAction).toHaveBeenCalledTimes(2);
    expect(state.has(PENDING_SESSION_KEY)).toBe(false);
  });

  it("never demotes an accepted exact open when action acknowledgement fails", async () => {
    const { manager, testable, state } = setup(
      handoff({ phase: "preparing" }),
    );
    testable.openClaudeSession.mockImplementationOnce(
      async (
        _sessionId: string,
        _title: string | undefined,
        onAccepted: () => Promise<void>,
      ) => {
        await onAccepted();
      },
    );
    testable.completeAction.mockRejectedValueOnce(
      new Error("acknowledgement timed out"),
    );

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(true);

    expect(recoveryMocks.showErrorMessage).not.toHaveBeenCalled();
    await testable.runOpenedHandoffCleanup();
    const pending = state.get(
      PENDING_SESSION_KEY,
    ) as RemoteHandoffRecord;
    expect(pending).toEqual(
      expect.objectContaining({
        phase: "cleanup-pending",
        lastError: "acknowledgement timed out",
      }),
    );
    expect(typeof pending.openedAt).toBe("number");
    manager.dispose();
  });

  it("never demotes an accepted exact open when the command reports a late error", async () => {
    const { manager, testable, state } = setup(
      handoff({ phase: "preparing" }),
    );
    testable.openClaudeSession.mockImplementationOnce(
      async (
        _sessionId: string,
        _title: string | undefined,
        onAccepted: () => Promise<void>,
      ) => {
        await onAccepted();
        throw new Error("command rejected after opening the tab");
      },
    );
    testable.health.mockResolvedValue({
      ...status(),
      configured: false,
    });

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(true);

    expect(recoveryMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({ phase: "session-opened" }),
    );
    await testable.runOpenedHandoffCleanup();
    expect(state.has(PENDING_SESSION_KEY)).toBe(false);
    manager.dispose();
  });

  it("reuses an accepted hand-back when a duplicate return request arrives", async () => {
    const accepted = handoff({
      phase: "session-opened",
      openedAt: 200,
    });
    const { manager, testable, state } = setup(accepted);
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;
    const liveStatus = status();
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> => {
        if (route === "/control/status") {
          return liveStatus;
        }
        if (route === "/control/session/prepare-handback") {
          return { lease: liveStatus.lease };
        }
        return undefined;
      },
    );

    await testable.handBack("finish");

    expect(state.get(PENDING_SESSION_KEY)).toEqual(accepted);
    expect(recover).toHaveBeenCalledWith({
      notifyOnFailure: true,
    });
    manager.dispose();
  });

  it("coalesces repeated status-bar Return requests into one hand-back", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "failed", actionId: undefined }),
    );
    const liveStatus = status();
    let finishPreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> => {
        if (route === "/control/status") {
          return liveStatus;
        }
        if (route === "/control/session/prepare-handback") {
          await preparationGate;
          return { lease: liveStatus.lease };
        }
        return undefined;
      },
    );
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;

    const first = testable.handBack("finish");
    const repeated = testable.handBack("finish");
    await vi.waitFor(() => {
      expect(testable.control).toHaveBeenCalledWith(
        "/control/session/prepare-handback",
        expect.anything(),
      );
    });
    finishPreparation();
    await Promise.all([first, repeated]);

    expect(
      testable.control.mock.calls.filter(
        ([route]) => route === "/control/session/prepare-handback",
      ),
    ).toHaveLength(1);
    expect(testable.control).toHaveBeenCalledWith(
      "/control/session/prepare-handback",
      expect.objectContaining({ timeoutMs: false }),
    );
    expect(recover).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("preempts an in-flight editor finish wait with one force request", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "failed", actionId: undefined }),
    );
    const liveStatus = status();
    if (!liveStatus.lease) {
      throw new Error("Expected a live hand-back lease.");
    }
    liveStatus.lease.operation = {
      id: "active-handback",
      kind: "handback",
      phase: "waiting-for-work",
      leaseId: liveStatus.lease.id,
      ownerWorkspacePath: liveStatus.lease.workspacePath,
      requestedAt: 100,
      updatedAt: 100,
    };
    let finishPreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    testable.control.mockImplementation(
      async (
        route: string,
        options?: { body?: { strategy?: string } },
      ): Promise<unknown> => {
        if (route === "/control/status") {
          return liveStatus;
        }
        if (route === "/control/session/prepare-handback") {
          if (options?.body?.strategy === "finish") {
            await preparationGate;
          }
          return { lease: liveStatus.lease };
        }
        return undefined;
      },
    );
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;

    const finish = testable.handBack("finish");
    await vi.waitFor(() => {
      const request = (
        testable.control.mock.calls as unknown as Array<
          [string, { body?: { strategy?: string } }]
        >
      ).find(
        ([route, options]) =>
          route === "/control/session/prepare-handback" &&
          options.body?.strategy === "finish",
      );
      expect(request).toBeDefined();
    });
    const force = testable.handBack("cancel");
    await vi.waitFor(() => {
      expect(testable.control).toHaveBeenCalledWith(
        "/control/session/prepare-handback",
        expect.objectContaining({
          body: {
            strategy: "cancel",
            operationId: "active-handback",
            leaseId: "lease-1",
          },
          timeoutMs: 30_000,
        }),
      );
    });
    finishPreparation();
    await Promise.all([finish, force]);

    const preparations = testable.control.mock.calls.filter(
      ([route]) => route === "/control/session/prepare-handback",
    );
    expect(preparations).toHaveLength(2);
    expect(recover).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("retries force when the first fenced escalation fails before acceptance", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "failed", actionId: undefined }),
    );
    const liveStatus = status();
    if (!liveStatus.lease) {
      throw new Error("Expected a live hand-back lease.");
    }
    liveStatus.lease.operation = {
      id: "retryable-handback",
      kind: "handback",
      phase: "waiting-for-work",
      leaseId: liveStatus.lease.id,
      ownerWorkspacePath: liveStatus.lease.workspacePath,
      requestedAt: 100,
      updatedAt: 100,
    };
    let finishPreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let cancelAttempts = 0;
    testable.control.mockImplementation(
      async (
        route: string,
        options?: { body?: { strategy?: string } },
      ): Promise<unknown> => {
        if (route === "/control/status") {
          return liveStatus;
        }
        if (route === "/control/session/prepare-handback") {
          if (options?.body?.strategy === "finish") {
            await preparationGate;
          } else if (options?.body?.strategy === "cancel") {
            cancelAttempts += 1;
            if (cancelAttempts === 1) {
              throw new Error("request failed before daemon acceptance");
            }
          }
          return { lease: liveStatus.lease };
        }
        return undefined;
      },
    );
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;

    const finish = testable.handBack("finish");
    await vi.waitFor(() => {
      expect(recoveryMocks.waitForStableTranscript).not.toHaveBeenCalled();
      expect(testable.control).toHaveBeenCalledWith(
        "/control/session/prepare-handback",
        expect.objectContaining({ body: { strategy: "finish", operationId: "retryable-handback", leaseId: "lease-1" } }),
      );
    });
    await expect(testable.handBack("cancel")).rejects.toThrow(
      "request failed before daemon acceptance",
    );
    const retriedForce = testable.handBack("cancel");
    await vi.waitFor(() => expect(cancelAttempts).toBe(2));
    finishPreparation();
    await Promise.all([finish, retriedForce]);

    expect(cancelAttempts).toBe(2);
    expect(recover).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("rejects a delayed force escalation after the durable operation changes", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "failed", actionId: undefined }),
    );
    const originalStatus = status();
    if (!originalStatus.lease) {
      throw new Error("Expected a live hand-back lease.");
    }
    originalStatus.lease.operation = {
      id: "original-handback",
      kind: "handback",
      phase: "waiting-for-work",
      leaseId: originalStatus.lease.id,
      ownerWorkspacePath: originalStatus.lease.workspacePath,
      requestedAt: 100,
      updatedAt: 100,
    };
    let currentStatus = originalStatus;
    let finishPreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    testable.control.mockImplementation(
      async (
        route: string,
        options?: { body?: { strategy?: string } },
      ): Promise<unknown> => {
        if (route === "/control/status") {
          return currentStatus;
        }
        if (
          route === "/control/session/prepare-handback" &&
          options?.body?.strategy === "finish"
        ) {
          await preparationGate;
          return { lease: originalStatus.lease };
        }
        return undefined;
      },
    );
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;

    const finish = testable.handBack("finish");
    await vi.waitFor(() => {
      expect(
        testable.control.mock.calls.some(
          ([route]) => route === "/control/session/prepare-handback",
        ),
      ).toBe(true);
    });
    currentStatus = {
      ...originalStatus,
      lease: {
        ...originalStatus.lease,
        id: "replacement-lease",
        operation: {
          ...originalStatus.lease.operation,
          id: "replacement-handback",
          leaseId: "replacement-lease",
        },
      },
    };

    await expect(testable.handBack("cancel")).rejects.toThrow(
      "no longer available to force",
    );
    const cancelDispatches = testable.control.mock.calls.filter(
      ([route, options]) =>
        route === "/control/session/prepare-handback" &&
        (options as { body?: { strategy?: string } } | undefined)?.body
          ?.strategy === "cancel",
    );
    expect(cancelDispatches).toHaveLength(0);

    currentStatus = originalStatus;
    finishPreparation();
    await finish;
    expect(recover).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("restarts transcript stabilization after force without opening twice", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "failed", actionId: undefined }),
    );
    const liveStatus = status();
    if (!liveStatus.lease) {
      throw new Error("Expected a live hand-back lease.");
    }
    liveStatus.lease.operation = {
      id: "stability-handback",
      kind: "handback",
      phase: "stabilizing-transcript",
      leaseId: liveStatus.lease.id,
      ownerWorkspacePath: liveStatus.lease.workspacePath,
      requestedAt: 100,
      updatedAt: 100,
    };
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> => {
        if (route === "/control/status") {
          return liveStatus;
        }
        if (route === "/control/session/prepare-handback") {
          return { lease: liveStatus.lease };
        }
        return undefined;
      },
    );
    let stabilizationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stabilizationStarted = resolve;
    });
    recoveryMocks.waitForStableTranscript
      .mockImplementationOnce(
        async (
          _transcriptPath: string,
          options?: { signal?: AbortSignal },
        ) => {
          stabilizationStarted();
          return new Promise((resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("stability restart requested"),
                ),
              { once: true },
            );
          });
        },
      )
      .mockResolvedValueOnce({
        size: 2,
        signature: "stable-after-force",
        observedAt: 200,
      });
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;

    const finish = testable.handBack("finish");
    await started;
    const force = testable.handBack("cancel");
    await Promise.all([finish, force]);

    expect(recoveryMocks.waitForStableTranscript).toHaveBeenCalledTimes(2);
    const operationUpdate = (
      testable.control.mock.calls as unknown as Array<
        [
          string,
          {
            body?: {
              id?: string;
              phase?: string;
              waitReason?: string;
            };
          },
        ]
      >
    ).find(
      ([route, options]) =>
        route === "/control/operation" &&
        options.body?.id === "stability-handback" &&
        options.body.phase === "stabilizing-transcript" &&
        options.body.waitReason?.includes("rechecking") === true,
    );
    expect(operationUpdate).toBeDefined();
    expect(recover).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("persists the fenced hand-back claim for cleanup after a reload", async () => {
    const { manager, testable, state } = setup(
      handoff({ phase: "failed" }),
    );
    const liveStatus = status();
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> => {
        if (route === "/control/status") {
          return liveStatus;
        }
        if (route === "/control/session/prepare-handback") {
          return { lease: liveStatus.lease };
        }
        return undefined;
      },
    );
    const recover = vi.fn().mockResolvedValue(false);
    (
      manager as unknown as {
        recoverLastRemoteConversation: typeof recover;
      }
    ).recoverLastRemoteConversation = recover;

    await testable.handBack(
      "finish",
      "handback-action",
      "handback-claim",
    );

    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({
        actionId: "handback-action",
        actionClaimToken: "handback-claim",
      }),
    );
    manager.dispose();
  });

  it("keeps automatic activation recovery silent when exact opening fails", async () => {
    const { manager, testable, state } = setup(
      handoff({ phase: "opening-session" }),
    );
    testable.openClaudeSession.mockRejectedValueOnce(
      new Error("Claude command unavailable"),
    );

    await expect(
      manager.recoverLastRemoteConversation({
        silentWhenMissing: true,
        retryFailed: false,
        notifyOnFailure: false,
      }),
    ).resolves.toBe(false);

    expect(recoveryMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({
        phase: "failed",
        lastError: "Claude command unavailable",
      }),
    );
    manager.dispose();
  });

  it("does not hold recovery open while an explicit failure toast awaits input", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "opening-session" }),
    );
    testable.openClaudeSession.mockRejectedValueOnce(
      new Error("Claude command unavailable"),
    );
    recoveryMocks.showErrorMessage.mockReturnValueOnce(
      new Promise(() => undefined),
    );

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(false);

    expect(recoveryMocks.showErrorMessage).toHaveBeenCalledOnce();
    expect(testable.withRemoteSetupLock).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("coalesces concurrent recovery calls behind the cross-window lock", async () => {
    const { manager, testable } = setup(
      handoff({ phase: "preparing" }),
    );
    let releaseOpen: (() => void) | undefined;
    testable.openClaudeSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseOpen = resolve;
        }),
    );
    testable.health.mockResolvedValue({
      ...status(),
      configured: false,
    });

    const first = manager.recoverLastRemoteConversation();
    const second = manager.recoverLastRemoteConversation();
    await vi.waitFor(() => {
      expect(releaseOpen).toBeTypeOf("function");
    });
    releaseOpen?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      true,
      true,
    ]);
    expect(testable.withRemoteSetupLock).toHaveBeenCalledOnce();
    expect(testable.openClaudeSession).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("retains a failed hand-back until prior ownership is positively retired", async () => {
    const { manager, testable, state } = setup(handoff());
    testable.blockedHandbackActions.add("action-1");

    await testable.retireFailedHandoffSupersededBy("lease-2");

    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({ phase: "failed", leaseId: "lease-1" }),
    );
    expect(testable.blockedHandbackActions.has("action-1")).toBe(
      true,
    );
    manager.dispose();
  });

  it("does not show an editor failure toast for a background phone hand-back", async () => {
    const { manager, testable } = setup(
      handoff({
        phase: "preparing",
        actionId: "other-action",
      }),
    );
    const action = {
      id: "phone-handback",
      type: "session.handback" as const,
      payload: { strategy: "finish" },
      createdAt: 100,
      leaseId: "lease-1",
      claimToken: "claim-phone-handback",
    };
    testable.handBack = vi
      .fn()
      .mockRejectedValue(new Error("exact open not ready"));
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> =>
        route.startsWith("/control/actions?")
          ? { actions: [action] }
          : undefined,
    );

    await testable.pollActions(testable.pollingGeneration);

    expect(testable.handBack).toHaveBeenCalledWith(
      "finish",
      "phone-handback",
      "claim-phone-handback",
    );
    expect(recoveryMocks.showErrorMessage).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("retains authoritative open state while terminal cleanup retries", async () => {
    const { manager, testable, state } = setup(
      handoff({
        phase: "session-opened",
        openedAt: 200,
        actionAcknowledgedAt: 210,
      }),
    );
    testable.health.mockResolvedValue({
      ...status(),
      configured: false,
    });
    testable.reconcileTunnels.mockRejectedValueOnce(
      new Error("tunnel is still closing"),
    );

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(true);

    expect(testable.openClaudeSession).not.toHaveBeenCalled();
    expect(recoveryMocks.showErrorMessage).not.toHaveBeenCalled();
    await testable.runOpenedHandoffCleanup();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({
        phase: "cleanup-pending",
        openedAt: 200,
        actionAcknowledgedAt: 210,
        lastError: "tunnel is still closing",
      }),
    );

    await testable.runOpenedHandoffCleanup();
    expect(state.has(PENDING_SESSION_KEY)).toBe(false);
    manager.dispose();
  });

  it("never acknowledges or stops a newer lease while finalizing an old hand-back", async () => {
    const { manager, testable, state, clearRemoteLaunchToken } = setup(
      handoff({
        phase: "session-opened",
        openedAt: 200,
      }),
    );
    testable.health.mockResolvedValue({
      ...status(),
      lease: {
        id: "lease-2",
        sourceSessionId: "session-2",
        sourceTranscriptPath: "/workspace/session-2.jsonl",
        workspacePath: "/workspace",
        workspaceName: "workspace",
        title: "New phone session",
        state: "running",
        provider: {
          provider: "anthropic",
          label: "Anthropic",
          model: "claude",
          roleModels: {
            default: "claude",
            opus: "claude",
            sonnet: "claude",
            haiku: "claude",
            subagent: "claude",
          },
          updatedAt: 300,
        },
        createdAt: 300,
        lastActivityAt: 300,
        providerChanged: false,
      },
    });

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(true);

    await testable.runOpenedHandoffCleanup();

    expect(testable.completeAction).not.toHaveBeenCalled();
    expect(testable.control).not.toHaveBeenCalled();
    expect(testable.reconcileTunnels).not.toHaveBeenCalled();
    expect(testable.shutdownDaemon).not.toHaveBeenCalled();
    expect(clearRemoteLaunchToken).not.toHaveBeenCalled();
    const retained = state.get(
      PENDING_SESSION_KEY,
    ) as RemoteHandoffRecord;
    expect(retained.phase).toBe("cleanup-pending");
    expect(retained.leaseId).toBe("lease-1");
    expect(retained.lastError).toContain("newer remote lease");
    manager.dispose();
  });

  it("reclaims an expired hand-back action claim after reload", async () => {
    const { manager, testable, state } = setup(
      handoff({
        phase: "session-opened",
        openedAt: 200,
        actionClaimToken: "expired-claim",
      }),
    );
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> => {
        if (route.startsWith("/control/actions?")) {
          return {
            actions: [
              {
                id: "action-1",
                type: "session.handback",
                payload: { strategy: "finish" },
                createdAt: 100,
                leaseId: "lease-1",
                claimToken: "fresh-claim",
                claimOwner: "window-owner",
                claimExpiresAt: Date.now() + 30_000,
              },
            ],
          };
        }
        return undefined;
      },
    );

    await testable.runOpenedHandoffCleanup();

    expect(testable.completeAction).toHaveBeenCalledWith(
      "action-1",
      true,
      undefined,
      "fresh-claim",
    );
    expect(state.has(PENDING_SESSION_KEY)).toBe(false);
    manager.dispose();
  });

  it("accepts an idempotent terminal action replay when its prior response was lost", async () => {
    const { manager, testable, state } = setup(
      handoff({
        phase: "cleanup-pending",
        openedAt: 200,
        actionClaimToken: "claim-before-reload",
      }),
    );
    testable.control.mockImplementation(
      async (route: string): Promise<unknown> =>
        route.startsWith("/control/actions?")
          ? { actions: [] }
          : undefined,
    );

    await testable.runOpenedHandoffCleanup();

    expect(testable.completeAction).toHaveBeenCalledWith(
      "action-1",
      true,
      undefined,
      "claim-before-reload",
    );
    expect(state.has(PENDING_SESSION_KEY)).toBe(false);
    manager.dispose();
  });

  it("reconstructs a missing hand-back record for the active fork, never the source session", async () => {
    const { manager, testable, state } = setup();
    const liveStatus = status();
    if (!liveStatus.lease) {
      throw new Error("Expected a lease fixture.");
    }
    liveStatus.lease.activeSessionId = "fork-session";
    liveStatus.lease.operation = {
      id: "operation-1",
      kind: "handback",
      phase: "opening-session",
      leaseId: "lease-1",
      ownerWorkspacePath: "/workspace",
      requestedAt: 150,
      updatedAt: 175,
    };
    liveStatus.hostActions = [
      {
        id: "action-1",
        type: "session.handback",
        payload: { strategy: "finish" },
        createdAt: 150,
        leaseId: "lease-1",
        operationId: "operation-1",
      },
    ];

    await expect(
      testable.reconstructPendingHandoff(liveStatus),
    ).resolves.toBe(true);
    expect(state.get(PENDING_SESSION_KEY)).toEqual(
      expect.objectContaining({
        sessionId: "fork-session",
        transcriptPath: "/workspace/fork-session.jsonl",
        phase: "opening-session",
      }),
    );

    await expect(
      manager.recoverLastRemoteConversation({
        silentWhenMissing: true,
        notifyOnFailure: false,
      }),
    ).resolves.toBe(true);

    expect(testable.openClaudeSession).toHaveBeenCalledWith(
      "fork-session",
      "Exact conversation",
      expect.any(Function),
    );
    expect(
      recoveryMocks.requireVisibleClaudeSession,
    ).toHaveBeenCalledWith(
      "fork-session",
      "/workspace",
      undefined,
      "/workspace/fork-session.jsonl",
    );
    expect(testable.openClaudeSession).not.toHaveBeenCalledWith(
      "session-1",
      expect.anything(),
      expect.anything(),
    );
    manager.dispose();
  });

  it("does not clear a newer hand-back that arrives while Claude opens", async () => {
    const first = handoff({ phase: "preparing" });
    const newer = handoff({
      leaseId: "lease-2",
      sessionId: "session-2",
      transcriptPath: "/workspace/session-2.jsonl",
      actionId: "action-2",
      createdAt: 300,
      updatedAt: 300,
    });
    const { manager, testable, state } = setup(first);
    testable.openClaudeSession.mockImplementationOnce(async () => {
      state.set(PENDING_SESSION_KEY, newer);
    });

    await expect(
      manager.recoverLastRemoteConversation(),
    ).resolves.toBe(false);

    expect(testable.completeAction).not.toHaveBeenCalled();
    expect(state.get(PENDING_SESSION_KEY)).toEqual(newer);
  });
});
