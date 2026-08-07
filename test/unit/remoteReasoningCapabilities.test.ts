import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { describe, expect, it } from "vitest";
import {
  assertSupportedRemoteEffort,
  resolveRemoteReasoningContext,
} from "../../src/remote/reasoningCapabilities.js";
import type { RemoteProviderContext } from "../../src/remote/types.js";

function provider(
  id: RemoteProviderContext["provider"],
  model: string,
): RemoteProviderContext {
  return {
    provider: id,
    label: id,
    model,
    roleModels: {
      default: model,
      opus: model,
      sonnet: model,
      haiku: model,
      subagent: model,
    },
    updatedAt: 1,
  };
}

function sdkModel(
  value: string,
  efforts: ModelInfo["supportedEffortLevels"],
  options: {
    resolvedModel?: string;
    displayName?: string;
    supportsAdaptiveThinking?: boolean;
  } = {},
): ModelInfo {
  return {
    value,
    ...(options.resolvedModel
      ? { resolvedModel: options.resolvedModel }
      : {}),
    displayName: options.displayName ?? value,
    description: "",
    supportsEffort: true,
    supportedEffortLevels: efforts,
    supportsAdaptiveThinking:
      options.supportsAdaptiveThinking ?? true,
  };
}

describe("remote reasoning capabilities", () => {
  it("accepts None as a control state even when the model catalog omits it", () => {
    const reasoning = resolveRemoteReasoningContext(
      provider("anthropic", "claude-opus-5"),
      [sdkModel("claude-opus-5", ["high", "xhigh"])],
      {},
    );

    expect(() =>
      assertSupportedRemoteEffort(reasoning, "none", "claude-opus-5"),
    ).not.toThrow();
  });

  it("uses Codex model/list rather than the broader Claude custom-model catalog", () => {
    const context = provider("openai-codex", "gpt-5.6-sol");
    context.reasoningEffort = "xhigh";
    context.modelReasoningEfforts = {
      "gpt-5.6-sol": ["high", "xhigh"],
    };

    const reasoning = resolveRemoteReasoningContext(
      context,
      [sdkModel("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"])],
      {},
    );

    expect(reasoning.supportedEffortLevels).toEqual(["high", "xhigh"]);
    expect(reasoning.effectiveEffort).toBe("xhigh");
    expect(reasoning.effortAuthority).toBe("codex-model-list");
  });

  it("reports the inherited Thinking state without changing provider-native effort", () => {
    const context = provider("openai-api", "gpt-5.6-sol");
    context.reasoningEffort = "max";

    const reasoning = resolveRemoteReasoningContext(
      context,
      [sdkModel("gpt-5.6-sol", ["high", "xhigh", "max"])],
      { alwaysThinkingEnabled: false },
    );

    expect(reasoning.thinkingEnabled).toBe(false);
    expect(reasoning.effectiveEffort).toBe("max");
  });

  it("repairs Anthropic Opus max to require Thinking when the live SDK advertises it", () => {
    const context = provider("anthropic", "claude-opus-5");
    context.reasoningEffort = "max";

    const reasoning = resolveRemoteReasoningContext(
      context,
      [
        sdkModel("opus", ["low", "medium", "high", "xhigh", "max"], {
          resolvedModel: "claude-opus-5",
          displayName: "Claude Opus 5",
        }),
      ],
      { alwaysThinkingEnabled: false },
    );

    expect(reasoning).toMatchObject({
      thinkingSupported: true,
      thinkingEnabled: true,
      thinkingAuthority: "claude-sdk",
      effectiveEffort: "max",
      effortAuthority: "claude-sdk",
    });
    expect(() =>
      assertSupportedRemoteEffort(reasoning, "max", "claude-opus-5"),
    ).not.toThrow();
  });

  it("keeps Codex effort available without Claude adaptive-thinking blocks", () => {
    const context = provider("openai-codex", "gpt-5.6-sol");
    context.reasoningEffort = "max";
    context.modelReasoningEfforts = {
      "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
    };

    const reasoning = resolveRemoteReasoningContext(
      context,
      [
        sdkModel("gpt-5.6-sol", ["low"], {
          supportsAdaptiveThinking: false,
        }),
      ],
      { alwaysThinkingEnabled: true },
    );

    expect(reasoning).toMatchObject({
      thinkingSupported: false,
      thinkingEnabled: false,
      thinkingAuthority: "claude-sdk",
      effectiveEffort: "max",
      effortAuthority: "codex-model-list",
    });
  });

  it("falls back to authoritative provider-catalog capability metadata when the SDK row is absent", () => {
    const context = provider("openai-api", "gpt-5.6-sol");
    context.reasoningEffort = "max";
    context.modelCatalog = {
      source: "openai-api",
      authoritative: true,
      updatedAt: 1,
      options: [
        {
          selector: "gpt-5.6-sol",
          resolvedModel: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          source: "openai-api",
          supportsEffort: true,
          supportedEffortLevels: ["high", "xhigh", "max"],
          supportsAdaptiveThinking: true,
        },
      ],
    };

    const reasoning = resolveRemoteReasoningContext(
      context,
      [],
      { alwaysThinkingEnabled: true },
    );

    expect(reasoning).toMatchObject({
      thinkingSupported: true,
      thinkingEnabled: true,
      thinkingAuthority: "openai-model-list",
      supportedEffortLevels: ["high", "xhigh", "max"],
      effectiveEffort: "max",
      effortAuthority: "openai-model-list",
    });
  });

  it("matches a presentation label without using it as the model selector", () => {
    const context = provider(
      "anthropic",
      "Default Claude model",
    );
    const reasoning = resolveRemoteReasoningContext(
      context,
      [
        sdkModel("default", ["low", "high", "max"], {
          resolvedModel: "claude-sonnet-5",
          displayName: "Default Claude model",
        }),
      ],
      {},
    );

    expect(reasoning.thinkingSupported).toBe(true);
    expect(reasoning.supportedEffortLevels).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("does not infer capabilities from an ambiguous display label", () => {
    const reasoning = resolveRemoteReasoningContext(
      provider("anthropic", "Claude Preview"),
      [
        sdkModel("opus-preview", ["high", "max"], {
          displayName: "Claude Preview",
        }),
        sdkModel("sonnet-preview", ["low", "high"], {
          displayName: "Claude Preview",
        }),
      ],
      {},
    );

    expect(reasoning.thinkingSupported).toBe(false);
    expect(reasoning.supportedEffortLevels).toEqual([]);
    expect(reasoning.effortAuthority).toBe("unavailable");
  });

  it("uses catalog selectors when provider state holds a resolved model ID", () => {
    const context = provider("openai-codex", "gpt-5.6-sol-wire");
    context.modelCatalog = {
      source: "codex-model-list",
      authoritative: true,
      updatedAt: 1,
      options: [
        {
          selector: "gpt-5.6-sol",
          resolvedModel: "gpt-5.6-sol-wire",
          displayName: "GPT-5.6 Sol",
          source: "codex-model-list",
        },
      ],
    };
    context.modelReasoningEfforts = {
      "gpt-5.6-sol": ["high", "xhigh", "max"],
    };

    const reasoning = resolveRemoteReasoningContext(
      context,
      [
        sdkModel("gpt-5.6-sol", ["low", "medium", "high"], {
          resolvedModel: "gpt-5.6-sol-wire",
          displayName: "GPT-5.6 Sol",
        }),
      ],
      {},
    );

    expect(reasoning.supportedEffortLevels).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
    expect(reasoning.effortAuthority).toBe("codex-model-list");
  });

  it("reports Ultra eligibility atomically even before its flags are enabled", () => {
    const reasoning = resolveRemoteReasoningContext(
      provider("anthropic", "claude-opus-5"),
      [sdkModel("claude-opus-5", ["low", "high", "xhigh"])],
      { alwaysThinkingEnabled: false, enableWorkflows: false },
      { workflowBridgeReady: true },
    );

    expect(reasoning.workflows).toMatchObject({
      available: true,
      enabled: false,
      experimental: true,
    });
    expect(reasoning.ultra).toMatchObject({
      available: true,
      enabled: false,
      experimental: true,
    });
    expect(reasoning.ultra.unavailableReason).toBeUndefined();
  });

  it("keeps Workflows available but makes Ultra unavailable without xhigh", () => {
    const model = sdkModel("hf:moonshotai/Kimi-K3", ["low"]);
    model.supportsAdaptiveThinking = false;
    const reasoning = resolveRemoteReasoningContext(
      provider("synthetic", "hf:moonshotai/Kimi-K3"),
      [model],
      { alwaysThinkingEnabled: false },
      { workflowBridgeReady: true },
    );

    expect(reasoning.workflows.available).toBe(true);
    expect(reasoning.ultra.available).toBe(false);
    expect(reasoning.ultra.unavailableReason).toMatch(/does not advertise xhigh/iu);
  });

  it("fails closed when an authoritative catalog advertises no effort support", () => {
    const context = provider("openai-api", "gpt-5.6-sol");
    context.modelCatalog = {
      source: "openai-api",
      authoritative: true,
      updatedAt: 1,
      options: [
        {
          selector: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          source: "openai-api",
          supportsEffort: false,
          supportedEffortLevels: [],
        },
      ],
    };
    const reasoning = resolveRemoteReasoningContext(context, [], {});

    expect(reasoning.effortAuthority).toBe("openai-model-list");
    expect(() =>
      assertSupportedRemoteEffort(reasoning, "max", "gpt-5.6-sol"),
    ).toThrow(/does not support max/iu);
  });

  it("rejects an unsupported effort instead of silently downgrading", () => {
    const context = resolveRemoteReasoningContext(
      provider("anthropic", "claude-sonnet-5"),
      [sdkModel("claude-sonnet-5", ["low", "medium", "high"])],
      {},
    );

    expect(() =>
      assertSupportedRemoteEffort(context, "max", "claude-sonnet-5"),
    ).toThrow(/does not support max.*will not silently substitute/iu);
  });
});
