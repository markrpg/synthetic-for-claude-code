import { describe, expect, it } from "vitest";
import { findProviderConflicts } from "../../src/validation/conflictDetector.js";

describe("findProviderConflicts", () => {
  it("finds enabled Bedrock, Vertex, and Foundry selections", () => {
    const conflicts = findProviderConflicts([
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
      { name: "CLAUDE_CODE_USE_VERTEX", value: "true" },
      { name: "CLAUDE_CODE_USE_FOUNDRY", value: "yes" },
    ]);
    expect(conflicts.map((conflict) => conflict.providerLabel)).toEqual([
      "Amazon Bedrock",
      "Google Vertex AI",
      "Microsoft Foundry",
    ]);
  });

  it("ignores disabled selections", () => {
    expect(
      findProviderConflicts([
        { name: "CLAUDE_CODE_USE_BEDROCK", value: "0" },
      ]),
    ).toEqual([]);
  });
});
