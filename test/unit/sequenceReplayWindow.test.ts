import { describe, expect, it } from "vitest";
import { SequenceReplayWindow } from "../../src/remote/sequenceReplayWindow.js";

describe("remote sequence replay window", () => {
  it("accepts authenticated commands that arrive out of order", () => {
    const window = new SequenceReplayWindow(8);

    expect(window.accept(2)).toBe(true);
    expect(window.accept(1)).toBe(true);
    expect(window.accept(4)).toBe(true);
    expect(window.accept(3)).toBe(true);
  });

  it("rejects duplicates and messages older than the bounded window", () => {
    const window = new SequenceReplayWindow(4);

    expect(window.accept(1)).toBe(true);
    expect(window.accept(1)).toBe(false);
    expect(window.accept(6)).toBe(true);
    expect(window.accept(2)).toBe(false);
    expect(window.accept(5)).toBe(true);
  });
});
