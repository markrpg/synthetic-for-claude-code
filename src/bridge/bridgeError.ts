export type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error"
  | "invalid_request_error";

export class BridgeRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly anthropicType: AnthropicErrorType,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

export function isContextWindowError(error: unknown): boolean {
  if (
    error instanceof BridgeRequestError &&
    error.code === "context_window_exceeded"
  ) {
    return true;
  }
  const message =
    error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("contextwindowexceeded") ||
    message.includes("context window") ||
    message.includes("context_length_exceeded") ||
    message.includes("maximum context length")
  );
}

export function codexTurnError(error: unknown): BridgeRequestError {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const message =
    typeof record.message === "string"
      ? record.message
      : "The Codex turn failed.";
  const info = record.codexErrorInfo;
  if (info === "contextWindowExceeded") {
    return new BridgeRequestError(
      message,
      400,
      "invalid_request_error",
      "context_window_exceeded",
    );
  }
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") {
    return new BridgeRequestError(
      message,
      429,
      "rate_limit_error",
      String(info),
    );
  }
  if (info === "unauthorized") {
    return new BridgeRequestError(
      message,
      401,
      "authentication_error",
      "unauthorized",
    );
  }
  if (
    info === "badRequest" ||
    info === "cyberPolicy" ||
    info === "sandboxError"
  ) {
    return new BridgeRequestError(
      message,
      400,
      "invalid_request_error",
      String(info),
    );
  }
  if (info === "serverOverloaded") {
    return new BridgeRequestError(
      message,
      529,
      "overloaded_error",
      "server_overloaded",
    );
  }
  return new BridgeRequestError(
    message,
    500,
    "api_error",
    typeof info === "string" ? info : undefined,
  );
}
