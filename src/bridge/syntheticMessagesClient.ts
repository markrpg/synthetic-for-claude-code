import type { SyntheticSettings } from "../providers/types.js";
import type { AnthropicRequest } from "./anthropicOpenAITranslator.js";
import { BridgeRequestError } from "./bridgeError.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

async function syntheticError(response: Response): Promise<BridgeRequestError> {
  let detail = "";
  let code: string | undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error = isRecord(body.error) ? body.error : body;
    detail =
      typeof error.message === "string"
        ? error.message
        : typeof body.message === "string"
          ? body.message
          : "";
    code =
      typeof error.code === "string"
        ? error.code
        : typeof error.type === "string"
          ? error.type
          : undefined;
  } catch {
    detail = "";
  }
  const message = detail
    ? `Synthetic API ${response.status}: ${detail}`
    : `Synthetic API request failed with status ${response.status}.`;
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
  if (response.status === 413) {
    return new BridgeRequestError(
      message,
      413,
      "request_too_large",
      code,
    );
  }
  if (
    response.status === 400 &&
    /context|token.*limit|too long/i.test(detail)
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

export class SyntheticMessagesClient {
  private readonly contextWindows = new Map<string, number>();
  private contextLoad: Promise<void> | undefined;

  public constructor(
    private readonly token: string,
    private readonly settings: SyntheticSettings,
  ) {}

  public async complete(
    request: AnthropicRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchMessages(
      { ...request, stream: false },
      signal,
    );
    return (await response.json()) as Record<string, unknown>;
  }

  public fetchStream(
    request: AnthropicRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetchMessages({ ...request, stream: true }, signal);
  }

  public async countTokens(
    request: AnthropicRequest,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    try {
      const response = await fetch(
        endpoint(this.settings.baseUrl, "/v1/messages/count_tokens"),
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            system: request.system,
            tools: request.tools,
            tool_choice: request.tool_choice,
          }),
          signal,
        },
      );
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as Record<string, unknown>;
      return typeof body.input_tokens === "number"
        ? body.input_tokens
        : undefined;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return undefined;
    }
  }

  public async contextWindow(model: unknown): Promise<number | undefined> {
    const modelId = typeof model === "string" ? model : "";
    if (!modelId) {
      return undefined;
    }
    this.contextLoad ??= this.loadContextWindows();
    await this.contextLoad;
    return this.contextWindows.get(modelId);
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
      ? response.content.filter(isRecord)
      : [];
    return content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n")
      .trim();
  }

  private async fetchMessages(
    request: AnthropicRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(
      endpoint(this.settings.baseUrl, "/v1/messages"),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(request),
        signal,
      },
    );
    if (!response.ok) {
      throw await syntheticError(response);
    }
    return response;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "x-api-key": this.token,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }

  private async loadContextWindows(): Promise<void> {
    try {
      const origin = new URL(this.settings.baseUrl).origin;
      const response = await fetch(`${origin}/openai/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as Record<string, unknown>;
      const data = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
      for (const model of data) {
        const id = typeof model.id === "string" ? model.id : undefined;
        const contextLength =
          typeof model.context_length === "number"
            ? model.context_length
            : typeof model.context_window === "number"
              ? model.context_window
              : undefined;
        if (id && contextLength && contextLength > 0) {
          this.contextWindows.set(id, contextLength);
        }
      }
    } catch {
      // The configured conservative fallback is used when discovery fails.
    }
  }
}
