import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claudeTabTitle,
  openExactClaudeSession,
  requireVisibleClaudeSession,
} from "../../src/remote/claudeSessionOpener.js";

describe("remote exact-session hand-back", () => {
  it("matches Claude Code's projected editor-tab title", () => {
    expect(claudeTabTitle("Short title")).toBe("Short title");
    expect(
      claudeTabTitle("Review results before next steps"),
    ).toBe("Review results before ne…");
    expect(() => claudeTabTitle("Claude Code")).toThrow(
      /cannot safely distinguish/i,
    );
    expect(() => claudeTabTitle("")).toThrow(
      /does not have a distinctive title/i,
    );
  });

  it("opens only the requested Claude session", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await openExactClaudeSession(
      "remote-session-id",
      {
        activateClaudeExtension: async () => true,
        listCommands: async () => [
          "claude-vscode.editor.openLast",
          "claude-vscode.editor.open",
        ],
        executeCommand: execute,
        confirmSessionOpen: async () => true,
      },
      1,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "claude-vscode.editor.open",
      "remote-session-id",
    );
  });

  it("does not treat exact-ID command acceptance as desktop confirmation", async () => {
    const accepted = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(false);
    let now = 0;

    await expect(
      openExactClaudeSession(
        "remote-session-id",
        {
          activateClaudeExtension: async () => true,
          listCommands: async () => ["claude-vscode.editor.open"],
          executeCommand: async () => undefined,
          onExactSessionCommandAccepted: accepted,
          confirmSessionOpen: confirm,
          now: () => now,
          wait: async (milliseconds) => {
            now += milliseconds;
          },
        },
        10,
      ),
    ).rejects.toThrow(/did not confirm.*exact remote conversation/i);

    expect(accepted).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalled();
  });

  it("accepts an attributed exact-session tab when Claude rejects after opening it", async () => {
    const commandError = new Error("command handler timed out");
    const accepted = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(
      openExactClaudeSession(
        "remote-session-id",
        {
          activateClaudeExtension: async () => true,
          listCommands: async () => ["claude-vscode.editor.open"],
          executeCommand: async () => {
            throw commandError;
          },
          onExactSessionCommandAccepted: accepted,
          confirmSessionOpen: confirm,
        },
        1_000,
      ),
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledWith("remote-session-id");
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("confirms the attributed tab while a Claude command promise remains stalled", async () => {
    let now = 0;
    let confirmations = 0;
    const accepted = vi.fn().mockResolvedValue(undefined);

    await expect(
      openExactClaudeSession(
        "remote-session-id",
        {
          activateClaudeExtension: async () => true,
          listCommands: async () => ["claude-vscode.editor.open"],
          executeCommand: () => new Promise(() => undefined),
          onExactSessionCommandAccepted: accepted,
          confirmSessionOpen: async () => {
            confirmations += 1;
            return confirmations === 2;
          },
          now: () => now,
          wait: async (milliseconds) => {
            now += milliseconds;
          },
        },
        1_000,
      ),
    ).resolves.toBeUndefined();

    expect(confirmations).toBe(2);
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("fails closed when the exact-session command is unavailable", async () => {
    const execute = vi.fn();
    let now = 0;

    await expect(
      openExactClaudeSession(
        "remote-session-id",
        {
          activateClaudeExtension: async () => true,
          listCommands: async () => [
            "claude-vscode.editor.openLast",
          ],
          executeCommand: execute,
          confirmSessionOpen: async () => false,
          now: () => now,
          wait: async () => {
            now += 10;
          },
        },
        5,
      ),
    ).rejects.toThrow(/exact-session open command/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when panel creation does not resume the exact session", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    let now = 0;

    await expect(
      openExactClaudeSession(
        "remote-session-id",
        {
          activateClaudeExtension: async () => true,
          listCommands: async () => ["claude-vscode.editor.open"],
          executeCommand: execute,
          confirmSessionOpen: async () => false,
          now: () => now,
          wait: async () => {
            now += 10;
          },
        },
        5,
      ),
    ).rejects.toThrow(/did not confirm.*exact remote conversation/i);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("uses one absolute timeout for command registration and confirmation", async () => {
    let now = 0;
    let commandsReady = false;
    let confirmations = 0;

    await expect(
      openExactClaudeSession(
        "remote-session-id",
        {
          activateClaudeExtension: async () => true,
          listCommands: async () =>
            commandsReady ? ["claude-vscode.editor.open"] : [],
          executeCommand: async () => undefined,
          confirmSessionOpen: async () => {
            confirmations += 1;
            return false;
          },
          now: () => now,
          wait: async () => {
            now += 4;
            commandsReady = now >= 8;
          },
        },
        10,
      ),
    ).rejects.toThrow(/did not confirm/i);
    expect(confirmations).toBe(1);
  });

  it("requires the target to be visible to Claude's non-programmatic session list", async () => {
    const visible = {
      sessionId: "remote-session-id",
      summary: "Remote continuation",
      lastModified: 1,
    };
    const list = vi.fn().mockResolvedValue([visible]);

    await expect(
      requireVisibleClaudeSession(
        "remote-session-id",
        "/workspace",
        list,
      ),
    ).resolves.toEqual(visible);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/workspace",
        includeProgrammatic: false,
        includeWorktrees: false,
      }),
    );
  });

  it("fails closed when the visible session ID resolves to another transcript", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "modelhop-exact-session-"),
    );
    try {
      const expected = path.join(directory, "expected.jsonl");
      const discovered = path.join(directory, "discovered.jsonl");
      await Promise.all([
        writeFile(expected, "{}\n"),
        writeFile(discovered, "{}\n"),
      ]);

      await expect(
        requireVisibleClaudeSession(
          "remote-session-id",
          "/workspace",
          async () => [
            {
              sessionId: "remote-session-id",
              summary: "Remote continuation",
              lastModified: 1,
              transcriptPath: discovered,
            },
          ],
          expected,
        ),
      ).rejects.toThrow(/different transcript/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when Claude still classifies the target as programmatic", async () => {
    await expect(
      requireVisibleClaudeSession(
        "remote-session-id",
        "/workspace",
        async () => [],
      ),
    ).rejects.toThrow(/not visible.*Claude Code extension/i);
  });
});
