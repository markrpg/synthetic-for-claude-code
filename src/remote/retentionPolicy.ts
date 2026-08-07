import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * ModelHop Remote retention defaults:
 *
 * - Attachments from a desktop-confirmed successful session: 7 days, with a
 *   512 MiB aggregate ceiling.
 * - Recovery backups explicitly confirmed by a successful exact-session
 *   hand-back: 30 days, with a 1 GiB aggregate ceiling.
 * - Pending, failed, unknown, or unconfirmed recovery material: retained
 *   indefinitely. It is never an automatic-cleanup candidate.
 */
export const DEFAULT_REMOTE_RETENTION_POLICY = Object.freeze({
  successfulAttachmentMaxAgeMs: 7 * DAY_MS,
  successfulAttachmentMaxBytes: 512 * 1024 * 1024,
  confirmedRecoveryBackupMaxAgeMs: 30 * DAY_MS,
  confirmedRecoveryBackupMaxBytes: 1024 * 1024 * 1024,
});

export type RemoteRetainedArtifactKind =
  | "attachment-directory"
  | "recovery-backup";

export interface RemoteRetentionPolicy {
  successfulAttachmentMaxAgeMs: number;
  successfulAttachmentMaxBytes: number;
  confirmedRecoveryBackupMaxAgeMs: number;
  confirmedRecoveryBackupMaxBytes: number;
}

interface OwnedRoot {
  id: string;
  path: string;
  kind: RemoteRetainedArtifactKind;
}

interface RetentionEntry {
  id: string;
  rootId: string;
  relativePath: string;
  kind: RemoteRetainedArtifactKind;
  sessionCorrelationId: string;
  createdAt: number;
  confirmedAt?: number;
  outcome: "unconfirmed" | "confirmed-success";
}

interface RetentionManifest {
  version: 1;
  updatedAt: number;
  entries: RetentionEntry[];
}

export interface RemoteRetentionCleanupResult {
  deleted: Array<{
    kind: RemoteRetainedArtifactKind;
    relativePath: string;
    bytes: number;
    reason: "age" | "byte-cap";
  }>;
  retainedUnconfirmed: number;
  unavailableRoots: number;
  rejectedUnsafeEntries: number;
  bytesFreed: number;
}

export class RemoteRetentionManifestError extends Error {}

function safeRelativePath(root: string, candidate: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Remote retention accepts only descendants of a ModelHop-owned root.",
    );
  }
  return relative;
}

function rootId(
  kind: RemoteRetainedArtifactKind,
  rootPath: string,
): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(path.resolve(rootPath))
    .digest("hex")
    .slice(0, 24);
}

function validEntry(value: unknown): value is RetentionEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<RetentionEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.rootId === "string" &&
    typeof entry.relativePath === "string" &&
    entry.relativePath.length > 0 &&
    !path.isAbsolute(entry.relativePath) &&
    entry.relativePath !== ".." &&
    !entry.relativePath.startsWith(`..${path.sep}`) &&
    (entry.kind === "attachment-directory" ||
      entry.kind === "recovery-backup") &&
    typeof entry.sessionCorrelationId === "string" &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    (entry.confirmedAt === undefined ||
      (typeof entry.confirmedAt === "number" &&
        Number.isFinite(entry.confirmedAt))) &&
    (entry.outcome === "unconfirmed" ||
      entry.outcome === "confirmed-success")
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function byteSize(candidate: string): Promise<number> {
  const details = await lstat(candidate);
  if (details.isSymbolicLink()) {
    throw new Error("Symbolic links are not retention candidates.");
  }
  if (!details.isDirectory()) {
    return details.size;
  }
  let total = 0;
  for (const entry of await readdir(candidate, {
    withFileTypes: true,
  })) {
    const child = path.join(candidate, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    total += entry.isDirectory()
      ? await byteSize(child)
      : (await lstat(child)).size;
  }
  return total;
}

export class RemoteRetentionManager {
  private readonly roots = new Map<string, OwnedRoot>();
  private manifest: RetentionManifest | undefined;

  public constructor(
    private readonly manifestPath: string,
    private readonly policy: RemoteRetentionPolicy =
      DEFAULT_REMOTE_RETENTION_POLICY,
  ) {}

  public registerOwnedRoot(
    kind: RemoteRetainedArtifactKind,
    ownedRootPath: string,
  ): string {
    if (!path.isAbsolute(ownedRootPath)) {
      throw new Error("A ModelHop-owned retention root must be absolute.");
    }
    const normalized = path.resolve(ownedRootPath);
    const id = rootId(kind, normalized);
    this.roots.set(id, { id, path: normalized, kind });
    return id;
  }

  public async recordArtifact(input: {
    kind: RemoteRetainedArtifactKind;
    path: string;
    sessionCorrelationId: string;
    createdAt?: number;
  }): Promise<void> {
    const match = [...this.roots.values()].find(
      (root) =>
        root.kind === input.kind &&
        (() => {
          try {
            safeRelativePath(root.path, input.path);
            return true;
          } catch {
            return false;
          }
        })(),
    );
    if (!match) {
      throw new Error(
        "The retention artifact is outside every registered ModelHop-owned root.",
      );
    }
    const manifest = await this.load();
    const relativePath = safeRelativePath(match.path, input.path);
    const existing = manifest.entries.find(
      (entry) =>
        entry.rootId === match.id &&
        entry.relativePath === relativePath &&
        entry.kind === input.kind,
    );
    if (existing) {
      if (
        existing.sessionCorrelationId !== input.sessionCorrelationId
      ) {
        throw new Error(
          "A retained artifact cannot be reassigned to another session.",
        );
      }
      return;
    }
    manifest.entries.push({
      id: randomUUID(),
      rootId: match.id,
      relativePath,
      kind: input.kind,
      sessionCorrelationId: input.sessionCorrelationId,
      createdAt: input.createdAt ?? Date.now(),
      outcome: "unconfirmed",
    });
    await this.save(manifest);
  }

  public async recordRecoveryBackups(
    backupRoot: string,
    sessionCorrelationId: string,
    fileNamePrefixes: readonly string[] = [],
  ): Promise<number> {
    this.registerOwnedRoot("recovery-backup", backupRoot);
    const entries = await readdir(backupRoot, {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    });
    let recorded = 0;
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".bak") ||
        (fileNamePrefixes.length > 0 &&
          !fileNamePrefixes.some((prefix) =>
            entry.name.startsWith(`${prefix}.`),
          ))
      ) {
        continue;
      }
      const candidate = path.join(backupRoot, entry.name);
      const details = await stat(candidate);
      await this.recordArtifact({
        kind: "recovery-backup",
        path: candidate,
        sessionCorrelationId,
        createdAt: details.birthtimeMs || details.mtimeMs,
      });
      recorded += 1;
    }
    return recorded;
  }

  public async confirmSuccessfulSession(
    sessionCorrelationId: string,
    confirmedAt = Date.now(),
  ): Promise<number> {
    const manifest = await this.load();
    let confirmed = 0;
    for (const entry of manifest.entries) {
      if (
        entry.sessionCorrelationId === sessionCorrelationId &&
        entry.outcome === "unconfirmed"
      ) {
        entry.outcome = "confirmed-success";
        entry.confirmedAt = confirmedAt;
        confirmed += 1;
      }
    }
    if (confirmed > 0) {
      await this.save(manifest);
    }
    return confirmed;
  }

  public async cleanup(now = Date.now()): Promise<RemoteRetentionCleanupResult> {
    const manifest = await this.load();
    const result: RemoteRetentionCleanupResult = {
      deleted: [],
      retainedUnconfirmed: manifest.entries.filter(
        (entry) => entry.outcome !== "confirmed-success",
      ).length,
      unavailableRoots: 0,
      rejectedUnsafeEntries: 0,
      bytesFreed: 0,
    };
    const candidates: Array<{
      entry: RetentionEntry;
      target: string;
      bytes: number;
    }> = [];
    const missingEntryIds = new Set<string>();
    for (const entry of manifest.entries) {
      if (entry.outcome !== "confirmed-success") {
        continue;
      }
      const root = this.roots.get(entry.rootId);
      if (!root || root.kind !== entry.kind) {
        result.unavailableRoots += 1;
        continue;
      }
      let target: string;
      try {
        target = path.resolve(root.path, entry.relativePath);
        safeRelativePath(root.path, target);
        const resolvedRoot = await realpath(root.path);
        const resolvedTarget = await realpath(target);
        safeRelativePath(resolvedRoot, resolvedTarget);
        const targetDetails = await lstat(target);
        if (targetDetails.isSymbolicLink()) {
          throw new Error("Symbolic links are unsafe retention targets.");
        }
        candidates.push({
          entry,
          target,
          bytes: await byteSize(target),
        });
      } catch (error) {
        if (isMissing(error)) {
          missingEntryIds.add(entry.id);
        } else {
          result.rejectedUnsafeEntries += 1;
        }
      }
    }

    const deleteIds = new Map<
      string,
      { reason: "age" | "byte-cap"; candidate: (typeof candidates)[number] }
    >();
    for (const candidate of candidates) {
      const maxAge =
        candidate.entry.kind === "attachment-directory"
          ? this.policy.successfulAttachmentMaxAgeMs
          : this.policy.confirmedRecoveryBackupMaxAgeMs;
      if (
        now -
          (candidate.entry.confirmedAt ?? candidate.entry.createdAt) >=
        maxAge
      ) {
        deleteIds.set(candidate.entry.id, {
          reason: "age",
          candidate,
        });
      }
    }

    for (const kind of [
      "attachment-directory",
      "recovery-backup",
    ] as const) {
      const maxBytes =
        kind === "attachment-directory"
          ? this.policy.successfulAttachmentMaxBytes
          : this.policy.confirmedRecoveryBackupMaxBytes;
      const kept = candidates
        .filter(
          (candidate) =>
            candidate.entry.kind === kind &&
            !deleteIds.has(candidate.entry.id),
        )
        .sort(
          (left, right) =>
            left.entry.createdAt - right.entry.createdAt,
        );
      let bytes = kept.reduce(
        (total, candidate) => total + candidate.bytes,
        0,
      );
      for (const candidate of kept) {
        if (bytes <= maxBytes) {
          break;
        }
        deleteIds.set(candidate.entry.id, {
          reason: "byte-cap",
          candidate,
        });
        bytes -= candidate.bytes;
      }
    }

    for (const { reason, candidate } of deleteIds.values()) {
      // `target` has been canonicalized against a registered root, is not the
      // root itself, and is not a symlink. No wildcard or user-provided root
      // is ever passed to recursive removal.
      await rm(candidate.target, { recursive: true, force: false });
      missingEntryIds.add(candidate.entry.id);
      result.deleted.push({
        kind: candidate.entry.kind,
        relativePath: candidate.entry.relativePath,
        bytes: candidate.bytes,
        reason,
      });
      result.bytesFreed += candidate.bytes;
    }

    if (missingEntryIds.size > 0) {
      manifest.entries = manifest.entries.filter(
        (entry) => !missingEntryIds.has(entry.id),
      );
      await this.save(manifest);
    }
    return result;
  }

  public async summary(): Promise<{
    total: number;
    unconfirmed: number;
    confirmed: number;
  }> {
    const manifest = await this.load();
    return {
      total: manifest.entries.length,
      unconfirmed: manifest.entries.filter(
        (entry) => entry.outcome === "unconfirmed",
      ).length,
      confirmed: manifest.entries.filter(
        (entry) => entry.outcome === "confirmed-success",
      ).length,
    };
  }

  private async load(): Promise<RetentionManifest> {
    if (this.manifest) {
      return this.manifest;
    }
    let source: string;
    try {
      source = await readFile(this.manifestPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      this.manifest = { version: 1, updatedAt: Date.now(), entries: [] };
      return this.manifest;
    }
    try {
      const parsed = JSON.parse(source) as Partial<RetentionManifest>;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.entries) ||
        !parsed.entries.every(validEntry)
      ) {
        throw new Error("Invalid retention manifest structure.");
      }
      this.manifest = {
        version: 1,
        updatedAt:
          typeof parsed.updatedAt === "number"
            ? parsed.updatedAt
            : Date.now(),
        entries: parsed.entries,
      };
      return this.manifest;
    } catch (error) {
      throw new RemoteRetentionManifestError(
        "ModelHop retention metadata is damaged. Automatic cleanup was disabled so recovery data remains untouched.",
        { cause: error },
      );
    }
  }

  private async save(manifest: RetentionManifest): Promise<void> {
    const directory = path.dirname(this.manifestPath);
    const temporaryPath = `${this.manifestPath}.${process.pid}-${randomUUID()}.tmp`;
    manifest.updatedAt = Date.now();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      temporaryPath,
      `${JSON.stringify(manifest)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await rename(temporaryPath, this.manifestPath);
    await chmod(this.manifestPath, 0o600);
    this.manifest = manifest;
  }
}
