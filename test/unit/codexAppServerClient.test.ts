import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/bridge/codexAppServerClient.js";
import { DEFAULT_OPENAI_SETTINGS } from "../../src/providers/openAIProvider.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function createFakeAppServer(root: string): Promise<{
  executable: string;
  logPath: string;
}> {
  const logPath = path.join(root, "requests.jsonl");
  const scriptPath = path.join(root, "fake-app-server.mjs");
  const executable = path.join(root, "fake-codex");
  const script = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const logPath = ${JSON.stringify(logPath)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
appendFileSync(logPath, JSON.stringify({
  startup: true,
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
}) + "\\n");
let dynamicTool = "tool";
let turnCounter = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "thread/start") {
    dynamicTool = message.params.dynamicTools?.[0]?.name ?? "tool";
    send({ id: message.id, result: { thread: { id: "thr_1", ephemeral: true } } });
  } else if (message.method === "thread/inject_items") {
    send({ id: message.id, result: {} });
  } else if (message.method === "turn/start") {
    turnCounter += 1;
    const turnId = "turn_" + turnCounter;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const inputText = JSON.stringify(message.params.input);
    if (!inputText.includes("wait for cancellation")) {
      setTimeout(() => send({
        id: 900,
        method: "item/tool/call",
        params: {
          threadId: "thr_1",
          turnId,
          callId: "call:unsafe/1",
          tool: dynamicTool,
          arguments: { path: "README.md" },
        },
      }), 5);
    }
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "thr_1",
        turn: { status: "interrupted", usage: {} },
      },
    });
  } else if (message.id === 900 && message.result) {
    send({
      method: "item/agentMessage/delta",
      params: { threadId: "thr_1", delta: "The file was read." },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thr_1",
        turn: {
          status: "completed",
          usage: { inputTokens: 30, outputTokens: 7 },
        },
      },
    });
  } else if (message.method === "account/read") {
    send({ id: message.id, result: { account: { type: "chatgpt" } } });
  } else if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        }],
      },
    });
  } else if (message.method === "account/logout") {
    send({ id: message.id, result: {} });
  }
});
`;
  await writeFile(scriptPath, script, { mode: 0o600 });
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, logPath };
}

function content(
  response: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(response.content)
    ? response.content.filter(isRecord)
    : [];
}

describe("CodexAppServerClient", () => {
  it("isolates Codex and keeps a dynamic Claude tool loop open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "modelhop-codex-test-"));
    const { executable, logPath } = await createFakeAppServer(root);
    const client = new CodexAppServerClient(executable, root);
    try {
      const first = await client.run(
        {
          model: "gpt-5.6-sol",
          system: "Use only the supplied Claude tools.",
          messages: [{ role: "user", content: "Read the README." }],
          tools: [
            {
              name: "mcp:files/read",
              description: "Read a file",
              input_schema: { type: "object" },
            },
          ],
        },
        DEFAULT_OPENAI_SETTINGS,
      );
      const tool = content(first)[0] ?? {};

      expect(first.stop_reason).toBe("tool_use");
      expect(tool.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(tool.name).toBe("mcp:files/read");
      expect(tool.input).toEqual({ path: "README.md" });

      const second = await client.run(
        {
          model: "gpt-5.6-sol",
          messages: [
            { role: "user", content: "Read the README." },
            { role: "assistant", content: [tool] },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: tool.id,
                  content: "# ModelHop",
                },
              ],
            },
          ],
        },
        DEFAULT_OPENAI_SETTINGS,
      );

      expect(second.stop_reason).toBe("end_turn");
      expect(content(second)).toEqual([
        { type: "text", text: "The file was read." },
      ]);
      expect(second.usage).toEqual({
        input_tokens: 30,
        output_tokens: 7,
      });

      const lines = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
        .filter(isRecord);
      const startup = lines.find((line) => line.startup === true);
      const threadStart = lines.find(
        (line) => line.method === "thread/start",
      );
      expect(startup?.hasOpenAIKey).toBe(false);
      expect(startup?.codexHome).toBe(
        path.join(root, ".modelhop-codex-home"),
      );
      expect(JSON.stringify(startup?.argv)).toContain(
        "features.shell_tool=false",
      );
      expect(JSON.stringify(startup?.argv)).toContain(
        "features.apps=false",
      );
      expect(JSON.stringify(threadStart)).toContain(
        '"ephemeral":true',
      );
      expect(JSON.stringify(threadStart)).toContain(
        '"dynamicTools"',
      );
      expect(JSON.stringify(threadStart)).not.toContain(
        "mcp:files/read",
      );
    } finally {
      client.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts an in-flight app-server turn when Claude cancels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "modelhop-codex-test-"));
    const { executable, logPath } = await createFakeAppServer(root);
    const client = new CodexAppServerClient(executable, root);
    try {
      const abort = new AbortController();
      const pending = client.run(
        {
          model: "gpt-5.6-sol",
          messages: [
            { role: "user", content: "wait for cancellation" },
          ],
        },
        DEFAULT_OPENAI_SETTINGS,
        abort.signal,
      );
      setTimeout(() => abort.abort(), 30);
      await pending;

      const log = await readFile(logPath, "utf8");
      expect(log).toContain('"method":"turn/interrupt"');
      expect(log).toContain('"turnId":"turn_1"');
    } finally {
      client.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
