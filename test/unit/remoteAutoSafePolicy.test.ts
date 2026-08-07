import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  classifyAutoSafeTool,
  isPublicResearchUrl,
} from "../../src/remote/autoSafePolicy.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "modelhop-auto-safe-"),
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

describe("ModelHop Remote Auto-safe policy", () => {
  it("allows public read-only research without a phone approval", async () => {
    const root = await workspace();
    await expect(
      classifyAutoSafeTool("WebSearch", { query: "Claude SDK" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      classifyAutoSafeTool("WebFetch", { url: "https://8.8.8.8/docs" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      classifyAutoSafeTool("Bash", {
        command: "curl -s https://8.8.8.8/docs",
      }, { workspacePath: root }),
    ).resolves.toMatchObject({ behavior: "allow" });
  });

  it("allows ordinary workspace-contained shell inspection", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "src"));
    for (const command of [
      "pwd",
      "ls -la src",
      "rg -n ModelHop src",
      "grep -n ModelHop src/index.ts",
      "head -n 20 src/index.ts",
      "tail -n 20 src/index.ts",
      "wc -l src/index.ts",
      "stat src/index.ts",
      "file src/index.ts",
    ]) {
      await expect(
        classifyAutoSafeTool(
          "Bash",
          { command },
          { workspacePath: root },
        ),
      ).resolves.toMatchObject({ behavior: "allow" });
    }
  });

  it("keeps shell inspection inside workspace and credential boundaries", async () => {
    const root = await workspace();
    for (const command of [
      "ls /etc",
      "rg password ~/.ssh",
      "grep token ../outside.txt",
      "head -n 5 .env",
      "tail $HOME/.netrc",
      "wc ${HOME}/.aws/credentials",
      "ls {src,../outside}",
      "ls *.env",
      "ls -RL src",
      "file --files-from=/etc/passwd",
      "file -m/etc/passwd src/index.ts",
      "wc --files0-from=/etc/passwd",
      "rg pattern src | wc -l",
    ]) {
      await expect(
        classifyAutoSafeTool(
          "Bash",
          { command },
          { workspacePath: root },
        ),
      ).resolves.toMatchObject({ behavior: "ask" });
    }
  });

  it("asks before a malformed or secret-bearing web search", async () => {
    const root = await workspace();
    for (const query of [
      "",
      "debug AKIAIOSFODNN7EXAMPLE",
      "inspect api_key=abcdefghijklmnopqrstuvwxyz123456",
      "find ghp_abcdefghijklmnopqrstuvwxyz123456",
    ]) {
      await expect(
        classifyAutoSafeTool(
          "WebSearch",
          { query },
          { workspacePath: root },
        ),
      ).resolves.toMatchObject({ behavior: "ask" });
    }
  });

  it("asks for uploads, request bodies, redirects and credential-bearing curl calls", async () => {
    const root = await workspace();
    for (const command of [
      "curl -X POST https://8.8.8.8/api",
      "curl --data hello https://8.8.8.8/api",
      "curl --upload-file artifact.zip https://8.8.8.8/api",
      "curl -L https://8.8.8.8/redirect",
      "curl -H @headers.txt https://8.8.8.8/api",
      "curl -H 'Authorization: Bearer secret' https://8.8.8.8/api",
      "curl 'https://8.8.8.8/api?access_token=secret'",
    ]) {
      await expect(
        classifyAutoSafeTool("Bash", { command }, { workspacePath: root }),
      ).resolves.toMatchObject({ behavior: "ask" });
    }
  });

  it("asks for private, internal, authenticated and non-HTTP targets", async () => {
    const root = await workspace();
    for (const url of [
      "http://127.0.0.1:3000",
      "http://10.0.0.2",
      "http://172.16.0.2",
      "http://192.168.1.2",
      "http://[::1]",
      "http://[::ffff:7f00:1]",
      "http://service.internal",
      "http://user:password@8.8.8.8",
      "file:///etc/passwd",
    ]) {
      expect(isPublicResearchUrl(url)).toBe(false);
      await expect(
        classifyAutoSafeTool("WebFetch", { url }, { workspacePath: root }),
      ).resolves.toMatchObject({ behavior: "ask" });
      await expect(
        classifyAutoSafeTool(
          "Bash",
          { command: `curl '${url}'` },
          { workspacePath: root },
        ),
      ).resolves.toMatchObject({ behavior: "ask" });
    }
  });

  it("allows canonical workspace reads and edits but asks for escape and credentials", async () => {
    const root = await workspace();
    const secondRoot = await workspace();
    await mkdir(path.join(root, "src"));
    await expect(
      classifyAutoSafeTool("Read", { file_path: "src/index.ts" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      classifyAutoSafeTool("Write", {
        file_path: path.join(secondRoot, "generated", "report.md"),
      }, {
        workspacePath: root,
        workspacePaths: [root, secondRoot],
      }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(
      classifyAutoSafeTool("Read", { file_path: "../outside.txt" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "ask" });
    await expect(
      classifyAutoSafeTool("Read", { file_path: ".env.production" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "ask" });
    await expect(
      classifyAutoSafeTool("Read", { file_path: ".config/gh/hosts.yml" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "ask" });
  });

  it("rejects symlink escape and malformed path-tool payloads", async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, path.join(root, "escaped"));
    await expect(
      classifyAutoSafeTool("Write", {
        file_path: "escaped/stolen.txt",
      }, { workspacePath: root }),
    ).resolves.toMatchObject({ behavior: "ask" });
    await expect(
      classifyAutoSafeTool("Read", {}, { workspacePath: root }),
    ).resolves.toMatchObject({ behavior: "ask" });
    await expect(
      classifyAutoSafeTool("LSP", { path: "src/index.ts" }, {
        workspacePath: root,
      }),
    ).resolves.toMatchObject({ behavior: "ask" });
  });

  it("never auto-allows arbitrary or destructive shell commands", async () => {
    const root = await workspace();
    for (const command of [
      "npm test",
      "find . -delete",
      "find . -exec rm {} +",
      "rg --pre 'sh -c evil' pattern",
      "git diff --ext-diff",
      "git show --textconv",
      "git push origin main",
      "gh release create v1",
      "rm -rf build",
      "sudo true",
      "ssh example.com true",
      "wget https://8.8.8.8/file",
    ]) {
      await expect(
        classifyAutoSafeTool("Bash", { command }, { workspacePath: root }),
      ).resolves.toMatchObject({ behavior: "ask" });
    }
  });

  it("asks for unknown tools and remembers only known orchestration by explicit choice", async () => {
    const root = await workspace();
    await expect(
      classifyAutoSafeTool("mcp__browser__write", {}, {
        workspacePath: root,
      }),
    ).resolves.toEqual({
      behavior: "ask",
      reason: "Unknown and dynamic tools require explicit approval.",
    });
    for (const toolName of ["Agent", "Task", "Workflow"]) {
      await expect(
        classifyAutoSafeTool(toolName, {}, { workspacePath: root }),
      ).resolves.toMatchObject({
        behavior: "ask",
        sessionRememberable: true,
      });
    }
    const taskStop = await classifyAutoSafeTool(
      "TaskStop",
      {},
      { workspacePath: root },
    );
    expect(taskStop).toMatchObject({ behavior: "ask" });
    expect("sessionRememberable" in taskStop).toBe(false);
  });
});
