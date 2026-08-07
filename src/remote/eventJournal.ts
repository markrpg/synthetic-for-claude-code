import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  decryptLocalStore,
  encryptLocalStore,
} from "./crypto.js";
import type { RemoteJournalEvent } from "./types.js";

const JOURNAL_FORMAT_VERSION = 2;
const SEGMENT_EVENT_LIMIT = 1_000;
const MAX_RETAINED_EVENTS = 10_000;
const DEFAULT_PAGE_SIZE = 200;

interface JournalSegment {
  file: string;
  firstId: number;
  lastId: number;
  count: number;
}

interface JournalManifest {
  version: typeof JOURNAL_FORMAT_VERSION;
  epoch: string;
  segments: JournalSegment[];
}

export interface RemoteJournalWindow {
  epoch: string;
  earliestEventId: number;
  latestEventId: number;
  gap: boolean;
  events: RemoteJournalEvent[];
}

export interface RemoteJournalSnapshot<T = unknown> {
  epoch: string;
  throughEventId: number;
  createdAt: number;
  payload: T;
}

export interface RemoteJournalStats {
  epoch: string;
  earliestEventId: number;
  latestEventId: number;
  retainedEvents: number;
  segmentCount: number;
  bytes: number;
  lastFlushAt?: number;
}

export class RemoteJournalCorruptionError extends Error {
  public constructor(
    message: string,
    public readonly quarantinePath?: string,
  ) {
    super(message);
    this.name = "RemoteJournalCorruptionError";
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isEvent(value: unknown): value is RemoteJournalEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    "type" in value &&
    typeof value.type === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function isSegment(value: unknown): value is JournalSegment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const segment = value as Partial<JournalSegment>;
  return (
    typeof segment.file === "string" &&
    !path.isAbsolute(segment.file) &&
    path.basename(segment.file) === segment.file &&
    Number.isSafeInteger(segment.firstId) &&
    (segment.firstId ?? 0) > 0 &&
    Number.isSafeInteger(segment.lastId) &&
    (segment.lastId ?? -1) >= (segment.firstId ?? 0) &&
    Number.isSafeInteger(segment.count) &&
    (segment.count ?? 0) > 0 &&
    segment.count === (segment.lastId ?? 0) - (segment.firstId ?? 0) + 1
  );
}

function isManifest(value: unknown): value is JournalManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === JOURNAL_FORMAT_VERSION &&
    "epoch" in value &&
    typeof value.epoch === "string" &&
    value.epoch.length >= 16 &&
    "segments" in value &&
    Array.isArray(value.segments) &&
    value.segments.every((segment: unknown) => isSegment(segment))
  );
}

function segmentFromFilename(
  journalPath: string,
  file: string,
): JournalSegment | undefined {
  const escapedBase = path
    .basename(journalPath)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^${escapedBase}\\.segment-(\\d{12})-(\\d{12})$`,
  ).exec(file);
  if (!match) {
    return undefined;
  }
  const firstId = Number(match[1]);
  const lastId = Number(match[2]);
  if (
    !Number.isSafeInteger(firstId) ||
    !Number.isSafeInteger(lastId) ||
    firstId <= 0 ||
    lastId < firstId
  ) {
    return undefined;
  }
  return {
    file,
    firstId,
    lastId,
    count: lastId - firstId + 1,
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms do not allow fsync on directory handles. The file itself
    // has already been synced, so this remains the strongest portable result.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function durableWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function durableAppend(
  targetPath: string,
  content: string,
): Promise<void> {
  const handle = await open(targetPath, "a", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class RemoteEventJournal {
  private readonly events: RemoteJournalEvent[] = [];
  private nextId = 1;
  private readonly waiters = new Set<() => void>();
  private persistenceChain: Promise<void> = Promise.resolve();
  private appendChain: Promise<void> = Promise.resolve();
  private manifest: JournalManifest = {
    version: JOURNAL_FORMAT_VERSION,
    epoch: randomUUID(),
    segments: [],
  };
  private activeCount = 0;
  private activeFirstId: number | undefined;
  private lastFlushAt: number | undefined;

  public constructor(
    private readonly journalPath: string,
    private readonly encryptionKey?: string,
  ) {}

  private get manifestPath(): string {
    return `${this.journalPath}.manifest`;
  }

  private get snapshotPath(): string {
    return `${this.journalPath}.snapshot`;
  }

  public async initialize(): Promise<void> {
    await this.appendChain;
    await this.persistenceChain;
    await mkdir(path.dirname(this.journalPath), {
      recursive: true,
      mode: 0o700,
    });
    this.events.splice(0);
    this.nextId = 1;
    this.activeCount = 0;
    this.activeFirstId = undefined;
    this.manifest = await this.loadManifest();
    const rows: RemoteJournalEvent[] = [];
    for (const segment of this.manifest.segments) {
      const segmentPath = path.join(
        path.dirname(this.journalPath),
        segment.file,
      );
      let segmentRows: RemoteJournalEvent[];
      try {
        segmentRows = await this.readJournalFile(segmentPath, false);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          const quarantinePath = await this.quarantine(this.manifestPath);
          throw new RemoteJournalCorruptionError(
            `The remote journal segment ${segment.file} is missing. The manifest was preserved at ${quarantinePath}.`,
            quarantinePath,
          );
        }
        throw error;
      }
      if (
        segmentRows.length !== segment.count ||
        segmentRows[0]?.id !== segment.firstId ||
        segmentRows.at(-1)?.id !== segment.lastId
      ) {
        const quarantinePath = await this.quarantine(this.manifestPath);
        throw new RemoteJournalCorruptionError(
          `The remote journal manifest does not match segment ${segment.file}. The manifest was preserved at ${quarantinePath}.`,
          quarantinePath,
        );
      }
      rows.push(...segmentRows);
    }
    const activeRows = await this.readJournalFile(this.journalPath, true);
    rows.push(...activeRows);

    const uniqueRows = new Map<number, RemoteJournalEvent>();
    let needsRepair = false;
    for (const event of rows) {
      if (uniqueRows.has(event.id)) {
        needsRepair = true;
        continue;
      }
      uniqueRows.set(event.id, event);
    }
    const ordered = [...uniqueRows.values()].sort(
      (left, right) => left.id - right.id,
    );
    if (ordered.some((event, index) => event !== rows[index])) {
      needsRepair = true;
    }
    const gapIndex = ordered.findIndex(
      (event, index) =>
        index > 0 && event.id !== (ordered[index - 1]?.id ?? 0) + 1,
    );
    if (gapIndex >= 0) {
      const quarantinePath = await this.quarantine(this.journalPath);
      throw new RemoteJournalCorruptionError(
        `The remote journal has a missing event before record ${String(
          gapIndex + 1,
        )}. The active journal was preserved at ${quarantinePath}.`,
        quarantinePath,
      );
    }
    const retained = ordered.slice(-MAX_RETAINED_EVENTS);
    this.events.push(...retained);
    this.nextId = (retained.at(-1)?.id ?? 0) + 1;
    this.activeCount = activeRows.length;
    this.activeFirstId = activeRows.at(0)?.id;

    if (
      needsRepair ||
      ordered.length !== retained.length ||
      activeRows.length > SEGMENT_EVENT_LIMIT
    ) {
      await this.rebuild(retained);
    } else {
      await this.ensureActiveFile();
      await this.persistManifest();
    }
  }

  public async append(
    type: RemoteJournalEvent["type"],
    payload: unknown,
  ): Promise<RemoteJournalEvent> {
    let appended: RemoteJournalEvent | undefined;
    const pending = this.appendChain.then(async () => {
      appended = await this.appendNow(type, payload);
    });
    this.appendChain = pending.catch(() => undefined);
    await pending;
    if (!appended) {
      throw new Error("The remote journal append did not complete.");
    }
    return appended;
  }

  private async appendNow(
    type: RemoteJournalEvent["type"],
    payload: unknown,
  ): Promise<RemoteJournalEvent> {
    const event: RemoteJournalEvent = structuredClone({
      id: this.nextId,
      type,
      createdAt: Date.now(),
      payload,
    } satisfies RemoteJournalEvent);
    await this.persist(async () => {
      await durableAppend(
        this.journalPath,
        `${this.serialize(event)}\n`,
      );
      this.lastFlushAt = Date.now();
    });
    this.nextId += 1;
    this.events.push(event);
    this.activeFirstId ??= event.id;
    this.activeCount += 1;
    if (this.events.length > MAX_RETAINED_EVENTS) {
      this.events.splice(
        0,
        this.events.length - MAX_RETAINED_EVENTS,
      );
    }
    if (this.activeCount >= SEGMENT_EVENT_LIMIT) {
      await this.rotateActiveSegment();
    }
    for (const resolve of this.waiters) {
      resolve();
    }
    this.waiters.clear();
    return structuredClone(event);
  }

  public epoch(): string {
    return this.manifest.epoch;
  }

  public earliestId(): number {
    return this.events.at(0)?.id ?? this.nextId;
  }

  public latestId(): number {
    return this.nextId - 1;
  }

  public window(
    after: number,
    limit = DEFAULT_PAGE_SIZE,
  ): RemoteJournalWindow {
    const cursor = Number.isSafeInteger(after) ? Math.max(0, after) : 0;
    const earliestEventId = this.earliestId();
    const latestEventId = this.latestId();
    const gap =
      latestEventId > 0 &&
      cursor < earliestEventId - 1;
    const pageSize = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(limit, 1_000))
      : DEFAULT_PAGE_SIZE;
    return {
      epoch: this.manifest.epoch,
      earliestEventId,
      latestEventId,
      gap,
      events: gap
        ? []
        : structuredClone(
            this.events
              .filter((event) => event.id > cursor)
              .slice(0, pageSize),
          ),
    };
  }

  public since(id: number, limit = DEFAULT_PAGE_SIZE): RemoteJournalEvent[] {
    return this.window(id, limit).events;
  }

  public async waitSince(
    id: number,
    timeoutMs: number,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<RemoteJournalWindow> {
    const existing = this.window(id, limit);
    if (existing.events.length > 0 || existing.gap || timeoutMs <= 0) {
      return existing;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(onReady);
        resolve();
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        this.waiters.delete(onReady);
        resolve();
      };
      this.waiters.add(onReady);
    });
    return this.window(id, limit);
  }

  public async saveSnapshot<T>(
    payload: T,
    throughEventId = this.latestId(),
  ): Promise<RemoteJournalSnapshot<T>> {
    if (
      !Number.isSafeInteger(throughEventId) ||
      throughEventId < 0 ||
      throughEventId > this.latestId()
    ) {
      throw new Error(
        "The remote snapshot cursor must identify a durable journal event.",
      );
    }
    const snapshot: RemoteJournalSnapshot<T> = {
      epoch: this.manifest.epoch,
      throughEventId,
      createdAt: Date.now(),
      payload,
    };
    await this.persist(() =>
      durableWrite(this.snapshotPath, this.serializeValue(snapshot)),
    );
    this.lastFlushAt = Date.now();
    return snapshot;
  }

  public async loadSnapshot<T>(): Promise<RemoteJournalSnapshot<T> | undefined> {
    let source: string;
    try {
      source = await readFile(this.snapshotPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    try {
      const value = this.deserializeValue(source) as Partial<
        RemoteJournalSnapshot<T>
      >;
      if (
        value.epoch !== this.manifest.epoch ||
        !Number.isSafeInteger(value.throughEventId) ||
        (value.throughEventId ?? -1) < 0 ||
        (value.throughEventId ?? Number.MAX_SAFE_INTEGER) > this.latestId() ||
        typeof value.createdAt !== "number" ||
        !Number.isFinite(value.createdAt) ||
        !("payload" in value)
      ) {
        throw new Error("Snapshot metadata is invalid.");
      }
      return value as RemoteJournalSnapshot<T>;
    } catch (error) {
      const quarantinePath = await this.quarantine(this.snapshotPath);
      throw new RemoteJournalCorruptionError(
        `The encrypted remote snapshot is damaged or cannot be decrypted: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        quarantinePath,
      );
    }
  }

  public async flush(): Promise<void> {
    await this.appendChain;
    await this.persistenceChain;
  }

  public async stats(): Promise<RemoteJournalStats> {
    const files = [
      ...this.manifest.segments.map((segment) =>
        path.join(path.dirname(this.journalPath), segment.file),
      ),
      this.journalPath,
    ];
    const sizes = await Promise.all(
      files.map(async (filePath) => {
        try {
          return (await stat(filePath)).size;
        } catch {
          return 0;
        }
      }),
    );
    return {
      epoch: this.manifest.epoch,
      earliestEventId: this.earliestId(),
      latestEventId: this.latestId(),
      retainedEvents: this.events.length,
      segmentCount: this.manifest.segments.length + 1,
      bytes: sizes.reduce((total, size) => total + size, 0),
      lastFlushAt: this.lastFlushAt,
    };
  }

  public async reset(): Promise<void> {
    const pending = this.appendChain.then(() => this.resetNow());
    this.appendChain = pending.catch(() => undefined);
    await pending;
  }

  private async resetNow(): Promise<void> {
    const segments = [...this.manifest.segments];
    await this.persist(async () => {
      this.manifest = {
        version: JOURNAL_FORMAT_VERSION,
        epoch: randomUUID(),
        segments: [],
      };
      await this.persistManifestNow();
      await durableWrite(this.journalPath, "");
      await unlink(this.snapshotPath).catch((error) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
      for (const segment of segments) {
        await unlink(
          path.join(path.dirname(this.journalPath), segment.file),
        ).catch((error) => {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
      this.lastFlushAt = Date.now();
    });
    this.events.splice(0);
    this.nextId = 1;
    this.activeCount = 0;
    this.activeFirstId = undefined;
  }

  private async loadManifest(): Promise<JournalManifest> {
    let source: string;
    try {
      source = await readFile(this.manifestPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const discovered = await this.discoverSegments();
        return {
          version: JOURNAL_FORMAT_VERSION,
          epoch: randomUUID(),
          segments: discovered,
        };
      }
      throw error;
    }
    try {
      const value = JSON.parse(source) as unknown;
      if (!isManifest(value)) {
        throw new Error("Manifest shape is invalid.");
      }
      const manifest = structuredClone(value);
      manifest.segments.sort((left, right) => left.firstId - right.firstId);
      const listed = new Set(manifest.segments.map((segment) => segment.file));
      let expectedFirst = (manifest.segments.at(-1)?.lastId ?? 0) + 1;
      for (const segment of await this.discoverSegments()) {
        if (listed.has(segment.file) || segment.firstId !== expectedFirst) {
          continue;
        }
        manifest.segments.push(segment);
        listed.add(segment.file);
        expectedFirst = segment.lastId + 1;
      }
      return manifest;
    } catch (error) {
      const quarantinePath = await this.quarantine(this.manifestPath);
      throw new RemoteJournalCorruptionError(
        `The remote journal manifest is damaged: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        quarantinePath,
      );
    }
  }

  private async discoverSegments(): Promise<JournalSegment[]> {
    return (
      await readdir(path.dirname(this.journalPath)).catch(
        () => [] as string[],
      )
    )
      .map((file) => segmentFromFilename(this.journalPath, file))
      .filter((segment): segment is JournalSegment => Boolean(segment))
      .sort((left, right) => left.firstId - right.firstId);
  }

  private async readJournalFile(
    filePath: string,
    allowMissing: boolean,
  ): Promise<RemoteJournalEvent[]> {
    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch (error) {
      if (allowMissing && isNodeError(error) && error.code === "ENOENT") {
        await durableWrite(filePath, "");
        return [];
      }
      throw error;
    }
    const lines = source.split("\n");
    const rows: RemoteJournalEvent[] = [];
    let invalidLine: number | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }
      try {
        const value = this.deserialize(line);
        if (!isEvent(value)) {
          throw new Error("Event shape is invalid.");
        }
        rows.push(value);
      } catch {
        invalidLine = index;
        break;
      }
    }
    if (invalidLine === undefined) {
      return rows;
    }
    const quarantinePath = await this.quarantine(filePath);
    const trailingPartial =
      invalidLine === lines.length - 1 && !source.endsWith("\n");
    if (trailingPartial) {
      await durableWrite(
        filePath,
        rows.length > 0
          ? `${rows.map((event) => this.serialize(event)).join("\n")}\n`
          : "",
      );
      return rows;
    }
    throw new RemoteJournalCorruptionError(
      `The encrypted remote journal is damaged or cannot be decrypted at record ${String(
        invalidLine + 1,
      )}. The original was preserved at ${quarantinePath}.`,
      quarantinePath,
    );
  }

  private async ensureActiveFile(): Promise<void> {
    try {
      await stat(this.journalPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await durableWrite(this.journalPath, "");
        return;
      }
      throw error;
    }
  }

  private async rotateActiveSegment(): Promise<void> {
    if (
      this.activeCount === 0 ||
      this.activeFirstId === undefined
    ) {
      return;
    }
    await this.persist(async () => {
      const lastId = this.latestId();
      const segmentFile = `${path.basename(
        this.journalPath,
      )}.segment-${String(this.activeFirstId).padStart(12, "0")}-${String(
        lastId,
      ).padStart(12, "0")}`;
      const segmentPath = path.join(
        path.dirname(this.journalPath),
        segmentFile,
      );
      await rename(this.journalPath, segmentPath);
      await durableWrite(this.journalPath, "");
      this.manifest.segments.push({
        file: segmentFile,
        firstId: this.activeFirstId ?? lastId,
        lastId,
        count: this.activeCount,
      });
      const removable = this.trimSegments();
      await this.persistManifestNow();
      for (const segment of removable) {
        await unlink(
          path.join(path.dirname(this.journalPath), segment.file),
        ).catch((error) => {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
      this.lastFlushAt = Date.now();
    });
    this.activeCount = 0;
    this.activeFirstId = undefined;
  }

  private trimSegments(): JournalSegment[] {
    const earliestRetained = this.events.at(0)?.id ?? this.nextId;
    const removable = this.manifest.segments.filter(
      (segment) => segment.lastId < earliestRetained,
    );
    this.manifest.segments = this.manifest.segments.filter(
      (segment) => segment.lastId >= earliestRetained,
    );
    return removable;
  }

  private async rebuild(events: readonly RemoteJournalEvent[]): Promise<void> {
    const existingSegments = [...this.manifest.segments];
    await this.persist(async () => {
      this.manifest.segments = [];
      const activeEvents = events.slice(-SEGMENT_EVENT_LIMIT);
      const sealedEvents = events.slice(0, -activeEvents.length || undefined);
      for (let index = 0; index < sealedEvents.length; index += SEGMENT_EVENT_LIMIT) {
        const chunk = sealedEvents.slice(index, index + SEGMENT_EVENT_LIMIT);
        const first = chunk[0];
        const last = chunk.at(-1);
        if (!first || !last) {
          continue;
        }
        const file = `${path.basename(
          this.journalPath,
        )}.segment-${String(first.id).padStart(12, "0")}-${String(
          last.id,
        ).padStart(12, "0")}`;
        await durableWrite(
          path.join(path.dirname(this.journalPath), file),
          `${chunk.map((event) => this.serialize(event)).join("\n")}\n`,
        );
        this.manifest.segments.push({
          file,
          firstId: first.id,
          lastId: last.id,
          count: chunk.length,
        });
      }
      await durableWrite(
        this.journalPath,
        activeEvents.length > 0
          ? `${activeEvents
              .map((event) => this.serialize(event))
              .join("\n")}\n`
          : "",
      );
      await this.persistManifestNow();
      const retainedFiles = new Set(
        this.manifest.segments.map((segment) => segment.file),
      );
      for (const segment of existingSegments) {
        if (retainedFiles.has(segment.file)) {
          continue;
        }
        await unlink(
          path.join(path.dirname(this.journalPath), segment.file),
        ).catch((error) => {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
      this.lastFlushAt = Date.now();
      this.activeCount = activeEvents.length;
      this.activeFirstId = activeEvents.at(0)?.id;
    });
  }

  private async persistManifest(): Promise<void> {
    await this.persist(() => this.persistManifestNow());
  }

  private async persistManifestNow(): Promise<void> {
    await durableWrite(
      this.manifestPath,
      `${JSON.stringify(this.manifest)}\n`,
    );
  }

  private async quarantine(filePath: string): Promise<string> {
    const quarantinePath = `${filePath}.corrupt-${String(Date.now())}-${randomUUID()}`;
    await copyFile(filePath, quarantinePath);
    return quarantinePath;
  }

  private async persist(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistenceChain.then(operation);
    this.persistenceChain = pending.catch(() => undefined);
    await pending;
  }

  private serialize(event: RemoteJournalEvent): string {
    return this.serializeValue(event);
  }

  private deserialize(line: string): unknown {
    return this.deserializeValue(line);
  }

  private serializeValue(value: unknown): string {
    return this.encryptionKey
      ? encryptLocalStore(this.encryptionKey, value)
      : JSON.stringify(value);
  }

  private deserializeValue(source: string): unknown {
    return this.encryptionKey
      ? decryptLocalStore<unknown>(this.encryptionKey, source)
      : (JSON.parse(source) as unknown);
  }
}
