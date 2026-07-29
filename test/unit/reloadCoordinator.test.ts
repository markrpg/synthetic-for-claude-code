import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMocks = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vscodeMocks.showInformationMessage,
  },
  commands: {
    executeCommand: vscodeMocks.executeCommand,
  },
}));

import { ReloadCoordinator } from "../../src/reload/reloadCoordinator.js";

function createContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  return {
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
  } as unknown as vscode.ExtensionContext;
}

describe("ReloadCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not block activation while a reload notification is open", async () => {
    vscodeMocks.showInformationMessage.mockReturnValue(
      new Promise<string | undefined>(() => undefined),
    );
    const coordinator = new ReloadCoordinator(createContext());
    await coordinator.markPending({
      provider: "anthropic",
      switchedAt: Date.now(),
      reason: "switch",
      workspaceOverride: false,
    });

    await expect(
      coordinator.showPostReloadNotification(),
    ).resolves.toBeUndefined();
    expect(vscodeMocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Open Claude Code to continue."),
      "Dismiss",
    );
  });
});
