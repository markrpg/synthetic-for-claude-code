import { describe, expect, it } from "vitest";
import {
  hasRegisteredQuickTunnelConnection,
  parseQuickTunnelUrl,
  validQuickTunnelOrigin,
} from "../../src/remote/quickTunnelOutput.js";

describe("Cloudflare Quick Tunnel output", () => {
  it("extracts a strict trycloudflare origin from decorated output", () => {
    expect(
      parseQuickTunnelUrl(
        "\u001B[32mINF | https://quiet-river-42.trycloudflare.com |\u001B[0m",
      ),
    ).toBe("https://quiet-river-42.trycloudflare.com");
  });

  it.each([
    "http://quiet-river.trycloudflare.com",
    "https://quiet-river.trycloudflare.com.evil.example",
    "https://trycloudflare.com",
    "https://user@quiet-river.trycloudflare.com",
    "https://quiet-river.trycloudflare.com/path",
    "https://quiet-river.trycloudflare.com?launch=secret",
    "https://quiet_river.trycloudflare.com",
    "https://public.example.com",
  ])("rejects unsupported or spoofed URL %s", (value) => {
    expect(validQuickTunnelOrigin(value)).toBeUndefined();
    expect(parseQuickTunnelUrl(value)).toBeUndefined();
  });

  it("recognizes cloudflared's registered connection event", () => {
    expect(
      hasRegisteredQuickTunnelConnection(
        "\u001B[32m2026-07-30T22:46:26Z INF Registered tunnel connection connIndex=0 connection=e64ff147-88dd-43e8-a22f-0486c1f9c32b event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic\u001B[0m",
      ),
    ).toBe(true);
  });

  it.each([
    "INF | https://quiet-river.trycloudflare.com |",
    "INF Registered tunnel connection",
    "INF Registered tunnel connections connIndex=0 connection=e64ff147-88dd-43e8-a22f-0486c1f9c32b event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic",
    'ERR message="Registered tunnel connection connIndex=0 connection=e64ff147-88dd-43e8-a22f-0486c1f9c32b event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic"',
    "INF Unregistered tunnel connection connIndex=0 connection=e64ff147-88dd-43e8-a22f-0486c1f9c32b event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic",
    "INF Registered tunnel connection connIndex=0 connection=not-a-uuid event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic",
  ])("rejects a misleading connection log line %s", (value) => {
    expect(hasRegisteredQuickTunnelConnection(value)).toBe(false);
  });
});
