import { createHash } from "node:crypto";
import type { RemoteEventJournal } from "./eventJournal.js";
import type {
  RemoteClientCommand,
  RemoteCommandResponse,
  RemoteJournalEvent,
} from "./types.js";

export type DurableCommandState =
  | "accepted"
  | "executing"
  | "completed"
  | "failed";

export interface DurableCommandReceipt {
  commandId: string;
  requestHash: string;
  state: DurableCommandState;
  acceptedAt: number;
  updatedAt: number;
  revision: number;
  completedAt?: number;
  response?: RemoteCommandResponse;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function remoteCommandRequestHash(
  command: RemoteClientCommand,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(command)))
    .digest("hex");
}

function receiptFrom(value: unknown): DurableCommandReceipt | undefined {
  if (
    !isRecord(value) ||
    typeof value.commandId !== "string" ||
    typeof value.requestHash !== "string" ||
    ![
      "accepted",
      "executing",
      "completed",
      "failed",
    ].includes(String(value.state)) ||
    typeof value.acceptedAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return undefined;
  }
  const state = value.state as DurableCommandState;
  const fallbackRevision =
    state === "accepted" ? 0 : state === "executing" ? 1 : 2;
  return {
    ...(value as unknown as DurableCommandReceipt),
    revision:
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0
        ? value.revision
        : fallbackRevision,
  };
}

function isValidSuccessor(
  current: DurableCommandReceipt,
  next: DurableCommandReceipt,
): boolean {
  if (
    current.commandId !== next.commandId ||
    current.requestHash !== next.requestHash ||
    current.acceptedAt !== next.acceptedAt ||
    next.revision <= current.revision
  ) {
    return false;
  }
  if (current.state === "accepted") {
    return next.state === "executing";
  }
  if (current.state === "executing") {
    return next.state === "completed" || next.state === "failed";
  }
  return false;
}

/**
 * Crash-durable exactly-once admission for mutating phone commands. A command
 * is recorded before its side effect. If a process stops in `executing`, the
 * next process reports an ambiguous outcome instead of repeating that effect.
 */
export class RemoteCommandLedger {
  private readonly receipts = new Map<string, DurableCommandReceipt>();
  private mutationChain: Promise<void> = Promise.resolve();

  public constructor(private readonly journal: RemoteEventJournal) {}

  public hydrate(events: readonly RemoteJournalEvent[]): void {
    this.receipts.clear();
    for (const event of events) {
      if (event.type === "command.receipt") {
        const receipt = receiptFrom(event.payload);
        if (receipt) {
          const current = this.receipts.get(receipt.commandId);
          if (!current || isValidSuccessor(current, receipt)) {
            this.receipts.set(receipt.commandId, structuredClone(receipt));
          }
        }
        continue;
      }
      // Version 1 wrote only terminal command.response entries. Preserve their
      // duplicate-prevention guarantee while migrating to version 2 receipts.
      if (
        event.type === "command.response" &&
        isRecord(event.payload) &&
        typeof event.payload.commandId === "string" &&
        isRecord(event.payload.response)
      ) {
        const response =
          event.payload.response as unknown as RemoteCommandResponse;
        if (this.receipts.has(event.payload.commandId)) {
          continue;
        }
        this.receipts.set(event.payload.commandId, {
          commandId: event.payload.commandId,
          requestHash: "legacy",
          state: response.ok ? "completed" : "failed",
          acceptedAt: event.createdAt,
          updatedAt: event.createdAt,
          revision: 2,
          completedAt: event.createdAt,
          response,
          error: response.error,
        });
      }
    }
  }

  public get(commandId: string): DurableCommandReceipt | undefined {
    const receipt = this.receipts.get(commandId);
    return receipt ? structuredClone(receipt) : undefined;
  }

  public async accept(
    command: RemoteClientCommand,
  ): Promise<DurableCommandReceipt> {
    return this.mutate(() => this.acceptNow(command));
  }

  private async acceptNow(
    command: RemoteClientCommand,
  ): Promise<DurableCommandReceipt> {
    const requestHash = remoteCommandRequestHash(command);
    const existing = this.receipts.get(command.id);
    if (existing) {
      if (
        existing.requestHash !== "legacy" &&
        existing.requestHash !== requestHash
      ) {
        throw new Error(
          "A remote command ID was reused with different content.",
        );
      }
      return structuredClone(existing);
    }
    const now = Date.now();
    return this.record({
      commandId: command.id,
      requestHash,
      state: "accepted",
      acceptedAt: now,
      updatedAt: now,
      revision: 0,
    });
  }

  public markExecuting(
    receipt: DurableCommandReceipt,
  ): Promise<DurableCommandReceipt> {
    return this.mutate(() => this.transition(receipt, "executing"));
  }

  public complete(
    receipt: DurableCommandReceipt,
    response: RemoteCommandResponse,
  ): Promise<DurableCommandReceipt> {
    return this.mutate(() =>
      this.transition(
        receipt,
        response.ok ? "completed" : "failed",
        response,
      ),
    );
  }

  public ambiguousResponse(
    commandId: string,
  ): RemoteCommandResponse {
    return {
      id: commandId,
      ok: true,
      data: {
        deliveryState: "unknown",
        message:
          "ModelHop is checking whether the Mac completed this command. It will not repeat the command while the outcome is uncertain.",
      },
    };
  }

  private async transition(
    expected: DurableCommandReceipt,
    state: DurableCommandState,
    response?: RemoteCommandResponse,
  ): Promise<DurableCommandReceipt> {
    const current = this.receipts.get(expected.commandId);
    if (
      !current ||
      current.requestHash !== expected.requestHash ||
      current.revision !== expected.revision ||
      current.state !== expected.state ||
      (state === "executing" && current.state !== "accepted") ||
      ((state === "completed" || state === "failed") &&
        current.state !== "executing")
    ) {
      throw new Error(
        "The remote command receipt changed before it could be committed.",
      );
    }
    return this.record({
      ...current,
      state,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      revision: current.revision + 1,
      completedAt:
        state === "completed" || state === "failed"
          ? Date.now()
          : undefined,
      response,
      error: response?.error,
    });
  }

  private async record(
    receipt: DurableCommandReceipt,
  ): Promise<DurableCommandReceipt> {
    const durableReceipt = structuredClone(receipt);
    await this.journal.append(
      "command.receipt",
      durableReceipt,
    );
    this.receipts.set(durableReceipt.commandId, durableReceipt);
    return structuredClone(durableReceipt);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationChain.then(operation);
    this.mutationChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
