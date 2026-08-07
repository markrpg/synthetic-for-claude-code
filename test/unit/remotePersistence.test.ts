import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteDeviceStore } from "../../src/remote/deviceStore.js";
import {
  RemoteEventJournal,
  RemoteJournalCorruptionError,
} from "../../src/remote/eventJournal.js";
import {
  EncryptedRemoteRuntimeStore,
  RemoteRuntimeStoreCorruptionError,
} from "../../src/remote/runtimeStore.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "modelhop-persistence-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("remote persistence", () => {
  it("encrypts paired device records at rest", async () => {
    const directory = await temporaryDirectory();
    const storePath = path.join(directory, "devices.enc");
    const key = randomBytes(32).toString("base64");
    const store = new RemoteDeviceStore(storePath, key);
    await store.initialize();
    await store.pair({
      id: "phone-id",
      name: "Private phone",
      publicKey: "public-key-material",
      pairedAt: 1,
      lastUsedAt: 2,
    });

    const source = await readFile(storePath, "utf8");
    expect(source).not.toContain("Private phone");

    const restored = new RemoteDeviceStore(storePath, key);
    await restored.initialize();
    expect(restored.findActive("phone-id")?.name).toBe(
      "Private phone",
    );
    await restored.revoke("phone-id");
    expect(restored.findActive("phone-id")).toBeUndefined();
    await restored.reset();
    expect(restored.list()).toEqual([]);
  });

  it("replays journal events once and resumes from an acknowledgement", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const journalKey = randomBytes(32).toString("base64");
    const journal = new RemoteEventJournal(
      journalPath,
      journalKey,
    );
    await journal.initialize();
    const first = await journal.append("notification", {
      message: "ready",
    });
    const second = await journal.append("session.state", {
      state: "paired",
    });

    expect(journal.since(0)).toEqual([first, second]);
    expect(journal.since(first.id)).toEqual([second]);

    expect(await readFile(journalPath, "utf8")).not.toContain("ready");
    const restored = new RemoteEventJournal(
      journalPath,
      journalKey,
    );
    await restored.initialize();
    expect(restored.since(first.id)).toEqual([second]);
  });

  it("repairs physical journal order and continues after the highest ID", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const event = (id: number, message: string) =>
      JSON.stringify({
        id,
        type: "notification",
        createdAt: id,
        payload: { message },
      });
    await writeFile(
      journalPath,
      [
        event(2, "second"),
        event(1, "first"),
        event(2, "duplicate must not replace second"),
      ].join("\n") + "\n",
      "utf8",
    );

    const journal = new RemoteEventJournal(journalPath);
    await journal.initialize();
    expect(
      journal.since(0).map((entry) => [entry.id, entry.payload]),
    ).toEqual([
      [1, { message: "first" }],
      [2, { message: "second" }],
    ]);
    expect((await journal.append("notification", {})).id).toBe(3);
  });

  it("detects a replay gap and exposes a bounded segmented window", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const rows = Array.from({ length: 10_002 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        type: "notification",
        createdAt: index + 1,
        payload: { index },
      }),
    );
    await writeFile(journalPath, `${rows.join("\n")}\n`, "utf8");

    const journal = new RemoteEventJournal(journalPath);
    await journal.initialize();

    expect(journal.earliestId()).toBe(3);
    expect(journal.latestId()).toBe(10_002);
    expect(journal.window(0)).toMatchObject({
      gap: true,
      earliestEventId: 3,
      latestEventId: 10_002,
      events: [],
    });
    expect(journal.window(2, 3).events.map((event) => event.id)).toEqual([
      3, 4, 5,
    ]);
    expect((await journal.stats()).segmentCount).toBeGreaterThan(1);
    await journal.saveSnapshot(
      { runtimeRevision: 42, work: ["settling-workflow"] },
      journal.latestId(),
    );
    await expect(journal.loadSnapshot()).resolves.toMatchObject({
      throughEventId: 10_002,
      payload: {
        runtimeRevision: 42,
        work: ["settling-workflow"],
      },
    });
  });

  it("preserves exact replay and snapshots beyond the former 2,000-event window", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const rows = Array.from({ length: 2_005 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        type: "notification",
        createdAt: index + 1,
        payload: { index },
      }),
    );
    await writeFile(journalPath, `${rows.join("\n")}\n`, "utf8");

    const journal = new RemoteEventJournal(journalPath);
    await journal.initialize();
    const replayed: number[] = [];
    let cursor = 0;
    while (cursor < journal.latestId()) {
      const window = journal.window(cursor, 1_000);
      expect(window.gap).toBe(false);
      replayed.push(...window.events.map((event) => event.id));
      cursor = window.events.at(-1)?.id ?? cursor;
    }
    expect(replayed).toEqual(
      Array.from({ length: 2_005 }, (_, index) => index + 1),
    );
    expect((await journal.stats()).segmentCount).toBeGreaterThan(2);

    await journal.saveSnapshot(
      { cursor, phase: "completion-unknown" },
      cursor,
    );
    const restored = new RemoteEventJournal(journalPath);
    await restored.initialize();
    await expect(restored.loadSnapshot()).resolves.toMatchObject({
      throughEventId: 2_005,
      payload: { cursor: 2_005, phase: "completion-unknown" },
    });
  });

  it("reconstructs a missing journal manifest from durable segments", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const rows = Array.from({ length: 1_001 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        type: "notification",
        createdAt: index + 1,
        payload: { index },
      }),
    );
    await writeFile(journalPath, `${rows.join("\n")}\n`, "utf8");
    const journal = new RemoteEventJournal(journalPath);
    await journal.initialize();
    await unlink(`${journalPath}.manifest`);

    const restored = new RemoteEventJournal(journalPath);
    await restored.initialize();
    expect(restored.earliestId()).toBe(1);
    expect(restored.latestId()).toBe(1_001);
    expect(restored.window(0, 1_000).events).toHaveLength(1_000);
    expect(restored.window(1_000).events[0]?.id).toBe(1_001);
  });

  it("reports a manifest that references a missing journal segment", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const rows = Array.from({ length: 1_001 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        type: "notification",
        createdAt: index + 1,
        payload: {},
      }),
    );
    await writeFile(journalPath, `${rows.join("\n")}\n`, "utf8");
    const journal = new RemoteEventJournal(journalPath);
    await journal.initialize();
    const manifestPath = `${journalPath}.manifest`;
    const manifestSource = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestSource) as {
      segments: Array<{ file: string }>;
    };
    const segment = manifest.segments[0];
    expect(segment).toBeDefined();
    await unlink(path.join(directory, segment?.file ?? "missing"));

    const restored = new RemoteEventJournal(journalPath);
    await expect(restored.initialize()).rejects.toThrow(
      "journal segment",
    );
    expect(await readFile(manifestPath, "utf8")).toBe(manifestSource);
  });

  it("repairs a partial trailing write and preserves its recovery copy", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const key = randomBytes(32).toString("base64");
    const journal = new RemoteEventJournal(journalPath, key);
    await journal.initialize();
    const first = await journal.append("notification", {
      message: "durable",
    });
    await appendFile(journalPath, "interrupted-record", "utf8");

    const restored = new RemoteEventJournal(journalPath, key);
    await restored.initialize();
    expect(restored.since(0)).toEqual([first]);
    expect((await restored.append("notification", {})).id).toBe(2);
    expect(
      (await readdir(directory)).some((file) => file.includes(".corrupt-")),
    ).toBe(true);
  });

  it("repairs an interrupted first record to an empty journal", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    await writeFile(journalPath, '{"id":1', "utf8");

    const journal = new RemoteEventJournal(journalPath);
    await journal.initialize();
    expect(journal.since(0)).toEqual([]);
    expect((await journal.append("notification", {})).id).toBe(1);
  });

  it("fails closed on non-trailing corruption without modifying the source", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const source = [
      JSON.stringify({
        id: 1,
        type: "notification",
        createdAt: 1,
        payload: {},
      }),
      "not-json",
      JSON.stringify({
        id: 2,
        type: "notification",
        createdAt: 2,
        payload: {},
      }),
      "",
    ].join("\n");
    await writeFile(journalPath, source, "utf8");

    const journal = new RemoteEventJournal(journalPath);
    await expect(journal.initialize()).rejects.toBeInstanceOf(
      RemoteJournalCorruptionError,
    );
    expect(await readFile(journalPath, "utf8")).toBe(source);
    expect(
      (await readdir(directory)).some((file) => file.includes(".corrupt-")),
    ).toBe(true);
  });

  it("serializes concurrent appends without duplicate event IDs", async () => {
    const directory = await temporaryDirectory();
    const journal = new RemoteEventJournal(
      path.join(directory, "events.jsonl"),
    );
    await journal.initialize();
    const events = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        journal.append("notification", { index }),
      ),
    );
    expect(events.map((event) => event.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(new Set(events.map((event) => event.id)).size).toBe(40);
  });

  it("does not let callers mutate durable in-memory journal events", async () => {
    const directory = await temporaryDirectory();
    const journal = new RemoteEventJournal(
      path.join(directory, "events.jsonl"),
    );
    await journal.initialize();
    const payload = { nested: { state: "accepted" } };
    const appended = await journal.append("notification", payload);
    payload.nested.state = "mutated-at-source";
    (appended.payload as typeof payload).nested.state = "mutated-return";
    const firstRead = journal.since(0);
    (firstRead[0]?.payload as typeof payload).nested.state = "mutated-window";

    expect(journal.since(0)[0]?.payload).toEqual({
      nested: { state: "accepted" },
    });
  });

  it("quarantines corruption instead of erasing the only recovery journal", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const key = randomBytes(32).toString("base64");
    const journal = new RemoteEventJournal(journalPath, key);
    await journal.initialize();
    await journal.append("notification", { message: "recover me" });
    const before = await readFile(journalPath, "utf8");

    const wrongKey = randomBytes(32).toString("base64");
    const damaged = new RemoteEventJournal(journalPath, wrongKey);
    await expect(damaged.initialize()).rejects.toBeInstanceOf(
      RemoteJournalCorruptionError,
    );

    expect(await readFile(journalPath, "utf8")).toBe(before);
    expect(
      (await readdir(directory)).some((file) => file.includes(".corrupt-")),
    ).toBe(true);
  });

  it("persists an encrypted authoritative snapshot for gap recovery", async () => {
    const directory = await temporaryDirectory();
    const journalPath = path.join(directory, "events.jsonl");
    const key = randomBytes(32).toString("base64");
    const journal = new RemoteEventJournal(journalPath, key);
    await journal.initialize();
    const event = await journal.append("session.state", {
      state: "running",
    });
    await journal.saveSnapshot(
      { lease: { state: "running" }, work: ["workflow-1"] },
      event.id,
    );

    const snapshotSource = await readFile(
      `${journalPath}.snapshot`,
      "utf8",
    );
    expect(snapshotSource).not.toContain("workflow-1");
    await expect(journal.loadSnapshot()).resolves.toMatchObject({
      epoch: journal.epoch(),
      throughEventId: event.id,
      payload: {
        lease: { state: "running" },
        work: ["workflow-1"],
      },
    });
  });

  it("loads a missing runtime manifest as no recovery state", async () => {
    const directory = await temporaryDirectory();
    const store = new EncryptedRemoteRuntimeStore(
      path.join(directory, "runtime.enc"),
      randomBytes(32).toString("base64"),
    );
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("atomically saves and restores the latest encrypted runtime manifest", async () => {
    const directory = await temporaryDirectory();
    const storePath = path.join(directory, "runtime.enc");
    const key = randomBytes(32).toString("base64");
    const store = new EncryptedRemoteRuntimeStore<{
      revision: number;
      state: string;
    }>(storePath, key);
    await Promise.all([
      store.save({ revision: 1, state: "running" }),
      store.save({ revision: 2, state: "settling" }),
    ]);
    await store.flush();
    expect(await readFile(storePath, "utf8")).not.toContain("settling");

    const restored = new EncryptedRemoteRuntimeStore<{
      revision: number;
      state: string;
    }>(storePath, key);
    await expect(restored.load()).resolves.toEqual({
      revision: 2,
      state: "settling",
    });
  });

  it("quarantines a damaged runtime manifest without deleting it", async () => {
    const directory = await temporaryDirectory();
    const storePath = path.join(directory, "runtime.enc");
    const source = "truncated-encrypted-runtime";
    await writeFile(storePath, source, "utf8");
    const store = new EncryptedRemoteRuntimeStore(
      storePath,
      randomBytes(32).toString("base64"),
    );

    await expect(store.load()).rejects.toBeInstanceOf(
      RemoteRuntimeStoreCorruptionError,
    );
    expect(await readFile(storePath, "utf8")).toBe(source);
    expect(
      (await readdir(directory)).some((file) => file.includes(".corrupt-")),
    ).toBe(true);
  });

  it("treats a wrong runtime key as recoverable corruption", async () => {
    const directory = await temporaryDirectory();
    const storePath = path.join(directory, "runtime.enc");
    const original = new EncryptedRemoteRuntimeStore(
      storePath,
      randomBytes(32).toString("base64"),
    );
    await original.save({ sessionId: "recover-me" });
    const source = await readFile(storePath, "utf8");
    const wrongKey = new EncryptedRemoteRuntimeStore(
      storePath,
      randomBytes(32).toString("base64"),
    );

    await expect(wrongKey.load()).rejects.toBeInstanceOf(
      RemoteRuntimeStoreCorruptionError,
    );
    expect(await readFile(storePath, "utf8")).toBe(source);
  });
});
