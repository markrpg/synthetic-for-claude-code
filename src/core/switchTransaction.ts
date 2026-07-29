import {
  mergeEnvironmentVariables,
} from "../configuration/mergeEnvironmentVariables.js";
import type {
  EnvironmentVariable,
  ProviderId,
} from "../providers/types.js";

export interface SwitchTransactionDependencies<Snapshot> {
  capture(
    currentVariables: readonly EnvironmentVariable[],
  ): Snapshot | Promise<Snapshot>;
  write(variables: readonly EnvironmentVariable[]): Promise<void>;
  verify(
    providerId: ProviderId,
    variables: readonly EnvironmentVariable[],
  ): Promise<void> | void;
  saveLastKnownGood(snapshot: Snapshot): Promise<void>;
  restore(snapshot: Snapshot): Promise<void>;
  updateActiveProvider(providerId: ProviderId): Promise<void>;
  clearActiveProvider(): Promise<void>;
  markPendingReload(providerId: ProviderId): Promise<void>;
  clearPendingReload(): Promise<void>;
  reload(): Promise<void>;
}

export class SwitchRollbackError extends Error {
  public constructor(
    public readonly switchError: unknown,
    public readonly rollbackError: unknown,
  ) {
    super(
      "Provider switching failed, and the previous configuration could not be restored automatically.",
    );
    this.name = "SwitchRollbackError";
  }
}

export async function applySwitchTransaction<Snapshot>(
  providerId: ProviderId,
  currentVariables: readonly EnvironmentVariable[],
  targetVariables: readonly EnvironmentVariable[],
  dependencies: SwitchTransactionDependencies<Snapshot>,
): Promise<EnvironmentVariable[]> {
  const mergedVariables = mergeEnvironmentVariables(
    currentVariables,
    targetVariables,
  );
  const snapshot = await dependencies.capture(currentVariables);

  try {
    await dependencies.write(mergedVariables);
    await dependencies.verify(providerId, mergedVariables);
    await dependencies.saveLastKnownGood(snapshot);
    await dependencies.updateActiveProvider(providerId);
    await dependencies.markPendingReload(providerId);
    await dependencies.reload();
    return mergedVariables;
  } catch (switchError) {
    let rollbackError: unknown;
    try {
      await dependencies.restore(snapshot);
    } catch (error) {
      rollbackError = error;
    }
    try {
      await dependencies.clearPendingReload();
    } catch (error) {
      rollbackError ??= error;
    }
    try {
      await dependencies.clearActiveProvider();
    } catch (error) {
      rollbackError ??= error;
    }
    if (rollbackError !== undefined) {
      throw new SwitchRollbackError(switchError, rollbackError);
    }
    throw switchError;
  }
}
