import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { OpenAIReasoningEffort } from "../providers/types.js";
import type {
  RemoteModelOption,
  RemoteProviderContext,
  RemoteReasoningCapabilityAuthority,
  RemoteReasoningContext,
} from "./types.js";
import { findUniqueRemoteModelOption } from "./providerRuntime.js";

export interface RemoteReasoningSettingsSnapshot {
  alwaysThinkingEnabled?: boolean;
  effortLevel?: OpenAIReasoningEffort;
  enableWorkflows?: boolean;
  disableWorkflows?: boolean;
  ultracode?: boolean;
}

const VALID_EFFORTS = new Set<OpenAIReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function remoteEffortRequiresClaudeThinking(
  provider: RemoteProviderContext["provider"],
  effort: OpenAIReasoningEffort | undefined,
): boolean {
  return (
    provider === "anthropic" &&
    (effort === "xhigh" || effort === "max")
  );
}

export function isRemoteReasoningEffort(
  value: unknown,
): value is OpenAIReasoningEffort {
  return (
    typeof value === "string" &&
    VALID_EFFORTS.has(value as OpenAIReasoningEffort)
  );
}

function uniqueEfforts(
  values: readonly unknown[] | undefined,
): OpenAIReasoningEffort[] {
  return [
    ...new Set((values ?? []).filter(isRemoteReasoningEffort)),
  ];
}

function matchingModel(
  models: readonly ModelInfo[],
  model: string,
): ModelInfo | undefined {
  const rows = models.map((candidate) => ({
    candidate,
    option: {
      selector: candidate.value,
      ...(candidate.resolvedModel
        ? { resolvedModel: candidate.resolvedModel }
        : {}),
      displayName: candidate.displayName,
      description: candidate.description,
      source: "claude-sdk",
      supportsEffort: candidate.supportsEffort,
      supportedEffortLevels: uniqueEfforts(
        candidate.supportedEffortLevels,
      ),
      supportsAdaptiveThinking:
        candidate.supportsAdaptiveThinking,
      supportsFastMode: candidate.supportsFastMode,
      supportsAutoMode: candidate.supportsAutoMode,
    } satisfies RemoteModelOption,
  }));
  const match = findUniqueRemoteModelOption(
    rows.map((row) => row.option),
    model,
  );
  return rows.find((row) => row.option === match?.option)?.candidate;
}

function providerModelSelectors(
  provider: RemoteProviderContext,
): string[] {
  const match = findUniqueRemoteModelOption(
    provider.modelCatalog?.options ?? [],
    provider.model,
  );
  return [
    provider.model,
    match?.option.selector,
    match?.option.resolvedModel,
  ].filter(
    (value, index, all): value is string =>
      Boolean(value) && all.indexOf(value) === index,
  );
}

function providerCatalogModel(
  provider: RemoteProviderContext,
): RemoteModelOption | undefined {
  return findUniqueRemoteModelOption(
    provider.modelCatalog?.options ?? [],
    provider.model,
  )?.option;
}

function providerCatalogAuthority(
  provider: RemoteProviderContext,
  model: RemoteModelOption,
): RemoteReasoningCapabilityAuthority {
  const source =
    model.source === "merged"
      ? provider.modelCatalog?.source
      : model.source;
  switch (source) {
    case "claude-sdk":
      return "claude-sdk";
    case "synthetic-api":
      return "synthetic-api";
    case "openai-api":
      return "openai-model-list";
    case "codex-model-list":
      return "codex-model-list";
    case "merged":
    case undefined:
      return "provider-model-catalog";
  }
}

function providerEffortAuthority(
  provider: RemoteProviderContext,
): RemoteReasoningCapabilityAuthority {
  return provider.provider === "openai-codex"
    ? "codex-model-list"
    : "openai-model-list";
}

function unavailableWorkflowsReason(
  administrativelyDisabled: boolean,
  workflowBridgeReady: boolean,
): string | undefined {
  if (administrativelyDisabled) {
    return "Dynamic workflows are disabled by the active Claude Code environment or policy.";
  }
  if (!workflowBridgeReady) {
    return "Remote workflow consent and child-run recovery are not connected yet.";
  }
  return undefined;
}

/**
 * Reconcile the live SDK catalog with any provider-authoritative catalog and
 * the session's current flag settings. OpenAI provider discovery wins for
 * effort values. Claude's initialization metadata remains authoritative for
 * Claude-harness thinking when it reports the selected model; a provider
 * catalog can supply that capability only when the SDK row is absent.
 */
export function resolveRemoteReasoningContext(
  provider: RemoteProviderContext,
  models: readonly ModelInfo[],
  settings: RemoteReasoningSettingsSnapshot,
  options: {
    workflowsAdministrativelyDisabled?: boolean;
    workflowBridgeReady?: boolean;
  } = {},
): RemoteReasoningContext {
  const modelSelectors = providerModelSelectors(provider);
  const sdkModel = modelSelectors
    .map((selector) => matchingModel(models, selector))
    .find((candidate) => candidate !== undefined);
  const catalogModel = providerCatalogModel(provider);
  const authoritativeCatalogModel =
    provider.modelCatalog?.authoritative === true
      ? catalogModel
      : undefined;
  const providerEfforts =
    provider.provider === "openai-codex" ||
    provider.provider === "openai-api"
      ? modelSelectors
          .map(
            (selector) =>
              provider.modelReasoningEfforts?.[selector],
          )
          .find((efforts) => efforts !== undefined)
      : undefined;
  const catalogAdvertisesEffort = Boolean(
    authoritativeCatalogModel &&
      (authoritativeCatalogModel.supportsEffort !== undefined ||
        authoritativeCatalogModel.supportedEffortLevels !== undefined),
  );
  let supportedEffortLevels: OpenAIReasoningEffort[];
  let effortAuthority: RemoteReasoningCapabilityAuthority;
  if (providerEfforts !== undefined) {
    supportedEffortLevels = uniqueEfforts(providerEfforts);
    effortAuthority = providerEffortAuthority(provider);
  } else if (sdkModel) {
    supportedEffortLevels = sdkModel.supportsEffort
      ? uniqueEfforts(sdkModel.supportedEffortLevels)
      : [];
    effortAuthority = "claude-sdk";
  } else if (authoritativeCatalogModel && catalogAdvertisesEffort) {
    supportedEffortLevels = authoritativeCatalogModel.supportsEffort
      ? uniqueEfforts(
          authoritativeCatalogModel.supportedEffortLevels,
        )
      : [];
    effortAuthority = providerCatalogAuthority(
      provider,
      authoritativeCatalogModel,
    );
  } else {
    supportedEffortLevels = [];
    effortAuthority = "unavailable";
  }
  let thinkingSupported = false;
  let thinkingAuthority: RemoteReasoningCapabilityAuthority =
    "unavailable";
  if (sdkModel) {
    thinkingSupported = sdkModel.supportsAdaptiveThinking === true;
    thinkingAuthority = "claude-sdk";
  } else if (
    authoritativeCatalogModel &&
    typeof authoritativeCatalogModel.supportsAdaptiveThinking ===
      "boolean"
  ) {
    thinkingSupported =
      authoritativeCatalogModel.supportsAdaptiveThinking;
    thinkingAuthority = providerCatalogAuthority(
      provider,
      authoritativeCatalogModel,
    );
  }
  const previous = provider.reasoning;
  const selectedEffort =
    previous?.effectiveEffort ??
    provider.reasoningEffort ??
    settings.effortLevel;
  const effectiveEffort =
    selectedEffort &&
    supportedEffortLevels.includes(selectedEffort)
      ? selectedEffort
      : undefined;
  // Anthropic rejects xhigh/max at request time unless Claude thinking is
  // actually enabled. Normalize stale setting combinations here so the UI
  // cannot advertise an API-invalid state. Provider-native OpenAI effort is
  // intentionally independent from Claude thinking.
  const thinkingEnabled = thinkingSupported
    ? remoteEffortRequiresClaudeThinking(
        provider.provider,
        effectiveEffort,
      ) ||
      (previous?.thinkingEnabled ??
        settings.alwaysThinkingEnabled !== false)
    : false;
  const workflowsAdministrativelyDisabled =
    options.workflowsAdministrativelyDisabled === true ||
    settings.disableWorkflows === true;
  const workflowsUnavailableReason = unavailableWorkflowsReason(
    workflowsAdministrativelyDisabled,
    options.workflowBridgeReady === true,
  );
  const workflowsAvailable = workflowsUnavailableReason === undefined;
  const workflowsEnabled =
    workflowsAvailable &&
    (previous?.workflows.enabled ?? settings.enableWorkflows === true);
  let ultraUnavailableReason: string | undefined;
  if (!workflowsAvailable) {
    ultraUnavailableReason = workflowsUnavailableReason;
  } else if (
    provider.provider === "anthropic" &&
    !thinkingSupported
  ) {
    ultraUnavailableReason = `${provider.model} does not advertise adaptive thinking, which Anthropic Ultra requires.`;
  } else if (!supportedEffortLevels.includes("xhigh")) {
    ultraUnavailableReason = `${provider.model} does not advertise xhigh reasoning, which Ultra requires.`;
  }
  const ultraAvailable = ultraUnavailableReason === undefined;
  const ultraEnabled =
    ultraAvailable &&
    (previous?.ultra.enabled ?? settings.ultracode === true);

  return {
    thinkingSupported,
    thinkingEnabled,
    thinkingAuthority,
    ...(thinkingSupported
      ? {}
      : {
          thinkingUnavailableReason: `Claude Code does not report adaptive thinking support for ${provider.model}.`,
        }),
    supportedEffortLevels,
    ...(effectiveEffort ? { effectiveEffort } : {}),
    effortAuthority,
    workflows: {
      available: workflowsAvailable,
      enabled: workflowsEnabled,
      experimental: true,
      ...(workflowsUnavailableReason
        ? { unavailableReason: workflowsUnavailableReason }
        : {}),
    },
    ultra: {
      available: ultraAvailable,
      enabled: ultraEnabled,
      experimental: true,
      ...(ultraUnavailableReason
        ? { unavailableReason: ultraUnavailableReason }
        : {}),
    },
  };
}

export function assertSupportedRemoteEffort(
  reasoning: RemoteReasoningContext,
  effort: OpenAIReasoningEffort,
  model: string,
): void {
  // `none` means "do not send a reasoning effort". It is a ModelHop control
  // state, not a capability value advertised by Claude/provider catalogs.
  if (effort === "none") {
    return;
  }
  if (reasoning.supportedEffortLevels.includes(effort)) {
    return;
  }
  if (
    reasoning.effortAuthority === undefined ||
    reasoning.effortAuthority === "unavailable"
  ) {
    throw new Error(
      `${model} did not advertise authoritative reasoning-effort capabilities. ModelHop will not guess whether ${effort} is supported.`,
    );
  }
  throw new Error(
    `${model} does not support ${effort} reasoning. Available efforts: ${reasoning.supportedEffortLevels.join(", ")}. ModelHop will not silently substitute another effort.`,
  );
}
