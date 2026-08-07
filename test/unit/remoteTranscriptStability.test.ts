import { describe, expect, it, vi } from "vitest";
import { waitForStableTranscript } from "../../src/remote/transcriptIntegrity.js";

describe("remote transcript stabilization", () => {
  it("requires three identical observations spanning at least two seconds", async () => {
    let now = 0;
    const observe = vi.fn().mockResolvedValue({
      size: 128,
      signature: "stable-tail",
    });

    await expect(
      waitForStableTranscript("/workspace/transcript.jsonl", {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        observe,
      }),
    ).resolves.toEqual({
      size: 128,
      signature: "stable-tail",
      observedAt: 2_000,
    });
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it("restarts the stability window after a late transcript write", async () => {
    let now = 0;
    const observations = [
      { size: 128, signature: "tail-a" },
      { size: 128, signature: "tail-a" },
      { size: 160, signature: "tail-b" },
      { size: 160, signature: "tail-b" },
      { size: 160, signature: "tail-b" },
    ];
    let index = 0;

    const result = await waitForStableTranscript(
      "/workspace/transcript.jsonl",
      {
        now: () => now,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        observe: async () =>
          observations[Math.min(index++, observations.length - 1)]!,
      },
    );

    expect(result).toEqual({
      size: 160,
      signature: "tail-b",
      observedAt: 4_000,
    });
  });

  it("aborts only the current observation window without accepting instability", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = waitForStableTranscript(
      "/workspace/transcript.jsonl",
      {
        signal: controller.signal,
        observe: async () => ({
          size: 128,
          signature: "still-changing",
        }),
        wait: async () => {
          started();
          await new Promise<never>(() => undefined);
        },
      },
    );

    await pollStarted;
    controller.abort(new Error("restart requested"));

    await expect(waiting).rejects.toThrow("restart requested");
  });
});
