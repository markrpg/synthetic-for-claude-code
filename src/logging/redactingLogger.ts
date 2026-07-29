import type * as vscode from "vscode";

export function redactSecret(
  message: string,
  secrets: readonly string[],
): string {
  return secrets.reduce(
    (result, secret) =>
      secret ? result.split(secret).join("[REDACTED]") : result,
    message,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      "cause" in error && error.cause !== undefined
        ? ` Caused by: ${errorMessage(error.cause)}`
        : "";
    return `${error.message}${cause}`;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unexpected error occurred.";
}

export class RedactingLogger {
  private readonly secrets = new Set<string>();

  public constructor(private readonly output: vscode.OutputChannel) {}

  public registerSecret(secret: string): void {
    if (secret) {
      this.secrets.add(secret);
    }
  }

  public safeErrorMessage(error: unknown): string {
    return redactSecret(errorMessage(error), [...this.secrets]);
  }

  public info(message: string): void {
    this.output.appendLine(redactSecret(message, [...this.secrets]));
  }

  public error(error: unknown): string {
    const message = this.safeErrorMessage(error);
    this.output.appendLine(`Error: ${message}`);
    return message;
  }

  public show(): void {
    this.output.show(true);
  }
}
