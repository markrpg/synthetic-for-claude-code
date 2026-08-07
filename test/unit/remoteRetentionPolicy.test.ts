import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteRetentionManager,
  RemoteRetentionManifestError,
  type RemoteRetentionPolicy,
} from "../../src/remote/retentionPolicy.js";

const temporaryDirectories: string[] = [];
const tinyPolicy: RemoteRetentionPolicy = {
  successfulAttachmentMaxAgeMs: 1_000,
  successfulAttachmentMaxBytes: 8,
  confirmedRecoveryBackupMaxAgeMs: 2_000,
  confirmedRecoveryBackupMaxBytes: 8,
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "modelhop-retention-test-"),
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

async function pathExists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(
    () => true,
    () => false,
  );
}

describe("Remote retention policy", () => {
  it("never deletes an unconfirmed recovery backup", async () => {
    const directory = await temporaryDirectory();
    const backupRoot = path.join(directory, ".modelhop-backups");
    const backup = path.join(backupRoot, "session-old.jsonl.bak");
    await mkdir(backupRoot);
    await writeFile(backup, "recovery-data", "utf8");
    const manager = new RemoteRetentionManager(
      path.join(directory, "retention.json"),
      {
        ...tinyPolicy,
        confirmedRecoveryBackupMaxAgeMs: 0,
        confirmedRecoveryBackupMaxBytes: 0,
      },
    );
    await manager.recordRecoveryBackups(backupRoot, "session-1");

    const result = await manager.cleanup(1_000_000);

    expect(result.deleted).toEqual([]);
    expect(result.retainedUnconfirmed).toBe(1);
    expect(await readFile(backup, "utf8")).toBe("recovery-data");
  });

  it("expires only a desktop-confirmed successful session", async () => {
    const directory = await temporaryDirectory();
    const attachmentRoot = path.join(
      directory,
      ".modelhop-remote",
    );
    const sessionDirectory = path.join(attachmentRoot, "lease-1");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(sessionDirectory, "photo.png"), "data");
    const manager = new RemoteRetentionManager(
      path.join(directory, "retention.json"),
      tinyPolicy,
    );
    manager.registerOwnedRoot(
      "attachment-directory",
      attachmentRoot,
    );
    await manager.recordArtifact({
      kind: "attachment-directory",
      path: sessionDirectory,
      sessionCorrelationId: "session-1",
      createdAt: 1,
    });
    await manager.confirmSuccessfulSession("session-1", 10);

    const result = await manager.cleanup(1_011);

    expect(result.deleted).toEqual([
      expect.objectContaining({
        kind: "attachment-directory",
        relativePath: "lease-1",
        reason: "age",
      }),
    ]);
    expect(await pathExists(sessionDirectory)).toBe(false);
  });

  it("enforces the byte ceiling from oldest confirmed material", async () => {
    const directory = await temporaryDirectory();
    const backupRoot = path.join(directory, ".modelhop-backups");
    await mkdir(backupRoot);
    const older = path.join(backupRoot, "session-a.jsonl.bak");
    const newer = path.join(backupRoot, "session-b.jsonl.bak");
    await writeFile(older, "123456", "utf8");
    await writeFile(newer, "abcdef", "utf8");
    const manager = new RemoteRetentionManager(
      path.join(directory, "retention.json"),
      tinyPolicy,
    );
    manager.registerOwnedRoot("recovery-backup", backupRoot);
    await manager.recordArtifact({
      kind: "recovery-backup",
      path: older,
      sessionCorrelationId: "session-a",
      createdAt: 1,
    });
    await manager.recordArtifact({
      kind: "recovery-backup",
      path: newer,
      sessionCorrelationId: "session-b",
      createdAt: 2,
    });
    await manager.confirmSuccessfulSession("session-a", 100);
    await manager.confirmSuccessfulSession("session-b", 100);

    const result = await manager.cleanup(101);

    expect(result.deleted).toEqual([
      expect.objectContaining({
        relativePath: "session-a.jsonl.bak",
        reason: "byte-cap",
      }),
    ]);
    expect(await pathExists(older)).toBe(false);
    expect(await pathExists(newer)).toBe(true);
  });

  it("rejects artifacts outside registered ModelHop-owned roots", async () => {
    const directory = await temporaryDirectory();
    const ownedRoot = path.join(directory, ".modelhop-remote");
    const outside = path.join(directory, "user-project.txt");
    await mkdir(ownedRoot);
    await writeFile(outside, "never delete", "utf8");
    const manager = new RemoteRetentionManager(
      path.join(directory, "retention.json"),
      tinyPolicy,
    );
    manager.registerOwnedRoot("recovery-backup", ownedRoot);

    await expect(
      manager.recordArtifact({
        kind: "recovery-backup",
        path: outside,
        sessionCorrelationId: "session-1",
      }),
    ).rejects.toThrow(/outside every registered/u);
    expect(await readFile(outside, "utf8")).toBe("never delete");
  });

  it("fails closed on damaged metadata without touching recovery data", async () => {
    const directory = await temporaryDirectory();
    const backupRoot = path.join(directory, ".modelhop-backups");
    const backup = path.join(backupRoot, "session.jsonl.bak");
    const manifest = path.join(directory, "retention.json");
    await mkdir(backupRoot);
    await writeFile(backup, "safe", "utf8");
    await writeFile(manifest, "{damaged", "utf8");
    const manager = new RemoteRetentionManager(manifest, tinyPolicy);
    manager.registerOwnedRoot("recovery-backup", backupRoot);

    await expect(manager.cleanup()).rejects.toBeInstanceOf(
      RemoteRetentionManifestError,
    );
    expect(await readFile(backup, "utf8")).toBe("safe");
  });

  it("does not follow a retained path that escapes through a symlink", async () => {
    const directory = await temporaryDirectory();
    const ownedRoot = path.join(directory, ".modelhop-remote");
    const outside = path.join(directory, "outside");
    const link = path.join(ownedRoot, "lease-link");
    await mkdir(ownedRoot);
    await mkdir(outside);
    await writeFile(path.join(outside, "user.txt"), "safe", "utf8");
    await symlink(outside, link);
    const manager = new RemoteRetentionManager(
      path.join(directory, "retention.json"),
      tinyPolicy,
    );
    manager.registerOwnedRoot("attachment-directory", ownedRoot);
    await manager.recordArtifact({
      kind: "attachment-directory",
      path: link,
      sessionCorrelationId: "session-1",
      createdAt: 1,
    });
    await manager.confirmSuccessfulSession("session-1", 1);

    const result = await manager.cleanup(10_000);

    expect(result.rejectedUnsafeEntries).toBe(1);
    expect(await readFile(path.join(outside, "user.txt"), "utf8")).toBe(
      "safe",
    );
  });
});
