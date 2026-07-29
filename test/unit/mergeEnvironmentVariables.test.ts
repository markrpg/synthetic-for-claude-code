import { describe, expect, it } from "vitest";
import {
  mergeEnvironmentVariables,
  normaliseEnvironmentVariables,
  preserveExistingSharedVariables,
} from "../../src/configuration/mergeEnvironmentVariables.js";
import type { EnvironmentVariable } from "../../src/providers/types.js";

const synthetic: EnvironmentVariable[] = [
  {
    name: "ANTHROPIC_BASE_URL",
    value: "https://api.synthetic.new/anthropic",
  },
  { name: "ANTHROPIC_AUTH_TOKEN", value: "test-placeholder" },
  { name: "ANTHROPIC_MODEL", value: "syn:large:vision" },
  {
    name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    value: "1",
  },
];

const anthropic: EnvironmentVariable[] = [
  {
    name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    value: "1",
  },
  { name: "CLAUDE_CODE_ATTRIBUTION_HEADER", value: "0" },
];

describe("mergeEnvironmentVariables", () => {
  it("handles an empty existing configuration", () => {
    expect(mergeEnvironmentVariables([], synthetic)).toEqual(synthetic);
  });

  it("preserves unrelated variables", () => {
    const existing = [{ name: "MCP_TIMEOUT", value: "30000" }];
    expect(mergeEnvironmentVariables(existing, synthetic)[0]).toEqual(
      existing[0],
    );
  });

  it("replaces existing Synthetic keys", () => {
    const result = mergeEnvironmentVariables(
      [{ name: "ANTHROPIC_MODEL", value: "old" }],
      synthetic,
    );
    expect(
      result.find((variable) => variable.name === "ANTHROPIC_MODEL")
        ?.value,
    ).toBe("syn:large:vision");
  });

  it("removes duplicate managed keys", () => {
    const result = mergeEnvironmentVariables(
      [
        { name: "ANTHROPIC_MODEL", value: "old-one" },
        { name: "ANTHROPIC_MODEL", value: "old-two" },
      ],
      synthetic,
    );
    expect(
      result.filter((variable) => variable.name === "ANTHROPIC_MODEL"),
    ).toHaveLength(1);
  });

  it("can preserve shared preferences explicitly", () => {
    const replacement = preserveExistingSharedVariables(
      [
        {
          name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
          value: "0",
        },
      ],
      synthetic,
    );
    expect(
      replacement.find(
        (variable) =>
          variable.name ===
          "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      )?.value,
    ).toBe("0");
  });

  it("removes the Synthetic token when switching to Anthropic", () => {
    const result = mergeEnvironmentVariables(synthetic, anthropic);
    expect(
      result.some(
        (variable) => variable.name === "ANTHROPIC_AUTH_TOKEN",
      ),
    ).toBe(false);
  });

  it("inserts required keys when switching to Synthetic", () => {
    const result = mergeEnvironmentVariables(anthropic, synthetic);
    expect(
      result.some(
        (variable) => variable.name === "ANTHROPIC_BASE_URL",
      ),
    ).toBe(true);
    expect(
      result.some(
        (variable) => variable.name === "ANTHROPIC_AUTH_TOKEN",
      ),
    ).toBe(true);
  });

  it("is idempotent", () => {
    const once = mergeEnvironmentVariables([], synthetic);
    expect(mergeEnvironmentVariables(once, synthetic)).toEqual(once);
  });

  it("drops malformed entries consistently", () => {
    const malformed: unknown[] = [
      null,
      { name: 12, value: "bad" },
      { name: "MCP_TIMEOUT" },
      { name: "MCP_TIMEOUT", value: "30000" },
    ];
    expect(mergeEnvironmentVariables(malformed, anthropic)[0]).toEqual({
      name: "MCP_TIMEOUT",
      value: "30000",
    });
    expect(normaliseEnvironmentVariables(malformed).malformedEntries).toHaveLength(
      3,
    );
  });

  it("uses deterministic preserved-then-profile ordering", () => {
    const result = mergeEnvironmentVariables(
      [
        { name: "Z_UNRELATED", value: "z" },
        { name: "ANTHROPIC_MODEL", value: "old" },
        { name: "A_UNRELATED", value: "a" },
      ],
      [
        { name: "ANTHROPIC_MODEL", value: "first" },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "token" },
        { name: "ANTHROPIC_MODEL", value: "last" },
      ],
    );
    expect(result).toEqual([
      { name: "Z_UNRELATED", value: "z" },
      { name: "A_UNRELATED", value: "a" },
      { name: "ANTHROPIC_MODEL", value: "last" },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "token" },
    ]);
  });
});
