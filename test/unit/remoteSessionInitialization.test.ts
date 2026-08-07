import type {
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  query as createSdkQuery,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { describe, expect, it, vi } from "vitest";
import type { RemoteEventJournal } from "../../src/remote/eventJournal.js";
import { RemoteSessionController } from "../../src/remote/sessionController.js";
import {
  remoteLifecycleDecision,
  REMOTE_MAXIMUM_SESSION_MS,
} from "../../src/remote/lifecyclePolicy.js";
import type {
  RemoteConversationEvent,
  RemoteDaemonConfiguration,
  RemoteJournalEvent,
  RemoteOperation,
  RemoteProviderContext,
} from "../../src/remote/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryJournal {
  public readonly events: RemoteJournalEvent[] = [];

  public latestId(): number {
    return this.events.at(-1)?.id ?? 0;
  }

  public async append(
    type: RemoteJournalEvent["type"],
    payload: unknown,
  ): Promise<RemoteJournalEvent> {
    const event: RemoteJournalEvent = {
      id: this.events.length + 1,
      type,
      createdAt: Date.now(),
      payload,
    };
    this.events.push(event);
    return event;
  }

  public asJournal(): RemoteEventJournal {
    return this as unknown as RemoteEventJournal;
  }
}

class FakeQuery implements AsyncIterable<SDKMessage> {
  private currentModel = "fake-model";
  private readonly effectiveSettings: Record<string, unknown> = {};
  private readonly initialization =
    deferred<SDKControlInitializeResponse>();
  private readonly messages: SDKMessage[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<SDKMessage>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;

  public readonly close = vi.fn(() => {
    if (this.closeEndsIterator) {
      this.end();
    }
  });

  public readonly initializationResult = vi.fn(
    () => this.initialization.promise,
  );

  public readonly interrupt = vi.fn(async () => undefined);

  public readonly stopTask = vi.fn(async (taskId: string) => {
    void taskId;
  });

  public readonly setModel = vi.fn(async (model?: string) => {
    if (model) {
      this.currentModel = model;
    }
  });

  public readonly setPermissionMode = vi.fn(
    async (
      mode:
        | "default"
        | "acceptEdits"
        | "bypassPermissions"
        | "plan"
        | "dontAsk"
        | "auto",
    ) => {
      void mode;
    },
  );

  public readonly applyFlagSettings = vi.fn(
    async (settings: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(settings)) {
        if (value === null) {
          delete this.effectiveSettings[key];
        } else {
          this.effectiveSettings[key] = value;
        }
      }
    },
  );

  public readonly setMaxThinkingTokens = vi.fn(
    async (
      maxThinkingTokens: number | null,
      thinkingDisplay?: "summarized" | "omitted" | null,
    ) => {
      void maxThinkingTokens;
      void thinkingDisplay;
    },
  );

  public readonly getSettings = vi.fn(async () => ({
    effective: { ...this.effectiveSettings },
  }));

  public readonly getContextUsage = vi.fn(async () => ({
    totalTokens: 0,
    maxTokens: 200_000,
    percentage: 0,
    model: this.currentModel,
  }));

  public constructor(
    private readonly closeEndsIterator = true,
  ) {}

  public resolveInitialization(
    models: SDKControlInitializeResponse["models"] = [],
  ): void {
    this.initialization.resolve({
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: [],
      models,
      account: {},
    });
  }

  public reportRuntimeModel(model: string): void {
    this.currentModel = model;
  }

  public rejectInitialization(error: unknown): void {
    this.initialization.reject(error);
  }

  public push(message: SDKMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.messages.push(message);
  }

  public end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  public fail(error: unknown): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  public asQuery(): Query {
    return this as unknown as Query;
  }

  public [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKMessage>> => {
        const message = this.messages.shift();
        if (message) {
          return { value: message, done: false };
        }
        if (this.ended) {
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<SDKMessage>>(
          (resolve, reject) => {
            this.waiters.push({ resolve, reject });
          },
        );
      },
    };
  }
}

function provider(
  providerId: RemoteProviderContext["provider"] = "anthropic",
): RemoteProviderContext {
  const model =
    providerId === "anthropic" ? "claude-sonnet" : "syn:large:text";
  return {
    provider: providerId,
    label: providerId === "anthropic" ? "Anthropic" : "Synthetic",
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

function modelInfo(
  value: string,
  efforts: Array<"low" | "medium" | "high" | "xhigh" | "max">,
  supportsAdaptiveThinking = true,
): SDKControlInitializeResponse["models"][number] {
  return {
    value,
    displayName: value,
    description: "",
    supportsEffort: true,
    supportedEffortLevels: efforts,
    supportsAdaptiveThinking,
  };
}

function configuration(
  providerContext: RemoteProviderContext = provider(),
): RemoteDaemonConfiguration {
  return {
    lease: {
      id: "remote-lease",
      sourceSessionId: "source-session",
      sourceTranscriptPath: "/workspace/source-session.jsonl",
      workspacePath: "/workspace",
      workspacePaths: ["/workspace"],
      workspaceName: "Workspace",
      title: "Remote initialization",
      state: "starting",
      provider: providerContext,
      createdAt: 1,
      lastActivityAt: 1,
      providerChanged: false,
      turnPhase: "idle",
    },
    workspaceOwnerId: "workspace-owner",
    claudeExecutable: "/usr/local/bin/claude",
    environment: {},
    permissionMode: "auto",
    pairedDeviceStoreKey: "device-store-key",
    hostIdentityPrivateKey: "host-private-key",
    hostIdentityPublicKey: "host-public-key",
    launchToken: "x".repeat(43),
    assetsDirectory: "/extension/dist/remote",
    iconPath: "/extension/media/modelhop-icon.png",
    unpairedTimeoutMs: 10 * 60_000,
    idleTimeoutMs: 60 * 60_000,
    maximumSessionMs: 8 * 60 * 60_000,
  };
}

function createController(
  fakeQuery: FakeQuery,
  journal = new MemoryJournal(),
  timing: {
    initializationTimeoutMs?: number;
    closeGraceMs?: number;
    cancellationGraceMs?: number;
  } = {},
  providerContext: RemoteProviderContext = provider(),
): {
  controller: RemoteSessionController;
  journal: MemoryJournal;
  queryFactory: ReturnType<typeof vi.fn>;
  getRequest: () => Parameters<typeof createSdkQuery>[0];
} {
  let capturedRequest: Parameters<typeof createSdkQuery>[0] | undefined;
  const queryFactory = vi.fn(
    (request: Parameters<typeof createSdkQuery>[0]) => {
      capturedRequest = request;
      return fakeQuery.asQuery();
    },
  );
  return {
    controller: new RemoteSessionController(
      configuration(providerContext),
      journal.asJournal(),
      undefined,
      queryFactory,
      timing,
    ),
    journal,
    queryFactory,
    getRequest: () => {
      if (!capturedRequest) {
        throw new Error("The Claude query has not been created.");
      }
      return capturedRequest;
    },
  };
}

async function start(controller: RemoteSessionController): Promise<void> {
  await controller.start({
    resumeSessionId: "source-session",
    forkSession: false,
  });
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function rootAssistantError(
  error: "rate_limit" | "billing_error" = "rate_limit",
  uuid = `assistant-${error}`,
): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    error,
    uuid,
    session_id: "source-session",
    message: {
      id: `message-${error}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet",
      content: [
        {
          type: "text",
          text:
            error === "rate_limit"
              ? "You've hit your session limit."
              : "Billing is unavailable.",
        },
      ],
      stop_reason: "stop_sequence",
      stop_sequence: "",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  } as unknown as SDKMessage;
}

function failedSdkResult(uuid: string): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    uuid,
    session_id: "source-session",
    is_error: true,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: ["rate limited"],
  } as unknown as SDKMessage;
}

describe("remote Claude session initialization", () => {
  it("uses the authoritative lease mode when recovering query configuration", async () => {
    const query = new FakeQuery();
    const recovered = configuration();
    recovered.lease.permissionMode = "plan";
    recovered.permissionMode = "auto";
    let request: Parameters<typeof createSdkQuery>[0] | undefined;
    const controller = new RemoteSessionController(
      recovered,
      new MemoryJournal().asJournal(),
      undefined,
      (input) => {
        request = input;
        return query.asQuery();
      },
    );
    const starting = start(controller);
    query.resolveInitialization();
    await starting;

    expect(request?.options?.permissionMode).toBe("plan");
    expect(controller.getLease().permissionMode).toBe("plan");

    await controller.close();
  });

  it.each([
    ["auto-safe", "auto"],
    ["acceptEdits", "acceptEdits"],
    ["default", "default"],
    ["plan", "plan"],
  ] as const)(
    "commits %s as authoritative permission state",
    async (remoteMode, sdkMode) => {
      const query = new FakeQuery();
      const journal = new MemoryJournal();
      const { controller } = createController(query, journal);
      const starting = start(controller);
      query.resolveInitialization();
      await starting;

      await controller.setPermissionMode(remoteMode);

      expect(query.setPermissionMode).toHaveBeenLastCalledWith(
        sdkMode,
      );
      expect(controller.getLease().permissionMode).toBe(remoteMode);
      expect(
        controller.getRuntimeSnapshot().lease.permissionMode,
      ).toBe(remoteMode);
      expect(
        journal.events
          .filter((event) => event.type === "session.capabilities")
          .at(-1)?.payload,
      ).toMatchObject({
        kind: "session.capabilities",
        permissionMode: remoteMode,
      });

      await controller.close();
    },
  );

  it("marks the SDK child as a Claude VS Code session so the IDE can discover its fork", async () => {
    const query = new FakeQuery();
    const queryFactory = vi.fn(
      (request: Parameters<typeof createSdkQuery>[0]) => {
        void request;
        return query.asQuery();
      },
    );
    const controller = new RemoteSessionController(
      configuration(),
      new MemoryJournal().asJournal(),
      undefined,
      queryFactory,
      {
        initializationTimeoutMs: 100,
        closeGraceMs: 5,
      },
    );
    const starting = start(controller);
    query.resolveInitialization();

    await starting;

    expect(
      queryFactory.mock.calls[0]?.[0]?.options?.env,
    ).toMatchObject({
      CLAUDE_AGENT_SDK_CLIENT_APP: "modelhop-remote/1.0.0",
      CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
    });
    expect(queryFactory.mock.calls[0]?.[0]?.options?.model).toBe(
      "claude-sonnet",
    );
    expect(
      queryFactory.mock.calls[0]?.[0]?.options?.forwardSubagentText,
    ).toBe(true);
    const mandatoryAsks = queryFactory.mock.calls[0]?.[0]?.options
      ?.managedSettings?.permissions?.ask;
    expect(mandatoryAsks).toContain("Bash(git push *)");
    expect(mandatoryAsks).not.toContain("Workflow");
    expect(mandatoryAsks).not.toContain("WebFetch");
    expect(mandatoryAsks).not.toContain("WebSearch");
    await controller.stop();
  });

  it("revalidates a stale unsupported Anthropic xhigh pair against the fresh launch catalog", async () => {
    const query = new FakeQuery();
    const providerContext = provider("anthropic");
    providerContext.model = "claude-opus-5";
    providerContext.roleModels.default = "claude-opus-5";
    providerContext.reasoningEffort = "xhigh";
    providerContext.reasoning = {
      thinkingSupported: false,
      thinkingEnabled: false,
      thinkingAuthority: "claude-sdk",
      supportedEffortLevels: ["high", "xhigh"],
      effectiveEffort: "xhigh",
      effortAuthority: "claude-sdk",
      workflows: { available: true, enabled: false },
      ultra: { available: true, enabled: false },
    };
    const { controller, queryFactory } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
      providerContext,
    );
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-opus-5", ["high", "xhigh"]),
    ]);

    await starting;

    const launchRequest = queryFactory.mock.calls[0]?.[0] as
      | Parameters<typeof createSdkQuery>[0]
      | undefined;
    expect(launchRequest?.options).toMatchObject({
      model: "claude-opus-5",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "xhigh",
      settings: {
        alwaysThinkingEnabled: true,
      },
    });
    expect(controller.getLease().provider.reasoning).toMatchObject({
      thinkingEnabled: true,
      effectiveEffort: "xhigh",
    });
    await controller.stop();
  });

  it("publishes Anthropic's real model catalog without using its display label as a selector", async () => {
    const query = new FakeQuery();
    const providerContext = provider("anthropic");
    providerContext.model = "default";
    providerContext.roleModels.default = "default";
    const { controller } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
      providerContext,
    );
    const starting = start(controller);
    query.resolveInitialization([
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default Claude model",
        description: "Use Claude Code's recommended model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "claude-opus-5",
        resolvedModel: "claude-opus-5-20260715",
        displayName: "Claude Opus 5",
        description: "Most capable Claude model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "claude-fable-5[1m]",
        resolvedModel: "claude-fable-5",
        displayName: "Fable",
        description:
          "Fable 5 · Most capable for your hardest and longest-running tasks",
        supportsEffort: true,
        supportedEffortLevels: [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ],
        supportsAdaptiveThinking: true,
      },
    ]);
    await starting;

    expect(controller.getLease().provider).toMatchObject({
      model: "default",
      modelCatalog: {
        source: "claude-sdk",
        authoritative: true,
        options: [
          {
            selector: "default",
            resolvedModel: "claude-sonnet-5",
            displayName: "Default Claude model",
          },
          {
            selector: "claude-opus-5",
            resolvedModel: "claude-opus-5-20260715",
            displayName: "Claude Opus 5",
          },
          {
            selector: "claude-fable-5[1m]",
            resolvedModel: "claude-fable-5",
            displayName: "Fable",
          },
        ],
      },
    });

    await controller.setModel("claude-fable-5[1m]", "max");
    expect(query.setModel).toHaveBeenLastCalledWith(
      "claude-fable-5[1m]",
    );
    expect(controller.getLease().provider.model).toBe(
      "claude-fable-5[1m]",
    );

    await controller.setModel("Default Claude model", "high");
    expect(query.setModel).toHaveBeenLastCalledWith("default");
    expect(controller.getLease().provider.model).toBe("default");
    await controller.stop();
  });

  it("keeps the active query model snapshot synchronized after a model change", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high"]),
      modelInfo("claude-opus-5", ["high"]),
    ]);
    await starting;

    await controller.setModel("claude-opus-5", "high");
    query.push({
      type: "result",
      subtype: "success",
      uuid: "result-after-model-change",
      session_id: "remote-session",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "Done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    } as unknown as SDKMessage);

    await waitFor(() =>
      journal.events.some(
        (event) =>
          event.type === "usage.snapshot" &&
          (event.payload as { model?: string }).model ===
            "claude-opus-5",
      ),
    );
    expect(query.setModel).toHaveBeenCalledWith("claude-opus-5");
    expect(query.applyFlagSettings).toHaveBeenCalledWith({
      effortLevel: "high",
    });
    expect(controller.getLease().provider.model).toBe(
      "claude-opus-5",
    );

    await controller.stop();
  });

  it("applies xhigh reasoning and explicitly clears reasoning when disabled", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high"]),
      modelInfo("claude-opus-5", ["high", "xhigh"]),
    ]);
    await starting;

    await controller.setModel("claude-opus-5", "xhigh");
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      alwaysThinkingEnabled: true,
      effortLevel: "xhigh",
    });
    expect(query.setMaxThinkingTokens).toHaveBeenCalledWith(
      31_999,
      "summarized",
    );
    expect(
      query.setMaxThinkingTokens.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      query.applyFlagSettings.mock.invocationCallOrder.at(-1) ?? 0,
    );

    await controller.setModel("claude-opus-5", "none");
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      alwaysThinkingEnabled: false,
      effortLevel: null,
    });
    expect(controller.getLease().provider.reasoningEffort).toBe("none");

    await controller.stop();
  });

  it("turns off the previous runtime Thinking budget on a model without adaptive Thinking", async () => {
    const query = new FakeQuery();
    const providerContext = provider("anthropic");
    providerContext.model = "claude-opus-5";
    providerContext.roleModels.default = "claude-opus-5";
    providerContext.reasoningEffort = "xhigh";
    providerContext.reasoning = {
      thinkingSupported: true,
      thinkingEnabled: true,
      thinkingAuthority: "claude-sdk",
      supportedEffortLevels: ["high", "xhigh"],
      effectiveEffort: "xhigh",
      effortAuthority: "claude-sdk",
      workflows: { available: true, enabled: false },
      ultra: { available: true, enabled: false },
    };
    const { controller } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
      providerContext,
    );
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-opus-5", ["high", "xhigh"]),
      modelInfo("claude-basic", ["high"], false),
    ]);
    await starting;
    query.setMaxThinkingTokens.mockClear();

    await controller.setModel("claude-basic", "high");

    expect(query.setMaxThinkingTokens).toHaveBeenLastCalledWith(
      0,
      undefined,
    );
    expect(controller.getLease().provider.reasoning).toMatchObject({
      thinkingSupported: false,
      thinkingEnabled: false,
      effectiveEffort: "high",
    });
    await controller.stop();
  });

  it("rolls the SDK model and flags back when applying the new model effort fails", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
    );
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["low", "medium", "high"]),
      modelInfo("claude-opus-5", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ]);
    await starting;
    query.applyFlagSettings.mockRejectedValueOnce(
      new Error("max could not be applied"),
    );

    await expect(
      controller.setModel("claude-opus-5", "max"),
    ).rejects.toThrow("max could not be applied");

    expect(query.setModel.mock.calls).toEqual([
      ["claude-opus-5"],
      ["claude-sonnet"],
    ]);
    expect(query.applyFlagSettings.mock.calls).toEqual([
      [
        {
          alwaysThinkingEnabled: true,
          effortLevel: "max",
        },
      ],
      [
        {
          effortLevel: null,
          workflowSizeGuideline: null,
          ultracode: false,
        },
      ],
      [
        {
          alwaysThinkingEnabled: null,
          effortLevel: null,
          enableWorkflows: null,
          workflowSizeGuideline: null,
          ultracode: null,
        },
      ],
    ]);
    expect(
      query.applyFlagSettings.mock.invocationCallOrder[1],
    ).toBeLessThan(query.setModel.mock.invocationCallOrder[1] ?? 0);
    expect(controller.getLease().provider.model).toBe(
      "claude-sonnet",
    );
    expect(
      journal.events.filter(
        (event) =>
          event.type === "provider.context" &&
          (event.payload as RemoteProviderContext).model ===
            "claude-opus-5",
      ),
    ).toHaveLength(0);
    await controller.stop();
  });

  it("fails closed if a rejected model change cannot restore the previous flags", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high"]),
      modelInfo("claude-opus-5", ["high", "max"]),
    ]);
    await starting;
    query.applyFlagSettings
      .mockRejectedValueOnce(new Error("new flags failed"))
      .mockRejectedValueOnce(new Error("rollback flags failed"));

    await expect(
      controller.setModel("claude-opus-5", "max"),
    ).rejects.toThrow(/remote input has been paused/iu);

    expect(controller.getLease()).toMatchObject({
      state: "error",
      turnPhase: "failed",
      provider: { model: "claude-sonnet" },
    });
    expect(query.close).toHaveBeenCalledOnce();
    await expect(controller.sendPrompt("must not run")).rejects.toThrow(
      /not accepting prompts/iu,
    );
  });

  it("restores the previous reasoning flags after a rejected reasoning update", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high", "xhigh"]),
    ]);
    await starting;
    await controller.setReasoning({ effort: "high" });
    query.applyFlagSettings.mockClear();
    query.setMaxThinkingTokens.mockClear();
    query.applyFlagSettings.mockRejectedValueOnce(
      new Error("xhigh was rejected"),
    );

    await expect(
      controller.setReasoning({ effort: "xhigh" }),
    ).rejects.toThrow("xhigh was rejected");

    expect(query.applyFlagSettings.mock.calls).toEqual([
      [
        {
          alwaysThinkingEnabled: true,
          effortLevel: "xhigh",
        },
      ],
      [
        {
          alwaysThinkingEnabled: true,
          effortLevel: "high",
          enableWorkflows: false,
          workflowSizeGuideline: null,
          ultracode: false,
        },
      ],
    ]);
    expect(query.setMaxThinkingTokens.mock.calls).toEqual([
      [31_999, "summarized"],
      [31_999, "summarized"],
    ]);
    expect(controller.getLease().provider.reasoning).toMatchObject({
      effectiveEffort: "high",
    });
    await controller.stop();
  });

  it("rolls back when Claude clamps xhigh to a different effective effort", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high", "xhigh"]),
    ]);
    await starting;
    query.getSettings.mockResolvedValueOnce({
      effective: {
        alwaysThinkingEnabled: true,
        effortLevel: "high",
      },
    });

    await expect(
      controller.setReasoning({ effort: "xhigh" }),
    ).rejects.toThrow(/applied high reasoning instead of xhigh/iu);

    expect(controller.getLease().provider.reasoning?.effectiveEffort).not.toBe(
      "xhigh",
    );
    expect(
      journal.events.some(
        (event) =>
          event.type === "provider.context" &&
          (event.payload as RemoteProviderContext).reasoning
            ?.effectiveEffort === "xhigh",
      ),
    ).toBe(false);
    expect(query.applyFlagSettings).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it("uses the live query Thinking control for an authoritative Synthetic model", async () => {
    const query = new FakeQuery();
    const providerContext = provider("synthetic");
    providerContext.model = "hf:synthetic/thinking-model";
    providerContext.roleModels.default = providerContext.model;
    providerContext.reasoningEffort = "high";
    providerContext.modelCatalog = {
      source: "synthetic-api",
      authoritative: true,
      updatedAt: 1,
      options: [
        {
          selector: providerContext.model,
          displayName: "Synthetic Thinking Model",
          source: "synthetic-api",
          supportsEffort: true,
          supportedEffortLevels: ["high", "xhigh"],
          supportsAdaptiveThinking: true,
        },
      ],
    };
    providerContext.reasoning = {
      thinkingSupported: true,
      thinkingEnabled: false,
      thinkingAuthority: "synthetic-api",
      supportedEffortLevels: ["high", "xhigh"],
      effectiveEffort: "high",
      effortAuthority: "synthetic-api",
      workflows: { available: true, enabled: false },
      ultra: { available: true, enabled: false },
    };
    const { controller } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
      providerContext,
    );
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo(providerContext.model, ["high", "xhigh"]),
    ]);
    await starting;
    query.setMaxThinkingTokens.mockClear();
    query.applyFlagSettings.mockClear();

    await controller.setReasoning({ thinkingEnabled: true });

    expect(query.setMaxThinkingTokens).toHaveBeenCalledWith(
      31_999,
      "summarized",
    );
    expect(
      query.setMaxThinkingTokens.mock.invocationCallOrder[0],
    ).toBeLessThan(
      query.applyFlagSettings.mock.invocationCallOrder[0] ?? 0,
    );
    expect(controller.getLease().provider.reasoning?.thinkingEnabled).toBe(
      true,
    );
    await controller.stop();
  });

  it("queues prompts until an Anthropic Thinking mutation is authoritative", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high", "xhigh"]),
    ]);
    await starting;

    const flagsGate = deferred<void>();
    query.applyFlagSettings.mockImplementationOnce(async (settings) => {
      await flagsGate.promise;
      for (const [key, value] of Object.entries(settings)) {
        void key;
        void value;
      }
    });
    const reasoningChange = controller.setReasoning({
      thinkingEnabled: true,
      effort: "xhigh",
    });
    await waitFor(
      () => query.applyFlagSettings.mock.calls.length === 1,
    );
    const prompt = controller.sendPrompt(
      "Run only after Thinking is active",
      [],
      "prompt-after-thinking",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      journal.events.some(
        (event) =>
          event.type === "conversation.item" &&
          JSON.stringify(event.payload).includes(
            "prompt-after-thinking",
          ),
      ),
    ).toBe(false);

    flagsGate.resolve();
    await reasoningChange;
    await prompt;
    expect(
      journal.events.some(
        (event) =>
          event.type === "conversation.item" &&
          JSON.stringify(event.payload).includes(
            "prompt-after-thinking",
          ),
      ),
    ).toBe(true);
    await controller.stop();
  });

  it("rejects model and reasoning mutations while a turn is active", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high", "xhigh"]),
      modelInfo("claude-opus-5", ["high", "xhigh"]),
    ]);
    await starting;
    await controller.sendPrompt("Keep this turn active");

    await expect(
      controller.setModel("claude-opus-5", "xhigh"),
    ).rejects.toThrow(/current response/iu);
    await expect(
      controller.setReasoning({ effort: "xhigh" }),
    ).rejects.toThrow(/current response/iu);
    expect(query.setModel).not.toHaveBeenCalled();
    expect(query.applyFlagSettings).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("serializes model and reasoning mutations for the active query", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["low", "medium", "high"]),
      modelInfo("claude-opus-5", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ]);
    await starting;
    const modelGate = deferred<void>();
    query.setModel.mockImplementationOnce(async (model?: string) => {
      await modelGate.promise;
      if (model) {
        query.reportRuntimeModel(model);
      }
    });

    const modelChange = controller.setModel(
      "claude-opus-5",
      "high",
    );
    await waitFor(() => query.setModel.mock.calls.length === 1);
    const reasoningChange = controller.setReasoning({
      effort: "xhigh",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(query.applyFlagSettings).not.toHaveBeenCalled();

    modelGate.resolve();
    await modelChange;
    await reasoningChange;
    expect(query.applyFlagSettings.mock.calls).toEqual([
      [
        {
          effortLevel: "high",
        },
      ],
      [
        {
          alwaysThinkingEnabled: true,
          effortLevel: "xhigh",
        },
      ],
    ]);
    expect(controller.getLease().provider).toMatchObject({
      model: "claude-opus-5",
      reasoningEffort: "xhigh",
    });
    await controller.stop();
  });

  it("applies Ultra dependencies atomically and disables Ultra for lower efforts", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo(
        "claude-sonnet",
        ["high", "xhigh", "max"],
        true,
      ),
    ]);
    await starting;

    await controller.setReasoning({ ultraEnabled: true });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      alwaysThinkingEnabled: true,
      effortLevel: "xhigh",
      enableWorkflows: true,
      workflowSizeGuideline: "small",
      ultracode: true,
    });
    expect(controller.getLease().provider.reasoning).toMatchObject({
      thinkingSupported: true,
      thinkingEnabled: true,
      effectiveEffort: "xhigh",
      workflows: { enabled: true },
      ultra: { enabled: true },
    });

    await controller.setReasoning({ effort: "max" });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      alwaysThinkingEnabled: true,
      effortLevel: "max",
    });
    expect(controller.getLease().provider.reasoning).toMatchObject({
      effectiveEffort: "max",
      ultra: { enabled: true },
    });

    await controller.setReasoning({ effort: "high" });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: "high",
      ultracode: false,
    });
    expect(controller.getLease().provider.reasoning).toMatchObject({
      effectiveEffort: "high",
      ultra: { enabled: false },
    });
    await controller.stop();
  });

  it("does not publish initialized provider state when restoring flags fails", async () => {
    const query = new FakeQuery();
    const providerContext = provider("anthropic");
    providerContext.reasoningEffort = "high";
    providerContext.reasoning = {
      thinkingSupported: true,
      thinkingEnabled: true,
      supportedEffortLevels: ["high"],
      effectiveEffort: "high",
      effortAuthority: "claude-sdk",
      workflows: { available: true, enabled: false },
      ultra: { available: false, enabled: false },
    };
    const { controller, journal } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
      providerContext,
    );
    query.applyFlagSettings.mockRejectedValueOnce(
      new Error("restored flags were rejected"),
    );
    const starting = start(controller);
    query.resolveInitialization([
      modelInfo("claude-sonnet", ["high"]),
    ]);

    await expect(starting).rejects.toThrow(
      "restored flags were rejected",
    );
    expect(controller.getLease().provider).toEqual(providerContext);
    expect(
      journal.events.some(
        (event) => event.type === "provider.context",
      ),
    ).toBe(false);
    expect(query.close).toHaveBeenCalledOnce();
  });

  it("publishes model-aware Thinking and Codex-authoritative effort controls", async () => {
    const query = new FakeQuery();
    const providerContext = provider("openai-codex");
    providerContext.model = "gpt-5.6-sol";
    providerContext.reasoningEffort = "high";
    providerContext.modelReasoningEfforts = {
      "gpt-5.6-sol": ["high", "xhigh"],
      "gpt-5.6-luna": ["low", "high"],
    };
    const { controller, journal } = createController(
      query,
      undefined,
      {
        initializationTimeoutMs: 100,
        closeGraceMs: 5,
      },
      providerContext,
    );
    query.reportRuntimeModel("gpt-5.6-sol");
    const starting = start(controller);
    query.resolveInitialization([
      {
        value: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      },
    ]);
    await starting;

    expect(controller.getLease().provider.reasoning).toMatchObject({
      thinkingSupported: true,
      thinkingEnabled: true,
      supportedEffortLevels: ["high", "xhigh"],
      effectiveEffort: "high",
      effortAuthority: "codex-model-list",
      workflows: {
        available: true,
        enabled: false,
        experimental: true,
      },
    });
    expect(controller.getLease().provider.modelCatalog).toMatchObject({
      source: "codex-model-list",
      authoritative: true,
      options: [
        { selector: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
        { selector: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
      ],
    });
    expect(
      journal.events.find(
        (event) => event.type === "session.capabilities",
      )?.payload,
    ).toMatchObject({
      reasoning: { supportedEffortLevels: ["high", "xhigh"] },
    });

    await controller.setReasoning({ thinkingEnabled: false });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      alwaysThinkingEnabled: false,
    });
    await controller.setReasoning({ effort: "xhigh" });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: "xhigh",
    });
    expect(controller.getLease().provider.reasoning).toMatchObject({
      thinkingEnabled: false,
      effectiveEffort: "xhigh",
    });

    await expect(
      controller.setReasoning({ effort: "max" }),
    ).rejects.toThrow(/does not support max/iu);
    await controller.setReasoning({ workflowsEnabled: true });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      enableWorkflows: true,
      workflowSizeGuideline: "small",
    });
    expect(controller.getLease().provider.reasoning).toMatchObject({
      workflows: { available: true, enabled: true },
      ultra: { available: true, enabled: false },
    });

    await controller.setReasoning({ ultraEnabled: true });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: "xhigh",
      enableWorkflows: true,
      ultracode: true,
      workflowSizeGuideline: "small",
    });
    expect(controller.getLease().provider.reasoning?.ultra.enabled).toBe(
      true,
    );

    await expect(
      controller.setModel("gpt-5.6-luna", "xhigh"),
    ).rejects.toThrow(/does not support xhigh/iu);
    expect(query.setModel).not.toHaveBeenCalledWith("gpt-5.6-luna");

    await controller.setModel("gpt-5.6-luna", "high");
    expect(controller.getLease().provider.reasoning).toMatchObject({
      supportedEffortLevels: ["low", "high"],
      effectiveEffort: "high",
      effortAuthority: "codex-model-list",
      ultra: { available: false, enabled: false },
    });
    expect(query.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: "high",
      ultracode: false,
    });

    await controller.stop();
  });

  it("settles a root provider error without requiring a result frame", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt(
      "Continue the research",
      [],
      "rate-limited-prompt",
    );

    query.push({
      type: "rate_limit_event",
      uuid: "allowance-rejected",
      session_id: "source-session",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1_800_000_000,
        utilization: 1,
      },
    } as unknown as SDKMessage);
    await waitFor(() =>
      journal.events.some(
        (event) =>
          event.type === "activity.event" &&
          (event.payload as { id?: string }).id === "allowance-rejected",
      ),
    );
    expect(controller.isBusy()).toBe(true);
    expect(controller.getTerminalProviderFailure()).toBeUndefined();

    query.push(rootAssistantError());
    await waitFor(() => !controller.isBusy());

    expect(controller.getLease().turnPhase).toBe("failed");
    expect(controller.getLease().turnCompletedAt).toEqual(
      expect.any(Number),
    );
    expect(controller.getTerminalProviderFailure()).toMatchObject({
      code: "rate_limit",
      queryGeneration: 1,
    });
    expect(controller.getRuntimeSnapshot()).toMatchObject({
      execution: {
        state: "idle",
        quiescent: true,
        pendingResult: false,
        foregroundActive: false,
        terminalProviderFailure: { code: "rate_limit" },
      },
    });
    expect(
      controller
        .getRuntimeSnapshot()
        .execution.workItems.find(
          (item) => item.kind === "foreground-response",
        ),
    ).toMatchObject({
      phase: "failed",
      terminalEvidence: {
        source: "sdk-assistant-error",
        status: "rate_limit",
      },
    });

    // Some SDK versions still emit their normal result after the terminal
    // assistant error. It may add usage, but cannot re-arm the turn ledger.
    const eventsBeforeLateResult = journal.events.length;
    query.push(failedSdkResult("late-rate-limit-result"));
    await waitFor(() =>
      journal.events.slice(eventsBeforeLateResult).some(
        (event) =>
          event.type === "usage.snapshot",
      ),
    );
    expect(controller.isBusy()).toBe(false);
    expect(controller.getRuntimeSnapshot()).toMatchObject({
      execution: {
        state: "idle",
        quiescent: true,
        pendingResult: false,
      },
    });

    await controller.stop();
  });

  it("keeps background work alive after a root provider error", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Run deep research");
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "deep-research",
          task_type: "workflow",
          description: "Deep research",
        },
      ],
      uuid: "deep-research-live",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().backgroundTaskCount === 1);

    query.push(rootAssistantError("rate_limit", "workflow-rate-limit"));
    await waitFor(
      () =>
        controller.getRuntimeSnapshot().execution.foregroundActive === false,
    );
    expect(controller.isBusy()).toBe(true);
    expect(controller.getLease().turnCompletedAt).toBeUndefined();
    expect(controller.getRuntimeSnapshot()).toMatchObject({
      execution: {
        state: "running",
        quiescent: false,
        pendingResult: true,
        terminalProviderFailure: { code: "rate_limit" },
      },
    });
    expect(
      controller
        .getRuntimeSnapshot()
        .execution.workItems.find((item) => item.id === "task:deep-research"),
    ).toMatchObject({ phase: "active", terminalEvidence: undefined });

    query.push({
      type: "system",
      subtype: "task_notification",
      task_id: "deep-research",
      status: "completed",
      summary: "The workflow's final record is durable.",
      uuid: "deep-research-terminal",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());
    expect(controller.getRuntimeSnapshot()).toMatchObject({
      execution: {
        state: "idle",
        quiescent: true,
        pendingResult: false,
      },
    });
    expect(
      controller
        .getRuntimeSnapshot()
        .execution.workItems.find((item) => item.id === "task:deep-research"),
    ).toMatchObject({
      phase: "complete",
      terminalEvidence: { source: "sdk-task-notification" },
    });

    await controller.stop();
  });

  it("keeps disappeared background work settling until terminal evidence arrives", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Run the workflow", [], "workflow-prompt");

    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "workflow-1",
          task_type: "agent",
          description: "Inspect the repository",
        },
      ],
      uuid: "background-live",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().backgroundTaskCount === 1);
    query.push({
      type: "result",
      subtype: "success",
      uuid: "workflow-result",
      session_id: "source-session",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "Foreground complete",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    await waitFor(
      () => controller.getLease().turnPhase === "running-task",
    );
    expect(controller.isBusy()).toBe(true);
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "background-empty",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(
      () =>
        controller.getRuntimeSnapshot().execution.state ===
        "settling",
    );
    expect(controller.isBusy()).toBe(true);
    expect(controller.getLease().turnCompletedAt).toBeUndefined();
    expect(controller.getLease().turnCompletedAt).toEqual(
      undefined,
    );
    expect(
      journal.events.some(
        (event) =>
          event.type === "activity.event" &&
          (event.payload as { id?: string; phase?: string }).id ===
            "task:workflow-1" &&
          (event.payload as { phase?: string }).phase === "settling",
      ),
    ).toBe(true);

    query.push({
      type: "system",
      subtype: "task_notification",
      task_id: "workflow-1",
      status: "completed",
      summary: "The workflow record is durable.",
      uuid: "workflow-terminal",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());
    expect(controller.getLease().turnCompletedAt).toEqual(
      expect.any(Number),
    );
    expect(
      controller
        .getRuntimeSnapshot()
        .execution.workItems.find(
          (item) => item.id === "task:workflow-1",
        ),
    ).toMatchObject({
      phase: "complete",
      terminalEvidence: {
        source: "sdk-task-notification",
      },
    });
    await controller.stop();
  });

  it("waits for background work before finishing hand-back", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Run in background");
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "workflow-2",
          task_type: "agent",
          description: "Finish the implementation",
        },
      ],
      uuid: "handback-background",
      session_id: "source-session",
    } as unknown as SDKMessage);
    query.push({
      type: "result",
      subtype: "success",
      uuid: "handback-result",
      session_id: "source-session",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "Foreground complete",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().backgroundTaskCount === 1);

    let returned = false;
    const handback = controller
      .prepareHandback("finish", 500)
      .then((lease) => {
        returned = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(returned).toBe(false);

    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "handback-background-empty",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(returned).toBe(false);

    query.push({
      type: "system",
      subtype: "task_updated",
      task_id: "workflow-2",
      status: "completed",
      description: "Finish the implementation",
      uuid: "handback-background-terminal",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await expect(handback).resolves.toMatchObject({
      state: "handing-back",
      backgroundTaskCount: 0,
    });
  });

  it("treats the hand-back timeout as attention, never cancellation", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Run the long workflow");
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "workflow-overdue",
          task_type: "workflow",
          description: "Audit remote continuity",
        },
      ],
      uuid: "overdue-live",
      session_id: "source-session",
    } as unknown as SDKMessage);
    query.push({
      type: "result",
      subtype: "success",
      uuid: "overdue-result",
      session_id: "source-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "overdue-missing",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(
      () => controller.getRuntimeSnapshot().execution.state === "settling",
    );

    let returned = false;
    const handback = controller.prepareHandback("finish", 5).then((lease) => {
      returned = true;
      return lease;
    });
    await waitFor(
      () =>
        controller.getRuntimeSnapshot().execution.state ===
        "completion-unknown",
    );
    expect(returned).toBe(false);
    expect(query.close).not.toHaveBeenCalled();

    query.push({
      type: "system",
      subtype: "task_notification",
      task_id: "workflow-overdue",
      status: "completed",
      uuid: "overdue-terminal",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await expect(handback).resolves.toMatchObject({ state: "handing-back" });
  });

  it("surfaces overdue settlement before an editor claims hand-back", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Run an unattended workflow");
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "workflow-supervised",
          task_type: "workflow",
          description: "Write final workflow record",
        },
      ],
      uuid: "supervised-live",
      session_id: "source-session",
    } as unknown as SDKMessage);
    query.push({
      type: "result",
      subtype: "success",
      uuid: "supervised-result",
      session_id: "source-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "supervised-missing",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(
      () => controller.getRuntimeSnapshot().execution.state === "settling",
    );
    const lease = controller.getLease();
    await controller.setOperation({
      id: "handoff-supervised",
      kind: "handback",
      phase: "waiting-for-turn",
      leaseId: lease.id,
      ownerWorkspacePath: lease.workspacePath,
      requestedAt: 1,
      updatedAt: 1,
      attentionAt: 10,
    });

    await controller.evaluateOperationAttention(10);

    expect(controller.getRuntimeSnapshot()).toMatchObject({
      execution: { state: "completion-unknown" },
      operation: {
        id: "handoff-supervised",
        waitReason: "Final workflow record pending",
        blockerIds: ["task:workflow-supervised"],
      },
    });
    expect(query.close).not.toHaveBeenCalled();

    query.push({
      type: "system",
      subtype: "task_notification",
      task_id: "workflow-supervised",
      status: "completed",
      uuid: "supervised-terminal",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());
    await controller.stop();
  });

  it("prevents active hand-back and provider-switch operations from overwriting each other", async () => {
    const operation = (
      id: string,
      kind: RemoteOperation["kind"],
    ): RemoteOperation => ({
      id,
      kind,
      phase: "waiting-for-turn",
      leaseId: "remote-lease",
      ownerWorkspacePath: "/workspace",
      requestedAt: 1,
      updatedAt: 1,
    });

    for (const [activeKind, replacementKind] of [
      ["handback", "provider-switch"],
      ["provider-switch", "handback"],
    ] as const) {
      const query = new FakeQuery();
      const { controller } = createController(query);
      const active = operation(`active-${activeKind}`, activeKind);
      await controller.setOperation(active);

      for (const replacement of [
        // Same ID proves kind is independently fenced.
        operation(active.id, replacementKind),
        // Same kind proves ID is independently fenced.
        operation(`replacement-${activeKind}`, activeKind),
      ]) {
        await expect(
          controller.setOperation(replacement),
        ).rejects.toThrow(
          `Cannot replace active ${activeKind} operation ${active.id}`,
        );
        expect(controller.getLease().operation).toEqual(active);
      }
    }
  });

  it("allows same-operation updates, explicit clearing, and replacement after terminal state", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query);
    const handback: RemoteOperation = {
      id: "durable-handback",
      kind: "handback",
      phase: "waiting-for-turn",
      leaseId: "remote-lease",
      ownerWorkspacePath: "/workspace",
      requestedAt: 1,
      updatedAt: 1,
    };
    await controller.setOperation(handback);
    await controller.setOperation({
      ...handback,
      phase: "reconciling-final-record",
      updatedAt: 2,
    });
    expect(controller.getLease().operation).toMatchObject({
      id: handback.id,
      kind: handback.kind,
      phase: "reconciling-final-record",
    });

    await controller.setOperation({
      ...handback,
      phase: "complete",
      updatedAt: 3,
    });
    const providerSwitch: RemoteOperation = {
      ...handback,
      id: "replacement-provider-switch",
      kind: "provider-switch",
      phase: "applying",
      updatedAt: 4,
    };
    await controller.setOperation(providerSwitch);
    expect(controller.getLease().operation).toEqual(providerSwitch);

    await controller.setOperation(undefined);
    expect(controller.getLease().operation).toBeUndefined();
    await controller.setOperation({
      ...handback,
      id: "new-handback-after-clear",
      updatedAt: 5,
    });
    expect(controller.getLease().operation).toMatchObject({
      id: "new-handback-after-clear",
      kind: "handback",
    });
  });

  it("keeps a result unsettled while an approval remains unresolved", async () => {
    const query = new FakeQuery();
    const { controller, getRequest } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Run the protected command");
    const canUseTool = getRequest().options?.canUseTool;
    if (!canUseTool) {
      throw new Error("Expected the remote permission handler.");
    }
    const approval = canUseTool(
      "Bash",
      { command: "true" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-protected",
        requestId: "approval-protected",
      },
    );
    await waitFor(
      () =>
        controller.getRuntimeSnapshot().pendingInteractions.approvalIds[0] ===
        "approval-protected",
    );
    query.push({
      type: "result",
      subtype: "success",
      uuid: "protected-result",
      session_id: "source-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    await expect(controller.waitUntilIdle(5)).rejects.toThrow(
      /continued attention/iu,
    );
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    await controller.resolvePermission("approval-protected", "allow");
    await expect(approval).resolves.toMatchObject({ behavior: "allow" });
    await waitFor(() => !controller.isBusy());
    expect(controller.getLease().turnCompletedAt).toEqual(expect.any(Number));
    await controller.stop();
  });

  it("silently allows public read-only research in Auto-safe mode", async () => {
    const query = new FakeQuery();
    const { controller, getRequest } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    const canUseTool = getRequest().options?.canUseTool;
    if (!canUseTool) {
      throw new Error("Expected the remote permission handler.");
    }

    await expect(
      canUseTool(
        "WebSearch",
        { query: "Claude Agent SDK permissions" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-web-search",
          requestId: "approval-web-search",
        },
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(
      controller.getRuntimeSnapshot().pendingInteractions.approvalIds,
    ).toEqual([]);
    await controller.stop();
  });

  it("offers an explicit safe session rule without changing Allow once", async () => {
    const query = new FakeQuery();
    const journal = new MemoryJournal();
    const { controller, getRequest } = createController(query, journal, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    const canUseTool = getRequest().options?.canUseTool;
    if (!canUseTool) {
      throw new Error("Expected the remote permission handler.");
    }
    const approval = canUseTool(
      "Workflow",
      { description: "Inspect the repository" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-workflow",
        requestId: "approval-workflow",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Workflow" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
    );
    await waitFor(() =>
      journal.events.some(
        (event) =>
          event.type === "permission.request" &&
          (event.payload as { requestId?: string }).requestId ===
            "approval-workflow",
      ),
    );
    expect(
      journal.events.find(
        (event) =>
          event.type === "permission.request" &&
          (event.payload as { requestId?: string }).requestId ===
            "approval-workflow",
      )?.payload,
    ).toMatchObject({
      sessionSuggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Workflow" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });

    await controller.resolvePermission(
      "approval-workflow",
      "allow-session",
    );
    await expect(approval).resolves.toMatchObject({
      behavior: "allow",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Workflow" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
    await controller.stop();
  });

  it("preserves managed-ask provenance and refuses to remember it", async () => {
    const query = new FakeQuery();
    const journal = new MemoryJournal();
    const { controller, getRequest } = createController(query, journal, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    const canUseTool = getRequest().options?.canUseTool;
    if (!canUseTool) {
      throw new Error("Expected the remote permission handler.");
    }
    const approval = canUseTool(
      "Workflow",
      { description: "Inspect the repository" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-managed-workflow",
        requestId: "approval-managed-workflow",
        matchedAskRule: {
          source: "managed",
          toolName: "Workflow",
          ruleContent: "*",
        },
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Workflow", ruleContent: "*" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      },
    );
    await waitFor(() =>
      journal.events.some(
        (event) =>
          event.type === "permission.request" &&
          (event.payload as { requestId?: string }).requestId ===
            "approval-managed-workflow",
      ),
    );
    expect(
      journal.events.find(
        (event) =>
          event.type === "permission.request" &&
          (event.payload as { requestId?: string }).requestId ===
            "approval-managed-workflow",
      )?.payload,
    ).toMatchObject({
      matchedAskRule: {
        source: "managed",
        toolName: "Workflow",
        ruleContent: "*",
      },
      sessionSuggestions: [],
    });
    await expect(
      controller.resolvePermission(
        "approval-managed-workflow",
        "allow-session",
      ),
    ).rejects.toThrow(/cannot be remembered safely/iu);
    await controller.resolvePermission(
      "approval-managed-workflow",
      "allow",
    );
    await expect(approval).resolves.toMatchObject({ behavior: "allow" });
    await controller.stop();
  });

  it("keeps a result unsettled while a Claude question remains unanswered", async () => {
    const query = new FakeQuery();
    const { controller, getRequest } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Ask before continuing");
    const canUseTool = getRequest().options?.canUseTool;
    if (!canUseTool) {
      throw new Error("Expected the remote question handler.");
    }
    const question = canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Continue?",
            options: [{ label: "Yes" }, { label: "No" }],
            multiSelect: false,
          },
        ],
      },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-question",
        requestId: "question-continue",
      },
    );
    await waitFor(
      () =>
        controller.getRuntimeSnapshot().pendingInteractions.questionIds[0] ===
        "question-continue",
    );
    query.push({
      type: "result",
      subtype: "success",
      uuid: "question-result",
      session_id: "source-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    await expect(controller.waitUntilIdle(5)).rejects.toThrow(
      /continued attention/iu,
    );

    await controller.resolveQuestion("question-continue", {
      "Continue?": "Yes",
    });
    await expect(question).resolves.toMatchObject({ behavior: "allow" });
    await waitFor(() => !controller.isBusy());
    expect(controller.getLease().turnCompletedAt).toEqual(expect.any(Number));
    await controller.stop();
  });

  it("stops every background task on explicit cancellation", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "workflow-a",
          task_type: "agent",
          description: "First child",
        },
        {
          task_id: "workflow-b",
          task_type: "agent",
          description: "Second child",
        },
      ],
      uuid: "cancel-background",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().backgroundTaskCount === 2);

    query.stopTask.mockRejectedValueOnce(
      new Error("task already completed"),
    );
    await controller.cancel();
    expect(query.stopTask).toHaveBeenCalledTimes(2);
    expect(query.stopTask).toHaveBeenCalledWith("workflow-a");
    expect(query.stopTask).toHaveBeenCalledWith("workflow-b");
    expect(query.interrupt).toHaveBeenCalledOnce();
    expect(
      controller.getLease().turnPhase,
    ).toBe("running-task");
    await controller.stop();
  });

  it("force-closes hand-back after bounded grace when terminal events never arrive", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(
      query,
      undefined,
      {
        initializationTimeoutMs: 100,
        closeGraceMs: 5,
        cancellationGraceMs: 5,
      },
    );
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt(
      "Run work whose terminal notification will be lost",
      [],
      "force-handback-prompt",
    );
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "force-handback-workflow",
          task_type: "workflow",
          description: "Workflow without a terminal event",
        },
      ],
      uuid: "force-handback-live",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().backgroundTaskCount === 1);
    query.interrupt.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );

    const lease = await controller.prepareHandback("cancel", 500);

    expect(lease).toMatchObject({
      state: "handing-back",
      turnPhase: "handing-back",
      backgroundTaskCount: 0,
    });
    expect(controller.isBusy()).toBe(false);
    expect(query.stopTask).toHaveBeenCalledOnce();
    expect(query.stopTask).toHaveBeenCalledWith(
      "force-handback-workflow",
    );
    expect(query.interrupt).toHaveBeenCalledOnce();
    expect(query.close).toHaveBeenCalledOnce();
    const cancelledWorkflow = controller
      .getRuntimeSnapshot()
      .execution.workItems.find(
        (item) => item.id === "task:force-handback-workflow",
      );
    expect(cancelledWorkflow).toMatchObject({
      phase: "cancelled",
      terminalEvidence: {
        source: "explicit-cancellation",
        status: "query-closed",
      },
    });
    expect(
      journal.events.some(
        (event) =>
          event.type === "work.state" &&
          (event.payload as { workItem?: { id?: string } }).workItem
            ?.id === "task:force-handback-workflow",
      ),
    ).toBe(true);

    // Retrying the same forced preparation must reuse the settled operation,
    // not signal or close the query a second time.
    await controller.prepareHandback("cancel", 500);
    expect(query.stopTask).toHaveBeenCalledOnce();
    expect(query.interrupt).toHaveBeenCalledOnce();
    expect(query.close).toHaveBeenCalledOnce();
  });

  it("re-arms forced hand-back cancellation after an earlier idle request", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
      cancellationGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;

    // An idempotent force request while idle must not leave a permanently
    // resolved actuator that swallows a later, legitimate escalation.
    await controller.requestHandbackCancellation();
    expect(query.interrupt).not.toHaveBeenCalled();

    await controller.sendPrompt("Work began after the idle force request");
    await controller.requestHandbackCancellation();

    expect(query.interrupt).toHaveBeenCalledOnce();
    expect(query.close).toHaveBeenCalledOnce();
    expect(controller.isBusy()).toBe(false);
  });

  it("preempts an overdue unbounded finish wait after bounded cancellation grace", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
      cancellationGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Keep the finish hand-back waiting");
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        {
          task_id: "preempted-workflow",
          task_type: "workflow",
          description: "Long workflow",
        },
      ],
      uuid: "preempted-workflow-live",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().backgroundTaskCount === 1);
    query.push({
      type: "result",
      subtype: "success",
      uuid: "preempted-result",
      session_id: "source-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as SDKMessage);
    query.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "preempted-workflow-missing",
      session_id: "source-session",
    } as unknown as SDKMessage);
    await waitFor(
      () => controller.getRuntimeSnapshot().execution.state === "settling",
    );

    let finishResolved = false;
    const finish = controller
      .prepareHandback("finish", 5)
      .then((lease) => {
        finishResolved = true;
        return lease;
      });
    await waitFor(
      () =>
        controller.getRuntimeSnapshot().execution.state ===
        "completion-unknown",
    );
    expect(finishResolved).toBe(false);
    expect(query.close).not.toHaveBeenCalled();
    query.interrupt.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );

    const force = controller.prepareHandback("cancel", 1_000);
    const [finishedLease, forcedLease] = await Promise.all([
      finish,
      force,
    ]);

    expect(finishedLease).toMatchObject({ state: "handing-back" });
    expect(forcedLease).toMatchObject({ state: "handing-back" });
    expect(query.stopTask).toHaveBeenCalledOnce();
    expect(query.interrupt).toHaveBeenCalledOnce();
    expect(query.close).toHaveBeenCalledOnce();
    expect(controller.isBusy()).toBe(false);
    expect(
      controller
        .getRuntimeSnapshot()
        .execution.workItems.find(
          (item) => item.id === "task:preempted-workflow",
        ),
    ).toMatchObject({
      phase: "cancelled",
      terminalEvidence: {
        source: "explicit-cancellation",
        status: "query-closed",
      },
    });
    expect(
      journal.events.filter(
        (event) =>
          event.type === "work.state" &&
          (event.payload as { workItem?: { id?: string } }).workItem
            ?.id === "task:preempted-workflow",
      ),
    ).toHaveLength(1);
  });

  it("withdraws a finish hand-back without cancelling active work", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Keep working remotely");

    const handback = controller.prepareHandback("finish", 1_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(controller.cancelHandbackRequest()).toBe(true);

    await expect(handback).rejects.toThrow(
      "hand-back request was cancelled",
    );
    expect(controller.isBusy()).toBe(true);
    expect(query.stopTask).not.toHaveBeenCalled();
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(query.close).not.toHaveBeenCalled();

    await controller.stop();
  });

  it("does not treat context-usage presentation text as a model selector", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;

    expect(controller.getLease().provider.model).toBe("claude-sonnet");
    expect(
      journal.events.some(
        (event) =>
          event.type === "usage.snapshot" &&
          (event.payload as { model?: string }).model ===
            "claude-sonnet",
      ),
    ).toBe(true);

    await controller.stop();
  });

  it("adopts an authoritative streamed model only through the published catalog", async () => {
    const query = new FakeQuery();
    const providerContext = provider("anthropic");
    providerContext.model = "default";
    const { controller } = createController(
      query,
      undefined,
      { initializationTimeoutMs: 100, closeGraceMs: 5 },
      providerContext,
    );
    const starting = start(controller);
    query.resolveInitialization([
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default Claude model",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
      },
      {
        value: "claude-opus-5",
        resolvedModel: "claude-opus-5-20260715",
        displayName: "Claude Opus 5",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        supportsAdaptiveThinking: true,
      },
    ]);
    await starting;
    query.push({
      type: "system",
      subtype: "init",
      uuid: "runtime-init",
      session_id: "remote-session",
      model: "claude-opus-5-20260715",
      permissionMode: "default",
      tools: [],
      slash_commands: [],
      skills: [],
    } as unknown as SDKMessage);
    await waitFor(
      () => controller.getLease().provider.model === "claude-opus-5",
    );
    await controller.stop();
  });

  it("accepts the authoritative initialization result without a streamed init frame", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();

    await expect(starting).resolves.toBeUndefined();
    expect(query.initializationResult).toHaveBeenCalledOnce();
    expect(query.close).not.toHaveBeenCalled();
    expect(
      journal.events.some(
        (event) => event.type === "session.capabilities",
      ),
    ).toBe(true);

    await controller.stop();
  });

  it("surfaces an authoritative initialization rejection immediately and closes the query", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 500,
      closeGraceMs: 5,
    });
    const failure = new Error("Claude authentication expired");
    const starting = start(controller);
    query.rejectInitialization(failure);

    await expect(starting).rejects.toThrow(
      "Claude authentication expired",
    );
    expect(query.close).toHaveBeenCalledOnce();
  });

  it("fails closed when the resumed runtime contradicts the selected provider", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    query.push({
      type: "system",
      subtype: "init",
      uuid: "wrong-provider-init",
      session_id: "remote-session",
      model: "hf:moonshotai/Kimi-K3",
      permissionMode: "default",
      tools: [],
      slash_commands: [],
      skills: [],
    } as unknown as SDKMessage);
    await waitFor(() => controller.getLease().state === "error");
    expect(controller.getLease().error).toMatch(
      /expected the anthropic route/i,
    );
  });

  it("closes the query and reports a true initialization timeout", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 20,
      closeGraceMs: 5,
    });

    await expect(start(controller)).rejects.toThrow(
      /did not initialize.*in time|initialization.*timed out/i,
    );
    expect(query.close).toHaveBeenCalledOnce();
  });

  it("rejects immediately when the query iterator ends before initialization", async () => {
    const query = new FakeQuery();
    query.end();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 500,
      closeGraceMs: 5,
    });

    const outcome = await Promise.race([
      start(controller).then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise<"still-waiting">((resolve) =>
        setTimeout(() => resolve("still-waiting"), 50),
      ),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(
      /stopped|ended|before initializ/i,
    );
    expect(query.close).toHaveBeenCalledOnce();
  });

  it("ignores a late init frame from the query closed during reconfiguration", async () => {
    const oldQuery = new FakeQuery(false);
    const newQuery = new FakeQuery();
    const journal = new MemoryJournal();
    const queries = [oldQuery, newQuery];
    const queryFactory = vi.fn(() => {
      const query = queries.shift();
      if (!query) {
        throw new Error("Unexpected extra query.");
      }
      return query.asQuery();
    });
    const controller = new RemoteSessionController(
      configuration(),
      journal.asJournal(),
      undefined,
      queryFactory,
      {
        initializationTimeoutMs: 100,
        closeGraceMs: 5,
      },
    );
    const initialStart = start(controller);
    oldQuery.resolveInitialization();
    await initialStart;

    const switchedConfiguration = configuration(
      provider("synthetic"),
    );
    const reconfiguring = controller.reconfigure(
      switchedConfiguration,
    );
    await waitFor(() => queryFactory.mock.calls.length === 2);
    newQuery.resolveInitialization();
    await reconfiguring;

    oldQuery.push({
      type: "system",
      subtype: "init",
      uuid: "stale-init",
      session_id: "stale-session",
      model: "stale-model",
      tools: [],
      slash_commands: [],
      skills: [],
      capabilities: [],
      permissionMode: "auto",
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getLease()).toMatchObject({
      provider: { provider: "synthetic" },
    });
    expect(controller.getLease().activeSessionId).not.toBe(
      "stale-session",
    );
    expect(
      journal.events.some(
        (event) =>
          event.type === "session.capabilities" &&
          JSON.stringify(event.payload).includes("stale-model"),
      ),
    ).toBe(false);

    oldQuery.end();
    await controller.stop();
  });

  it("publishes authoritative turn timing across phases and resets it for the next turn", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;

    await controller.sendPrompt("First prompt", [], "client-first");
    const firstStartedAt = controller.getLease().turnStartedAt;
    expect(firstStartedAt).toEqual(expect.any(Number));
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    query.push({
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "compact-status",
      session_id: "remote-session",
    } as unknown as SDKMessage);
    await waitFor(
      () => controller.getLease().turnPhase === "compacting",
    );
    expect(controller.getLease().turnStartedAt).toBe(
      firstStartedAt,
    );
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    query.push({
      type: "tool_progress",
      uuid: "tool-progress",
      session_id: "remote-session",
      tool_use_id: "tool-use",
      tool_name: "Read",
      elapsed_time_seconds: 1,
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getLease().turnStartedAt).toBe(
      firstStartedAt,
    );
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    query.push({
      type: "result",
      subtype: "success",
      uuid: "first-result",
      session_id: "remote-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());
    const firstCompletedAt = controller.getLease().turnCompletedAt;
    expect(firstCompletedAt).toEqual(expect.any(Number));
    expect(firstCompletedAt).toBeGreaterThanOrEqual(
      firstStartedAt ?? 0,
    );

    await new Promise((resolve) => setTimeout(resolve, 2));
    await controller.sendPrompt("Second prompt", [], "client-second");
    expect(controller.getLease().turnStartedAt).toBeGreaterThanOrEqual(
      firstCompletedAt ?? 0,
    );
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    await controller.cancel();
    expect(query.interrupt).toHaveBeenCalledOnce();
    expect(controller.isBusy()).toBe(true);
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    query.push({
      type: "result",
      subtype: "success",
      uuid: "cancelled-result",
      session_id: "remote-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 1 },
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());
    expect(controller.getLease().turnCompletedAt).toEqual(
      expect.any(Number),
    );

    await controller.stop();
  });

  it("revokes new remote input without interrupting an active turn", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Keep working", [], "client-active");

    await controller.revokeRemoteInput("maximum-session", 123_456);

    expect(controller.isBusy()).toBe(true);
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(query.close).not.toHaveBeenCalled();
    expect(controller.getLease()).toMatchObject({
      remoteInputRevokedAt: 123_456,
      remoteInputRevokedReason: "maximum-session",
      turnCompletedAt: undefined,
    });
    expect(
      journal.events.filter(
        (event) =>
          event.type === "activity.event" &&
          (event.payload as { id?: string }).id ===
            "remote-input-maximum-session",
      ),
    ).toHaveLength(1);

    await controller.revokeRemoteInput("maximum-session", 123_999);
    expect(
      journal.events.filter(
        (event) =>
          event.type === "activity.event" &&
          (event.payload as { id?: string }).id ===
            "remote-input-maximum-session",
      ),
    ).toHaveLength(1);

    await controller.stop();
  });

  it("journals authenticated non-prompt activity for the idle deadline", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(query);

    await controller.touchRemoteActivity(123_456);

    expect(controller.getLease().lastActivityAt).toBe(123_456);
    expect(journal.events.at(-1)).toMatchObject({
      type: "session.state",
      payload: { lastActivityAt: 123_456 },
    });
  });

  it("releases a revoked phone and advances the ownership fence", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query);

    await controller.claimDevice("phone-a");
    const claimed = controller.getRuntimeSnapshot();
    expect(claimed.ownership).toMatchObject({
      deviceId: "phone-a",
    });

    await controller.claimDevice("phone-a", true);
    const reconnected = controller.getRuntimeSnapshot();
    expect(reconnected.ownership.fencingGeneration).toBe(
      claimed.ownership.fencingGeneration + 1,
    );

    await controller.releaseDeviceOwnership("phone-a");
    const released = controller.getRuntimeSnapshot();
    expect(released.lease.ownerDeviceId).toBeUndefined();
    expect(released.lease.state).toBe("waiting-for-device");
    expect(released.ownership.deviceId).toBeUndefined();
    expect(released.ownership.fencingGeneration).toBe(
      reconnected.ownership.fencingGeneration + 1,
    );

    await controller.releaseDeviceOwnership("phone-a");
    expect(
      controller.getRuntimeSnapshot().ownership.fencingGeneration,
    ).toBe(released.ownership.fencingGeneration);
  });

  it("pauses on desktop divergence without cancelling the active turn", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Continue safely", [], "client-diverged");
    await controller.revokeRemoteInput("desktop-diverged", 200_000);

    await controller.markDiverged();

    expect(controller.isBusy()).toBe(true);
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(controller.getLease()).toMatchObject({
      state: "paused-diverged",
      remoteInputRevokedReason: "desktop-diverged",
      turnCompletedAt: undefined,
    });

    query.push({
      type: "result",
      subtype: "success",
      uuid: "diverged-result",
      session_id: "remote-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());

    expect(query.interrupt).not.toHaveBeenCalled();
    const completedLease = controller.getLease();
    expect(completedLease).toMatchObject({
      state: "paused-diverged",
      turnPhase: "failed",
    });
    expect(typeof completedLease.turnCompletedAt).toBe("number");
    await controller.stop();
  });

  it("settles an active turn when the SDK iterator throws without interrupting it", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Keep the failed turn durable", [], "client-failure");
    const waitingForIdle = controller.waitUntilIdle(100);

    query.fail(new Error("SDK transport failed"));

    await waitingForIdle;
    expect(controller.isBusy()).toBe(false);
    expect(query.interrupt).not.toHaveBeenCalled();
    const failedLease = controller.getLease();
    expect(failedLease).toMatchObject({
      state: "error",
      turnPhase: "failed",
      error: "SDK transport failed",
    });
    expect(typeof failedLease.turnCompletedAt).toBe("number");
    await controller.stop();
  });

  it("settles an unexpected iterator end so maximum-expiry hand-back can proceed", async () => {
    const query = new FakeQuery();
    const { controller } = createController(query, undefined, {
      initializationTimeoutMs: 100,
      closeGraceMs: 5,
    });
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.claimDevice("phone");
    await controller.sendPrompt("Finish before hand-back", [], "client-ended");
    const waitingForIdle = controller.waitUntilIdle(100);

    query.end();

    await waitingForIdle;
    const lease = controller.getLease();
    expect(controller.isBusy()).toBe(false);
    expect(query.interrupt).not.toHaveBeenCalled();
    expect(lease.state).toBe("error");
    expect(
      remoteLifecycleDecision({
        now: REMOTE_MAXIMUM_SESSION_MS,
        configuredAt: 0,
        ownerDeviceId: lease.ownerDeviceId,
        busy: controller.isBusy(),
        turnCompletedAt: lease.turnCompletedAt,
        lastActivityAt: lease.lastActivityAt,
        idleTimeoutMs: 60 * 60_000,
        unpairedTimeoutMs: 10 * 60_000,
        maximumSessionMs: REMOTE_MAXIMUM_SESSION_MS,
      }),
    ).toBe("handback-after-maximum");
    await controller.stop();
  });

  it("collapses partial SDK UUIDs into one assistant item and resets after the result", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(
      query,
      undefined,
      {
        initializationTimeoutMs: 100,
        closeGraceMs: 5,
      },
    );
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Stream this", [], "client-stream");

    query.push({
      type: "stream_event",
      uuid: "stream-start-wrapper",
      session_id: "remote-session",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: { id: "assistant-turn-one", content: [] },
      },
    } as unknown as SDKMessage);
    for (const [uuid, text] of [
      ["stream-delta-one", "One "],
      ["stream-delta-two", "answer"],
    ] as const) {
      query.push({
        type: "stream_event",
        uuid,
        session_id: "remote-session",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      } as unknown as SDKMessage);
    }
    query.push({
      type: "assistant",
      uuid: "assistant-final-wrapper",
      session_id: "remote-session",
      parent_tool_use_id: null,
      message: {
        id: "assistant-turn-one",
        role: "assistant",
        content: [{ type: "text", text: "One answer" }],
      },
    } as unknown as SDKMessage);
    query.push({
      type: "result",
      subtype: "success",
      uuid: "stream-result",
      session_id: "remote-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2 },
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());

    const assistantEvents = (): RemoteConversationEvent[] =>
      journal.events.flatMap((event) => {
        if (event.type !== "conversation.item") {
          return [];
        }
        const conversation = event.payload as RemoteConversationEvent;
        return conversation.item.role === "assistant"
          ? [conversation]
          : [];
      });
    expect(
      new Set(assistantEvents().map((event) => event.item.id)),
    ).toEqual(new Set(["assistant-turn-one"]));
    expect(assistantEvents().at(-1)).toMatchObject({
      operation: "upsert",
      item: {
        id: "assistant-turn-one",
        status: "complete",
      },
    });

    await controller.sendPrompt("New turn", [], "client-new-turn");
    query.push({
      type: "stream_event",
      uuid: "new-turn-first-delta",
      session_id: "remote-session",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "New" },
      },
    } as unknown as SDKMessage);
    await waitFor(() =>
      assistantEvents().some(
        (event) => event.item.id === "new-turn-first-delta",
      ),
    );
    expect(
      new Set(assistantEvents().map((event) => event.item.id)),
    ).toEqual(
      new Set(["assistant-turn-one", "new-turn-first-delta"]),
    );

    await controller.stop();
  });

  it("keeps a tool loop active until the authoritative result arrives", async () => {
    const query = new FakeQuery();
    const { controller, journal } = createController(
      query,
      undefined,
      {
        initializationTimeoutMs: 100,
        closeGraceMs: 5,
      },
    );
    const starting = start(controller);
    query.resolveInitialization();
    await starting;
    await controller.sendPrompt("Inspect the file", [], "client-tool-loop");

    query.push({
      type: "assistant",
      uuid: "tool-request-row",
      session_id: "remote-session",
      parent_tool_use_id: null,
      message: {
        id: "tool-request-message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "read-one",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
    } as unknown as SDKMessage);
    query.push({
      type: "user",
      uuid: "tool-result-row",
      session_id: "remote-session",
      parent_tool_use_id: "read-one",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "read-one",
            content: "README contents",
          },
        ],
      },
    } as unknown as SDKMessage);
    await waitFor(() =>
      journal.events.some(
        (event) =>
          event.type === "activity.event" &&
          (event.payload as { category?: string }).category === "tool",
      ),
    );
    expect(controller.isBusy()).toBe(true);
    expect(controller.getLease().turnCompletedAt).toBeUndefined();

    query.push({
      type: "result",
      subtype: "success",
      uuid: "tool-loop-result",
      session_id: "remote-session",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as SDKMessage);
    await waitFor(() => !controller.isBusy());
    expect(controller.getLease().turnPhase).toBe("complete");

    await controller.stop();
  });
});
