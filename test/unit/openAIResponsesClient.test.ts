import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIResponsesClient } from "../../src/bridge/openAIResponsesClient.js";
import { DEFAULT_OPENAI_SETTINGS } from "../../src/providers/openAIProvider.js";

function reasoningStore() {
  const values = new Map<string, readonly unknown[]>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, items: readonly unknown[]) => {
      values.set(key, items);
    },
    values,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIResponsesClient", () => {
  it("uses the Responses API, store:false, and records exact response usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_1",
          model: "gpt-5.6-sol",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Done." }],
            },
            { type: "reasoning", encrypted_content: "encrypted" },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 40 },
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-limit-requests": "500",
            "x-ratelimit-remaining-requests": "499",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = reasoningStore();
    const observer = { record: vi.fn() };
    const client = new OpenAIResponsesClient(
      "secret-key",
      DEFAULT_OPENAI_SETTINGS,
      store,
      observer,
    );

    const result = await client.complete({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Finish." }],
    });

    expect(result.content).toEqual([{ type: "text", text: "Done." }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.openai.com/v1/responses",
    );
    const options = fetchMock.mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    expect(options?.method).toBe("POST");
    expect(
      (options?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer secret-key");
    const parsed: unknown = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    const request =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    expect(request.store).toBe(false);
    expect(request.include).toEqual(["reasoning.encrypted_content"]);
    expect(observer.record).toHaveBeenCalledWith(
      {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        requestCount: 1,
      },
      expect.objectContaining({
        remainingRequests: 499,
        limitRequests: 500,
      }),
      expect.any(Number),
    );
    expect(store.values.size).toBe(1);
  });

  it("preserves Anthropic SSE ordering for text and tool calls", async () => {
    const encoder = new TextEncoder();
    const openAIFrames = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call:1",
          name: "Read",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "{\"path\":",
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: "\"README.md\"}",
      },
      { type: "response.output_item.done", output_index: 0 },
      {
        type: "response.completed",
        response: {
          output: [],
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of openAIFrames) {
          controller.enqueue(
            encoder.encode(
              `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
            ),
          );
        }
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    );
    const observer = { record: vi.fn() };
    const client = new OpenAIResponsesClient(
      "secret-key",
      DEFAULT_OPENAI_SETTINGS,
      reasoningStore(),
      observer,
    );
    const frames: string[] = [];
    for await (const frame of client.stream({
      model: "gpt-5.6-sol",
      stream: true,
      messages: [{ role: "user", content: "Read it." }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    })) {
      frames.push(frame);
    }
    const combined = frames.join("");

    expect(combined.indexOf("message_start")).toBeLessThan(
      combined.indexOf("content_block_start"),
    );
    expect(combined).toContain('"type":"input_json_delta"');
    expect(combined).toContain('\\"README.md\\"');
    expect(combined.indexOf("content_block_stop")).toBeLessThan(
      combined.indexOf("message_delta"),
    );
    expect(combined).toContain('"stop_reason":"tool_use"');
    expect(
      combined
        .trimEnd()
        .endsWith('event: message_stop\ndata: {"type":"message_stop"}'),
    ).toBe(true);
  });
});
