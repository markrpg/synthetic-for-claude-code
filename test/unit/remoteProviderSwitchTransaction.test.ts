import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type {
  RemoteDaemonStatus,
  RemoteHostAction,
  RemoteProviderContext,
} from "../../src/remote/types.js";

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
  env: { openExternal: vi.fn(), sessionId: "editor-session" },
  ViewColumn: { Active: 1 },
  ProgressLocation: { Notification: 1 },
}));

import {
  RemoteManager,
  remoteProviderRouteMatches,
  remoteProviderSwitchIsQuiescent,
} from "../../src/remote/remoteManager.js";

const oldVariables = [
  { name: "ANTHROPIC_API_KEY", value: "anthropic-secret" },
];
const targetVariables = [
  { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:17777" },
  { name: "MODELHOP_PROVIDER", value: "synthetic" },
];

function provider(
  providerId: RemoteProviderContext["provider"],
  model: string,
  updatedAt: number,
): RemoteProviderContext {
  return {
    provider: providerId,
    label: providerId === "anthropic" ? "Anthropic" : "Synthetic",
    model,
    roleModels: {
      default: model,
      opus: model,
      sonnet: model,
      haiku: model,
      subagent: model,
    },
    updatedAt,
  };
}

function status(
  providerContext: RemoteProviderContext,
  transcriptPath: string,
): RemoteDaemonStatus {
  return {
    name: "modelhop-remote",
    version: "1.3.0",
    buildVersion: "2.2.4-remote.4",
    ready: true,
    configured: true,
    lease: {
      id: "lease-1",
      sourceSessionId: "session-1",
      sourceTranscriptPath: transcriptPath,
      workspacePath: path.dirname(transcriptPath),
      workspaceName: "workspace",
      title: "Provider transaction",
      state: "switching-provider",
      provider: providerContext,
      createdAt: 100,
      lastActivityAt: 200,
      providerChanged: false,
      operation: {
        id: "operation-1",
        kind: "provider-switch",
        phase: "quiescing",
        leaseId: "lease-1",
        ownerWorkspacePath: path.dirname(transcriptPath),
        requestedAt: 200,
        updatedAt: 200,
      },
      backgroundTaskCount: 0,
    },
    query: { generation: 1, state: "idle" },
    pendingPairings: [],
    pairedDevices: [],
    hostActions: [],
  };
}

const action: RemoteHostAction = {
  id: "action-1",
  type: "provider.change",
  payload: { provider: "synthetic" },
  createdAt: 200,
  leaseId: "lease-1",
  operationId: "operation-1",
};

interface TestManager {
  managerInstanceId: string;
  pollingGeneration: number;
  control: ReturnType<typeof vi.fn>;
  providerContext: ReturnType<typeof vi.fn>;
  providerTransactionConfiguration: ReturnType<typeof vi.fn>;
  runProviderSwitchTransaction(
    action: RemoteHostAction,
    providerId: "synthetic",
    status: RemoteDaemonStatus,
  ): Promise<void>;
  pollActions(generation: number): Promise<void>;
}

async function setup() {
  const directory = await mkdtemp("/tmp/modelhop-provider-switch-");
  const transcriptPath = path.join(directory, "session.jsonl");
  await writeFile(transcriptPath, '{"type":"user"}\n');
  const secrets = new Map<string, string>();
  let activeProvider: "anthropic" | "synthetic" = "anthropic";
  let variables = oldVariables.map((item) => ({ ...item }));
  const context = {
    globalStorageUri: { fsPath: directory },
    globalState: {
      get: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
    secrets: {
      get: vi.fn(async (key: string) => secrets.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        secrets.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        secrets.delete(key);
      }),
    },
    asAbsolutePath: (value: string) => value,
  } as unknown as vscode.ExtensionContext;
  const settingsService = {
    read: () => ({
      global: { variables },
      effective: { variables },
    }),
    write: vi.fn(async (next: typeof variables) => {
      variables = next.map((item) => ({ ...item }));
    }),
    verifyWritten: vi.fn(),
  };
  const switchCommand = {
    execute: vi.fn(async (next: typeof activeProvider) => {
      activeProvider = next;
      variables =
        next === "synthetic"
          ? targetVariables.map((item) => ({ ...item }))
          : oldVariables.map((item) => ({ ...item }));
    }),
  };
  const reloadCoordinator = {
    markPending: vi.fn().mockResolvedValue(undefined),
    reloadWindow: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new RemoteManager(
    context,
    settingsService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    switchCommand as never,
    reloadCoordinator as never,
    {
      error: vi.fn(),
      safeErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    } as never,
    () => activeProvider,
  );
  const testable = manager as unknown as TestManager;
  const previousContext = provider("anthropic", "default", 100);
  const expectedContext = provider(
    "synthetic",
    "hf:moonshotai/Kimi-K3",
    300,
  );
  testable.providerContext = vi.fn().mockResolvedValue(expectedContext);
  return {
    manager,
    testable,
    context,
    secrets,
    settingsService,
    switchCommand,
    reloadCoordinator,
    previousContext,
    expectedContext,
    initialStatus: status(previousContext, transcriptPath),
    getVariables: () => variables,
  };
}

describe("remote provider switch transaction", () => {
  it("uses the independent query axis as its quiescence barrier", () => {
    const idle = status(
      provider("anthropic", "default", 100),
      "/workspace/session.jsonl",
    );
    expect(remoteProviderSwitchIsQuiescent(idle)).toBe(true);
    expect(
      remoteProviderSwitchIsQuiescent({
        ...idle,
        query: { generation: 1, state: "settling" },
      }),
    ).toBe(false);
    expect(
      remoteProviderSwitchIsQuiescent({
        ...idle,
        query: { generation: 1, state: "completion-unknown" },
      }),
    ).toBe(false);
  });

  it("rejects mixed provider/model and role-routing evidence", () => {
    const expected = provider(
      "synthetic",
      "hf:moonshotai/Kimi-K3",
      100,
    );
    expect(remoteProviderRouteMatches(expected, expected)).toBe(true);
    expect(
      remoteProviderRouteMatches(
        expected,
        provider("anthropic", "default", 200),
      ),
    ).toBe(false);
    expect(
      remoteProviderRouteMatches(expected, {
        ...expected,
        roleModels: { ...expected.roleModels, sonnet: "wrong-model" },
      }),
    ).toBe(false);
  });

  it("persists one encrypted operation before reload and reclaims it after reload", async () => {
    const fixture = await setup();
    fixture.testable.control = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      fixture.testable.runProviderSwitchTransaction(
        action,
        "synthetic",
        fixture.initialStatus,
      ),
    ).rejects.toThrow(/resume after the editor reload/i);

    const stored = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      actionId: "action-1",
      operationId: "operation-1",
      leaseId: "lease-1",
      previousProvider: "anthropic",
      targetProvider: "synthetic",
      phase: "reload-requested",
    });
    expect(stored.previousGlobalVariables).toEqual(oldVariables);
    expect(fixture.reloadCoordinator.reloadWindow).toHaveBeenCalledOnce();
    expect(
      fixture.testable.control.mock.calls.some(
        ([route]) => route === "/control/configure",
      ),
    ).toBe(false);

    fixture.testable.managerInstanceId = "after-reload";
    const targetStatus = status(
      {
        ...fixture.expectedContext,
        updatedAt: Date.now(),
      },
      fixture.initialStatus.lease!.sourceTranscriptPath,
    );
    targetStatus.lease!.desktopEnvironmentHash = stored
      .targetEnvironmentHash as string;
    fixture.testable.providerTransactionConfiguration = vi
      .fn()
      .mockResolvedValue({
        lease: targetStatus.lease,
      });
    fixture.testable.control = vi.fn(async (route: string) => {
      if (route === "/control/status") {
        return fixture.initialStatus;
      }
      if (route === "/control/configure") {
        return targetStatus;
      }
      return { ok: true };
    });

    await fixture.testable.runProviderSwitchTransaction(
      action,
      "synthetic",
      fixture.initialStatus,
    );

    const committed = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    expect(committed.phase).toBe("committed");
    expect(fixture.reloadCoordinator.reloadWindow).toHaveBeenCalledOnce();
    expect(
      fixture.testable.control.mock.calls.filter(
        ([route]) => route === "/control/configure",
      ),
    ).toHaveLength(1);
    fixture.manager.dispose();
  });

  it("does not acknowledge the durable action before reload reclamation", async () => {
    const fixture = await setup();
    fixture.testable.pollingGeneration = 4;
    fixture.testable.control = vi.fn(async (route: string) => {
      if (route.startsWith("/control/actions?")) {
        return { actions: [action] };
      }
      if (route === "/control/status") {
        return fixture.initialStatus;
      }
      return { ok: true };
    });

    await fixture.testable.pollActions(4);

    expect(
      fixture.testable.control.mock.calls.some(
        ([route]) => route === "/control/actions/complete",
      ),
    ).toBe(false);
    const checkpoint = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    expect(checkpoint.phase).toBe("reload-requested");
    fixture.manager.dispose();
  });

  it("reconciles a lost configure response without duplicating or rolling back the switch", async () => {
    const fixture = await setup();
    fixture.testable.control = vi.fn().mockResolvedValue({ ok: true });
    await expect(
      fixture.testable.runProviderSwitchTransaction(
        action,
        "synthetic",
        fixture.initialStatus,
      ),
    ).rejects.toThrow(/resume after the editor reload/i);
    const stored = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    fixture.testable.managerInstanceId = "after-reload";
    const targetRunning = status(
      { ...fixture.expectedContext, updatedAt: Date.now() },
      fixture.initialStatus.lease!.sourceTranscriptPath,
    );
    targetRunning.lease!.desktopEnvironmentHash = stored
      .targetEnvironmentHash as string;
    targetRunning.query = { generation: 2, state: "running" };
    const targetIdle = structuredClone(targetRunning);
    targetIdle.query = { generation: 2, state: "idle" };
    fixture.testable.providerTransactionConfiguration = vi
      .fn()
      .mockResolvedValue({ lease: targetRunning.lease });
    let configureAttempts = 0;
    let statusChecks = 0;
    fixture.testable.control = vi.fn(async (route: string) => {
      if (route === "/control/configure") {
        configureAttempts += 1;
        throw new Error("response lost");
      }
      if (route === "/control/status") {
        statusChecks += 1;
        return statusChecks === 1
          ? fixture.initialStatus
          : targetRunning;
      }
      return { ok: true };
    });

    await expect(
      fixture.testable.runProviderSwitchTransaction(
        action,
        "synthetic",
        fixture.initialStatus,
      ),
    ).rejects.toThrow(/checking the Mac/i);
    expect(configureAttempts).toBe(1);
    expect(fixture.switchCommand.execute).not.toHaveBeenLastCalledWith(
      "anthropic",
      expect.anything(),
    );

    const [checkpointKey, checkpointValue] =
      [...fixture.secrets.entries()][0] ?? [];
    const checkpoint = JSON.parse(checkpointValue ?? "{}") as Record<
      string,
      unknown
    >;
    checkpoint.nextAttemptAt = 0;
    fixture.secrets.set(
      checkpointKey ?? "missing",
      JSON.stringify(checkpoint),
    );
    fixture.testable.control = vi.fn(async (route: string) => {
      if (route === "/control/status") {
        return targetIdle;
      }
      if (route === "/control/configure") {
        configureAttempts += 1;
      }
      return { ok: true };
    });

    await fixture.testable.runProviderSwitchTransaction(
      action,
      "synthetic",
      fixture.initialStatus,
    );

    const committed = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    expect(committed.phase).toBe("committed");
    expect(configureAttempts).toBe(1);
    fixture.manager.dispose();
  });

  it("restores the complete previous route when initialization contradicts the target", async () => {
    const fixture = await setup();
    fixture.testable.control = vi.fn().mockResolvedValue({ ok: true });
    await expect(
      fixture.testable.runProviderSwitchTransaction(
        action,
        "synthetic",
        fixture.initialStatus,
      ),
    ).rejects.toThrow(/resume after the editor reload/i);
    const stored = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    fixture.testable.managerInstanceId = "after-reload";
    const mismatched = status(
      provider("anthropic", "claude-opus-5", Date.now()),
      fixture.initialStatus.lease!.sourceTranscriptPath,
    );
    mismatched.lease!.desktopEnvironmentHash = stored
      .targetEnvironmentHash as string;
    const rolledBack = status(
      { ...fixture.previousContext, updatedAt: Date.now() + 1 },
      fixture.initialStatus.lease!.sourceTranscriptPath,
    );
    // The rollback restores the encrypted pre-switch environment hash.
    const previousHash = stored.previousEnvironmentHash as string;
    rolledBack.lease!.desktopEnvironmentHash = previousHash;
    fixture.testable.providerTransactionConfiguration = vi
      .fn()
      .mockResolvedValue({ lease: fixture.initialStatus.lease });
    let configureCount = 0;
    fixture.testable.control = vi.fn(async (route: string) => {
      if (route === "/control/status") {
        return fixture.initialStatus;
      }
      if (route === "/control/configure") {
        configureCount += 1;
        return configureCount === 1 ? mismatched : rolledBack;
      }
      return { ok: true };
    });

    await fixture.testable.runProviderSwitchTransaction(
      action,
      "synthetic",
      fixture.initialStatus,
    );

    const checkpoint = JSON.parse(
      [...fixture.secrets.values()][0] ?? "{}",
    ) as Record<string, unknown>;
    expect(checkpoint.phase).toBe("rolled-back");
    expect(fixture.getVariables()).toEqual(oldVariables);
    expect(fixture.switchCommand.execute).toHaveBeenLastCalledWith(
      "anthropic",
      {
        skipConfirmation: true,
        reload: false,
        allowDuringRemoteSession: true,
      },
    );
    expect(configureCount).toBe(2);
    fixture.manager.dispose();
  });
});
