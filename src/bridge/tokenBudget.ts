import type { AnthropicRequest } from "./anthropicOpenAITranslator.js";
import type { ContextManagementSettings } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function estimateStringTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 3.5 + nonAscii / 1.25);
}

export function estimateTokens(value: unknown): number {
  if (value === null || value === undefined) {
    return 1;
  }
  if (typeof value === "string") {
    return Math.max(1, estimateStringTokens(value));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return 1;
  }
  if (Array.isArray(value)) {
    const items = value as unknown[];
    return (
      2 +
      items.reduce<number>(
        (total, item) => total + estimateTokens(item) + 1,
        0,
      )
    );
  }
  if (!isRecord(value)) {
    return 1;
  }
  if (
    value.type === "image" &&
    isRecord(value.source) &&
    (typeof value.source.data === "string" ||
      typeof value.source.url === "string")
  ) {
    // Image tokenization depends on resolution and provider. This deliberately
    // reserves a conservative fixed amount without treating base64 bytes as text.
    return 2_048;
  }
  return Object.entries(value).reduce(
    (total, [key, item]) =>
      total + estimateStringTokens(key) + estimateTokens(item) + 2,
    2,
  );
}

export function estimateAnthropicRequestTokens(
  request: AnthropicRequest,
): number {
  return estimateTokens({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.tool_choice,
  });
}

export function contextThreshold(
  contextWindow: number,
  request: AnthropicRequest,
  settings: ContextManagementSettings,
): number {
  const requestedOutput =
    typeof request.max_tokens === "number" &&
    Number.isFinite(request.max_tokens)
      ? Math.max(0, request.max_tokens)
      : 16_384;
  const percentageBudget = Math.floor(
    contextWindow * (settings.thresholdPercent / 100),
  );
  const outputReservedBudget =
    contextWindow - Math.min(requestedOutput, contextWindow / 3) - 8_192;
  return Math.max(
    8_192,
    Math.min(percentageBudget, outputReservedBudget),
  );
}
