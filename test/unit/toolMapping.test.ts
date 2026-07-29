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

  it("hashes unusually long IDs into a bounded Anthropic-safe value", () => {
    const mapped = toAnthropicToolId("tool:".repeat(100));

    expect(mapped).toMatch(/^mh_hash_[a-f0-9]{24}$/);
  });
});
