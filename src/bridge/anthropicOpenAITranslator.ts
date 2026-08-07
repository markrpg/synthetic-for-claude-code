import { createHash } from "node:crypto";
import type {
  OpenAIProviderSettings,
  OpenAIReasoningEffort,
} from "../providers/types.js";
import {
  buildToolNameMapping,
  fromAnthropicToolId,
  toAnthropicToolId,
  type ToolNameMapping,
} from "./toolMapping.js";

export interface AnthropicRequest {
  model?: unknown;
  max_tokens?: unknown;
  messages?: unknown;
  system?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  temperature?: unknown;
  stop_sequences?: unknown;
  metadata?: unknown;
  output_config?: unknown;
  thinking?: unknown;
}

export interface TranslationPlan {
  request: Record<string, unknown>;
  toolNames: ToolNameMapping;
  model: string;
  effort: OpenAIReasoningEffort;
  responseSignatureSeed: string;
}

export interface ReasoningLookup {
  get(signature: string): readonly unknown[] | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function contentArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function systemToText(system: unknown): string {
  if (typeof system === "string") {
    return system;
  }
  return contentArray(system)
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => stringValue(block.text) ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function toolResultOutput(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return JSON.stringify(content ?? "");
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        return JSON.stringify(item);
      }
      if (item.type === "text") {
        return stringValue(item.text) ?? "";
      }
      if (item.type === "image" && isRecord(item.source)) {
        const mediaType = stringValue(item.source.media_type);
        const data = stringValue(item.source.data);
        return mediaType && data
          ? `[image data:${mediaType};base64,${data}]`
          : "[image]";
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

function inputContent(blocks: readonly unknown[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const rawBlock of blocks) {
    if (!isRecord(rawBlock)) {
      continue;
    }
    if (rawBlock.type === "text") {
      result.push({
        type: "input_text",
        text: stringValue(rawBlock.text) ?? "",
      });
    } else if (rawBlock.type === "image" && isRecord(rawBlock.source)) {
      const mediaType = stringValue(rawBlock.source.media_type);
      const data = stringValue(rawBlock.source.data);
      const url = stringValue(rawBlock.source.url);
      if (mediaType && data) {
        result.push({
          type: "input_image",
          image_url: `data:${mediaType};base64,${data}`,
          detail: "auto",
        });
      } else if (url) {
        result.push({
          type: "input_image",
          image_url: url,
          detail: "auto",
        });
      }
    }
  }
  return result;
}

export function assistantSignature(content: unknown): string {
  const visible = contentArray(content)
    .filter(isRecord)
    .filter(
      (block) =>
        block.type === "text" ||
        block.type === "tool_use" ||
        block.type === "server_tool_use",
    )
    .map((block) => JSON.stringify(block))
    .join("\n");
  return createHash("sha256").update(visible).digest("hex");
}

export function translateAnthropicMessages(
  messages: unknown,
  toolNames: ToolNameMapping,
  reasoning?: ReasoningLookup,
): unknown[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const input: unknown[] = [];
  for (const rawMessage of messages) {
    if (!isRecord(rawMessage)) {
      continue;
    }
    const role = rawMessage.role === "assistant" ? "assistant" : "user";
    const blocks = contentArray(rawMessage.content);
    if (role === "assistant") {
      const stored = reasoning?.get(assistantSignature(rawMessage.content));
      if (stored) {
        input.push(...stored);
      }
      const text = blocks
        .filter(isRecord)
        .filter((block) => block.type === "text")
        .map((block) => stringValue(block.text) ?? "")
        .filter(Boolean);
      if (text.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: text.map((value) => ({
            type: "output_text",
            text: value,
          })),
        });
      }
      for (const block of blocks.filter(isRecord)) {
        if (
          block.type !== "tool_use" &&
          block.type !== "server_tool_use"
        ) {
          continue;
        }
        const name = stringValue(block.name) ?? "tool";
        input.push({
          type: "function_call",
          call_id: fromAnthropicToolId(
            stringValue(block.id) ?? `call_${Date.now()}`,
          ),
          name: toolNames.toOpenAI.get(name) ?? name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
      continue;
    }

    const ordinary = inputContent(blocks);
    if (ordinary.length > 0) {
      input.push({ type: "message", role: "user", content: ordinary });
    }
    for (const block of blocks.filter(isRecord)) {
      if (block.type !== "tool_result") {
        continue;
      }
      input.push({
        type: "function_call_output",
        call_id: fromAnthropicToolId(stringValue(block.tool_use_id) ?? ""),
        output: toolResultOutput(block),
      });
    }
  }
  return input;
}

function translateTools(
  tools: unknown,
  names: ToolNameMapping,
): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.filter(isRecord).map((tool) => {
    const originalName = stringValue(tool.name) ?? "tool";
    return {
      type: "function",
      name: names.toOpenAI.get(originalName) ?? originalName,
      description: stringValue(tool.description) ?? "",
      parameters: isRecord(tool.input_schema)
        ? tool.input_schema
        : { type: "object", additionalProperties: true },
      strict: false,
    };
  });
}

function translateToolChoice(
  choice: unknown,
  names: ToolNameMapping,
): unknown {
  if (!isRecord(choice)) {
    return "auto";
  }
  if (choice.type === "any") {
    return "required";
  }
  if (choice.type === "none") {
    return "none";
  }
  if (choice.type === "tool") {
    const original = stringValue(choice.name) ?? "";
    return {
      type: "function",
      name: names.toOpenAI.get(original) ?? original,
    };
  }
  return "auto";
}

function requestedModel(
  model: unknown,
  settings: OpenAIProviderSettings,
): string {
  const value = stringValue(model)?.trim();
  return value || settings.defaultModel;
}

export function reasoningEffortForModel(
  model: string,
  settings: OpenAIProviderSettings,
): OpenAIReasoningEffort {
  const candidates: Array<
    readonly [string, OpenAIReasoningEffort]
  > = [
    [settings.defaultModel, settings.defaultReasoningEffort],
    [settings.opusModel, settings.opusReasoningEffort],
    [settings.sonnetModel, settings.sonnetReasoningEffort],
    [settings.haikuModel, settings.haikuReasoningEffort],
    [settings.subagentModel, settings.subagentReasoningEffort],
  ];
  const rank: Record<OpenAIReasoningEffort, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    xhigh: 4,
    max: 5,
  };
  return candidates
    .filter(([candidate]) => candidate === model)
    .map(([, effort]) => effort)
    .sort((left, right) => rank[right] - rank[left])[0] ?? "medium";
}

const OPENAI_REASONING_EFFORTS = new Set<OpenAIReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Claude Code expresses a per-turn /effort choice through
 * `output_config.effort`. Prefer that explicit choice over ModelHop's stored
 * role default so Claude's native control changes the real upstream GPT/Codex
 * turn instead of only changing its local UI.
 *
 * The separate Anthropic `thinking` field is intentionally not translated:
 * OpenAI reasoning continuity is carried as encrypted provider-native items,
 * and ModelHop must never fabricate Anthropic thinking signatures.
 */
export function reasoningEffortForRequest(
  request: AnthropicRequest,
  model: string,
  settings: OpenAIProviderSettings,
): OpenAIReasoningEffort {
  const outputConfig = isRecord(request.output_config)
    ? request.output_config
    : undefined;
  const requested = stringValue(outputConfig?.effort);
  return requested &&
    OPENAI_REASONING_EFFORTS.has(requested as OpenAIReasoningEffort)
    ? (requested as OpenAIReasoningEffort)
    : reasoningEffortForModel(model, settings);
}

function safetyIdentifier(metadata: unknown): string {
  const source = isRecord(metadata)
    ? JSON.stringify(metadata)
    : "modelhop-local-user";
  return `mh_${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

export function translateAnthropicRequest(
  request: AnthropicRequest,
  settings: OpenAIProviderSettings,
  reasoning?: ReasoningLookup,
): TranslationPlan {
  const toolNames = buildToolNameMapping(
    Array.isArray(request.tools)
      ? request.tools
          .filter(isRecord)
          .map((tool) => stringValue(tool.name) ?? "tool")
      : [],
  );
  const model = requestedModel(request.model, settings);
  const input = translateAnthropicMessages(
    request.messages,
    toolNames,
    reasoning,
  );
  const tools = translateTools(request.tools, toolNames);
  const maxOutput =
    typeof request.max_tokens === "number"
      ? request.max_tokens
      : 16_384;
  const effort = reasoningEffortForRequest(request, model, settings);
  const body: Record<string, unknown> = {
    model,
    input,
    instructions: systemToText(request.system),
    max_output_tokens: maxOutput,
    reasoning: { effort },
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: request.stream === true,
    safety_identifier: safetyIdentifier(request.metadata),
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = translateToolChoice(request.tool_choice, toolNames);
    body.parallel_tool_calls = true;
  }
  return {
    request: body,
    toolNames,
    model,
    effort,
    responseSignatureSeed: JSON.stringify(input),
  };
}

function outputItems(response: unknown): Array<Record<string, unknown>> {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return [];
  }
  return response.output.filter(isRecord);
}

export function reasoningItems(response: unknown): unknown[] {
  return outputItems(response).filter((item) => item.type === "reasoning");
}

export function translateOpenAIResponse(
  response: unknown,
  plan: TranslationPlan,
): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new Error("OpenAI returned an invalid response.");
  }
  const content: Array<Record<string, unknown>> = [];
  for (const item of outputItems(response)) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRecord)) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        } else if (
          part.type === "refusal" &&
          typeof part.refusal === "string"
        ) {
          content.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item.type === "function_call") {
      let input: unknown = {};
      try {
        input = JSON.parse(stringValue(item.arguments) ?? "{}") as unknown;
      } catch {
        input = {};
      }
      const openAIName = stringValue(item.name) ?? "tool";
      content.push({
        type: "tool_use",
        id: toAnthropicToolId(
          stringValue(item.call_id) ?? stringValue(item.id) ?? "call",
        ),
        name: plan.toolNames.fromOpenAI.get(openAIName) ?? openAIName,
        input,
      });
    }
  }
  const usage = isRecord(response.usage) ? response.usage : {};
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const hasToolUse = content.some((item) => item.type === "tool_use");
  return {
    id: stringValue(response.id) ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: stringValue(response.model) ?? plan.model,
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output_tokens:
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      cache_read_input_tokens:
        typeof inputDetails.cached_tokens === "number"
          ? inputDetails.cached_tokens
          : 0,
      cache_creation_input_tokens: 0,
    },
  };
}

export function signatureForOpenAIResponse(
  translated: Record<string, unknown>,
): string {
  return assistantSignature(translated.content);
}
