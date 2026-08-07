export interface TerminalAcknowledgementOptions {
  terminalEventId: number;
  createCommandId(): string;
  send(command: {
    id: string;
    type: "session.terminal.ack";
    terminalEventId: number;
  }): Promise<unknown>;
  wait(milliseconds: number): Promise<void>;
  retryDelays?: readonly number[];
}

function isAuthoritativeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { authoritative?: unknown }).authoritative === true
  );
}

/**
 * Network ambiguity reuses the same durable command ID. An authoritative
 * early rejection needs a new receipt because that result is already durable.
 */
export async function acknowledgeTerminalWithRetry(
  options: TerminalAcknowledgementOptions,
): Promise<boolean> {
  let commandId = options.createCommandId();
  const retryDelays = options.retryDelays ?? [0, 125, 300, 700, 1_400];
  for (const delay of retryDelays) {
    if (delay > 0) {
      await options.wait(delay);
    }
    try {
      await options.send({
        id: commandId,
        type: "session.terminal.ack",
        terminalEventId: options.terminalEventId,
      });
      return true;
    } catch (error) {
      if (isAuthoritativeError(error)) {
        commandId = options.createCommandId();
      }
    }
  }
  return false;
}
