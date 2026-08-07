import { describe, expect, it } from "vitest";
import { encryptEnvelope } from "../../src/remote/crypto.js";
import { MAX_REMOTE_ATTACHMENT_BYTES } from "../../src/remote/pathPolicy.js";
import {
  allowsTerminalRemoteSession,
  REMOTE_COMMAND_BODY_LIMIT,
  REMOTE_CONNECT_BODY_LIMIT,
  requiresLaunchTokenBeforeBody,
  requiresOpenRemoteSession,
  requiresRemoteControlToken,
} from "../../src/remote/routePolicy.js";

describe("remote HTTP route policy", () => {
  it("protects health status and every control route", () => {
    expect(requiresRemoteControlToken("/health")).toBe(true);
    expect(requiresRemoteControlToken("/control/status")).toBe(true);
    expect(requiresRemoteControlToken("/control/configure")).toBe(true);
  });

  it("leaves only the capability-gated phone API and static app outside control auth", () => {
    expect(requiresRemoteControlToken("/")).toBe(false);
    expect(requiresRemoteControlToken("/api/bootstrap")).toBe(false);
    expect(requiresRemoteControlToken("/api/command")).toBe(false);
    expect(requiresOpenRemoteSession("/api/command")).toBe(true);
    expect(requiresOpenRemoteSession("/")).toBe(true);
    expect(requiresOpenRemoteSession("/health")).toBe(false);
    expect(
      requiresOpenRemoteSession("/control/session/stop"),
    ).toBe(false);
  });

  it("keeps only encrypted terminal delivery routes available during shutdown", () => {
    expect(allowsTerminalRemoteSession("/api/events")).toBe(true);
    expect(allowsTerminalRemoteSession("/api/command")).toBe(true);
    expect(allowsTerminalRemoteSession("/")).toBe(false);
    expect(allowsTerminalRemoteSession("/api/bootstrap")).toBe(false);
    expect(allowsTerminalRemoteSession("/api/connect")).toBe(false);
  });

  it("requires the launch capability before reading a connection body", () => {
    expect(requiresLaunchTokenBeforeBody("/api/connect")).toBe(true);
    expect(requiresLaunchTokenBeforeBody("/api/command")).toBe(false);
    expect(REMOTE_CONNECT_BODY_LIMIT).toBeLessThan(
      REMOTE_COMMAND_BODY_LIMIT,
    );
  });

  it("fits the advertised maximum attachment after both base64 layers", () => {
    const envelope = encryptEnvelope(
      "connection-id",
      1,
      Buffer.alloc(32),
      {
        id: "attachment-id",
        type: "attachment.upload",
        name: "maximum.bin",
        mediaType: "application/octet-stream",
        contentBase64: Buffer.alloc(
          MAX_REMOTE_ATTACHMENT_BYTES,
        ).toString("base64"),
      },
    );
    expect(
      Buffer.byteLength(JSON.stringify(envelope)),
    ).toBeLessThanOrEqual(REMOTE_COMMAND_BODY_LIMIT);
  });
});
