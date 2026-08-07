/**
 * Accepts authenticated messages that arrive slightly out of order while
 * rejecting duplicates and messages outside a bounded replay window.
 *
 * Independent HTTP requests can reach the loopback daemon in a different
 * order from the one in which the phone encrypted them. Ordering therefore
 * cannot be enforced with a single `last seen` counter without rejecting
 * legitimate concurrent commands.
 */
export class SequenceReplayWindow {
  private highest = 0;
  private readonly seen = new Set<number>();

  public constructor(private readonly width = 2_048) {
    if (!Number.isSafeInteger(width) || width < 2) {
      throw new Error("The replay window must contain at least two messages.");
    }
  }

  public accept(sequence: number): boolean {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      this.seen.has(sequence)
    ) {
      return false;
    }
    const currentFloor = Math.max(0, this.highest - this.width);
    if (sequence <= currentFloor) {
      return false;
    }

    this.highest = Math.max(this.highest, sequence);
    this.seen.add(sequence);
    const nextFloor = Math.max(0, this.highest - this.width);
    for (const candidate of this.seen) {
      if (candidate <= nextFloor) {
        this.seen.delete(candidate);
      }
    }
    return true;
  }
}
