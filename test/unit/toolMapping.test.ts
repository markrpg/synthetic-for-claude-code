import { describe, expect, it } from "vitest";
import {
  buildToolNameMapping,
  fromAnthropicToolId,
  toAnthropicToolId,
} from "../../src/bridge/toolMapping.js";

describe("bridge tool mapping", () => {
  it("keeps compatible names and deterministically maps incompatible names", () => {
    const first = buildToolNameMapping(["Read", "mcp:server/tool name"]);
    const second = buildToolNameMapping(["Read", "mcp:server/tool name"]);
    const mapped = first.toOpenAI.get("mcp:server/tool name");

    expect(first.toOpenAI.get("Read")).toBe("Read");
    expect(mapped).toMatch(/^modelhop_[a-f0-9]{24}$/);
    expect(second.toOpenAI.get("mcp:server/tool name")).toBe(mapped);
    expect(first.fromOpenAI.get(mapped ?? "")).toBe(
      "mcp:server/tool name",
    );
  });

  it("round-trips incompatible tool IDs without exposing invalid characters", () => {
    const source = "mcp:tool/call 1";
    const mapped = toAnthropicToolId(source);

    expect(mapped).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(fromAnthropicToolId(mapped)).toBe(source);
  });

  it("escapes Codex-reserved tool names and namespaces", () => {
    const names = [
      "mcp__runpod__attach-tag",
      "codex_apps__github",
      "tool_search",
      "Read",
    ];
    const mapping = buildToolNameMapping(names);

    expect(mapping.toOpenAI.get("mcp__runpod__attach-tag")).toBe(
      "modelhop_mcp__runpod__attach-tag",
    );
    expect(mapping.toOpenAI.get("codex_apps__github")).toBe(
      "modelhop_codex_apps__github",
    );
    expect(mapping.toOpenAI.get("tool_search")).toBe(
      "modelhop_tool_search",
    );
    expect(mapping.toOpenAI.get("Read")).toBe("Read");
    for (const original of names) {
      const mapped = mapping.toOpenAI.get(original);
      expect(mapping.fromOpenAI.get(mapped ?? "")).toBe(original);
    }
  });

  it("hashes unusually long IDs into a bounded Anthropic-safe value", () => {
    const mapped = toAnthropicToolId("tool:".repeat(100));

    expect(mapped).toMatch(/^mh_hash_[a-f0-9]{24}$/);
  });
});
