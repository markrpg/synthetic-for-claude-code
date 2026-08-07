import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ContextManager,
  EncryptedContextStore,
  transcriptUnits,
} from "../../src/bridge/contextManager.js";

const settings = {
  enabled: true,
  thresholdPercent: 72,
  fallbackContextTokens: 12_000,
  retainRecentTokens: 4_000,
};

function longConversation(): Array<Record<string, unknown>> {
  return Array.from({ length: 14 }, (_value, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}:${"x".repeat(4_000)}`,
  }));
}

describe("ContextManager", () => {
  it("compacts an old prefix once and reuses it without changing the visible request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "modelhop-context-"));
    const storagePath = path.join(root, "context.json");
    const store = new EncryptedContextStore(storagePath, "secret");
    const manager = new ContextManager(store);
    const summarizer = vi.fn().mockResolvedValue(
      "Decisions, changed files, and unfinished work.",
    );
    const messages = longConversation();
    const request = {
      model: "gpt-test",
      max_tokens: 512,
      system: "Original system instructions.",
      messages,
    };
    try {
      const first = await manager.prepare(request, {
        settings,
        summarizer,
      });
      expect(first.compacted).toBe(true);
      expect(summarizer).toHaveBeenCalled();
      expect(first.request.messages).not.toBe(messages);
      expect((first.request.messages as unknown[]).length).toBeLessThan(
        messages.length,
      );
      expect(JSON.stringify(first.request.system)).toContain(
        "ModelHop compacted historical context",
      );
      expect(request.messages).toBe(messages);

      const calls = summarizer.mock.calls.length;
      const second = await manager.prepare(request, {
        settings,
        summarizer,
      });
      expect(second.compacted).toBe(true);
      expect(summarizer).toHaveBeenCalledTimes(calls);
      expect(second.request).toEqual(first.request);

      await store.flush();
      const stored = await readFile(storagePath, "utf8");
      expect(stored).not.toContain(
        "Decisions, changed files, and unfinished work.",
      );

      const reloadedStore = new EncryptedContextStore(
        storagePath,
        "secret",
      );
      await reloadedStore.load();
      const reloaded = new ContextManager(reloadedStore);
      await reloaded.prepare(request, {
        settings,
        summarizer,
      });
      expect(summarizer).toHaveBeenCalledTimes(calls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps parallel tool calls and all linked results in one atomic unit", () => {
    const messages = [
      { role: "user", content: "Inspect both files." },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a", name: "Read", input: {} },
          { type: "tool_use", id: "call_b", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: "A",
          },
          {
            type: "tool_result",
            tool_use_id: "call_b",
            content: "B",
          },
        ],
      },
      { role: "assistant", content: "Both files are valid." },
    ];
    const units = transcriptUnits(messages);

    expect(units).toEqual([
      expect.objectContaining({ start: 0, end: 1, complete: true }),
      expect.objectContaining({ start: 1, end: 3, complete: true }),
      expect.objectContaining({ start: 3, end: 4, complete: true }),
    ]);
  });

  it("marks an unresolved tool call as unsafe to compact", () => {
    const units = transcriptUnits([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "pending",
            name: "Edit",
            input: {},
          },
        ],
      },
    ]);
    expect(units[0]).toMatchObject({ start: 0, end: 1, complete: false });
  });

  it("reports counting and compaction without exposing content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "modelhop-context-"));
    const store = new EncryptedContextStore(
      path.join(root, "context.json"),
      "secret",
    );
    const manager = new ContextManager(store);
    const progress: unknown[] = [];
    try {
      await manager.prepare(
        {
          model: "gpt-test",
          max_tokens: 512,
          messages: longConversation(),
        },
        {
          settings,
          summarizer: async () => "Compact factual summary.",
          onProgress: (event) => progress.push(event),
        },
      );
      expect(progress).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "counting" }),
          expect.objectContaining({ phase: "compacting" }),
          expect.objectContaining({
            phase: "ready",
            compacted: true,
          }),
        ]),
      );
      expect(JSON.stringify(progress)).not.toContain("xxxx");
    } finally {
      await store.flush();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fail inference preparation when an activity observer fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "modelhop-context-"));
    const store = new EncryptedContextStore(
      path.join(root, "context.json"),
      "secret",
    );
    try {
      await expect(
        new ContextManager(store).prepare(
          {
            model: "gpt-test",
            max_tokens: 512,
            messages: [{ role: "user", content: "hello" }],
          },
          {
            settings,
            summarizer: async () => "Unused.",
            onProgress: () => {
              throw new Error("observer failed");
            },
          },
        ),
      ).resolves.toMatchObject({ compacted: false });
    } finally {
      await store.flush();
      await rm(root, { recursive: true, force: true });
    }
  });
});
