import { describe, expect, it, vi } from "vitest";
import {
  applySwitchTransaction,
  SwitchRollbackError,
  type SwitchTransactionDependencies,
} from "../../src/core/switchTransaction.js";
import type { EnvironmentVariable } from "../../src/providers/types.js";

interface TestSnapshot {
  environmentVariables: EnvironmentVariable[];
}

function dependencies(
  overrides: Partial<SwitchTransactionDependencies<TestSnapshot>> = {},
): SwitchTransactionDependencies<TestSnapshot> {
  return {
    capture: (variables) => ({
      environmentVariables: [...variables],
    }),
    write: vi.fn(async () => undefined),
    verify: vi.fn(() => undefined),
    saveLastKnownGood: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    updateActiveProvider: vi.fn(async () => undefined),
    clearActiveProvider: vi.fn(async () => undefined),
    markPendingReload: vi.fn(async () => undefined),
    clearPendingReload: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("applySwitchTransaction", () => {
  const current = [{ name: "MCP_TIMEOUT", value: "30000" }];
  const target = [
    { name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", value: "1" },
  ];

  it("writes, verifies, snapshots, and reloads", async () => {
    const deps = dependencies();
    const result = await applySwitchTransaction(
      "anthropic",
      current,
      target,
      deps,
    );
    expect(result).toEqual([...current, ...target]);
    expect(deps.write).toHaveBeenCalledWith(result);
    expect(deps.verify).toHaveBeenCalledWith("anthropic", result);
    expect(deps.saveLastKnownGood).toHaveBeenCalled();
    expect(deps.reload).toHaveBeenCalled();
    expect(deps.restore).not.toHaveBeenCalled();
  });

  it("rolls back when verification fails", async () => {
    const verificationError = new Error("verification failed");
    const deps = dependencies({
      verify: vi.fn(() => {
        throw verificationError;
      }),
    });

    await expect(
      applySwitchTransaction("anthropic", current, target, deps),
    ).rejects.toBe(verificationError);
    expect(deps.restore).toHaveBeenCalledWith({
      environmentVariables: current,
    });
    expect(deps.clearPendingReload).toHaveBeenCalled();
    expect(deps.clearActiveProvider).toHaveBeenCalled();
  });

  it("reports a failed rollback without hiding the switch failure", async () => {
    const switchError = new Error("write failed");
    const rollbackError = new Error("rollback failed");
    const deps = dependencies({
      write: vi.fn(async () => {
        throw switchError;
      }),
      restore: vi.fn(async () => {
        throw rollbackError;
      }),
    });

    const error = await applySwitchTransaction(
      "anthropic",
      current,
      target,
      deps,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SwitchRollbackError);
    expect((error as SwitchRollbackError).switchError).toBe(switchError);
    expect((error as SwitchRollbackError).rollbackError).toBe(
      rollbackError,
    );
  });

  it("attempts configuration rollback even if metadata cleanup fails", async () => {
    const restore = vi.fn(async () => undefined);
    const deps = dependencies({
      verify: vi.fn(() => {
        throw new Error("verification failed");
      }),
      restore,
      clearPendingReload: vi.fn(async () => {
        throw new Error("state cleanup failed");
      }),
    });

    await expect(
      applySwitchTransaction("anthropic", current, target, deps),
    ).rejects.toBeInstanceOf(SwitchRollbackError);
    expect(restore).toHaveBeenCalled();
    expect(deps.clearActiveProvider).toHaveBeenCalled();
  });
});
