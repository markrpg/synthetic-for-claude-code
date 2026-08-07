import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteCommandLedger } from "../../src/remote/commandLedger.js";
import { RemoteEventJournal } from "../../src/remote/eventJournal.js";
import type { RemoteClientCommand } from "../../src/remote/types.js";

const temporaryDirectories: string[] = [];

async function journalFixture(): Promise<{
  journal: RemoteEventJournal;
  journalPath: string;
  key: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "modelhop-command-ledger-test-"),
  );
  temporaryDirectories.push(directory);
  const journalPath = path.join(directory, "events.jsonl");
  const key = randomBytes(32).toString("base64");
  const journal = new RemoteEventJournal(journalPath, key);
  await journal.initialize();
  return { journal, journalPath, key };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("durable remote command ledger", () => {
  it("persists admission before execution and restores a terminal receipt", async () => {
    const { journal, journalPath, key } = await journalFixture();
    const command: RemoteClientCommand = {
      id: "prompt-1",
      type: "prompt.send",
      prompt: "Continue safely",
    };
    const ledger = new RemoteCommandLedger(journal);
    const accepted = await ledger.accept(command);
    expect(accepted.state).toBe("accepted");
    const executing = await ledger.markExecuting(accepted);
    await ledger.complete(executing, {
      id: command.id,
      ok: true,
      data: { accepted: true },
    });

    const restoredJournal = new RemoteEventJournal(journalPath, key);
    await restoredJournal.initialize();
    const restored = new RemoteCommandLedger(restoredJournal);
    restored.hydrate(
      restoredJournal.window(
        restoredJournal.earliestId() - 1,
        10_000,
      ).events,
    );
    expect(restored.get(command.id)).toMatchObject({
      state: "completed",
      response: { id: command.id, ok: true },
    });
  });

  it("reports an interrupted executing command as ambiguous instead of repeating it", async () => {
    const { journal, journalPath, key } = await journalFixture();
    const command: RemoteClientCommand = {
      id: "reset-1",
      type: "codex.reset",
      creditId: "credit-1",
    };
    const ledger = new RemoteCommandLedger(journal);
    const accepted = await ledger.accept(command);
    await ledger.markExecuting(accepted);

    const restoredJournal = new RemoteEventJournal(journalPath, key);
    await restoredJournal.initialize();
    const restored = new RemoteCommandLedger(restoredJournal);
    restored.hydrate(
      restoredJournal.window(
        restoredJournal.earliestId() - 1,
        10_000,
      ).events,
    );
    const receipt = await restored.accept(command);
    expect(receipt.state).toBe("executing");
    expect(restored.ambiguousResponse(command.id)).toMatchObject({
      ok: true,
      data: { deliveryState: "unknown" },
    });
  });

  it("can terminally reconcile an executing hand-back from its durable host intent", async () => {
    const { journal, journalPath, key } = await journalFixture();
    const command: RemoteClientCommand = {
      id: "handback-1",
      type: "session.handback",
      strategy: "finish",
    };
    const first = new RemoteCommandLedger(journal);
    const accepted = await first.accept(command);
    await first.markExecuting(accepted);

    const restoredJournal = new RemoteEventJournal(journalPath, key);
    await restoredJournal.initialize();
    const restored = new RemoteCommandLedger(restoredJournal);
    restored.hydrate(restoredJournal.window(0, 10_000).events);
    const executing = await restored.accept(command);
    expect(executing.state).toBe("executing");

    await restored.complete(executing, {
      id: command.id,
      ok: true,
      data: {
        queued: true,
        actionId: "deterministic-action",
        operationId: "deterministic-operation",
      },
    });

    expect(restored.get(command.id)).toMatchObject({
      state: "completed",
      response: {
        ok: true,
        data: { actionId: "deterministic-action" },
      },
    });
  });

  it("returns a durable terminal response after the client loses the HTTP response", async () => {
    const { journal, journalPath, key } = await journalFixture();
    const command: RemoteClientCommand = {
      id: "approval-1",
      type: "permission.resolve",
      requestId: "request-1",
      decision: "allow",
    };
    let effects = 0;
    const ledger = new RemoteCommandLedger(journal);
    const accepted = await ledger.accept(command);
    const executing = await ledger.markExecuting(accepted);
    effects += 1;
    await ledger.complete(executing, {
      id: command.id,
      ok: true,
      data: { applied: true },
    });
    const eventsBeforeRetry = journal.latestId();

    const restoredJournal = new RemoteEventJournal(journalPath, key);
    await restoredJournal.initialize();
    const restored = new RemoteCommandLedger(restoredJournal);
    restored.hydrate(restoredJournal.window(0, 10_000).events);
    const retry = await restored.accept(command);
    if (retry.state === "accepted") {
      effects += 1;
    }
    expect(retry).toMatchObject({
      state: "completed",
      response: { id: command.id, ok: true, data: { applied: true } },
    });
    expect(effects).toBe(1);
    expect(restoredJournal.latestId()).toBe(eventsBeforeRetry);
  });

  it("retries an accepted command after a crash before execution exactly once", async () => {
    const { journal, journalPath, key } = await journalFixture();
    const command: RemoteClientCommand = {
      id: "prompt-accepted",
      type: "prompt.send",
      prompt: "Resume safely",
    };
    const first = new RemoteCommandLedger(journal);
    await first.accept(command);

    const restoredJournal = new RemoteEventJournal(journalPath, key);
    await restoredJournal.initialize();
    const restored = new RemoteCommandLedger(restoredJournal);
    restored.hydrate(restoredJournal.window(0, 10_000).events);
    const accepted = await restored.accept(command);
    let effects = 0;
    const executing = await restored.markExecuting(accepted);
    effects += 1;
    await restored.complete(executing, {
      id: command.id,
      ok: true,
    });
    expect(effects).toBe(1);
    expect(restored.get(command.id)?.state).toBe("completed");
  });

  it("allows only one claimant to advance an accepted receipt", async () => {
    const { journal } = await journalFixture();
    const ledger = new RemoteCommandLedger(journal);
    const accepted = await ledger.accept({
      id: "concurrent-command",
      type: "usage.refresh",
    });
    const results = await Promise.allSettled([
      ledger.markExecuting(accepted),
      ledger.markExecuting(accepted),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
  });

  it("does not let a legacy response erase a version-two request hash", async () => {
    const { journal, journalPath, key } = await journalFixture();
    const command: RemoteClientCommand = {
      id: "hashed-command",
      type: "prompt.send",
      prompt: "original",
    };
    const ledger = new RemoteCommandLedger(journal);
    const accepted = await ledger.accept(command);
    const executing = await ledger.markExecuting(accepted);
    const response = { id: command.id, ok: true };
    await ledger.complete(executing, response);
    await journal.append("command.response", {
      commandId: command.id,
      response,
    });

    const restoredJournal = new RemoteEventJournal(journalPath, key);
    await restoredJournal.initialize();
    const restored = new RemoteCommandLedger(restoredJournal);
    restored.hydrate(restoredJournal.window(0, 10_000).events);
    await expect(
      restored.accept({
        id: command.id,
        type: "prompt.send",
        prompt: "different",
      }),
    ).rejects.toThrow("reused with different content");
  });

  it("does not let a caller mutate a completed durable response", async () => {
    const { journal } = await journalFixture();
    const ledger = new RemoteCommandLedger(journal);
    const command: RemoteClientCommand = {
      id: "immutable-response",
      type: "usage.refresh",
    };
    const accepted = await ledger.accept(command);
    const executing = await ledger.markExecuting(accepted);
    const data = { applied: true };
    const response = { id: command.id, ok: true, data };
    await ledger.complete(executing, response);
    data.applied = false;

    expect(ledger.get(command.id)?.response).toMatchObject({
      data: { applied: true },
    });
  });

  it("rejects command ID reuse with different authenticated content", async () => {
    const { journal } = await journalFixture();
    const ledger = new RemoteCommandLedger(journal);
    await ledger.accept({
      id: "same-id",
      type: "prompt.send",
      prompt: "first",
    });
    await expect(
      ledger.accept({
        id: "same-id",
        type: "prompt.send",
        prompt: "different",
      }),
    ).rejects.toThrow("reused with different content");
  });
});
