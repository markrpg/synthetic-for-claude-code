import { describe, expect, it } from "vitest";
import {
  BridgeRequestError,
  codexTurnError,
  isContextWindowError,
} from "../../src/bridge/bridgeError.js";

describe("bridge errors", () => {
  it("turns Codex context exhaustion into a terminal Anthropic request error", () => {
    const error = codexTurnError({
      message: "Codex ran out of room in the model's context window.",
      codexErrorInfo: "contextWindowExceeded",
    });

    expect(error).toBeInstanceOf(BridgeRequestError);
    expect(error.status).toBe(400);
    expect(error.anthropicType).toBe("invalid_request_error");
    expect(error.code).toBe("context_window_exceeded");
    expect(isContextWindowError(error)).toBe(true);
  });

  it("keeps temporary overloads retryable at the HTTP layer", () => {
    const error = codexTurnError({
      message: "Busy",
      codexErrorInfo: "serverOverloaded",
    });
    expect(error.status).toBe(529);
    expect(error.anthropicType).toBe("overloaded_error");
  });
});
