import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairModelHopTranscriptVisibility } from "../../src/remote/transcriptIntegrity.js";

const TARGET_SESSION = "03c1ba1d-8fe2-4a1d-beb5-c35e4a323c49";
const OTHER_SESSION = "ccdd0636-9430-4202-8e73-7c7bc39d69ac";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(
  content: string,
): Promise<{
  root: string;
  transcriptPath: string;
  backupDirectory: string;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "modelhop-transcript-visibility-"),
  );
  temporaryDirectories.push(root);
  const transcriptDirectory = path.join(root, "projects", "workspace");
  const transcriptPath = path.join(
    transcriptDirectory,
    `${TARGET_SESSION}.jsonl`,
  );
  const backupDirectory = path.join(root, "backups");
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(transcriptPath, content, "utf8");
  return { root, transcriptPath, backupDirectory };
}

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

describe("ModelHop remote transcript visibility", () => {
  it("repairs sdk-ts rows into an IDE-visible transcript and preserves a byte-exact backup", async () => {
    const original =
      line({
        type: "user",
        sessionId: TARGET_SESSION,
        entrypoint: "sdk-ts",
        cwd: "/workspace",
        message: { role: "user", content: "Continue remotely" },
        preserved: { nested: [1, "two", false] },
      }) +
      line({
        type: "assistant",
        sessionId: TARGET_SESSION,
        entrypoint: "sdk-ts",
        cwd: "/workspace",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working" }],
        },
      });
    const { transcriptPath, backupDirectory } =
      await fixture(original);

    const result = await repairModelHopTranscriptVisibility(
      transcriptPath,
      TARGET_SESSION,
      { backupDirectory },
    );

    expect(result).toMatchObject({
      changed: true,
      records: 2,
      sessionRecords: 2,
      repairedEntrypoints: 2,
      visibleToClaudeIde: true,
    });
    const repaired = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((record) => JSON.parse(record) as Record<string, unknown>);
    expect(repaired).toEqual([
      {
        type: "user",
        sessionId: TARGET_SESSION,
        entrypoint: "claude-vscode",
        cwd: "/workspace",
        message: { role: "user", content: "Continue remotely" },
        preserved: { nested: [1, "two", false] },
      },
      {
        type: "assistant",
        sessionId: TARGET_SESSION,
        entrypoint: "claude-vscode",
        cwd: "/workspace",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working" }],
        },
      },
    ]);
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath ?? "", "utf8")).toBe(
      original,
    );
  });

  it("fails closed when any session-bearing record belongs to another session", async () => {
    const original =
      line({
        type: "user",
        sessionId: TARGET_SESSION,
        entrypoint: "sdk-ts",
      }) +
      line({
        type: "assistant",
        sessionId: OTHER_SESSION,
        entrypoint: "sdk-ts",
      });
    const { transcriptPath, backupDirectory } =
      await fixture(original);

    await expect(
      repairModelHopTranscriptVisibility(
        transcriptPath,
        TARGET_SESSION,
        { backupDirectory },
      ),
    ).rejects.toThrow(/different session ID/);
    expect(await readFile(transcriptPath, "utf8")).toBe(original);
    await expect(readdir(backupDirectory)).rejects.toThrow();
  });

  it("leaves an already IDE-visible transcript untouched without making a backup", async () => {
    const original = line({
      type: "user",
      sessionId: TARGET_SESSION,
      entrypoint: "claude-vscode",
      message: { role: "user", content: "Already visible" },
    });
    const { transcriptPath, backupDirectory } =
      await fixture(original);

    const result = await repairModelHopTranscriptVisibility(
      transcriptPath,
      TARGET_SESSION,
      { backupDirectory },
    );

    expect(result).toEqual({
      changed: false,
      records: 1,
      sessionRecords: 1,
      repairedEntrypoints: 0,
      visibleToClaudeIde: true,
    });
    expect(await readFile(transcriptPath, "utf8")).toBe(original);
    await expect(readdir(backupDirectory)).rejects.toThrow();
  });

  it("rejects malformed JSONL without overwriting or backing up the transcript", async () => {
    const original = `${line({
      type: "user",
      sessionId: TARGET_SESSION,
      entrypoint: "sdk-ts",
    })}{not valid json}\n`;
    const { transcriptPath, backupDirectory } =
      await fixture(original);

    await expect(
      repairModelHopTranscriptVisibility(
        transcriptPath,
        TARGET_SESSION,
        { backupDirectory },
      ),
    ).rejects.toThrow(/malformed/);
    expect(await readFile(transcriptPath, "utf8")).toBe(original);
    await expect(readdir(backupDirectory)).rejects.toThrow();
  });
});
