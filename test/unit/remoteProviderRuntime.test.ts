import { describe, expect, it } from "vitest";
import {
  anthropicRemoteModel,
  assertRemoteRuntimeModel,
  findUniqueRemoteModelOption,
  mergeProviderUsage,
  resolveRemoteRuntimeModelObservation,
  sameRemoteQueryConfiguration,
  sdkModelForProvider,
} from "../../src/remote/providerRuntime.js";
import type {
  RemoteDaemonConfiguration,
  RemoteModelOption,
  RemoteProviderContext,
} from "../../src/remote/types.js";

const modelOptions: readonly RemoteModelOption[] = [
  {
    selector: "default",
    resolvedModel: "claude-sonnet-5",
    displayName: "Default Claude model",
    source: "claude-sdk",
    isDefault: true,
  },
  {
    selector: "opus",
    resolvedModel: "claude-opus-5",
    displayName: "Claude Opus 5",
    source: "claude-sdk",
  },
];

function provider(
  providerId: RemoteProviderContext["provider"] = "synthetic",
  model = "hf:moonshotai/Kimi-K3",
): RemoteProviderContext {
  return {
    provider: providerId,
    label: providerId === "synthetic" ? "Synthetic" : "Anthropic",
    model,
    roleModels: {
      default: model,
      opus: model,
      sonnet: model,
      haiku: model,
      subagent: model,
    },
    usage: { remaining: 50 },
    updatedAt: 100,
  };
}

function configuration(
  providerContext = provider(),
): RemoteDaemonConfiguration {
  return {
    lease: {
      id: "lease",
      sourceSessionId: "session",
      sourceTranscriptPath: "/workspace/session.jsonl",
      workspacePath: "/workspace",
      workspaceName: "Workspace",
      title: "Conversation",
      state: "paired",
      provider: providerContext,
      createdAt: 1,
      lastActivityAt: 1,
      providerChanged: false,
    },
    workspaceOwnerId: "workspace-owner",
    claudeExecutable: "/usr/local/bin/claude",
    environment: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18296",
      MODELHOP_PROVIDER: providerContext.provider,
    },
    permissionMode: "auto",
    pairedDeviceStoreKey: "key",
    hostIdentityPrivateKey: "private",
    hostIdentityPublicKey: "public",
    launchToken: "x".repeat(43),
    assetsDirectory: "/extension/dist/remote",
    iconPath: "/extension/media/modelhop-icon.png",
    unpairedTimeoutMs: 1,
    idleTimeoutMs: 1,
    maximumSessionMs: 1,
  };
}

describe("remote provider runtime authority", () => {
  it("never carries a previous alternate-provider model into Anthropic", () => {
    expect(anthropicRemoteModel("hf:moonshotai/Kimi-K3")).toBe(
      "default",
    );
    expect(anthropicRemoteModel("gpt-5.6-sol")).toBe("default");
    expect(anthropicRemoteModel(undefined)).toBe("default");
    expect(anthropicRemoteModel("claude-opus-5")).toBe(
      "claude-opus-5",
    );
    expect(anthropicRemoteModel("fable")).toBe("fable");
    expect(anthropicRemoteModel("sonnet")).toBe("sonnet");
    expect(anthropicRemoteModel("Default Claude model")).toBe(
      "default",
    );
    expect(anthropicRemoteModel("DefaultClaudemodel")).toBe(
      "default",
    );
    expect(
      sdkModelForProvider(
        provider("anthropic", "  DEFAULT_CLAUDE_MODEL  "),
      ),
    ).toBe("default");
  });

  it("keeps selector, canonical ID, and display copy separate", () => {
    expect(
      findUniqueRemoteModelOption(modelOptions, "opus"),
    ).toMatchObject({
      matchedBy: "selector",
      option: { selector: "opus" },
    });
    expect(
      findUniqueRemoteModelOption(modelOptions, "claude-opus-5"),
    ).toMatchObject({
      matchedBy: "resolved-model",
      option: { selector: "opus" },
    });
    expect(
      findUniqueRemoteModelOption(modelOptions, "Claude Opus 5"),
    ).toMatchObject({
      matchedBy: "display-name",
      option: { selector: "opus" },
    });
  });

  it("only adopts a runtime observation when its catalog match is unique", () => {
    expect(
      resolveRemoteRuntimeModelObservation(
        "anthropic",
        "default",
        "Claude Opus 5",
        modelOptions,
      ),
    ).toMatchObject({
      selector: "opus",
      matchedBy: "display-name",
      option: { resolvedModel: "claude-opus-5" },
    });

    const ambiguous: readonly RemoteModelOption[] = [
      ...modelOptions,
      {
        selector: "opus-preview",
        resolvedModel: "claude-opus-5-preview",
        displayName: "Claude Opus 5",
        source: "claude-sdk",
      },
    ];
    expect(
      resolveRemoteRuntimeModelObservation(
        "anthropic",
        "sonnet",
        "Claude Opus 5",
        ambiguous,
      ),
    ).toEqual({ selector: "sonnet" });
    expect(
      resolveRemoteRuntimeModelObservation(
        "synthetic",
        "hf:moonshotai/Kimi-K3",
        "Future presentation label",
        modelOptions,
      ),
    ).toEqual({ selector: "hf:moonshotai/Kimi-K3" });
  });

  it("normalises Anthropic's default presentation sentinel without a catalog", () => {
    expect(
      resolveRemoteRuntimeModelObservation(
        "anthropic",
        "DefaultClaudemodel",
        "Default Claude model",
      ),
    ).toEqual({
      selector: "default",
      matchedBy: "anthropic-default",
    });
  });

  it("fails closed when a known model family contradicts the provider label", () => {
    expect(() =>
      assertRemoteRuntimeModel(
        "anthropic",
        "hf:moonshotai/Kimi-K3",
      ),
    ).toThrow(/expected the anthropic route/i);
    expect(() =>
      assertRemoteRuntimeModel("synthetic", "claude-opus-5"),
    ).toThrow(/expected the synthetic route/i);
    expect(() =>
      assertRemoteRuntimeModel("openai-codex", "claude-sonnet-5"),
    ).toThrow(/expected the openai-codex route/i);
    expect(() =>
      assertRemoteRuntimeModel(
        "synthetic",
        "hf:openai/gpt-oss-120b",
      ),
    ).not.toThrow();
    expect(() =>
      assertRemoteRuntimeModel("anthropic", "future-model"),
    ).not.toThrow();
  });

  it("ignores presentation-only usage changes when deciding to restart", () => {
    const before = configuration();
    const after = structuredClone(before);
    after.lease.provider.usage = { remaining: 25 };
    after.lease.provider.updatedAt += 1;

    expect(sameRemoteQueryConfiguration(before, after)).toBe(true);
  });

  it("requires a new query when the model or provider environment changes", () => {
    const before = configuration();
    const changedModel = structuredClone(before);
    changedModel.lease.provider.model = "hf:moonshotai/Kimi-K3.1";
    changedModel.lease.provider.roleModels.default =
      "hf:moonshotai/Kimi-K3.1";
    expect(
      sameRemoteQueryConfiguration(before, changedModel),
    ).toBe(false);

    const changedEnvironment = structuredClone(before);
    changedEnvironment.environment.ANTHROPIC_BASE_URL =
      "https://api.synthetic.new/anthropic";
    expect(
      sameRemoteQueryConfiguration(before, changedEnvironment),
    ).toBe(false);
  });

  it("merges usage without allowing a refresh to relabel the query", () => {
    const active = provider();
    const refreshed = {
      ...provider(),
      model: "stale-model",
      roleModels: {
        ...provider().roleModels,
        default: "stale-model",
      },
      usage: { remaining: 24 },
      updatedAt: 200,
    };
    const merged = mergeProviderUsage(active, refreshed);

    expect(merged.model).toBe("hf:moonshotai/Kimi-K3");
    expect(merged.roleModels.default).toBe(
      "hf:moonshotai/Kimi-K3",
    );
    expect(merged.usage).toEqual({ remaining: 24 });
    expect(() =>
      mergeProviderUsage(
        active,
        provider("anthropic", "claude-opus-5"),
      ),
    ).toThrow(/active synthetic remote query/i);
  });
});
