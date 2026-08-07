import { describe, expect, it } from "vitest";
import type {
  RemoteProviderContext,
  RemoteUsageSnapshot,
} from "../../src/remote/types.js";
import {
  formatRemoteElapsed,
  isInternalClaudeConversationText,
  reconcileActivityRecords,
  shouldMarkActivityUnread,
  shouldPresentUsageSnapshot,
  type ActivityRecord,
} from "../../src/remote/web/mobileApp.js";

function usage(
  provider: RemoteProviderContext["provider"],
  updatedAt: number,
  model = "reported-model",
): RemoteUsageSnapshot {
  return {
    kind: "usage.snapshot",
    provider,
    status: "available",
    model,
    updatedAt,
  };
}

describe("remote mobile event policy", () => {
  it("keeps legacy Claude control envelopes out of human conversation", () => {
    expect(
      isInternalClaudeConversationText(
        "<local-command-caveat>Internal command context</local-command-caveat>",
      ),
    ).toBe(true);
    expect(
      isInternalClaudeConversationText(
        "<task-notification><status>stopped</status></task-notification>",
        "task-notification",
      ),
    ).toBe(true);
    expect(
      isInternalClaudeConversationText(
        "<command-name>/config</command-name>\n<command-args></command-args>",
      ),
    ).toBe(true);
    expect(
      isInternalClaudeConversationText(
        "<command-name> is the XML tag I am debugging",
        "human",
      ),
    ).toBe(false);
    expect(
      isInternalClaudeConversationText("Please continue the implementation"),
    ).toBe(false);
  });

  it("updates an activity in place without changing its original time", () => {
    const original: ActivityRecord[] = [
      {
        key: "tool-read",
        title: "Reading src/a.ts",
        tone: "info",
        busy: true,
        createdAt: 10,
      },
      {
        key: "tool-edit",
        title: "Editing src/b.ts",
        tone: "info",
        busy: true,
        createdAt: 20,
      },
    ];
    const reconciled = reconcileActivityRecords(
      original,
      {
        key: "tool-read",
        title: "Read src/a.ts",
        tone: "success",
        busy: false,
      },
      30,
    );
    expect(reconciled.inserted).toBe(false);
    expect(reconciled.records.map((entry) => entry.key)).toEqual([
      "tool-read",
      "tool-edit",
    ]);
    expect(reconciled.records[0]).toMatchObject({
      title: "Read src/a.ts",
      tone: "success",
      busy: false,
      createdAt: 10,
    });
  });

  it("does not badge reconstructed journal activity", () => {
    expect(shouldMarkActivityUnread(true, false)).toBe(false);
    expect(shouldMarkActivityUnread(true, true)).toBe(false);
    expect(shouldMarkActivityUnread(false, false)).toBe(false);
    expect(shouldMarkActivityUnread(false, true)).toBe(true);
  });

  it("shows an idle dash and handles a Mac clock ahead of the phone", () => {
    expect(formatRemoteElapsed(undefined, undefined, 1_000)).toEqual({
      label: "—",
      dateTime: "",
    });
    expect(
      formatRemoteElapsed(20_000, undefined, 10_000),
    ).toEqual({ label: "Active", dateTime: "" });
    expect(
      formatRemoteElapsed(20_000, undefined, 10_000, 52_000),
    ).toEqual({ label: "00:42", dateTime: "PT42S" });
    expect(
      formatRemoteElapsed(20_000, undefined, 10_000, 3_682_000),
    ).toEqual({ label: "1:01:12", dateTime: "PT3672S" });
  });

  it("rejects stale and wrong-provider usage for the visible route", () => {
    const previous = usage("anthropic", 20, "claude-opus-5");
    expect(
      shouldPresentUsageSnapshot(
        "anthropic",
        previous,
        usage("anthropic", 19, "stale-model"),
      ),
    ).toBe(false);
    expect(
      shouldPresentUsageSnapshot(
        "anthropic",
        undefined,
        usage("synthetic", 30, "Kimi K3"),
      ),
    ).toBe(false);
    expect(
      shouldPresentUsageSnapshot(
        "anthropic",
        previous,
        usage("anthropic", 21, "claude-opus-5"),
      ),
    ).toBe(true);
  });
});
