import { describe, expect, it } from "vitest";
import {
  isValidSyntheticModelId,
  MODEL_ROLES,
} from "../../src/models/modelRouting.js";
import { DEFAULT_SYNTHETIC_SETTINGS } from "../../src/providers/syntheticProvider.js";

describe("model routing", () => {
  it("defines every Claude routing role", () => {
    expect(MODEL_ROLES.map((role) => role.settingKey)).toEqual([
      "defaultModel",
      "opusModel",
      "sonnetModel",
      "haikuModel",
      "subagentModel",
    ]);
  });

  it("accepts aliases and pinned Hugging Face model IDs", () => {
    expect(isValidSyntheticModelId("syn:large:vision")).toBe(true);
    expect(
      isValidSyntheticModelId("hf:moonshotai/Kimi-K2.7-Code"),
    ).toBe(true);
  });

  it("uses Synthetic's documented Claude Code role defaults", () => {
    expect(DEFAULT_SYNTHETIC_SETTINGS).toMatchObject({
      opusModel: "syn:large:vision",
      sonnetModel: "syn:large:vision",
      haikuModel: "syn:small:text",
      subagentModel: "syn:large:vision",
    });
  });

  it("rejects unsupported or whitespace-containing IDs", () => {
    expect(isValidSyntheticModelId("claude-opus")).toBe(false);
    expect(isValidSyntheticModelId("hf:bad model")).toBe(false);
    expect(isValidSyntheticModelId("syn:")).toBe(false);
  });
});
