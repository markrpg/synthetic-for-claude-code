import { randomUUID } from "node:crypto";
import type { OpenAIProviderSettings } from "../providers/types.js";
import { estimateOpenAICost } from "../openai/openAIPricing.js";
import {
  reasoningItems,
  signatureForOpenAIResponse,
  translateAnthropicRequest,
  translateOpenAIResponse,
  type AnthropicRequest,
  type ReasoningLookup,
  type TranslationPlan,
} from "./anthropicOpenAITranslator.js";
import { BridgeRequestError } from "./bridgeError.js";
import { toAnthropicToolId } from "./toolMapping.js";
import type {
  RateLimitSnapshot,
  TokenUsageSnapshot,
} from "./types.js";

interface ReasoningStore extends ReasoningLookup {
  set(signature: string, items: readonly unknown[]): void;
}

export interface OpenAIUsageObserver {
  record(
    usage: Partial<TokenUsageSnapshot>,
    rateLimits: RateLimitSnapshot,
    estimatedCostUsd?: number,
  ): void;
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rateLimits(headers: Headers): RateLimitSnapshot {
  return {
    remainingRequests: numericHeader(
      headers,
      "x-ratelimit-remaining-requests",
    ),
    limitRequests: numericHeader(headers, "x-ratelimit-limit-requests"),
    resetRequests:
      headers.get("x-ratelimit-reset-requests") ?? undefined,
    remainingTokens: numericHeader(
      headers,
      "x-ratelimit-remaining-tokens",
    ),
    limitTokens: numericHeader(headers, "x-ratelimit-limit-tokens"),
    resetTokens: headers.get("x-ratelimit-reset-tokens") ?? undefined,
  };
}

function usageFromResponse(response: unknown): Partial<TokenUsageSnapshot> {
  if (
    typeof response !== "object" ||
    response === null ||
    typeof (response as Record<string, unknown>).usage !== "object" ||
    (response as Record<string, unknown>).usage === null
  ) {
    return {};
  }
  const usage = (response as Record<string, unknown>).usage as Record<
    string,
    unknown
  >;
  const details =
    typeof usage.input_tokens_details === "object" &&
    usage.input_tokens_details !== null
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  return {
    inputTokens:
      typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cachedInputTokens:
      typeof details.cached_tokens === "number" ? details.cached_tokens : 0,
    requestCount: 1,
  };
}

async function openAIError(
  response: Response,
): Promise<BridgeRequestError> {
  let detail = "";
  let code: string | undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error =
      typeof body.error === "object" && body.error !== null
        ? (body.error as Record<string, unknown>)
        : undefined;
    detail = typeof error?.message === "string" ? error.message : "";
    code =
      typeof error?.code === "string"
        ? error.code
        : typeof error?.type === "string"
          ? error.type
          : undefined;
  } catch {
    detail = "";
  }
  const message =
    detail
      ? `OpenAI API ${response.status}: ${detail}`
      : `OpenAI API request failed with status ${response.status}.`;
  if (response.status === 401) {
    return new BridgeRequestError(
      message,
      401,
      "authentication_error",
      code,
    );
  }
  if (response.status === 403) {
    return new BridgeRequestError(message, 403, "permission_error", code);
  }
  if (response.status === 429) {
    return new BridgeRequestError(message, 429, "rate_limit_error", code);
  }
  if (
    response.status === 400 &&
    (code === "context_length_exceeded" ||
      /context window|maximum context length/i.test(detail))
  ) {
    return new BridgeRequestError(
      message,
      400,
      "invalid_request_error",
      "context_window_exceeded",
    );
  }
  if (response.status >= 500) {
    return new BridgeRequestError(message, 502, "api_error", code);
  }
  return new BridgeRequestError(
    message,
    response.status,
    "invalid_request_error",
    code,
  );
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* parseSSE(response: Response): AsyncGenerator<{
  event: string;
  data: unknown;
}> {
  if (!response.body) {
    throw new Error("OpenAI returned an empty streaming response.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const stream = response.body as unknown as {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    };
  };
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) {
        break;
      }
      const frame = buffer.slice(0, boundary);
      const separatorLength = buffer[boundary] === "\r" ? 4 : 2;
      buffer = buffer.slice(boundary + separatorLength);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      const joined = data.join("\n");
      if (!joined || joined === "[DONE]") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(joined) as unknown;
      } catch {
        continue;
      }
      yield { event, data: parsed };
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export class OpenAIResponsesClient {
  public constructor(
    private readonly apiKey: string,
    private readonly settings: OpenAIProviderSettings,
    private readonly reasoningStore: ReasoningStore,
    private readonly usageObserver: OpenAIUsageObserver,
  ) {}

  public async complete(
    request: AnthropicRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const plan = translateAnthropicRequest(
      { ...request, stream: false },
      this.settings,
      this.reasoningStore,
    );
    const response = await this.fetchResponse(plan, signal);
    const body: unknown = await response.json();
    const translated = translateOpenAIResponse(body, plan);
    this.rememberReasoning(body, translated);
    const usage = usageFromResponse(body);
    this.usageObserver.record(
      usage,
      rateLimits(response.headers),
      estimateOpenAICost(plan.model, usage),
    );
    return translated;
  }

  public async summarize(
    transcript: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.complete(
      {
        model: this.settings.haikuModel,
        max_tokens: 4_096,
        system:
          "Summarize older Claude Code conversation context for another coding model. Preserve concrete requirements, decisions, file paths, code changes, commands and results, errors, unresolved work, and tool outcomes. Do not add facts. Do not include private reasoning. Return only the compact factual summary.",
        messages: [{ role: "user", content: transcript }],
      },
      signal,
    );
    const content = Array.isArray(response.content)
      ? response.content
      : [];
    return content
      .filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((block) =>
        typeof block.text === "string" ? block.text : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  public async *stream(
    request: AnthropicRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const plan = translateAnthropicRequest(
      { ...request, stream: true },
      this.settings,
      this.reasoningStore,
    );
    const response = await this.fetchResponse(plan, signal);
    const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    yield sse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: plan.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    const contentIndexes = new Map<number, number>();
    let nextContentIndex = 0;
    let completedResponse: unknown;
    let stopReason = "end_turn";
    for await (const frame of parseSSE(response)) {
      const data = record(frame.data);
      if (!data) {
        continue;
      }
      const eventType =
        typeof data.type === "string" ? data.type : frame.event;
      const outputIndex =
        typeof data.output_index === "number" ? data.output_index : 0;
      if (eventType === "response.output_text.delta") {
        let contentIndex = contentIndexes.get(outputIndex);
        if (contentIndex === undefined) {
          contentIndex = nextContentIndex++;
          contentIndexes.set(outputIndex, contentIndex);
          yield sse("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: {
            type: "text_delta",
            text: typeof data.delta === "string" ? data.delta : "",
          },
        });
      } else if (eventType === "response.output_item.added") {
        const item = record(data.item);
        if (item?.type === "function_call") {
          const contentIndex = nextContentIndex++;
          contentIndexes.set(outputIndex, contentIndex);
          const openAIName =
            typeof item.name === "string" ? item.name : "tool";
          yield sse("content_block_start", {
            type: "content_block_start",
            index: contentIndex,
            content_block: {
              type: "tool_use",
              id: toAnthropicToolId(
                typeof item.call_id === "string"
                  ? item.call_id
                  : typeof item.id === "string"
                    ? item.id
                    : `call_${outputIndex}`,
              ),
              name:
                plan.toolNames.fromOpenAI.get(openAIName) ?? openAIName,
              input: {},
            },
          });
          stopReason = "tool_use";
        }
      } else if (
        eventType === "response.function_call_arguments.delta"
      ) {
        const contentIndex = contentIndexes.get(outputIndex);
        if (contentIndex !== undefined) {
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: {
              type: "input_json_delta",
              partial_json:
                typeof data.delta === "string" ? data.delta : "",
            },
          });
        }
      } else if (eventType === "response.output_item.done") {
        const contentIndex = contentIndexes.get(outputIndex);
        if (contentIndex !== undefined) {
          yield sse("content_block_stop", {
            type: "content_block_stop",
            index: contentIndex,
          });
          contentIndexes.delete(outputIndex);
        }
      } else if (eventType === "response.completed") {
        completedResponse = data.response;
      } else if (
        eventType === "response.failed" ||
        eventType === "error"
      ) {
        const error = record(data.error);
        throw new Error(
          typeof error?.message === "string"
            ? error.message
            : "OpenAI streaming response failed.",
        );
      }
    }
    for (const contentIndex of contentIndexes.values()) {
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });
    }
    const usage = usageFromResponse(completedResponse);
    this.usageObserver.record(
      usage,
      rateLimits(response.headers),
      estimateOpenAICost(plan.model, usage),
    );
    if (completedResponse) {
      const translated = translateOpenAIResponse(completedResponse, plan);
      this.rememberReasoning(completedResponse, translated);
    }
    yield sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: usage.outputTokens ?? 0,
      },
    });
    yield sse("message_stop", { type: "message_stop" });
  }

  private async fetchResponse(
    plan: TranslationPlan,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(plan.request),
      signal,
    });
    if (!response.ok) {
      throw await openAIError(response);
    }
    return response;
  }

  private rememberReasoning(
    response: unknown,
    translated: Record<string, unknown>,
  ): void {
    const items = reasoningItems(response);
    if (items.length > 0) {
      this.reasoningStore.set(
        signatureForOpenAIResponse(translated),
        items,
      );
    }
  }
}
