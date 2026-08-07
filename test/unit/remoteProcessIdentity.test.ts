import { describe, expect, it } from "vitest";
import { cloudflaredCommandMatches } from "../../src/remote/processIdentity.js";
import type { RemoteTunnelState } from "../../src/remote/types.js";

const tunnel: RemoteTunnelState = {
  transport: "cloudflare-quick",
  pid: 42,
  baseUrl: "https://modelhop-test.trycloudflare.com",
  executable: "/private/modelhop/cloudflared",
  originPort: 18_796,
  configPath: "/private/modelhop/cloudflared-quick-owner.yml",
  logPath: "/private/modelhop/cloudflared.log",
  startedAt: Date.now(),
};

describe("Cloudflare process identity", () => {
  it("requires the executable, unique ownership config, and origin", () => {
    expect(
      cloudflaredCommandMatches(
        tunnel,
        "/private/modelhop/cloudflared tunnel --config /private/modelhop/cloudflared-quick-owner.yml --url http://127.0.0.1:18796",
      ),
    ).toBe(true);
    expect(
      cloudflaredCommandMatches(
        tunnel,
        "/private/modelhop/cloudflared tunnel --config /tmp/other.yml --url http://127.0.0.1:18796",
      ),
    ).toBe(false);
    expect(
      cloudflaredCommandMatches(
        tunnel,
        "/private/modelhop/cloudflared tunnel --config /private/modelhop/cloudflared-quick-owner.yml --url http://127.0.0.1:19999",
      ),
    ).toBe(false);
  });
});
