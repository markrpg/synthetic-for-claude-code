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

  it("uses readable exact model IDs by default", () => {
    expect(DEFAULT_SYNTHETIC_SETTINGS).toMatchObject({
      defaultModel: "hf:moonshotai/Kimi-K3",
      opusModel: "hf:moonshotai/Kimi-K3",
      sonnetModel: "hf:moonshotai/Kimi-K3",
      haikuModel: "hf:zai-org/GLM-4.7-Flash",
      subagentModel: "hf:moonshotai/Kimi-K3",
    });
  });

  it("rejects unsupported or whitespace-containing IDs", () => {
    expect(isValidSyntheticModelId("claude-opus")).toBe(false);
    expect(isValidSyntheticModelId("hf:bad model")).toBe(false);
    expect(isValidSyntheticModelId("syn:")).toBe(false);
  });
});
