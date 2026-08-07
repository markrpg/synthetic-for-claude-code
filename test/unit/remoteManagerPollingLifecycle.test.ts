import path from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDaemonStatus } from "../../src/remote/types.js";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: path.join(base.fsPath, ...parts),
    }),
  },
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: () => ({
      text: "",
      command: "",
      tooltip: "",
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    tabGroups: { all: [] },
  },
  workspace: {
    workspaceFolders: [
      { name: "workspace", uri: { fsPath: "/workspace" } },
    ],
    getConfiguration: () => ({ inspect: () => undefined }),
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

import {
  preservedRemotePermissionConfiguration,
  RemoteManager,
} from "../../src/remote/remoteManager.js";

function handingBackStatus(): RemoteDaemonStatus {
  return {
    name: "modelhop-remote",
    version: "1.3.0",
    buildVersion: "2.2.3-remote.2",
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
    tunnel: {
      transport: "cloudflare-quick",
      pid: 1234,
      baseUrl: "https://fixture.trycloudflare.com",
      executable: "/tmp/cloudflared",
      originPort: 18_700,
      configPath: "/tmp/cloudflared.yml",
      logPath: "/tmp/cloudflared.log",
      startedAt: 100,
    },
  };
}

interface TestableRemoteManager {
  pollingGeneration: number;
  pollPairings(generation: number): Promise<void>;
  pollActions(generation: number): Promise<void>;
  runSupervisorCycle(generation: number): Promise<void>;
  handleRemoteTransportFailure(message: string): Promise<void>;
  completeAction(
    actionId: string,
    success: boolean,
    error?: string,
    claimToken?: string,
  ): Promise<void>;
  heartbeatHostAction: ReturnType<typeof vi.fn>;
  withActionClaimHeartbeat<T>(
    action: {
      id: string;
      type: "usage.refresh";
      payload: Record<string, unknown>;
      createdAt: number;
      claimToken: string;
      claimExpiresAt: number;
    },
    task: () => Promise<T>,
  ): Promise<T>;
  stopPolling(): void;
  preparePhoneSession(): Promise<void>;
  recreatePhoneLink: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
  reconcileTunnels: ReturnType<typeof vi.fn>;
  shutdownDaemon: ReturnType<typeof vi.fn>;
  selectWorkspace: ReturnType<typeof vi.fn>;
  showQr: ReturnType<typeof vi.fn>;
  tunnelManager: {
    isRunning: ReturnType<typeof vi.fn>;
  };
}

function setup(): {
  manager: RemoteManager;
  testable: TestableRemoteManager;
  clearRemoteLaunchToken: ReturnType<typeof vi.fn>;
} {
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: "/tmp/modelhop-lifecycle-test" },
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
  const manager = new RemoteManager(
    context,
    { read: () => ({ effective: { variables: [] } }) } as never,
    {} as never,
    {
      clearRemoteLaunchToken,
      getOrCreateRemoteControlToken: vi
        .fn()
        .mockResolvedValue("control-token"),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      error: vi.fn(),
      safeErrorMessage: (error: unknown) => String(error),
    } as never,
    () => "anthropic",
  );
  const testable = manager as unknown as TestableRemoteManager;
  testable.updateStatus = vi.fn();
  testable.control = vi.fn().mockResolvedValue({ pairings: [] });
  testable.reconcileTunnels = vi.fn().mockResolvedValue(undefined);
  testable.shutdownDaemon = vi.fn().mockResolvedValue(undefined);
  testable.selectWorkspace = vi.fn().mockResolvedValue(undefined);
  testable.showQr = vi.fn();
  testable.recreatePhoneLink = vi.fn().mockResolvedValue(undefined);
  return { manager, testable, clearRemoteLaunchToken };
}

describe("remote manager terminal lifecycle", () => {
  it.each([
    ["auto-safe", "auto"],
    ["acceptEdits", "acceptEdits"],
    ["default", "default"],
    ["plan", "plan"],
  ] as const)(
    "preserves %s when rebuilding provider configuration",
    (remoteMode, sdkMode) => {
      expect(
        preservedRemotePermissionConfiguration({
          permissionMode: remoteMode,
        }),
      ).toEqual({ remoteMode, sdkMode });
    },
  );

  it("migrates a legacy lease to Auto-safe", () => {
    expect(preservedRemotePermissionConfiguration()).toEqual({
      remoteMode: "auto-safe",
      sdkMode: "auto",
    });
  });

  it("discards an in-flight status poll after polling stops", async () => {
    const { manager, testable } = setup();
    const existing = handingBackStatus();
    testable.health = vi.fn().mockResolvedValue(existing);
    let resolveTunnelCheck!: (running: boolean) => void;
    testable.tunnelManager.isRunning = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveTunnelCheck = resolve;
        }),
    );
    testable.pollingGeneration = 7;

    const pendingPoll = testable.pollPairings(7);
    await vi.waitFor(() => {
      expect(testable.tunnelManager.isRunning).toHaveBeenCalledWith(
        existing.tunnel,
      );
    });
    testable.stopPolling();
    testable.updateStatus();
    resolveTunnelCheck(true);
    await pendingPoll;

    expect(testable.updateStatus).toHaveBeenCalledOnce();
    expect(testable.updateStatus).toHaveBeenCalledWith();
    expect(testable.control).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("retires a handing-back lease instead of reopening its old phone link", async () => {
    const { manager, testable, clearRemoteLaunchToken } = setup();
    const existing = handingBackStatus();
    testable.health = vi.fn().mockResolvedValue(existing);

    await testable.preparePhoneSession();

    expect(testable.showQr).not.toHaveBeenCalled();
    expect(testable.reconcileTunnels).toHaveBeenCalledWith(existing);
    expect(testable.shutdownDaemon).toHaveBeenCalledOnce();
    expect(clearRemoteLaunchToken).toHaveBeenCalledOnce();
    expect(testable.updateStatus).toHaveBeenCalledWith();
    expect(testable.selectWorkspace).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("clears stale tunnel capability state when the daemon is already gone", async () => {
    const { manager, testable, clearRemoteLaunchToken } = setup();
    testable.health = vi.fn().mockResolvedValue(undefined);

    await testable.preparePhoneSession();

    expect(testable.reconcileTunnels).toHaveBeenCalledWith(undefined);
    expect(testable.shutdownDaemon).not.toHaveBeenCalled();
    expect(clearRemoteLaunchToken).toHaveBeenCalledOnce();
    expect(testable.updateStatus).toHaveBeenCalledWith();
    expect(testable.selectWorkspace).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("preserves a live detached query across an extension build mismatch", async () => {
    const { manager, testable } = setup();
    const existing = handingBackStatus();
    testable.health = vi.fn().mockResolvedValue(existing);
    testable.tunnelManager.isRunning = vi.fn().mockResolvedValue(true);

    await manager.initialize();

    expect(testable.shutdownDaemon).not.toHaveBeenCalled();
    expect(testable.reconcileTunnels).toHaveBeenCalledWith(
      existing,
      existing.tunnel,
    );
    manager.dispose();
  });

  it("keeps detached work alive when only the phone tunnel fails", async () => {
    const { manager, testable, clearRemoteLaunchToken } = setup();
    const existing = handingBackStatus();
    testable.health = vi.fn().mockResolvedValue(existing);
    testable.tunnelManager.isRunning = vi.fn().mockResolvedValue(false);

    await testable.handleRemoteTransportFailure(
      "The Cloudflare Quick Tunnel disconnected.",
    );

    expect(testable.reconcileTunnels).toHaveBeenCalledWith(existing);
    expect(testable.shutdownDaemon).not.toHaveBeenCalled();
    expect(clearRemoteLaunchToken).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("recreates only the phone link for a running detached query", async () => {
    const { manager, testable } = setup();
    const existing: RemoteDaemonStatus = {
      ...handingBackStatus(),
      lease: {
        ...handingBackStatus().lease!,
        state: "running",
        turnStartedAt: 100,
      },
      tunnel: undefined,
    };
    testable.health = vi.fn().mockResolvedValue(existing);

    await testable.preparePhoneSession();

    expect(testable.recreatePhoneLink).toHaveBeenCalledWith(existing);
    expect(testable.shutdownDaemon).not.toHaveBeenCalled();
    expect(testable.selectWorkspace).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("runs health, pairing, and actions in one non-overlapping supervisor lane", async () => {
    const { manager, testable } = setup();
    let releasePairing!: () => void;
    testable.pollPairings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePairing = resolve;
        }),
    );
    testable.pollActions = vi.fn().mockResolvedValue(undefined);
    testable.pollingGeneration = 7;

    const first = testable.runSupervisorCycle(7);
    const overlapping = testable.runSupervisorCycle(7);
    await vi.waitFor(() => {
      expect(testable.pollPairings).toHaveBeenCalledOnce();
    });
    releasePairing();
    await Promise.all([first, overlapping]);

    expect(testable.pollActions).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("returns the fenced claim token when completing a host action", async () => {
    const { manager, testable } = setup();

    await testable.completeAction(
      "action-1",
      true,
      undefined,
      "claim-token-1",
    );

    const completionCall = testable.control.mock.calls[0] as unknown as [
      string,
      {
        method: string;
        body: Record<string, unknown>;
      },
    ];
    expect(completionCall[0]).toBe("/control/actions/complete");
    expect(completionCall[1].method).toBe("POST");
    expect(completionCall[1].body).toMatchObject({
      actionId: "action-1",
      success: true,
      error: undefined,
      claimToken: "claim-token-1",
    });
    expect(typeof completionCall[1].body.owner).toBe("string");
    manager.dispose();
  });

  it("renews a slow host-action claim before half of its TTL", async () => {
    vi.useFakeTimers();
    try {
      const { manager, testable } = setup();
      testable.heartbeatHostAction = vi
        .fn()
        .mockResolvedValue(Date.now() + 30_000);
      let finishTask!: () => void;
      const task = testable.withActionClaimHeartbeat(
        {
          id: "action-slow",
          type: "usage.refresh",
          payload: {},
          createdAt: Date.now(),
          claimToken: "claim-slow",
          claimExpiresAt: Date.now() + 30_000,
        },
        () =>
          new Promise<void>((resolve) => {
            finishTask = resolve;
          }),
      );

      await vi.advanceTimersByTimeAsync(10_000);
      expect(testable.heartbeatHostAction).toHaveBeenCalledWith(
        "action-slow",
        "claim-slow",
      );
      finishTask();
      await task;
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
