import { describe, expect, it } from "vitest";
import {
  formatOpenAIModelName,
  isCompatibleOpenAIModelId,
  parseOpenAIModels,
} from "../../src/openai/openAIModelService.js";

describe("OpenAI model catalog", () => {
  it("filters discovery through the bundled Claude-tool compatibility catalog", () => {
    expect(
      parseOpenAIModels({
        data: [
          { id: "gpt-5.6-sol" },
          { id: "gpt-5.6-terra" },
          { id: "gpt-5.6-luna" },
          { id: "gpt-realtime" },
          { id: "text-embedding-3-large" },
          { id: "unknown-gpt" },
        ],
      }).map((model) => model.id),
    ).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]);
    expect(isCompatibleOpenAIModelId("gpt-realtime")).toBe(false);
  });

  it("shows canonical model names", () => {
    expect(formatOpenAIModelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(formatOpenAIModelName("custom-model")).toBe("custom-model");
  });
});
