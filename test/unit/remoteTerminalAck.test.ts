import { describe, expect, it, vi } from "vitest";

import { acknowledgeTerminalWithRetry } from "../../src/remote/web/terminalAck.js";

describe("terminal acknowledgement retry", () => {
  it("reuses the command ID after an ambiguous network failure", async () => {
    const sent: string[] = [];
    const send = vi.fn(async (command: { id: string }) => {
      sent.push(command.id);
      if (sent.length === 1) {
        throw new Error("response lost");
      }
    });

    await expect(
      acknowledgeTerminalWithRetry({
        terminalEventId: 42,
        createCommandId: () => "terminal-command",
        send,
        wait: async () => undefined,
        retryDelays: [0, 1],
      }),
    ).resolves.toBe(true);
    expect(sent).toEqual(["terminal-command", "terminal-command"]);
  });

  it("uses a new receipt after an authoritative early rejection", async () => {
    const ids = ["terminal-early", "terminal-ready"];
    const sent: string[] = [];
    const send = vi.fn(async (command: { id: string }) => {
      sent.push(command.id);
      if (sent.length === 1) {
        throw Object.assign(new Error("terminal cursor unavailable"), {
          authoritative: true,
        });
      }
    });

    await expect(
      acknowledgeTerminalWithRetry({
        terminalEventId: 84,
        createCommandId: () => ids.shift() ?? "unexpected",
        send,
        wait: async () => undefined,
        retryDelays: [0, 1],
      }),
    ).resolves.toBe(true);
    expect(sent).toEqual(["terminal-early", "terminal-ready"]);
  });

  it("fails closed after the bounded retry window", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      acknowledgeTerminalWithRetry({
        terminalEventId: 126,
        createCommandId: () => "terminal-offline",
        send,
        wait: async () => undefined,
        retryDelays: [0, 1, 2],
      }),
    ).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
