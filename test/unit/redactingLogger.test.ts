import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  redactSecret,
  RedactingLogger,
} from "../../src/logging/redactingLogger.js";

function createLogger(lines: string[]): RedactingLogger {
  const output = {
    appendLine(value: string) {
      lines.push(value);
    },
    show() {
      // No-op test output channel.
    },
  } as unknown as vscode.OutputChannel;
  return new RedactingLogger(output);
}

describe("redaction", () => {
  it("removes complete tokens", () => {
    expect(redactSecret("token=secret-value", ["secret-value"])).toBe(
      "token=[REDACTED]",
    );
  });

  it("keeps surrounding diagnostics usable", () => {
    expect(
      redactSecret("request secret-value failed at validation", [
        "secret-value",
      ]),
    ).toBe("request [REDACTED] failed at validation");
  });

  it("ignores missing or empty secrets", () => {
    expect(redactSecret("safe message", ["", "not-present"])).toBe(
      "safe message",
    );
  });

  it("redacts nested error messages", () => {
    const lines: string[] = [];
    const logger = createLogger(lines);
    logger.registerSecret("secret-value");
    const inner = new Error("inner secret-value");
    const outer = new Error("outer failure", { cause: inner });
    expect(logger.error(outer)).toBe(
      "outer failure Caused by: inner [REDACTED]",
    );
    expect(lines.join("\n")).not.toContain("secret-value");
  });
});
