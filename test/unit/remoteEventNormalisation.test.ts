import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { describe, expect, it } from "vitest";
import {
  normaliseSdkMessage,
  resetSdkMessageNormalisationState,
  type SdkMessageNormalisationState,
} from "../../src/remote/sessionController.js";
import type { RemoteProviderContext } from "../../src/remote/types.js";

const provider: RemoteProviderContext = {
  provider: "openai-codex",
  label: "OpenAI via Codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  roleModels: {
    default: "gpt-5.6-sol",
    opus: "gpt-5.6-sol",
    sonnet: "gpt-5.6-terra",
    haiku: "gpt-5.6-luna",
    subagent: "gpt-5.6-terra",
  },
  updatedAt: 1,
};

function sdk(value: unknown): SDKMessage {
  return value as SDKMessage;
}

describe("remote SDK event normalisation", () => {
  it.each([
    "auto-safe",
    "acceptEdits",
    "default",
    "plan",
  ] as const)(
    "keeps %s authoritative when the SDK refreshes commands",
    (permissionMode) => {
      const state: SdkMessageNormalisationState = {
        permissionMode,
      };
      const events = normaliseSdkMessage(
        sdk({
          type: "system",
          subtype: "commands_changed",
          uuid: `commands-${permissionMode}`,
          session_id: "session",
          commands: [{ name: "review" }],
        }),
        provider,
        new Map(),
        state,
      );

      expect(events[0]).toMatchObject({
        type: "session.capabilities",
        payload: {
          permissionMode,
          commands: [{ name: "review" }],
        },
      });
    },
  );

  it("drops redundant request transport acknowledgements", () => {
    for (const subtype of ["request_sent", "request_started"]) {
      expect(
        normaliseSdkMessage(
          sdk({
            type: "system",
            subtype,
            uuid: `transport-${subtype}`,
            session_id: "session",
          }),
          provider,
        ),
      ).toEqual([]);
    }
  });

  it("presents rejected provider allowance without synthesizing work", () => {
    const events = normaliseSdkMessage(
      sdk({
        type: "rate_limit_event",
        uuid: "rate-limit-rejected",
        session_id: "session",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_800_000_000,
          utilization: 1,
        },
      }),
      provider,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "rate-limit-rejected",
        category: "error",
        phase: "failed",
        title: "Provider allowance exhausted",
        detail: "Resets at 2027-01-15T08:00:00.000Z",
        data: {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected" },
        },
      },
    });
  });

  it("upserts a journaled prompt using its stable client ID", () => {
    const events = normaliseSdkMessage(
      sdk({
        type: "user",
        uuid: "sdk-message",
        session_id: "session",
        parent_tool_use_id: null,
        origin: { kind: "human" },
        message: { role: "user", content: "Keep going" },
      }),
      provider,
      new Map([["sdk-message", "client-message"]]),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "conversation.item",
      payload: {
        operation: "upsert",
        item: {
          id: "client-message",
          sdkMessageId: "sdk-message",
          role: "user",
          status: "accepted",
          content: "Keep going",
        },
      },
    });
  });

  it("keeps hidden transcript metadata out of conversation", () => {
    expect(
      normaliseSdkMessage(
        sdk({
          type: "user",
          uuid: "image-metadata",
          session_id: "session",
          isMeta: true,
          userType: "external",
          message: {
            role: "user",
            content:
              "[Image: original 2400x900, displayed at 1200x450. Multiply coordinates by 2 to map to original image.]",
          },
        }),
        provider,
      ),
    ).toEqual([]);
  });

  it("keeps Claude command envelopes out of human dialogue", () => {
    for (const [uuid, content, origin] of [
      [
        "command",
        "<command-name>/config</command-name><command-message>config</command-message>",
        undefined,
      ],
      [
        "caveat",
        "<local-command-caveat>Private transport instructions</local-command-caveat>",
        undefined,
      ],
    ] as const) {
      expect(
        normaliseSdkMessage(
          sdk({
            type: "user",
            uuid,
            session_id: "session",
            ...(origin ? { origin } : {}),
            message: { role: "user", content },
          }),
          provider,
        ),
      ).toEqual([]);
    }
  });

  it("presents a task notification as Activity without leaking its XML", () => {
    const events = normaliseSdkMessage(
      sdk({
        type: "user",
        uuid: "task-notification-row",
        timestamp: "2026-08-02T11:14:18.947Z",
        session_id: "session",
        origin: { kind: "task-notification" },
        message: {
          role: "user",
          content:
            "<task-notification><task-id>agent-7</task-id><status>stopped</status><summary>The audit stopped, but its transcript remains available.</summary></task-notification>",
        },
      }),
      provider,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "task:agent-7",
        taskId: "agent-7",
        category: "task",
        phase: "complete",
        title: "Background task stopped",
        detail: "The audit stopped, but its transcript remains available.",
        createdAt: Date.parse("2026-08-02T11:14:18.947Z"),
      },
    });
  });

  it("marks a task missing from the live list as settling, not complete", () => {
    const state: SdkMessageNormalisationState = {};
    normaliseSdkMessage(
      sdk({
        type: "system",
        subtype: "background_tasks_changed",
        uuid: "tasks-live",
        session_id: "session",
        tasks: [
          {
            task_id: "workflow-1",
            task_type: "workflow",
            description: "Audit continuity",
          },
        ],
      }),
      provider,
      new Map(),
      state,
    );

    const events = normaliseSdkMessage(
      sdk({
        type: "system",
        subtype: "background_tasks_changed",
        uuid: "tasks-empty",
        session_id: "session",
        tasks: [],
      }),
      provider,
      new Map(),
      state,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "task:workflow-1",
        phase: "settling",
        detail: "Final workflow record pending",
        data: { status: "settling" },
      },
    });
    expect(
      events.some(
        (event) =>
          event.type === "activity.event" &&
          event.payload.phase === "complete",
      ),
    ).toBe(false);
  });

  it("uses a terminal task update to reconcile a settling task", () => {
    const state: SdkMessageNormalisationState = {
      tasks: new Map([
        [
          "workflow-2",
          {
            id: "workflow-2",
            title: "Record the result",
            createdAt: 10,
            phase: "settling",
          },
        ],
      ]),
    };
    const events = normaliseSdkMessage(
      sdk({
        type: "system",
        subtype: "task_updated",
        task_id: "workflow-2",
        status: "completed",
        description: "Record the result",
        uuid: "task-terminal-update",
        session_id: "session",
      }),
      provider,
      new Map(),
      state,
    );

    expect(events[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "task:workflow-2",
        phase: "complete",
      },
    });
  });

  it("preserves unusual text when Claude identifies it as a real human prompt", () => {
    const events = normaliseSdkMessage(
      sdk({
        type: "user",
        uuid: "human-xml",
        session_id: "session",
        origin: { kind: "human" },
        message: {
          role: "user",
          content: "<command-name>This is literal example text</command-name>",
        },
      }),
      provider,
    );
    expect(events[0]).toMatchObject({
      type: "conversation.item",
      payload: {
        item: {
          id: "human-xml",
          role: "user",
          content: "<command-name>This is literal example text</command-name>",
        },
      },
    });
  });

  it("routes subagent narrative to one activity instead of the main chat", () => {
    const state: SdkMessageNormalisationState = {};
    normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "agent-tool-wrapper",
        session_id: "session",
        message: {
          id: "agent-tool-message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent-one",
              name: "Agent",
              input: { description: "Audit reconnect behavior" },
            },
          ],
        },
      }),
      provider,
      new Map(),
      state,
    );
    const first = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "agent-response-one",
        session_id: "session",
        parent_tool_use_id: "agent-one",
        message: {
          id: "nested-message",
          role: "assistant",
          content: [{ type: "text", text: "Inspecting reconnect state." }],
        },
      }),
      provider,
      new Map(),
      state,
    );
    const second = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "agent-response-two",
        session_id: "session",
        parent_tool_use_id: "agent-one",
        message: {
          id: "nested-message",
          role: "assistant",
          content: [{ type: "text", text: "Found the stale lease." }],
        },
      }),
      provider,
      new Map(),
      state,
    );
    for (const events of [first, second]) {
      expect(events[0]).toMatchObject({
        type: "activity.event",
        payload: {
          id: "agent:agent-one",
          category: "task",
          title: "Audit reconnect behavior",
        },
      });
      expect(
        events.some((event) => event.type === "conversation.item"),
      ).toBe(false);
    }
  });

  it("keeps parallel tool results as independent stable operations", () => {
    const state = {};
    const events = normaliseSdkMessage(
      sdk({
        type: "user",
        uuid: "tool-result",
        session_id: "session",
        parent_tool_use_id: "tool-use",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-use",
              content: "done",
            },
          ],
        },
      }),
      provider,
      new Map(),
      state,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "activity.event",
      payload: {
        category: "tool",
        phase: "complete",
        id: "tool:tool-use",
        toolUseId: "tool-use",
        title: "Tool complete",
      },
    });

    const second = normaliseSdkMessage(
      sdk({
        type: "user",
        uuid: "tool-result-2",
        session_id: "session",
        parent_tool_use_id: "tool-use-2",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-use-2",
              content: "done",
            },
          ],
        },
      }),
      provider,
      new Map(),
      state,
    );

    expect(second[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "tool:tool-use-2",
        toolUseId: "tool-use-2",
        title: "Tool complete",
      },
    });
    expect(
      (second[0] as { payload: { id: string } }).payload.id,
    ).not.toBe(
      (events[0] as { payload: { id: string } }).payload.id,
    );
  });

  it("uses the canonical assistant message ID during transcript bootstrap", () => {
    const events = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "transcript-row-id",
        session_id: "session",
        message: {
          id: "canonical-assistant-id",
          role: "assistant",
          content: [{ type: "text", text: "Complete response" }],
        },
      }),
      provider,
    );
    expect(events[0]).toMatchObject({
      type: "conversation.item",
      payload: {
        item: {
          id: "canonical-assistant-id",
          sdkMessageId: "canonical-assistant-id",
        },
      },
    });
  });

  it("exposes compaction and result usage as typed events", () => {
    expect(
      normaliseSdkMessage(
        sdk({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "compact",
          session_id: "session",
        }),
        provider,
      )[0],
    ).toMatchObject({
      type: "activity.event",
      payload: {
        category: "compaction",
        phase: "compacting",
      },
    });

    const result = normaliseSdkMessage(
      sdk({
        type: "result",
        subtype: "success",
        uuid: "result",
        session_id: "session",
        is_error: false,
        stop_reason: "end_turn",
        total_cost_usd: 0.25,
        num_turns: 2,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
        },
      }),
      provider,
    );

    const usage = result.find(
      (event) => event.type === "usage.snapshot",
    );
    expect(usage?.type).toBe("usage.snapshot");
    if (usage?.type !== "usage.snapshot") {
      throw new Error("Expected a usage snapshot.");
    }
    expect(usage.payload.provider).toBe("openai-codex");
    expect(usage.payload.status).toBe("available");
    expect(usage.payload.session).toEqual({
      inputTokens: 140,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      totalTokens: 160,
      costUsd: 0.25,
      requests: 2,
    });
  });

  it("uses one assistant item across partial UUIDs and the canonical response", () => {
    const state: SdkMessageNormalisationState = {};

    expect(
      normaliseSdkMessage(
        sdk({
          type: "stream_event",
          uuid: "partial-start-uuid",
          session_id: "session",
          parent_tool_use_id: null,
          event: {
            type: "message_start",
            message: { id: "canonical-message", content: [] },
          },
        }),
        provider,
        new Map(),
        state,
      ),
    ).toEqual([]);

    const firstDelta = normaliseSdkMessage(
      sdk({
        type: "stream_event",
        uuid: "partial-delta-one",
        session_id: "session",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        },
      }),
      provider,
      new Map(),
      state,
    );
    const secondDelta = normaliseSdkMessage(
      sdk({
        type: "stream_event",
        uuid: "partial-delta-two",
        session_id: "session",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        },
      }),
      provider,
      new Map(),
      state,
    );
    const completed = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "canonical-wrapper-uuid",
        session_id: "session",
        parent_tool_use_id: null,
        message: {
          id: "canonical-message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      }),
      provider,
      new Map(),
      state,
    );

    const conversationItemId = (
      events: ReturnType<typeof normaliseSdkMessage>,
    ): string => {
      const event = events[0];
      if (!event || event.type !== "conversation.item") {
        throw new Error("Expected a conversation item event.");
      }
      return event.payload.item.id;
    };
    const ids = [firstDelta, secondDelta, completed].map(
      conversationItemId,
    );
    expect(ids).toEqual([
      "canonical-message",
      "canonical-message",
      "canonical-message",
    ]);
    expect(completed[0]).toMatchObject({
      type: "conversation.item",
      payload: {
        operation: "upsert",
        item: {
          id: "canonical-message",
          sdkMessageId: "canonical-message",
          status: "complete",
        },
      },
    });

    resetSdkMessageNormalisationState(state);
    const nextTurn = normaliseSdkMessage(
      sdk({
        type: "stream_event",
        uuid: "next-turn-partial",
        session_id: "session",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Next" },
        },
      }),
      provider,
      new Map(),
      state,
    );
    expect(nextTurn[0]).toMatchObject({
      type: "conversation.item",
      payload: { item: { id: "next-turn-partial" } },
    });
  });

  it("preserves split response blocks and starts a new item after a tool result", () => {
    const state: SdkMessageNormalisationState = {};
    normaliseSdkMessage(
      sdk({
        type: "stream_event",
        uuid: "first-start",
        session_id: "session",
        event: {
          type: "message_start",
          message: { id: "first-response", content: [] },
        },
      }),
      provider,
      new Map(),
      state,
    );
    const text = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "first-text",
        session_id: "session",
        message: {
          id: "first-response",
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      }),
      provider,
      new Map(),
      state,
    );
    const tool = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "first-tool",
        session_id: "session",
        message: {
          id: "first-response",
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
      }),
      provider,
      new Map(),
      state,
    );
    expect(text[0]).toMatchObject({
      type: "conversation.item",
      payload: { item: { id: "first-response" } },
    });
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "tool:tool-one",
        category: "tool",
        phase: "running-tool",
        title: "Reading README.md",
      },
    });

    const result = normaliseSdkMessage(
      sdk({
        type: "user",
        uuid: "tool-result",
        session_id: "session",
        parent_tool_use_id: "tool-one",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[Image: original 100x100, displayed at 50x50.]",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-one",
              content: "file contents",
            },
          ],
        },
      }),
      provider,
      new Map(),
      state,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "activity.event",
      payload: {
        id: "tool:tool-one",
        category: "tool",
        phase: "complete",
      },
    });

    normaliseSdkMessage(
      sdk({
        type: "stream_event",
        uuid: "second-start",
        session_id: "session",
        event: {
          type: "message_start",
          message: { id: "second-response", content: [] },
        },
      }),
      provider,
      new Map(),
      state,
    );
    const completed = normaliseSdkMessage(
      sdk({
        type: "assistant",
        uuid: "second-final",
        session_id: "session",
        message: {
          id: "second-response",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking references." },
            { type: "text", text: "The file is complete." },
          ],
        },
      }),
      provider,
      new Map(),
      state,
    );
    expect(completed[0]).toMatchObject({
      type: "conversation.item",
      payload: {
        item: {
          id: "second-response",
          content: [
            { type: "thinking", thinking: "Checking references." },
            { type: "text", text: "The file is complete." },
          ],
        },
      },
    });
  });
});
