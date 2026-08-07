import type {
  RemoteDaemonConfiguration,
  RemoteModelOption,
  RemoteProviderContext,
} from "./types.js";
import type { ProviderId } from "../providers/types.js";

const CLAUDE_MODEL_ALIASES = new Set([
  "default",
  "fable",
  "opus",
  "sonnet",
  "haiku",
]);

const ANTHROPIC_DEFAULT_PRESENTATION_KEYS = new Set([
  "defaultclaudemodel",
  "claudedefaultmodel",
]);

function modelLookupKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function compactModelLookupKey(value: string): string {
  return modelLookupKey(value).replace(/[\s_-]+/gu, "");
}

export function isAnthropicDefaultPresentation(
  value: string | undefined,
): boolean {
  return Boolean(
    value &&
      ANTHROPIC_DEFAULT_PRESENTATION_KEYS.has(
        compactModelLookupKey(value),
      ),
  );
}

export function normaliseAnthropicModelSelector(
  value: string | undefined,
): string {
  const selector = value?.trim();
  return !selector || isAnthropicDefaultPresentation(selector)
    ? "default"
    : selector;
}

export type RemoteModelMatchKind =
  | "selector"
  | "resolved-model"
  | "display-name";

export interface RemoteModelMatch {
  option: RemoteModelOption;
  matchedBy: RemoteModelMatchKind;
}

/**
 * Match a selector, canonical model ID, or display label only when it resolves
 * to one provider selector. Duplicate metadata rows for the same selector are
 * harmless; a label shared by different selectors is intentionally ambiguous.
 */
export function findUniqueRemoteModelOption(
  options: readonly RemoteModelOption[],
  value: string | undefined,
): RemoteModelMatch | undefined {
  const target = value ? modelLookupKey(value) : "";
  if (!target) {
    return undefined;
  }
  const matches = new Map<
    string,
    { option: RemoteModelOption; kinds: Set<RemoteModelMatchKind> }
  >();
  for (const option of options) {
    const kinds = new Set<RemoteModelMatchKind>();
    if (modelLookupKey(option.selector) === target) {
      kinds.add("selector");
    }
    if (
      option.resolvedModel &&
      modelLookupKey(option.resolvedModel) === target
    ) {
      kinds.add("resolved-model");
    }
    if (modelLookupKey(option.displayName) === target) {
      kinds.add("display-name");
    }
    if (kinds.size === 0) {
      continue;
    }
    const selectorKey = modelLookupKey(option.selector);
    const existing = matches.get(selectorKey);
    if (existing) {
      for (const kind of kinds) {
        existing.kinds.add(kind);
      }
    } else {
      matches.set(selectorKey, { option, kinds });
    }
  }
  if (matches.size !== 1) {
    return undefined;
  }
  const match = [...matches.values()][0];
  if (!match) {
    return undefined;
  }
  const matchedBy = ([
    "selector",
    "resolved-model",
    "display-name",
  ] as const).find((kind) => match.kinds.has(kind));
  return matchedBy ? { option: match.option, matchedBy } : undefined;
}

export interface RemoteRuntimeModelResolution {
  selector: string;
  option?: RemoteModelOption;
  matchedBy?: RemoteModelMatchKind | "anthropic-default";
}

/**
 * Convert a runtime observation into a provider-safe selector. Runtime APIs
 * sometimes return display copy (for example `Default Claude model`) instead
 * of a model ID. Unknown or ambiguous observations can never replace the
 * configured selector.
 */
export function resolveRemoteRuntimeModelObservation(
  provider: ProviderId,
  configuredSelector: string,
  observedModel: string | undefined,
  options: readonly RemoteModelOption[] = [],
): RemoteRuntimeModelResolution {
  const rawConfigured = configuredSelector.trim();
  const providerConfigured =
    provider === "anthropic"
      ? normaliseAnthropicModelSelector(rawConfigured)
      : rawConfigured || "default";
  const configuredMatch = findUniqueRemoteModelOption(
    options,
    providerConfigured,
  );
  const selector = configuredMatch?.option.selector ?? providerConfigured;
  const observed = observedModel?.trim();
  if (!observed) {
    return configuredMatch
      ? {
          selector,
          option: configuredMatch.option,
          matchedBy: configuredMatch.matchedBy,
        }
      : { selector };
  }
  const observedMatch = findUniqueRemoteModelOption(options, observed);
  if (observedMatch) {
    return {
      selector: observedMatch.option.selector,
      option: observedMatch.option,
      matchedBy: observedMatch.matchedBy,
    };
  }
  if (
    provider === "anthropic" &&
    isAnthropicDefaultPresentation(observed)
  ) {
    const defaultMatch = findUniqueRemoteModelOption(options, "default");
    return {
      selector: defaultMatch?.option.selector ?? "default",
      ...(defaultMatch ? { option: defaultMatch.option } : {}),
      matchedBy: "anthropic-default",
    };
  }
  return configuredMatch
    ? {
        selector,
        option: configuredMatch.option,
        matchedBy: configuredMatch.matchedBy,
      }
    : { selector };
}

/**
 * A resumed Claude session can remember the model selected under a previous
 * provider. Never carry a Synthetic or OpenAI model into the Anthropic route.
 */
export function anthropicRemoteModel(
  transcriptModel: string | undefined,
): string {
  const model = normaliseAnthropicModelSelector(transcriptModel);
  const normalised = model.toLowerCase();
  if (
    CLAUDE_MODEL_ALIASES.has(normalised) ||
    normalised.startsWith("claude-")
  ) {
    return model;
  }
  return "default";
}

export function sdkModelForProvider(
  provider: RemoteProviderContext,
): string {
  const model =
    provider.provider === "anthropic"
      ? normaliseAnthropicModelSelector(provider.model)
      : provider.model.trim();
  return model || "default";
}

type RemoteModelFamily = "anthropic" | "synthetic" | "openai";

function knownModelFamily(model: string): RemoteModelFamily | undefined {
  const normalised = model.trim().toLowerCase();
  if (normalised.startsWith("hf:") || normalised.startsWith("syn:")) {
    return "synthetic";
  }
  if (
    normalised.includes("kimi") ||
    normalised.includes("qwen") ||
    normalised.includes("moonshot")
  ) {
    return "synthetic";
  }
  if (
    normalised.startsWith("gpt-") ||
    normalised.startsWith("codex-") ||
    /^o[1-9](?:-|$)/u.test(normalised)
  ) {
    return "openai";
  }
  if (normalised.startsWith("claude-")) {
    return "anthropic";
  }
  return undefined;
}

export class RemoteProviderModelMismatchError extends Error {}

/**
 * Unknown/future model names are allowed. Known cross-provider names are not:
 * seeing Kimi after an Anthropic switch is proof that the resumed route did
 * not actually change and the transaction must roll back rather than lie.
 */
export function assertRemoteRuntimeModel(
  provider: ProviderId,
  model: string,
): void {
  const family = knownModelFamily(model);
  const expected =
    provider === "anthropic"
      ? "anthropic"
      : provider === "synthetic"
        ? "synthetic"
        : "openai";
  if (family && family !== expected) {
    throw new RemoteProviderModelMismatchError(
      `Claude Code initialized ${model} while ModelHop expected the ${provider} route. The provider switch was not committed.`,
    );
  }
}

function sameEnvironment(
  left: Record<string, string | undefined>,
  right: Record<string, string | undefined>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

export function sameProviderRuntime(
  left: RemoteProviderContext,
  right: RemoteProviderContext,
): boolean {
  return (
    left.provider === right.provider &&
    sdkModelForProvider(left) === sdkModelForProvider(right) &&
    left.reasoningEffort === right.reasoningEffort &&
    left.roleModels.default === right.roleModels.default &&
    left.roleModels.opus === right.roleModels.opus &&
    left.roleModels.sonnet === right.roleModels.sonnet &&
    left.roleModels.haiku === right.roleModels.haiku &&
    left.roleModels.subagent === right.roleModels.subagent
  );
}

/**
 * Returns true only when the already-running SDK query can safely remain
 * alive. Usage and timestamps are presentation data and do not restart it.
 */
export function sameRemoteQueryConfiguration(
  left: RemoteDaemonConfiguration,
  right: RemoteDaemonConfiguration,
): boolean {
  return (
    sameProviderRuntime(left.lease.provider, right.lease.provider) &&
    sameEnvironment(left.environment, right.environment) &&
    left.claudeExecutable === right.claudeExecutable &&
    left.permissionMode === right.permissionMode
  );
}

/**
 * `/control/provider` is a usage-refresh channel. Preserve the route that the
 * detached daemon actually owns so a racing editor reload cannot relabel an
 * old query as a newly selected provider.
 */
export function mergeProviderUsage(
  active: RemoteProviderContext,
  refreshed: RemoteProviderContext,
): RemoteProviderContext {
  if (active.provider !== refreshed.provider) {
    throw new Error(
      `Ignored ${refreshed.provider} usage for the active ${active.provider} remote query.`,
    );
  }
  return {
    ...active,
    usage: refreshed.usage,
    updatedAt: Math.max(active.updatedAt, refreshed.updatedAt),
  };
}
