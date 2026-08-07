import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  resolveWorkspaceFile,
  validateReadableFile,
} from "../../src/remote/pathPolicy.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "modelhop-path-test-"),
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

describe("remote workspace path policy", () => {
  it("accepts regular files inside the workspace", async () => {
    const workspace = await temporaryDirectory();
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "app.ts"), "ok");

    await expect(
      validateReadableFile(workspace, "src/app.ts"),
    ).resolves.toMatchObject({ size: 2 });
  });

  it("uses a generous bounded default and supports stricter callers", async () => {
    const workspace = await temporaryDirectory();
    const source = path.join(workspace, "preview.log");
    await writeFile(source, Buffer.alloc(768 * 1024, 0x61));

    await expect(
      validateReadableFile(workspace, "preview.log"),
    ).resolves.toMatchObject({ size: 768 * 1024 });
    expect(MAX_REMOTE_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_REMOTE_IMAGE_BYTES).toBe(25 * 1024 * 1024);
    await expect(
      validateReadableFile(workspace, "preview.log", 512 * 1024),
    ).rejects.toThrow("512 KB");
  });

  it("rejects traversal and symlinks escaping the workspace", async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(outside, "secret"), "do not expose");
    await symlink(outside, path.join(workspace, "escaped"));

    await expect(
      resolveWorkspaceFile(workspace, "../secret"),
    ).rejects.toThrow("outside the workspace");
    await expect(
      resolveWorkspaceFile(workspace, "escaped/secret"),
    ).rejects.toThrow("outside the workspace");
  });
});
