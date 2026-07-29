import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeProjectDirectoryName,
  ClaudeTranscriptRepairService,
  repairTranscriptContent,
  TranscriptCompatibilityError,
} from "../../src/transcripts/claudeTranscriptRepairService.js";

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}

function contentBlocks(
  record: Record<string, unknown>,
): Record<string, unknown>[] {
  const message = record.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    throw new Error("Expected message content.");
  }
  return (message.content as unknown[]).map((block) => {
    if (!isRecord(block)) {
      throw new Error("Expected a content block.");
    }
    return block;
  });
}

describe("repairTranscriptContent", () => {
  it("repairs linked tool IDs and removes unsigned Synthetic thinking without breaking the branch", () => {
    const source = [
      jsonLine({
        type: "assistant",
        uuid: "thinking-record",
        parentUuid: null,
        message: {
          model: "hf:moonshotai/Kimi-K3",
          content: [
            {
              type: "thinking",
              thinking: "private reasoning",
              signature: "not-an-anthropic-signature",
            },
            {
              type: "redacted_thinking",
              data: "not-an-anthropic-signature",
            },
          ],
        },
      }),
      jsonLine({
        type: "assistant",
        uuid: "tool-record",
        parentUuid: "thinking-record",
        message: {
          model: "hf:moonshotai/Kimi-K3",
          content: [
            {
              type: "tool_use",
              id: "Read:0-example",
              name: "Read",
              input: {},
            },
          ],
        },
      }),
      jsonLine({
        type: "user",
        uuid: "result-record",
        parentUuid: "tool-record",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "Read:0-example",
              content: "result",
            },
          ],
        },
      }),
      jsonLine({
        type: "assistant",
        uuid: "claude-thinking",
        parentUuid: "result-record",
        message: {
          model: "claude-opus-5",
          content: [
            {
              type: "thinking",
              thinking: "opaque",
              signature: "valid-signature",
            },
          ],
        },
      }),
      "malformed line retained",
      "",
    ].join("\n");

    const repair = repairTranscriptContent(source);
    expect(repair).toMatchObject({
      changed: true,
      toolUseIdsRepaired: 1,
      toolResultIdsRepaired: 1,
      thinkingBlocksRemoved: 2,
      assistantRecordsRemoved: 1,
      parentLinksRepaired: 1,
    });

    const lines = repair.content.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    const toolRecord = parseRecord(lines[0] ?? "{}");
    const resultRecord = parseRecord(lines[1] ?? "{}");
    const claudeThinking = parseRecord(lines[2] ?? "{}");
    const repairedToolId = contentBlocks(toolRecord)[0]?.id;
    expect(typeof repairedToolId).toBe("string");
    expect(repairedToolId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(repairedToolId).not.toBe("Read:0-example");
    expect(contentBlocks(resultRecord)[0]?.tool_use_id).toBe(
      repairedToolId,
    );
    expect(toolRecord.parentUuid).toBeNull();
    expect(
      contentBlocks(claudeThinking)[0]?.signature,
    ).toBe("valid-signature");
    expect(lines[3]).toBe("malformed line retained");
  });

  it("leaves compatible transcripts byte-for-byte unchanged", () => {
    const source = `${jsonLine({
      type: "assistant",
      uuid: "tool-record",
      parentUuid: null,
      message: {
        model: "claude-opus-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_valid-123",
            name: "Read",
            input: {},
          },
        ],
      },
    })}\n${jsonLine({
      type: "user",
      uuid: "result-record",
      parentUuid: "tool-record",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_valid-123",
            content: "result",
          },
        ],
      },
    })}\n`;

    expect(repairTranscriptContent(source)).toMatchObject({
      content: source,
      changed: false,
      toolUseIdsRepaired: 0,
      thinkingBlocksRemoved: 0,
    });
  });

  it("repairs server-tool IDs and nested caller references", () => {
    const source = `${jsonLine({
      type: "assistant",
      uuid: "server-record",
      parentUuid: null,
      message: {
        model: "hf:future/Synthetic-Model",
        content: [
          {
            type: "server_tool_use",
            id: "server:0-example",
            name: "code_execution",
            input: {},
          },
          {
            type: "code_execution_tool_result",
            tool_use_id: "server:0-example",
            content: {},
          },
          {
            type: "tool_use",
            id: "client:0-example",
            name: "query_database",
            input: {},
            caller: {
              type: "code_execution",
              tool_id: "server:0-example",
            },
          },
        ],
      },
    })}\n${jsonLine({
      type: "user",
      uuid: "result-record",
      parentUuid: "server-record",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "client:0-example",
            content: "result",
          },
        ],
      },
    })}\n`;

    const repair = repairTranscriptContent(source);
    const assistant = parseRecord(
      repair.content.split("\n")[0] ?? "{}",
    );
    const blocks = contentBlocks(assistant);
    const serverId = blocks[0]?.id;
    const clientId = blocks[2]?.id;

    expect(serverId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(clientId).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(blocks[1]?.tool_use_id).toBe(serverId);
    const caller = blocks[2]?.caller;
    expect(isRecord(caller) ? caller.tool_id : undefined).toBe(
      serverId,
    );
    const result = parseRecord(
      repair.content.split("\n")[1] ?? "{}",
    );
    expect(contentBlocks(result)[0]?.tool_use_id).toBe(clientId);
  });

  it("refuses to guess when tool blocks are malformed or incomplete", () => {
    const malformed = `${jsonLine({
      type: "assistant",
      uuid: "tool-record",
      parentUuid: null,
      message: {
        model: "hf:future/Synthetic-Model",
        content: [
          {
            type: "tool_use",
            id: "tool:0-example",
            name: "invalid tool name",
            input: "not-an-object",
          },
        ],
      },
    })}\n`;

    expect(() => repairTranscriptContent(malformed)).toThrow(
      TranscriptCompatibilityError,
    );
  });

  it("silently repairs incompatible tool names with linked results intact", () => {
    const source = `${jsonLine({
      type: "assistant",
      uuid: "tool-record",
      parentUuid: null,
      message: {
        model: "hf:future/Synthetic-Model",
        content: [
          {
            type: "tool_use",
            id: "toolu_valid",
            name: "mcp:files/read path",
            input: { path: "README.md" },
          },
        ],
      },
    })}\n${jsonLine({
      type: "user",
      uuid: "result-record",
      parentUuid: "tool-record",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_valid",
            content: "result",
          },
        ],
      },
    })}\n`;

    const repair = repairTranscriptContent(source);
    const assistant = parseRecord(
      repair.content.split("\n")[0] ?? "{}",
    );

    expect(repair.changed).toBe(true);
    expect(repair.toolNamesRepaired).toBe(1);
    expect(contentBlocks(assistant)[0]?.name).toMatch(
      /^modelhop_[a-f0-9]{24}$/,
    );
    expect(repair.toolUseIdsRepaired).toBe(0);
    expect(repair.toolResultIdsRepaired).toBe(0);
  });

  it("does not audit unrelated native Anthropic history", () => {
    const interruptedNativeTurn = `${jsonLine({
      type: "assistant",
      uuid: "tool-record",
      parentUuid: null,
      message: {
        model: "claude-opus-5",
        content: [
          {
            type: "tool_use",
            id: "toolu_valid",
            name: "Read",
            input: {},
          },
        ],
      },
    })}\n`;

    expect(
      repairTranscriptContent(interruptedNativeTurn),
    ).toMatchObject({
      content: interruptedNativeTurn,
      changed: false,
    });
  });
});

describe("ClaudeTranscriptRepairService", () => {
  it("atomically repairs current-workspace transcripts and saves a private backup", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "claude-transcript-repair-"),
    );
    try {
      const workspacePath = path.join(root, "My_Workspace");
      const claudeHome = path.join(root, ".claude");
      const projectDirectory = path.join(
        claudeHome,
        "projects",
        claudeProjectDirectoryName(workspacePath),
      );
      const backupRoot = path.join(root, "backups");
      const transcriptPath = path.join(
        projectDirectory,
        "session.jsonl",
      );
      await mkdir(workspacePath, { recursive: true });
      await mkdir(projectDirectory, { recursive: true });
      await writeFile(
        transcriptPath,
        `${jsonLine({
          type: "assistant",
          uuid: "tool-record",
          parentUuid: null,
          message: {
            model: "hf:moonshotai/Kimi-K3",
            content: [
              {
                type: "tool_use",
                id: "Bash:0-example",
                name: "Bash",
                input: {},
              },
            ],
          },
        })}\n${jsonLine({
          type: "user",
          uuid: "result-record",
          parentUuid: "tool-record",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "Bash:0-example",
                content: "result",
              },
            ],
          },
        })}\n`,
      );
      const service = new ClaudeTranscriptRepairService(
        backupRoot,
        claudeHome,
      );

      const summary = await service.repairWorkspaceTranscripts([
        workspacePath,
      ]);

      expect(summary).toMatchObject({
        filesScanned: 1,
        filesChanged: 1,
        toolUseIdsRepaired: 1,
      });
      expect(await readFile(transcriptPath, "utf8")).not.toContain(
        "Bash:0-example",
      );
      const projectBackups = await readdir(
        path.join(
          backupRoot,
          claudeProjectDirectoryName(workspacePath),
        ),
      );
      expect(projectBackups).toHaveLength(1);
      const backup = await readFile(
        path.join(
          backupRoot,
          claudeProjectDirectoryName(workspacePath),
          projectBackups[0] ?? "",
        ),
        "utf8",
      );
      expect(backup).toContain("Bash:0-example");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
