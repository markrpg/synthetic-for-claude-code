import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeTranscriptPath,
  transcriptTailSignature,
} from "../../src/remote/transcriptIntegrity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("remote transcript integrity", () => {
  it("derives the forked transcript beside the source transcript", () => {
    expect(
      activeTranscriptPath(
        "/Users/example/.claude/projects/project/source.jsonl",
        "fork-session",
      ),
    ).toBe(
      "/Users/example/.claude/projects/project/fork-session.jsonl",
    );
  });

  it("changes the semantic tail signature when transcript content changes", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "modelhop-transcript-"),
    );
    temporaryDirectories.push(directory);
    const transcript = path.join(directory, "session.jsonl");
    await writeFile(transcript, '{"type":"user","text":"one"}\n');
    const first = await transcriptTailSignature(transcript);
    await writeFile(
      transcript,
      '{"type":"user","text":"one"}\n{"type":"assistant","text":"two"}\n',
    );
    const second = await transcriptTailSignature(transcript);

    expect(first).not.toBe(second);
  });

  it("rejects an empty transcript before hand-back", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "modelhop-transcript-"),
    );
    temporaryDirectories.push(directory);
    const transcript = path.join(directory, "empty.jsonl");
    await writeFile(transcript, "");

    await expect(
      transcriptTailSignature(transcript),
    ).rejects.toThrow(/empty/);
  });
});
