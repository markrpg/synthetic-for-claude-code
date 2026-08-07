import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverWorkspaceSessions,
  loadTranscriptPreview,
} from "../../src/remote/sessionDiscovery.js";
import { claudeProjectDirectoryName } from "../../src/transcripts/claudeTranscriptRepairService.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Claude session discovery", () => {
  it("finds workspace transcripts without loading full history", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "modelhop-session-test-"),
    );
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const claudeHome = path.join(root, "claude");
    const project = path.join(
      claudeHome,
      "projects",
      claudeProjectDirectoryName(workspace),
    );
    await mkdir(workspace);
    await mkdir(project, { recursive: true });
    const transcript = path.join(project, "session-id.jsonl");
    await writeFile(
      transcript,
      [
        JSON.stringify({
          type: "user",
          isMeta: true,
          message: {
            content:
              "[Image: original 2400x900, displayed at 1200x450.]",
          },
        }),
        JSON.stringify({
          type: "user",
          message: { content: "Build the remote feature" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet",
            content: [{ type: "text", text: "Working on it" }],
          },
        }),
      ].join("\n"),
    );

    const sessions = await discoverWorkspaceSessions(
      workspace,
      claudeHome,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-id",
      title: "Build the remote feature",
      model: "claude-sonnet",
      visibleToClaudeIde: true,
    });
    await expect(loadTranscriptPreview(transcript)).resolves.toHaveLength(2);
  });

  it("matches Claude IDE visibility and generated-title precedence", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "modelhop-session-visibility-test-"),
    );
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const claudeHome = path.join(root, "claude");
    const project = path.join(
      claudeHome,
      "projects",
      claudeProjectDirectoryName(workspace),
    );
    await mkdir(workspace);
    await mkdir(project, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(project, "visible-session.jsonl"),
        [
          JSON.stringify({
            type: "ai-title",
            aiTitle: "Generated conversation title",
          }),
          JSON.stringify({
            type: "user",
            entrypoint: "claude-vscode",
            parentUuid: null,
            message: { content: "/ start" },
          }),
        ].join("\n"),
      ),
      writeFile(
        path.join(project, "programmatic-session.jsonl"),
        JSON.stringify({
          type: "user",
          entrypoint: "sdk-ts",
          parentUuid: null,
          message: { content: "Hidden SDK session" },
        }),
      ),
      writeFile(
        path.join(project, "daemon-session.jsonl"),
        JSON.stringify({
          type: "user",
          entrypoint: "claude-vscode",
          parentUuid: null,
          sessionKind: "daemon",
          message: { content: "Hidden daemon session" },
        }),
      ),
    ]);

    const sessions = await discoverWorkspaceSessions(
      workspace,
      claudeHome,
    );
    expect(
      sessions.find(
        (session) => session.sessionId === "visible-session",
      ),
    ).toMatchObject({
      title: "Generated conversation title",
      visibleToClaudeIde: true,
    });
    expect(
      sessions.find(
        (session) => session.sessionId === "programmatic-session",
      )?.visibleToClaudeIde,
    ).toBe(false);
    expect(
      sessions.find(
        (session) => session.sessionId === "daemon-session",
      )?.visibleToClaudeIde,
    ).toBe(false);
  });

  it("omits hidden metadata and consolidates split assistant responses", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "modelhop-session-preview-test-"),
    );
    temporaryDirectories.push(root);
    const transcript = path.join(root, "session.jsonl");
    await writeFile(
      transcript,
      [
        {
          type: "user",
          uuid: "hidden-image-size",
          isMeta: true,
          userType: "external",
          message: {
            role: "user",
            content:
              "[Image: original 2400x900, displayed at 1200x450. Multiply coordinates by 2.]",
          },
        },
        {
          type: "user",
          uuid: "visible-prompt",
          message: { role: "user", content: "Inspect README.md" },
        },
        {
          type: "assistant",
          uuid: "thinking-row",
          message: {
            id: "assistant-response",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Inspecting the file." },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "text-row",
          message: {
            id: "assistant-response",
            role: "assistant",
            content: [
              { type: "text", text: "README.md is available." },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "tool-row",
          message: {
            id: "assistant-response",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-one",
                name: "Read",
                input: { file_path: "README.md" },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "tool-result-row",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-one",
                content: "contents",
              },
            ],
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
    );

    const preview = await loadTranscriptPreview(transcript);
    expect(preview).toHaveLength(3);
    expect(preview[0]).toMatchObject({
      type: "user",
      uuid: "visible-prompt",
    });
    expect(preview[1]).toMatchObject({
      type: "assistant",
      message: {
        id: "assistant-response",
        content: [
          { type: "thinking", thinking: "Inspecting the file." },
          { type: "text", text: "README.md is available." },
          { type: "tool_use", id: "tool-one", name: "Read" },
        ],
      },
    });
    expect(preview[2]).toMatchObject({
      type: "user",
      uuid: "tool-result-row",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-one",
            content: "contents",
          },
        ],
      },
    });
  });

  it("uses provenance to separate controls, operations, and human XML", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "modelhop-session-provenance-test-"),
    );
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const claudeHome = path.join(root, "claude");
    const project = path.join(
      claudeHome,
      "projects",
      claudeProjectDirectoryName(workspace),
    );
    await mkdir(workspace);
    await mkdir(project, { recursive: true });
    const transcript = path.join(project, "provenance.jsonl");
    await writeFile(
      transcript,
      [
        {
          type: "user",
          uuid: "config-envelope",
          timestamp: "2026-08-02T10:00:00.000Z",
          userType: "external",
          lastPrompt:
            "<command-name>/config</command-name><command-message>config</command-message>",
          message: {
            role: "user",
            content:
              "<command-name>/config</command-name><command-message>config</command-message>",
          },
        },
        {
          type: "user",
          uuid: "task-notification",
          timestamp: "2026-08-02T10:00:01.000Z",
          origin: { kind: "task-notification" },
          message: {
            role: "user",
            content: "A background task completed.",
          },
        },
        {
          type: "user",
          uuid: "human-prompt",
          timestamp: "2026-08-02T10:00:02.000Z",
          origin: { kind: "human" },
          message: {
            role: "user",
            content: "Continue the implementation",
          },
        },
        {
          type: "user",
          uuid: "human-xml",
          timestamp: "2026-08-02T10:00:03.000Z",
          origin: { kind: "human" },
          message: {
            role: "user",
            content:
              "<command-name>This is literal human-authored XML</command-name>",
          },
        },
        {
          type: "assistant",
          uuid: "assistant-reply",
          timestamp: "2026-08-02T10:00:04.000Z",
          message: {
            id: "assistant-reply",
            role: "assistant",
            content: [{ type: "text", text: "Continuing now." }],
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
    );

    const sessions = await discoverWorkspaceSessions(
      workspace,
      claudeHome,
    );
    expect(sessions[0]?.title).toBe("Continue the implementation");

    const preview = await loadTranscriptPreview(transcript);
    expect(preview.map((row) => row.uuid)).toEqual([
      "task-notification",
      "human-prompt",
      "human-xml",
      "assistant-reply",
    ]);
    expect(preview[2]).toMatchObject({
      timestamp: "2026-08-02T10:00:03.000Z",
      origin: { kind: "human" },
      message: {
        content:
          "<command-name>This is literal human-authored XML</command-name>",
      },
    });
  });

  it("keeps dialogue when recent history is dominated by tool operations", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "modelhop-session-tool-budget-test-"),
    );
    temporaryDirectories.push(root);
    const transcript = path.join(root, "session.jsonl");
    const rows: Record<string, unknown>[] = [
      {
        type: "user",
        uuid: "prompt-one",
        timestamp: "2026-08-02T11:00:00.000Z",
        origin: { kind: "human" },
        data: { retained: true },
        message: { role: "user", content: "First question" },
      },
      {
        type: "assistant",
        uuid: "response-one",
        timestamp: "2026-08-02T11:00:01.000Z",
        message: {
          id: "response-one",
          role: "assistant",
          content: [{ type: "text", text: "First answer" }],
        },
      },
    ];
    for (let index = 0; index < 20; index += 1) {
      rows.push(
        {
          type: "assistant",
          uuid: `tool-${String(index)}`,
          timestamp: `2026-08-02T11:01:${String(index).padStart(2, "0")}.000Z`,
          message: {
            id: `tool-${String(index)}`,
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `call-${String(index)}`,
                name: "Read",
                input: { file_path: `file-${String(index)}.ts` },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: `result-${String(index)}`,
          timestamp: `2026-08-02T11:02:${String(index).padStart(2, "0")}.000Z`,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `call-${String(index)}`,
                content: `result-${String(index)}`,
              },
            ],
          },
        },
      );
    }
    rows.push(
      {
        type: "user",
        uuid: "prompt-two",
        timestamp: "2026-08-02T11:03:00.000Z",
        origin: { kind: "human" },
        message: { role: "user", content: "Recent question" },
      },
      {
        type: "assistant",
        uuid: "response-two",
        timestamp: "2026-08-02T11:03:01.000Z",
        message: {
          id: "response-two",
          role: "assistant",
          content: [{ type: "text", text: "Recent answer" }],
        },
      },
    );
    await writeFile(
      transcript,
      rows.map((row) => JSON.stringify(row)).join("\n"),
    );

    const preview = await loadTranscriptPreview(transcript, 4, 4);
    expect(preview.map((row) => row.uuid)).toEqual([
      "prompt-one",
      "response-one",
      "tool-18",
      "result-18",
      "tool-19",
      "result-19",
      "prompt-two",
      "response-two",
    ]);
    expect(preview[0]).toEqual(rows[0]);
    expect(preview[1]).toEqual(rows[1]);
  });
});
