import type {
  PendingPermission,
  RemoteActivityEvent,
  RemoteConversationEvent,
  RemoteJournalEvent,
  RemoteEventBatch,
  RemoteProviderContext,
  RemoteSessionCapabilities,
  RemoteSessionLease,
  RemoteUsageSnapshot,
} from "../../../src/remote/types.js";
import type { ProviderId } from "../../../src/providers/types.js";

export const FIXTURE_NOW = Date.UTC(2026, 6, 31, 10, 30, 0);

export interface FixtureScenario {
  id: string;
  label: string;
  description: string;
  presentation?: "application" | "pairing" | "pairing-error";
  lease: RemoteSessionLease;
  provider: RemoteProviderContext;
  events: RemoteJournalEvent[];
  batch?: Omit<Partial<RemoteEventBatch>, "events">;
}

const roleModels = {
  default: "gpt-5.6-sol",
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
  subagent: "gpt-5.6-terra",
};

function provider(
  providerId: ProviderId,
  overrides: Partial<RemoteProviderContext> = {},
): RemoteProviderContext {
  const defaults: Record<
    ProviderId,
    Pick<RemoteProviderContext, "label" | "model">
  > = {
    anthropic: {
      label: "Anthropic",
      model: "Claude Sonnet 4.5",
    },
    synthetic: {
      label: "Synthetic",
      model: "Kimi K3",
    },
    "openai-api": {
      label: "OpenAI API",
      model: "gpt-5.6-sol",
    },
    "openai-codex": {
      label: "OpenAI via Codex",
      model: "gpt-5.6-sol",
    },
  };
  const thinkingSupported = providerId !== "synthetic";
  const isCodex = providerId === "openai-codex";
  return {
    provider: providerId,
    ...defaults[providerId],
    reasoningEffort:
      providerId.startsWith("openai") ? "high" : undefined,
    reasoning: {
      thinkingSupported,
      thinkingEnabled: thinkingSupported,
      thinkingUnavailableReason: thinkingSupported
        ? undefined
        : "Synthetic did not report a compatible thinking control for Kimi K3.",
      supportedEffortLevels: thinkingSupported
        ? ["low", "medium", "high", "xhigh", "max"]
        : [],
      effectiveEffort: thinkingSupported ? "high" : undefined,
      effortAuthority: !thinkingSupported
        ? "unavailable"
        : isCodex
          ? "codex-model-list"
          : "claude-sdk",
      workflows: {
        available: true,
        enabled: false,
      },
      ultra: {
        available: thinkingSupported,
        enabled: false,
        unavailableReason: thinkingSupported
          ? undefined
          : "Claude adaptive thinking and Extra high effort are required for Ultra.",
      },
    },
    roleModels:
      providerId === "synthetic"
        ? {
            default: "Kimi K3",
            opus: "Kimi K3",
            sonnet: "Kimi K3",
            haiku: "GLM-4.7-Flash",
            subagent: "Kimi K3",
          }
        : roleModels,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

function lease(
  activeProvider: RemoteProviderContext,
  overrides: Partial<RemoteSessionLease> = {},
): RemoteSessionLease {
  return {
    id: "fixture-lease",
    sourceSessionId: "fixture-source-session",
    activeSessionId: "fixture-active-session",
    sourceTranscriptPath:
      "/Users/example/.claude/projects/modelhop/fixture.jsonl",
    workspacePath: "/Users/example/Projects/ModelHop",
    workspacePaths: [
      "/Users/example/Projects/ModelHop",
      "/Users/example/Projects/ModelHopDocs",
    ],
    workspaceName: "ModelHop · 2 folders",
    title: "Remote reliability and mobile UX",
    ownerDeviceId: "fixture-iphone",
    state: "running",
    permissionMode: "auto-safe",
    provider: activeProvider,
    createdAt: FIXTURE_NOW - 3_600_000,
    lastActivityAt: FIXTURE_NOW,
    tunnelStartedAt: FIXTURE_NOW - 1_800_000,
    providerChanged: false,
    turnPhase: "idle",
    turnStartedAt: FIXTURE_NOW - 42_000,
    ...overrides,
  };
}

function observableLease(
  activeProvider: RemoteProviderContext,
  overrides: Partial<RemoteSessionLease>,
  operational: Record<string, unknown>,
): RemoteSessionLease {
  return {
    ...lease(activeProvider, overrides),
    ...operational,
  };
}

function journal(
  id: number,
  type: string,
  payload: unknown,
  offsetMs = id * 1_000,
): RemoteJournalEvent {
  const event = {
    id,
    type,
    payload,
    createdAt: FIXTURE_NOW + offsetMs,
  };
  return event as RemoteJournalEvent;
}

function conversationItem(
  id: string,
  role: "user" | "assistant",
  content: string,
  status: RemoteConversationEvent["item"]["status"] = "complete",
): RemoteConversationEvent {
  return {
    kind: "conversation.item",
    operation: "upsert",
    item: {
      id,
      role,
      status,
      content,
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    },
  };
}

function activity(
  id: string,
  phase: RemoteActivityEvent["phase"],
  title: string,
  detail?: string,
  overrides: Partial<RemoteActivityEvent> = {},
): RemoteActivityEvent {
  return {
    kind: "activity.event",
    id,
    category: "status",
    phase,
    title,
    detail,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

function capabilities(
  model: string,
): RemoteSessionCapabilities {
  return {
    kind: "session.capabilities",
    model,
    permissionMode: "auto-safe",
    tools: ["Read", "Edit", "Bash", "Glob", "Grep"],
    commands: [
      {
        name: "/compact",
        description: "Compact the conversation context",
      },
      {
        name: "/model",
        description: "Choose the active model",
      },
      {
        name: "/usage",
        description: "Show provider usage",
      },
      {
        name: "/review",
        description: "Review workspace changes",
      },
    ],
    skills: ["interface-kit", "openai-docs"],
    protocolCapabilities: [
      "conversation-items",
      "activity-events",
      "usage-snapshots",
      "file-hierarchy",
    ],
    updatedAt: FIXTURE_NOW,
  };
}

function usage(
  providerId: ProviderId,
): RemoteUsageSnapshot {
  const common = {
    kind: "usage.snapshot" as const,
    provider: providerId,
    status: "available" as const,
    model:
      providerId === "synthetic"
        ? "Kimi K3"
        : providerId === "anthropic"
          ? "Claude Sonnet 4.5"
          : "gpt-5.6-sol",
    updatedAt: FIXTURE_NOW,
    session: {
      inputTokens: 18_420,
      outputTokens: 2_840,
      cacheReadTokens: 11_220,
      totalTokens: 32_480,
      requests: 7,
      costUsd:
        providerId === "openai-api" ? 0.1842 : undefined,
    },
    context: {
      usedTokens: 32_480,
      maxTokens: 200_000,
      percentage: 16.24,
    },
  };
  if (providerId === "synthetic") {
    return {
      ...common,
      allowance: {
        fiveHour: {
          remainingPercent: 35.8,
          nextTickAt: "2026-07-31T10:41:00.000Z",
        },
        weekly: {
          percentRemaining: 51.79,
          nextRegenAt: "2026-07-31T11:33:00.000Z",
        },
      },
    };
  }
  if (providerId === "openai-codex") {
    return {
      ...common,
      allowance: {
        primary: {
          remainingPercent: 60,
          resetsAt: "2026-07-31T14:00:00.000Z",
        },
        resetCredits: 1,
      },
    };
  }
  if (providerId === "openai-api") {
    return {
      ...common,
      allowance: {
        remainingRequests: 4_972,
        remainingTokens: 1_920_000,
      },
    };
  }
  return {
    ...common,
    allowance: {
      source: "claude-account",
    },
  };
}

const openAICodex = provider("openai-codex", {
  usage: {
    codex: {
      rateLimits: {
        primary: {
          usedPercent: 40,
          resetsAt: 1_775_139_600,
        },
        secondary: {
          usedPercent: 14,
          resetsAt: 1_775_488_800,
        },
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [{ id: "reset-fixture", status: "available" }],
        },
      },
    },
  },
});

const synthetic = provider("synthetic", {
  usage: {
    fiveHour: {
      remainingPercent: 35.8,
      nextTickAt: "2026-07-31T10:41:00.000Z",
    },
    weekly: {
      percentRemaining: 51.79,
      nextRegenAt: "2026-07-31T11:33:00.000Z",
    },
  },
});

const anthropicCatalog = provider("anthropic", {
  model: "default",
  roleModels: {
    default: "default",
    opus: "opus",
    sonnet: "sonnet",
    haiku: "haiku",
    subagent: "sonnet",
  },
  modelCatalog: {
    source: "claude-sdk",
    authoritative: true,
    options: [
      {
        selector: "default",
        resolvedModel: "claude-opus-5",
        displayName: "Default Claude model",
        source: "claude-sdk",
        isDefault: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        contextWindow: 200_000,
      },
      {
        selector: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        source: "claude-sdk",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        contextWindow: 200_000,
      },
      {
        selector: "claude-fable-5[1m]",
        resolvedModel: "claude-fable-5",
        displayName: "Fable",
        description:
          "Fable 5 · Most capable for your hardest and longest-running tasks",
        source: "claude-sdk",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        contextWindow: 1_000_000,
      },
      {
        selector: "sonnet",
        resolvedModel: "claude-sonnet-4-5",
        displayName: "Sonnet",
        source: "claude-sdk",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
        contextWindow: 200_000,
      },
      {
        selector: "haiku",
        resolvedModel: "claude-haiku-4-5",
        displayName: "Haiku",
        source: "claude-sdk",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium"],
        supportsAdaptiveThinking: false,
        contextWindow: 200_000,
      },
    ],
    updatedAt: FIXTURE_NOW,
  },
});

const anthropicUltraCapable = provider("anthropic", {
  reasoning: {
    thinkingSupported: true,
    thinkingEnabled: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    effectiveEffort: "high",
    effortAuthority: "claude-sdk",
    workflows: {
      available: true,
      enabled: false,
    },
    ultra: {
      available: false,
      enabled: false,
      unavailableReason: "Turn Workflows on before enabling Ultra.",
    },
  },
});

const codexPrivateReasoning = provider("openai-codex", {
  reasoningEffort: "max",
  reasoning: {
    thinkingSupported: false,
    thinkingEnabled: false,
    thinkingUnavailableReason:
      "Claude Code does not report adaptive thinking support for gpt-5.6-sol.",
    supportedEffortLevels: ["high", "xhigh", "max"],
    effectiveEffort: "max",
    effortAuthority: "codex-model-list",
    workflows: {
      available: true,
      enabled: false,
    },
    ultra: {
      available: true,
      enabled: false,
    },
  },
});

const reasoningLoading = provider("openai-codex", {
  reasoning: undefined,
  modelCatalog: undefined,
});

const baselineEvents: RemoteJournalEvent[] = [
  journal(1, "session.capabilities", capabilities("gpt-5.6-sol")),
  journal(
    2,
    "conversation.item",
    conversationItem(
      "user-1",
      "user",
      "Make remote hand-back reopen this exact Claude conversation.",
    ),
  ),
  journal(
    3,
    "conversation.item",
    conversationItem(
      "assistant-1",
      "assistant",
      "I’ll make the hand-back durable, validate the transcript, and reopen Claude with the exact session ID.",
    ),
  ),
  journal(4, "usage.snapshot", usage("openai-codex")),
];

const longCommand = [
  "ssh -T -i /Users/example/.ssh/remote -p 27245",
  "-o StrictHostKeyChecking=yes root@203.0.113.42",
  "'set -euo pipefail; cd /workspace/model_cache/really/long/path;",
  "python scripts/verify_native_expression_targeted_retry.py",
  "--configuration fixture/reliability/mobile/approval.json'",
].join(" ");

export const fixtureApproval: PendingPermission = {
  requestId: "fixture-approval",
  toolUseId: "tool_fixture_approval",
  toolName: "Bash",
  title: "Remote verification needs approval",
  displayName: "Run remote verification",
  description:
    "Connects to the configured development machine and may replace two generated fixture outputs.",
  decisionReason:
    "Auto-safe requires confirmation for remote commands and destructive writes.",
  input: {
    command: longCommand,
    timeout: 600_000,
    description:
      "Rerun targeted native-expression confirmation and checksum the generated result.",
  },
  createdAt: FIXTURE_NOW,
};

const question = {
  requestId: "fixture-question",
  toolUseId: "tool_fixture_question",
  createdAt: FIXTURE_NOW,
  questions: [
    {
      header: "Release gate",
      question: "Which verification should run next?",
      multiSelect: false,
      options: [
        {
          label: "Mobile browser matrix",
          description: "Run every deterministic phone viewport.",
        },
        {
          label: "Real phone smoke",
          description: "Pair through a fresh Quick Tunnel.",
        },
      ],
    },
  ],
};

const scenarios: FixtureScenario[] = [
  {
    id: "normal",
    label: "Normal conversation",
    description: "Stable Codex conversation with real usage.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: baselineEvents,
  },
  {
    id: "markdown-rich",
    label: "Rich Markdown and file references",
    description:
      "Rendered Markdown with safe repository files, images, and external links.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: [
      journal(1, "session.capabilities", capabilities("gpt-5.6-sol")),
      journal(
        2,
        "conversation.item",
        conversationItem(
          "markdown-user",
          "user",
          "Show the **completed work** and link its files.",
        ),
      ),
      journal(
        3,
        "conversation.item",
        conversationItem(
          "markdown-assistant",
          "assistant",
          [
            "# Remote update",
            "",
            "The **encrypted hand-back** is ready:",
            "",
            "- Open [README.md](README.md#L2-L3)",
            "- Inspect `src/remote/web/mobileApp.ts:42`",
            "- Review [remote security](@ModelHopDocs/remote-security.md)",
            "- Open the bare reference preview.html",
            "",
            "![ModelHop preview](docs/modelhop-preview.png)",
            "",
            "> Provider credentials remain on the Mac.",
            "",
            "```ts",
            'const state = "connected";',
            "```",
            "",
            "| State | Result |",
            "| --- | --- |",
            "| Pairing | Secure |",
            "",
            "Read the [security guide](https://example.com/modelhop).",
            "",
            "<script>window.fixtureUnsafe = true</script>",
            "[Unsafe destination](javascript:alert(1))",
          ].join("\n"),
        ),
      ),
      journal(
        4,
        "activity.event",
        activity(
          "markdown-activity",
          "complete",
          "Remote update complete",
          "**Encrypted journal** retained for reconnection.",
        ),
      ),
      journal(5, "usage.snapshot", usage("openai-codex")),
    ],
  },
  {
    id: "maximum-active-turn",
    label: "Eight-hour limit during an active turn",
    description:
      "New input is revoked while the Mac-side Claude turn continues.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "running",
      turnPhase: "streaming",
      remoteInputRevokedAt: FIXTURE_NOW,
      remoteInputRevokedReason: "maximum-session",
    }),
    events: [
      ...baselineEvents,
      journal(
        10,
        "activity.event",
        activity(
          "remote-input-maximum-session",
          "streaming",
          "Remote session reached its eight-hour limit",
          "New prompts are disabled. The active Claude turn will continue and return to the laptop when it finishes.",
          { category: "lifecycle" },
        ),
      ),
    ],
  },
  {
    id: "prompt-queued",
    label: "Prompt · queued",
    description: "An outgoing message is durably queued before submission.",
    provider: openAICodex,
    lease: lease(openAICodex, { turnPhase: "queued" }),
    events: [
      journal(1, "session.capabilities", capabilities("gpt-5.6-sol")),
      journal(
        2,
        "conversation.item",
        conversationItem(
          "fixture-prompt-queued",
          "user",
          "Run the mobile regression matrix.",
          "queued",
        ),
      ),
    ],
  },
  {
    id: "prompt-accepted",
    label: "Prompt · accepted",
    description: "An outgoing message has been accepted exactly once.",
    provider: openAICodex,
    lease: lease(openAICodex, { turnPhase: "requesting" }),
    events: [
      journal(1, "session.capabilities", capabilities("gpt-5.6-sol")),
      journal(
        2,
        "conversation.item",
        conversationItem(
          "fixture-prompt-accepted",
          "user",
          "Keep my reading position stable.",
          "accepted",
        ),
      ),
    ],
  },
  {
    id: "prompt-failed",
    label: "Prompt · failed",
    description: "A rejected send remains visible with a retryable state.",
    provider: openAICodex,
    lease: lease(openAICodex, { turnPhase: "failed" }),
    events: [
      journal(1, "session.capabilities", capabilities("gpt-5.6-sol")),
      journal(
        2,
        "conversation.item",
        conversationItem(
          "fixture-prompt-failed",
          "user",
          "This deterministic message was rejected.",
          "failed",
        ),
      ),
      journal(3, "error", {
        message: "The fixture transport rejected this prompt.",
      }),
    ],
  },
  {
    id: "auto-safe",
    label: "Auto-safe routine work",
    description: "A routine read proceeds without an approval sheet.",
    provider: synthetic,
    lease: lease(synthetic, { turnPhase: "running-tool" }),
    events: [
      journal(1, "session.capabilities", capabilities("Kimi K3")),
      journal(
        2,
        "activity.event",
        activity(
          "auto-safe-read",
          "running-tool",
          "Reading workspace files",
          "Auto-safe allowed this routine read.",
          { category: "tool", toolUseId: "tool_auto_safe" },
        ),
      ),
    ],
  },
  {
    id: "long-conversation",
    label: "Long conversation",
    description: "Many messages and long wrapping content.",
    provider: synthetic,
    lease: lease(synthetic),
    events: [
      journal(1, "session.capabilities", capabilities("Kimi K3")),
      ...Array.from({ length: 22 }, (_, index) =>
        journal(
          index + 2,
          "conversation.item",
          conversationItem(
            `fixture-long-conversation-${index}`,
            index % 2 === 0 ? "user" : "assistant",
            index % 2 === 0
              ? `Review mobile behaviour for step ${index + 1}, keeping the current conversation and all tool links intact.`
              : `Step ${index + 1} is complete. The deterministic transcript remains readable while additional streamed content arrives.`,
          ),
        ),
      ),
      journal(30, "usage.snapshot", usage("synthetic")),
    ],
  },
  {
    id: "compacting",
    label: "Long compaction",
    description: "Context counting and bridge-side compaction in progress.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      turnPhase: "compacting",
    }),
    events: [
      ...baselineEvents,
      journal(
        10,
        "activity.event",
        activity(
          "counting",
          "counting",
          "Measuring conversation context",
          "184,200 of 200,000 tokens",
          { category: "compaction" },
        ),
      ),
      journal(
        11,
        "activity.event",
        activity(
          "compacting",
          "compacting",
          "Compacting completed history",
          "Preserving recent messages and every tool-call relationship.",
          {
            category: "compaction",
            progress: { current: 68, total: 100, elapsedMs: 18_400 },
          },
        ),
      ),
    ],
  },
  {
    id: "thinking",
    label: "Thinking and counting",
    description:
      "A readable thinking phase followed by model-aware token counting.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      turnPhase: "counting",
    }),
    events: [
      ...baselineEvents,
      journal(
        10,
        "activity.event",
        activity(
          "thinking",
          "requesting",
          "Claude is thinking",
          "Planning the safest way to preserve the active conversation.",
          { category: "information" },
        ),
      ),
      journal(
        11,
        "activity.event",
        activity(
          "thinking-count",
          "counting",
          "Counting context for gpt-5.6-sol",
          "184,200 of 200,000 tokens",
          { category: "compaction" },
        ),
      ),
    ],
  },
  {
    id: "reasoning-ultra-capable",
    label: "Reasoning controls · Ultra capable",
    description:
      "An eligible Claude session exposes thinking, model-valid effort, workflows, and Ultra.",
    provider: anthropicUltraCapable,
    lease: lease(anthropicUltraCapable),
    events: [
      journal(
        1,
        "session.capabilities",
        capabilities(anthropicUltraCapable.model),
      ),
    ],
  },
  {
    id: "reasoning-provider-private",
    label: "Reasoning controls · provider private",
    description:
      "Provider-native effort remains available when Claude adaptive thinking is not.",
    provider: codexPrivateReasoning,
    lease: lease(codexPrivateReasoning),
    events: [
      journal(
        1,
        "session.capabilities",
        capabilities(codexPrivateReasoning.model),
      ),
    ],
  },
  {
    id: "reasoning-loading",
    label: "Reasoning controls · loading",
    description:
      "Capability discovery is visibly pending and never misreported as unsupported.",
    provider: reasoningLoading,
    lease: lease(reasoningLoading),
    events: [
      journal(
        1,
        "session.capabilities",
        capabilities(reasoningLoading.model),
      ),
    ],
  },
  {
    id: "tools-running",
    label: "Tools and tasks",
    description: "Parallel tools and a long-running background task.",
    provider: synthetic,
    lease: lease(synthetic, {
      turnPhase: "running-task",
    }),
    events: [
      ...baselineEvents,
      journal(
        12,
        "activity.event",
        activity(
          "tool-read",
          "running-tool",
          "Reading remote session controller",
          "Parallel call 1 of 2 · src/remote/sessionController.ts",
          { category: "tool", toolUseId: "tool_read_fixture" },
        ),
      ),
      journal(
        13,
        "activity.event",
        activity(
          "tool-grep",
          "running-tool",
          "Searching hand-back references",
          "Parallel call 2 of 2 · src/remote/**/*.ts",
          { category: "tool", toolUseId: "tool_grep_fixture" },
        ),
      ),
      journal(
        14,
        "activity.event",
        activity(
          "task-test",
          "running-task",
          "Mobile browser tests are running",
          "18 of 42 assertions passed",
          {
            category: "task",
            taskId: "task_mobile_fixture",
            progress: { current: 18, total: 42, elapsedMs: 32_000 },
          },
        ),
      ),
    ],
  },
  {
    id: "approval",
    label: "High-risk approval",
    description: "A long command that Auto-safe cannot approve.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "waiting-for-permission",
      turnPhase: "waiting-approval",
    }),
    events: [
      ...baselineEvents,
      journal(12, "permission.request", fixtureApproval),
      journal(
        13,
        "activity.event",
        activity(
          "approval-wait",
          "waiting-approval",
          "Your approval is required",
          "Remote verification is paused.",
          {
            category: "permission",
            toolUseId: fixtureApproval.toolUseId,
          },
        ),
      ),
    ],
  },
  {
    id: "approval-notification",
    label: "Approval alert",
    description: "Browser notification routes to one exact approval.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: baselineEvents,
  },
  {
    id: "question",
    label: "Claude question",
    description: "A structured question waits for the phone owner.",
    provider: synthetic,
    lease: lease(synthetic, {
      state: "waiting-for-question",
      turnPhase: "waiting-question",
    }),
    events: [
      journal(1, "session.capabilities", capabilities("Kimi K3")),
      journal(2, "question.request", question),
    ],
  },
  {
    id: "models-anthropic",
    label: "Models · Anthropic",
    description:
      "Anthropic SDK selectors stay separate from their human-facing labels and resolved model names.",
    provider: anthropicCatalog,
    lease: lease(anthropicCatalog),
    events: [
      journal(1, "session.capabilities", capabilities("default")),
    ],
  },
  ...(["auto-safe", "acceptEdits", "default", "plan"] as const).map(
    (mode, index): FixtureScenario => ({
      id: `permission-${mode}`,
      label: `Permission · ${mode}`,
      description: `Remote permission mode ${mode}.`,
      provider: openAICodex,
      lease: lease(openAICodex, { permissionMode: mode }),
      events: [
        journal(1 + index, "session.capabilities", {
          ...capabilities("gpt-5.6-sol"),
          permissionMode: mode,
        }),
      ],
    }),
  ),
  {
    id: "permission-change-failed",
    label: "Permission · rejected change",
    description:
      "An authoritative command failure restores the prior permission mode.",
    provider: openAICodex,
    lease: lease(openAICodex, { permissionMode: "default" }),
    events: [
      journal(1, "session.capabilities", {
        ...capabilities("gpt-5.6-sol"),
        permissionMode: "default",
      }),
    ],
  },
  ...(
    [
      "anthropic",
      "synthetic",
      "openai-api",
      "openai-codex",
    ] as ProviderId[]
  ).map((providerId, index): FixtureScenario => {
    const active = providerId === "synthetic"
      ? synthetic
      : providerId === "openai-codex"
        ? openAICodex
        : provider(providerId);
    return {
      id: `usage-${providerId}`,
      label: `Usage · ${active.label}`,
      description: `Provider-specific usage for ${active.label}.`,
      provider: active,
      lease: lease(active),
      events: [
        journal(1, "session.capabilities", capabilities(active.model)),
        journal(2 + index, "usage.snapshot", usage(providerId)),
      ],
    };
  }),
  {
    id: "provider-switch-waiting",
    label: "Provider switch waiting for turn",
    description:
      "A reconnected phone remains blocked while Claude finishes the current turn before switching.",
    provider: synthetic,
    lease: lease(synthetic, {
      state: "running",
      turnPhase: "streaming",
      operation: {
        id: "fixture-switch-waiting-operation",
        kind: "provider-switch",
        phase: "waiting-for-turn",
        leaseId: "fixture-lease",
        ownerWorkspacePath: "/Users/example/Projects/ModelHop",
        requestedAt: FIXTURE_NOW - 5_000,
        updatedAt: FIXTURE_NOW,
        deadlineAt: FIXTURE_NOW + 60_000,
        previousProvider: "synthetic",
        targetProvider: "openai-codex",
      },
    }),
    events: [
      ...baselineEvents,
      journal(
        12,
        "operation.state",
        {
          id: "fixture-switch-waiting-operation",
          kind: "provider-switch",
          phase: "waiting-for-turn",
        },
      ),
    ],
  },
  {
    id: "switching-provider",
    label: "Provider switching",
    description: "Input is blocked while ModelHop changes provider.",
    provider: synthetic,
    lease: lease(synthetic, {
      state: "switching-provider",
      turnPhase: "switching-provider",
      operation: {
        id: "fixture-switch-operation",
        kind: "provider-switch",
        phase: "reloading",
        leaseId: "fixture-lease",
        ownerWorkspacePath: "/Users/example/Projects/ModelHop",
        requestedAt: FIXTURE_NOW - 5_000,
        updatedAt: FIXTURE_NOW,
        deadlineAt: FIXTURE_NOW + 60_000,
        previousProvider: "synthetic",
        targetProvider: "openai-codex",
      },
    }),
    events: [
      ...baselineEvents,
      journal(
        12,
        "activity.event",
        activity(
          "provider-switch",
          "switching-provider",
          "Switching to OpenAI via Codex",
          "Reloading Claude Code and restoring this remote session.",
          { category: "lifecycle" },
        ),
      ),
    ],
  },
  {
    id: "provider-rollback",
    label: "Provider rollback",
    description: "A failed switch restores the previous Synthetic route.",
    provider: synthetic,
    lease: lease(synthetic, {
      state: "error",
      turnPhase: "failed",
      error: "Codex failed to become ready; Synthetic was restored.",
      operation: {
        id: "fixture-provider-rollback",
        kind: "provider-switch",
        phase: "failed",
        leaseId: "fixture-lease",
        ownerWorkspacePath: "/Users/example/Projects/ModelHop",
        requestedAt: FIXTURE_NOW - 20_000,
        updatedAt: FIXTURE_NOW,
        deadlineAt: FIXTURE_NOW + 40_000,
        previousProvider: "synthetic",
        targetProvider: "openai-codex",
        error: "Codex failed to become ready.",
      },
    }),
    events: [
      journal(
        1,
        "activity.event",
        activity(
          "rollback",
          "failed",
          "Provider switch rolled back",
          "Synthetic and Kimi K3 remain active.",
          { category: "error" },
        ),
      ),
    ],
  },
  {
    id: "reload-recovery",
    label: "Reload recovery",
    description: "A durable provider operation is reclaimed after reload.",
    provider: synthetic,
    lease: lease(synthetic, {
      state: "switching-provider",
      turnPhase: "switching-provider",
      operation: {
        id: "fixture-reload-recovery",
        kind: "provider-switch",
        phase: "restarting",
        leaseId: "fixture-lease",
        ownerWorkspacePath: "/Users/example/Projects/ModelHop",
        requestedAt: FIXTURE_NOW - 8_000,
        updatedAt: FIXTURE_NOW,
        deadlineAt: FIXTURE_NOW + 52_000,
        previousProvider: "synthetic",
        targetProvider: "openai-codex",
      },
    }),
    events: [
      journal(
        1,
        "activity.event",
        activity(
          "reload-recovery",
          "switching-provider",
          "Restoring provider switch after reload",
          "The phone link and pending operation stayed active.",
          { category: "lifecycle" },
        ),
      ),
    ],
  },
  {
    id: "handback-long-workflow",
    label: "Hand-back · long workflow",
    description: "Return waits for a named workflow without stopping Mac-side work.",
    provider: openAICodex,
    lease: observableLease(
      openAICodex,
      { state: "handing-back", turnPhase: "handing-back" },
      {
        operation: {
          id: "handoff-long-workflow",
          kind: "handback",
          phase: "waiting-for-work",
          requestedAt: FIXTURE_NOW - 64 * 60_000,
          updatedAt: FIXTURE_NOW - 8_000,
          attentionAt: FIXTURE_NOW + 60_000,
          blockerIds: ["workflow-audit"],
          waitReason: "Waiting for the workflow's authoritative terminal record.",
        },
        workItems: [{
          id: "workflow-audit",
          kind: "workflow",
          title: "Audit GNM rights evidence",
          phase: "running",
          detail: "All three research agents are still coordinated by this workflow.",
          startedAt: FIXTURE_NOW - 64 * 60_000,
          updatedAt: FIXTURE_NOW - 8_000,
          progress: { current: 3, total: 4 },
          blocksQuiescence: true,
        }],
      },
    ),
    events: baselineEvents,
  },
  {
    id: "handback-overdue",
    label: "Hand-back · overdue",
    description: "The attention threshold offers safe choices without cancelling work.",
    provider: openAICodex,
    lease: observableLease(
      openAICodex,
      { state: "handing-back", turnPhase: "handing-back" },
      {
        operation: {
          id: "handoff-overdue",
          kind: "handback",
          phase: "waiting-for-work",
          requestedAt: FIXTURE_NOW - 72 * 60_000,
          updatedAt: FIXTURE_NOW - 11_000,
          attentionAt: FIXTURE_NOW - 57 * 60_000,
          blockerIds: ["workflow-overdue"],
          availableActions: [
            "continue-waiting",
            "cancel-handback",
            "cancel-work-and-return",
          ],
        },
        workItems: [{
          id: "workflow-overdue",
          kind: "workflow",
          title: "Remote reliability audit",
          phase: "running",
          detail: "The workflow is still writing its final verification artifacts.",
          startedAt: FIXTURE_NOW - 72 * 60_000,
          updatedAt: FIXTURE_NOW - 11_000,
          progress: { percent: 92 },
          blocksQuiescence: true,
        }],
      },
    ),
    events: baselineEvents,
  },
  {
    id: "final-record-reconciliation",
    label: "Final record reconciliation",
    description: "Files landed, but completion remains pending until the final workflow record arrives.",
    provider: openAICodex,
    lease: observableLease(
      openAICodex,
      { state: "running", turnPhase: "running-task" },
      {
        workItems: [{
          id: "workflow-record",
          kind: "workflow",
          title: "Audit GNM rights evidence",
          phase: "settling",
          detail: "All child agents finished; ModelHop is preserving the query while the workflow record is committed.",
          startedAt: FIXTURE_NOW - 66 * 60_000,
          updatedAt: FIXTURE_NOW - 4_000,
          blocksQuiescence: true,
          outputReferences: ["docs/audit-results.md"],
        }],
      },
    ),
    events: baselineEvents,
  },
  {
    id: "tunnel-lost-active-work",
    label: "Tunnel lost · work active",
    description: "The phone link is gone while Claude continues locally.",
    provider: synthetic,
    lease: observableLease(
      synthetic,
      { state: "running", turnPhase: "running-task" },
      {
        transport: { state: "link-lost" },
        workItems: [{
          id: "workflow-tunnel-loss",
          kind: "workflow",
          title: "Run mobile reliability gate",
          phase: "running",
          detail: "The encrypted journal is still recording progress on your Mac.",
          startedAt: FIXTURE_NOW - 9 * 60_000,
          updatedAt: FIXTURE_NOW - 2_000,
        }],
      },
    ),
    events: baselineEvents,
  },
  {
    id: "journal-gap-resync",
    label: "Journal gap resync",
    description: "A reconnect pauses commands until an atomic Mac snapshot arrives.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: [],
    batch: {
      epoch: "fixture-epoch-2",
      earliestEventId: 8_000,
      latestEventId: 10_120,
      snapshotCursor: 10_116,
      gap: true,
      snapshot: {
        version: 1,
        revision: 31,
        capturedAt: FIXTURE_NOW,
        lease: lease(openAICodex, {
          state: "running",
          turnPhase: "running-tool",
        }),
        transport: { state: "connected", updatedAt: FIXTURE_NOW },
        execution: {
          state: "running",
          queryGeneration: 4,
          foregroundActive: true,
          lastProgressAt: FIXTURE_NOW - 1_000,
          workItems: [{
            id: "work-after-gap",
            kind: "tool",
            title: "Rebuild encrypted activity view",
            phase: "active",
            createdAt: FIXTURE_NOW - 10_000,
            updatedAt: FIXTURE_NOW - 1_000,
            lastProgressAt: FIXTURE_NOW - 1_000,
            cancellable: true,
          }],
        },
        ownership: {
          workspaceOwnerId: "fixture-window",
          deviceId: "fixture-iphone",
          fencingGeneration: 4,
        },
        route: { revision: 18, provider: openAICodex },
        usage: usage("openai-codex"),
        journal: {
          epoch: "fixture-epoch-2",
          latestEventId: 10_120,
          snapshotCursor: 10_116,
        },
        pendingInteractions: { approvalIds: [], questionIds: [] },
      },
    },
  },
  {
    id: "delivery-unknown",
    label: "Delivery unknown",
    description: "A lost phone response checks the Mac before retrying the prompt.",
    provider: openAICodex,
    lease: lease(openAICodex, { state: "paired", turnPhase: "idle" }),
    events: baselineEvents,
  },
  {
    id: "multiple-approvals",
    label: "Multiple approvals",
    description: "Independent protected actions remain visible and resolvable.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "waiting-for-permission",
      turnPhase: "waiting-approval",
    }),
    events: [
      journal(1, "permission.request", fixtureApproval),
      journal(2, "permission.request", {
        ...fixtureApproval,
        requestId: "fixture-approval-push",
        toolUseId: "tool_fixture_push",
        title: "Publishing needs approval",
        displayName: "Push the current branch",
        description: "Writes commits to the configured remote repository.",
        decisionReason: "Auto-safe always confirms external writes.",
        input: { command: "git push origin feature/remote-reliability" },
      } satisfies PendingPermission),
    ],
  },
  {
    id: "provider-rollback-usable",
    label: "Provider rollback · usable",
    description: "A failed route change restores the old provider without stranding input.",
    provider: synthetic,
    lease: observableLease(
      synthetic,
      { state: "running", turnPhase: "idle" },
      {
        operation: {
          id: "rollback-usable",
          kind: "provider-switch",
          phase: "failed",
          requestedAt: FIXTURE_NOW - 35_000,
          updatedAt: FIXTURE_NOW,
          rollbackResult: "Synthetic · Kimi K3 is active again. You can continue this conversation.",
        },
        routeRevision: 24,
      },
    ),
    events: [
      journal(1, "activity.event", activity(
        "rollback-usable",
        "complete",
        "Previous provider restored",
        "Synthetic · Kimi K3 is active and ready.",
        { category: "lifecycle" },
      )),
    ],
  },
  {
    id: "stale-model-usage",
    label: "Stale model usage",
    description: "Old-provider usage cannot replace the current route revision.",
    provider: openAICodex,
    lease: observableLease(
      openAICodex,
      { state: "running", turnPhase: "idle" },
      { routeRevision: 18 },
    ),
    events: [
      journal(1, "usage.snapshot", usage("synthetic")),
      journal(2, "provider.context", openAICodex),
      journal(3, "usage.snapshot", usage("openai-codex")),
    ],
  },
  {
    id: "expired-poll",
    label: "Expired poll",
    description: "An expired link is distinct from transient reconnecting.",
    provider: openAICodex,
    lease: observableLease(
      openAICodex,
      { state: "running", turnPhase: "idle" },
      { transport: { state: "expired" } },
    ),
    events: [],
  },
  {
    id: "non-owner-window",
    label: "Non-owner window",
    description: "A second editor window can monitor but cannot mutate the lease.",
    provider: openAICodex,
    lease: observableLease(
      openAICodex,
      { state: "running", turnPhase: "running-task" },
      {
        ownership: {
          owner: "non-owner",
          canMutate: false,
          ownerLabel: "ModelHop window · GameAnimationGenerator",
          fencingGeneration: 7,
        },
        workItems: [{
          id: "owner-workflow",
          kind: "workflow",
          title: "Owned by GameAnimationGenerator window",
          phase: "running",
          updatedAt: FIXTURE_NOW - 3_000,
        }],
      },
    ),
    events: baselineEvents,
  },
  {
    id: "reconnecting",
    label: "Reconnecting",
    description: "Encrypted link interruption with journal recovery.",
    provider: synthetic,
    lease: lease(synthetic),
    events: [
      ...baselineEvents,
      journal(
        12,
        "activity.event",
        activity(
          "reconnecting",
          "requesting",
          "Reconnecting securely",
          "No prompt or tool call will be repeated.",
          { category: "lifecycle" },
        ),
      ),
    ],
  },
  {
    id: "handback-failed",
    label: "Hand-back recovery",
    description: "Exact Claude session could not be opened yet.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "handing-back",
      turnPhase: "handing-back",
      operation: {
        id: "fixture-handback",
        kind: "handback",
        phase: "failed",
        leaseId: "fixture-lease",
        ownerWorkspacePath: "/Users/example/Projects/ModelHop",
        requestedAt: FIXTURE_NOW - 15_000,
        updatedAt: FIXTURE_NOW,
        deadlineAt: FIXTURE_NOW + 120_000,
        error: "Claude Code is still activating.",
      },
    }),
    events: [
      ...baselineEvents,
      journal(12, "operation.state", {
        id: "fixture-handback",
        kind: "handback",
        phase: "failed",
        requestedAt: FIXTURE_NOW - 15_000,
        updatedAt: FIXTURE_NOW,
        error: "Claude Code is still activating.",
      }),
    ],
  },
  {
    id: "handback-delivery-unknown",
    label: "Hand-back · checking Mac",
    description:
      "A lost command response is reconciled with the original durable command ID.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "running",
      turnPhase: "idle",
    }),
    events: baselineEvents,
  },
  {
    id: "handback-delayed",
    label: "Hand-back · finishing turn",
    description: "Phone input is locked while the active turn finishes.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "handing-back",
      turnPhase: "handing-back",
      operation: {
        id: "fixture-handback-delayed",
        kind: "handback",
        phase: "waiting-for-turn",
        leaseId: "fixture-lease",
        ownerWorkspacePath: "/Users/example/Projects/ModelHop",
        requestedAt: FIXTURE_NOW - 6_000,
        updatedAt: FIXTURE_NOW,
        deadlineAt: FIXTURE_NOW + 114_000,
      },
    }),
    events: [
      journal(
        1,
        "activity.event",
        activity(
          "handback-delayed",
          "handing-back",
          "Finishing the active turn",
          "ModelHop will verify the transcript before opening Claude.",
          { category: "lifecycle" },
        ),
      ),
    ],
  },
  {
    id: "handback-success",
    label: "Hand-back · success",
    description: "The exact conversation opened and the link is ending.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "stopped",
      turnPhase: "complete",
    }),
    events: [
      journal(1, "notification", {
        message:
          "The exact Claude conversation is open on your laptop.",
      }),
    ],
  },
  {
    id: "recovery-success",
    label: "Recovery · success",
    description: "A retained handoff record reopened the exact session.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "running",
      turnPhase: "complete",
    }),
    events: [
      journal(
        1,
        "activity.event",
        activity(
          "recovery-success",
          "complete",
          "Conversation recovery succeeded",
          "Claude opened fixture-active-session.",
          { category: "lifecycle" },
        ),
      ),
    ],
  },
  {
    id: "expired-session",
    label: "Expired session",
    description: "The previous phone link ended and cannot be reused.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "error",
      turnPhase: "failed",
      error:
        "This temporary phone link has expired. Create a new QR code on your laptop.",
    }),
    events: [],
  },
  {
    id: "slash-commands",
    label: "Slash commands",
    description: "Authoritative Claude Code command autocomplete.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: [
      journal(1, "session.capabilities", capabilities("gpt-5.6-sol")),
    ],
  },
  {
    id: "attachments",
    label: "Attachment choices",
    description: "Repository, document, photo, and camera sources.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: baselineEvents,
  },
  {
    id: "generated-files",
    label: "Generated files",
    description: "Completed task with durable output paths.",
    provider: synthetic,
    lease: lease(synthetic, { turnPhase: "complete" }),
    events: [
      journal(
        1,
        "activity.event",
        activity(
          "generated-files",
          "complete",
          "Mobile snapshots generated",
          "test/mobile/__screenshots__/normal.png",
          { category: "task" },
        ),
      ),
    ],
  },
  {
    id: "git-changes",
    label: "Git status and diff",
    description: "Reviewable workspace changes and generated files.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: baselineEvents,
  },
  {
    id: "multi-root-files",
    label: "Multi-root repository",
    description: "Two lazy workspace roots with pagination.",
    provider: openAICodex,
    lease: lease(openAICodex),
    events: baselineEvents,
  },
  {
    id: "wrapping-stress",
    label: "Wrapping stress",
    description: "Long paths, commands, JSON, URLs, and errors.",
    provider: openAICodex,
    lease: lease(openAICodex, { turnPhase: "failed" }),
    events: [
      journal(
        1,
        "conversation.item",
        conversationItem(
          "wrapping-user",
          "user",
          `Inspect ${"/workspace/extremely-long-directory-name/".repeat(8)}fixture.ts`,
        ),
      ),
      journal(2, "error", {
        message:
          `Remote command failed: ${longCommand} ${"UNBROKEN_IDENTIFIER_".repeat(18)}`,
      }),
    ],
  },
  {
    id: "ended",
    label: "Ended tunnel",
    description: "Terminal page after conversation returns to laptop.",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "stopped",
      turnPhase: "complete",
    }),
    events: [
      journal(1, "notification", {
        message:
          "Conversation returned to laptop. This temporary phone link has ended.",
      }),
    ],
  },
  {
    id: "pairing",
    label: "Pairing",
    description: "Six-digit confirmation on a fresh phone.",
    presentation: "pairing",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "waiting-for-device",
      ownerDeviceId: undefined,
    }),
    events: [],
  },
  {
    id: "pairing-error",
    label: "Pairing failure",
    description: "Expired launch token with a safe retry explanation.",
    presentation: "pairing-error",
    provider: openAICodex,
    lease: lease(openAICodex, {
      state: "error",
      ownerDeviceId: undefined,
      error: "This private launch link has expired.",
    }),
    events: [],
  },
];

export const fixtureScenarios = new Map(
  scenarios.map((scenario) => [scenario.id, scenario]),
);

export const defaultFixtureScenario = scenarios[0]!;

export function fixtureScenarioList(): FixtureScenario[] {
  return [...scenarios];
}
