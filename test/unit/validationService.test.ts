import { describe, expect, it } from "vitest";
import { mergeEnvironmentVariables } from "../../src/configuration/mergeEnvironmentVariables.js";
import { anthropicProfile } from "../../src/providers/anthropicProvider.js";
import {
  createSyntheticProfile,
  DEFAULT_SYNTHETIC_SETTINGS,
} from "../../src/providers/syntheticProvider.js";
import {
  createOpenAIProfile,
  DEFAULT_OPENAI_SETTINGS,
} from "../../src/providers/openAIProvider.js";
import {
  ConfigurationValidationError,
  ValidationService,
} from "../../src/validation/validationService.js";

const service = new ValidationService();
const synthetic = [
  ...createSyntheticProfile().environmentVariables,
  { name: "ANTHROPIC_AUTH_TOKEN", value: "test-placeholder" },
];

function expectInvalid(variables: unknown, provider = "synthetic"): void {
  expect(() => {
    service.validateVariables(
      provider as "synthetic" | "anthropic",
      variables,
      DEFAULT_SYNTHETIC_SETTINGS,
    );
  }).toThrow(ConfigurationValidationError);
}

describe("ValidationService", () => {
  it("rejects a missing token", () => {
    expectInvalid(createSyntheticProfile().environmentVariables);
  });

  it("rejects a missing base URL", () => {
    expectInvalid(
      synthetic.filter(
        (variable) => variable.name !== "ANTHROPIC_BASE_URL",
      ),
    );
  });

  it("rejects HTTP for Synthetic", () => {
    expectInvalid(
      synthetic.map((variable) =>
        variable.name === "ANTHROPIC_BASE_URL"
          ? {
              ...variable,
              value: "http://api.synthetic.new/anthropic",
            }
          : variable,
      ),
    );
  });

  it("rejects an empty model value", () => {
    expectInvalid(
      synthetic.map((variable) =>
        variable.name === "ANTHROPIC_MODEL"
          ? { ...variable, value: "" }
          : variable,
      ),
    );
  });

  it("rejects duplicate managed keys", () => {
    expectInvalid([
      ...synthetic,
      { name: "ANTHROPIC_MODEL", value: "syn:large:vision" },
    ]);
  });

  it("rejects Bedrock conflicts", () => {
    expectInvalid([
      ...synthetic,
      { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
    ]);
  });

  it("rejects Vertex conflicts", () => {
    expectInvalid([
      ...synthetic,
      { name: "CLAUDE_CODE_USE_VERTEX", value: "true" },
    ]);
  });

  it("accepts a valid Synthetic profile", () => {
    expect(
      service.validateVariables(
        "synthetic",
        synthetic,
        DEFAULT_SYNTHETIC_SETTINGS,
      ),
    ).toEqual(synthetic);
  });

  it("accepts a valid Anthropic profile with unrelated variables", () => {
    const variables = mergeEnvironmentVariables(
      [{ name: "MCP_TIMEOUT", value: "30000" }],
      anthropicProfile.environmentVariables,
    );
    expect(
      service.validateVariables(
        "anthropic",
        variables,
        DEFAULT_SYNTHETIC_SETTINGS,
      ),
    ).toEqual(variables);
  });

  it("accepts a native Anthropic API key", () => {
    const variables = [
      { name: "ANTHROPIC_API_KEY", value: "test-placeholder" },
    ];
    expect(
      service.validateVariables(
        "anthropic",
        variables,
        DEFAULT_SYNTHETIC_SETTINGS,
      ),
    ).toEqual(variables);
  });

  it("rejects stale Synthetic values in Anthropic mode", () => {
    expectInvalid(
      [
        ...anthropicProfile.environmentVariables,
        { name: "ANTHROPIC_MODEL", value: "syn:large:vision" },
      ],
      "anthropic",
    );
  });

  it("accepts a loopback OpenAI API profile with bridge-only auth", () => {
    const settings = {
      ...DEFAULT_OPENAI_SETTINGS,
      baseUrl: "http://127.0.0.1:17777",
    };
    const variables = [
      ...createOpenAIProfile("openai-api", settings).environmentVariables.slice(
        0,
        1,
      ),
      { name: "ANTHROPIC_AUTH_TOKEN", value: "bridge-only-token" },
      ...createOpenAIProfile(
        "openai-api",
        settings,
      ).environmentVariables.slice(1),
    ];

    expect(
      service.validateVariables(
        "openai-api",
        variables,
        DEFAULT_SYNTHETIC_SETTINGS,
        settings,
      ),
    ).toEqual(variables);
  });

  it("rejects a non-loopback bridge and an exposed OpenAI/Anthropic key", () => {
    const settings = {
      ...DEFAULT_OPENAI_SETTINGS,
      baseUrl: "https://gateway.example.invalid",
    };
    const variables = [
      ...createOpenAIProfile("openai-api", settings).environmentVariables,
      { name: "ANTHROPIC_AUTH_TOKEN", value: "bridge-only-token" },
      { name: "ANTHROPIC_API_KEY", value: "must-not-be-here" },
    ];

    expect(() =>
      service.validateVariables(
        "openai-api",
        variables,
        DEFAULT_SYNTHETIC_SETTINGS,
        settings,
      ),
    ).toThrow(ConfigurationValidationError);
  });
});
