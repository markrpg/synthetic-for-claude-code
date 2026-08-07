import { describe, expect, it } from "vitest";
import {
  assistantSignature,
  translateAnthropicRequest,
  translateOpenAIResponse,
} from "../../src/bridge/anthropicOpenAITranslator.js";
import { DEFAULT_OPENAI_SETTINGS } from "../../src/providers/openAIProvider.js";

describe("Anthropic/OpenAI translation", () => {
  it("translates instructions, images, tools, parallel calls, and role reasoning", () => {
    const plan = translateAnthropicRequest(
      {
        model: "gpt-5.6-terra",
        max_tokens: 2048,
        system: [{ type: "text", text: "Use Claude's tools." }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect this." },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aW1hZ2U=",
                },
              },
            ],
          },
        ],
        tools: [
          {
            name: "mcp:files/read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
        tool_choice: { type: "any" },
        stream: true,
      },
      DEFAULT_OPENAI_SETTINGS,
    );

    expect(plan.model).toBe("gpt-5.6-terra");
    expect(plan.effort).toBe("medium");
    expect(plan.request).toMatchObject({
      instructions: "Use Claude's tools.",
      max_output_tokens: 2048,
      reasoning: { effort: "medium" },
      store: false,
      stream: true,
      parallel_tool_calls: true,
      tool_choice: "required",
      include: ["reasoning.encrypted_content"],
    });
    expect(plan.request).not.toHaveProperty("temperature");
    expect(plan.request).not.toHaveProperty("stop");
    const tools = plan.request.tools;
    expect(Array.isArray(tools)).toBe(true);
    const firstTool =
      Array.isArray(tools) &&
      typeof tools[0] === "object" &&
      tools[0] !== null
        ? (tools[0] as Record<string, unknown>)
        : {};
    expect(firstTool.type).toBe("function");
    expect(firstTool.strict).toBe(false);
    expect(firstTool.name).toMatch(/^modelhop_/);
    expect(JSON.stringify(plan.request.input)).toContain(
      "data:image/png;base64,aW1hZ2U=",
    );
  });

  it("honours Claude Code's explicit per-turn effort for the upstream model", () => {
    const plan = translateAnthropicRequest(
      {
        model: "gpt-5.6-terra",
        output_config: { effort: "max" },
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "Use maximum effort." }],
      },
      DEFAULT_OPENAI_SETTINGS,
    );

    expect(plan.effort).toBe("max");
    expect(plan.request).toMatchObject({ reasoning: { effort: "max" } });
    expect(plan.request).not.toHaveProperty("thinking");
  });

  it("ignores an invalid per-turn effort and keeps the configured role effort", () => {
    const plan = translateAnthropicRequest(
      {
        model: "gpt-5.6-terra",
        output_config: { effort: "maximum-ish" },
      },
      DEFAULT_OPENAI_SETTINGS,
    );

    expect(plan.effort).toBe("medium");
    expect(plan.request).toMatchObject({ reasoning: { effort: "medium" } });
  });

  it("preserves encrypted reasoning continuity without fabricating thinking blocks", () => {
    const priorContent = [
      { type: "text", text: "I will inspect it." },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { path: "README.md" },
      },
      { type: "thinking", thinking: "not portable", signature: "foreign" },
    ];
    const encryptedReasoning = {
      type: "reasoning",
      encrypted_content: "encrypted",
    };
    const signature = assistantSignature(priorContent);
    const plan = translateAnthropicRequest(
      {
        messages: [
          { role: "assistant", content: priorContent },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "contents",
              },
            ],
          },
        ],
        tools: [
          { name: "Read", input_schema: { type: "object" } },
        ],
      },
      DEFAULT_OPENAI_SETTINGS,
      {
        get(value) {
          return value === signature ? [encryptedReasoning] : undefined;
        },
      },
    );

    expect(plan.request.input).toEqual(
      expect.arrayContaining([
        encryptedReasoning,
        expect.objectContaining({
          type: "function_call_output",
          call_id: "toolu_1",
          output: "contents",
        }),
      ]),
    );
    expect(JSON.stringify(plan.request.input)).not.toContain(
      "not portable",
    );
  });

  it("maps Responses text and parallel function calls back to Claude blocks", () => {
    const plan = translateAnthropicRequest(
      {
        model: "gpt-5.6-sol",
        tools: [
          {
            name: "mcp:files/read",
            input_schema: { type: "object" },
          },
        ],
      },
      DEFAULT_OPENAI_SETTINGS,
    );
    const mappedName = plan.toolNames.toOpenAI.get("mcp:files/read");
    const response = translateOpenAIResponse(
      {
        id: "resp_1",
        model: "gpt-5.6-sol",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Checking both." }],
          },
          {
            type: "function_call",
            call_id: "call:one",
            name: mappedName,
            arguments: "{\"path\":\"a.txt\"}",
          },
          {
            type: "function_call",
            call_id: "call:two",
            name: mappedName,
            arguments: "{\"path\":\"b.txt\"}",
          },
          {
            type: "reasoning",
            encrypted_content: "must-not-leak",
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 40 },
        },
      },
      plan,
    );

    expect(response.stop_reason).toBe("tool_use");
    const content = Array.isArray(response.content)
      ? (response.content as Array<Record<string, unknown>>)
      : [];
    expect(content[0]).toEqual({
      type: "text",
      text: "Checking both.",
    });
    expect(content[1]).toMatchObject({
      type: "tool_use",
      name: "mcp:files/read",
      input: { path: "a.txt" },
    });
    expect(content[2]).toMatchObject({
      type: "tool_use",
      name: "mcp:files/read",
      input: { path: "b.txt" },
    });
    expect(content[1]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(content[2]?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(JSON.stringify(response)).not.toContain("must-not-leak");
  });
});
