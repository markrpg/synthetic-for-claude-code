import { describe, expect, it } from "vitest";
import { normaliseRemoteQuestions } from "../../src/remote/sessionController.js";

describe("remote Claude questions", () => {
  it("normalises supported AskUserQuestion input for the phone", () => {
    expect(
      normaliseRemoteQuestions({
        questions: [
          {
            header: "Approach",
            question: "Which implementation should I use?",
            multiSelect: false,
            options: [
              {
                label: "Native tunnel",
                description: "Use the editor tunnel service.",
              },
              { label: "Local only" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        header: "Approach",
        question: "Which implementation should I use?",
        multiSelect: false,
        options: [
          {
            label: "Native tunnel",
            description: "Use the editor tunnel service.",
          },
          { label: "Local only", description: undefined },
        ],
      },
    ]);
  });

  it("drops malformed questions and bounds option counts", () => {
    const options = Array.from({ length: 25 }, (_, index) => ({
      label: `Option ${index}`,
    }));
    const result = normaliseRemoteQuestions({
      questions: [
        null,
        { question: "" },
        { question: "Choose", options, multiSelect: true },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.options).toHaveLength(20);
    expect(result[0]?.multiSelect).toBe(true);
  });
});
