import { describe, expect, it } from "vitest";
import { detectProvider } from "../../src/validation/providerDetector.js";

describe("detectProvider", () => {
  it("detects no base URL as Anthropic", () => {
    expect(detectProvider([])).toBe("anthropic");
  });

  it("detects the exact Synthetic URL", () => {
    expect(
      detectProvider([
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://api.synthetic.new/anthropic",
        },
      ]),
    ).toBe("synthetic");
  });

  it("normalises a trailing slash", () => {
    expect(
      detectProvider([
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://api.synthetic.new/anthropic/",
        },
      ]),
    ).toBe("synthetic");
  });

  it("detects localhost as a custom gateway", () => {
    expect(
      detectProvider([
        {
          name: "ANTHROPIC_BASE_URL",
          value: "http://localhost:4000",
        },
      ]),
    ).toBe("custom");
  });

  it("detects another HTTPS gateway as custom", () => {
    expect(
      detectProvider([
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://gateway.example.invalid/anthropic",
        },
      ]),
    ).toBe("custom");
  });

  it("detects all ModelHop bridge routes by their ownership marker", () => {
    for (const provider of [
      "synthetic",
      "openai-api",
      "openai-codex",
    ] as const) {
      expect(
        detectProvider(
          [
            {
              name: "ANTHROPIC_BASE_URL",
              value: "http://127.0.0.1:17777",
            },
            { name: "MODELHOP_PROVIDER", value: provider },
          ],
          undefined,
          "http://127.0.0.1:17777",
        ),
      ).toBe(provider);
    }
  });

  it("fails closed when a loopback bridge lacks a valid ownership marker", () => {
    expect(
      detectProvider(
        [
          {
            name: "ANTHROPIC_BASE_URL",
            value: "http://127.0.0.1:17777",
          },
        ],
        undefined,
        "http://127.0.0.1:17777",
      ),
    ).toBe("invalid");
  });

  it("recognises a configured replacement Synthetic endpoint", () => {
    expect(
      detectProvider(
        [
          {
            name: "ANTHROPIC_BASE_URL",
            value: "https://new.synthetic.example/anthropic",
          },
        ],
        "https://new.synthetic.example/anthropic",
      ),
    ).toBe("synthetic");
  });

  it("detects a malformed URL as invalid", () => {
    expect(
      detectProvider([
        { name: "ANTHROPIC_BASE_URL", value: "not a url" },
      ]),
    ).toBe("invalid");
  });

  it("detects malformed array entries as invalid", () => {
    expect(detectProvider([{ name: "MCP_TIMEOUT" }])).toBe("invalid");
  });
});
