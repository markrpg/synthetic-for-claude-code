import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { SnapshotService } from "../../src/snapshots/snapshotService.js";

function createContext(): {
  context: vscode.ExtensionContext;
  state: Map<string, unknown>;
  secrets: Map<string, string>;
} {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const context = {
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
    secrets: {
      get(key: string): Thenable<string | undefined> {
        return Promise.resolve(secrets.get(key));
      },
      store(key: string, value: string): Thenable<void> {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete(key: string): Thenable<void> {
        secrets.delete(key);
        return Promise.resolve();
      },
    },
  } as unknown as vscode.ExtensionContext;
  return { context, state, secrets };
}

describe("SnapshotService", () => {
  it("keeps token material out of global state and hydrates on read", async () => {
    const { context, state, secrets } = createContext();
    const service = new SnapshotService(context);
    const variables = [
      {
        name: "ANTHROPIC_BASE_URL",
        value: "https://api.synthetic.new/anthropic",
      },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "test-placeholder" },
    ];
    const snapshot = service.capture(variables);

    await service.saveLastKnownGood(snapshot);

    expect(JSON.stringify([...state.values()])).not.toContain(
      "test-placeholder",
    );
    expect([...secrets.values()]).toContain("test-placeholder");
    expect(
      (await service.getLastKnownGood())?.environmentVariables,
    ).toEqual(variables);
  });
});
