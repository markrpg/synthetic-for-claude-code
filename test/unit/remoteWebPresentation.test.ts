import { describe, expect, it } from "vitest";
import type { RemoteProviderContext } from "../../src/remote/types.js";
import {
  buildFileHierarchy,
  constellationLayout,
  findHierarchyNode,
  formatProviderUsage,
  mergeUsageSnapshots,
  normalizeSdkActivity,
  orderedUnseenEvents,
} from "../../src/remote/web/presentation.js";

function provider(
  overrides: Partial<RemoteProviderContext> = {},
): RemoteProviderContext {
  return {
    provider: "openai-codex",
    label: "OpenAI via Codex",
    model: "gpt-5.6-sol",
    roleModels: {
      default: "gpt-5.6-sol",
      opus: "gpt-5.6-sol",
      sonnet: "gpt-5.6-terra",
      haiku: "gpt-5.6-luna",
      subagent: "gpt-5.6-terra",
    },
    updatedAt: 1,
    ...overrides,
  };
}

describe("remote mobile presentation", () => {
  it("orders unseen journal events once by their durable IDs", () => {
    const event = (id: number, title: string) => ({
      id,
      type: "notification" as const,
      createdAt: id,
      payload: { message: title },
    });
    expect(
      orderedUnseenEvents(
        [
          event(4, "four"),
          event(2, "two"),
          event(3, "first three"),
          event(3, "duplicate three"),
          event(1, "already applied"),
        ],
        1,
      ).map((entry) => [entry.id, entry.payload]),
    ).toEqual([
      [2, { message: "two" }],
      [3, { message: "first three" }],
      [4, { message: "four" }],
    ]);
  });

  it("shows Codex allowance before a zero-valued token accumulator", () => {
    expect(
      formatProviderUsage(
        provider({
          usage: {
            tokens: {
              requestCount: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
            codex: {
              rateLimits: {
                primary: { usedPercent: 37.5 },
              },
            },
          },
        }),
      ),
    ).toBe("62.5% left");
  });

  it("does not present an initialized zero OpenAI counter as real usage", () => {
    expect(
      formatProviderUsage(
        provider({
          provider: "openai-api",
          label: "OpenAI API",
          usage: {
            tokens: {
              requestCount: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
        }),
      ),
    ).toBe("Waiting for first request");
  });

  it("describes Anthropic allowance without claiming usage is unavailable", () => {
    expect(
      formatProviderUsage(
        provider({
          provider: "anthropic",
          label: "Anthropic",
          model: "claude-opus-4-1",
          usage: undefined,
        }),
      ),
    ).toBe("Account allowance managed in Claude");
  });

  it("keeps observed session and context when an allowance refresh is unavailable", () => {
    const available = {
      kind: "usage.snapshot" as const,
      provider: "anthropic" as const,
      status: "available" as const,
      model: "claude-opus-4-1",
      updatedAt: 10,
      session: {
        inputTokens: 8_000,
        outputTokens: 2_000,
        totalTokens: 10_000,
        requests: 4,
      },
      context: {
        usedTokens: 12_000,
        maxTokens: 200_000,
        percentage: 6,
      },
    };
    expect(
      mergeUsageSnapshots(available, {
        kind: "usage.snapshot",
        provider: "anthropic",
        status: "unavailable",
        model: "claude-opus-4-1",
        updatedAt: 20,
        error: "Account allowance is managed in Claude",
      }),
    ).toMatchObject({
      status: "unavailable",
      updatedAt: 20,
      session: available.session,
      context: available.context,
    });
  });

  it("turns raw SDK status and task events into readable activity", () => {
    expect(
      normalizeSdkActivity({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    ).toMatchObject({
      title: "Compressing context",
      phase: "Compacting conversation",
      busy: true,
    });
    expect(
      normalizeSdkActivity({
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        description: "Index the repository",
      }),
    ).toMatchObject({
      title: "Index the repository",
      phase: "Running task",
    });
  });

  it("builds a deterministic folder hierarchy and constellation", () => {
    const tree = buildFileHierarchy([
      "src/remote/web/app.ts",
      "src/remote/web/styles.css",
      "src/extension.ts",
      "README.md",
    ]);
    const web = findHierarchyNode(tree, "src/remote/web");
    expect(web?.children.map((child) => child.name)).toEqual([
      "app.ts",
      "styles.css",
    ]);
    const layout = constellationLayout(tree, "src/remote/web");
    expect(
      layout.find((entry) => entry.relation === "current"),
    ).toMatchObject({
      relation: "current",
      node: { path: "src/remote/web" },
    });
    expect(
      layout.find((entry) => entry.relation === "parent"),
    ).toMatchObject({
      relation: "parent",
      node: { path: "src/remote" },
    });
  });
});
