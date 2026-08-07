const ANSI_ESCAPE = new RegExp(
  String.raw`\x1B\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const HTTPS_URL = /https:\/\/[^\s"'<>|]+/gi;
const QUICK_TUNNEL_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;
const REGISTERED_TUNNEL_CONNECTION =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+)?INF Registered tunnel connection connIndex=\d+ connection=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12} event=0 ip=[a-f0-9:.]+ location=[a-z0-9-]+ protocol=(?:quic|http2)$/i;

export function validQuickTunnelOrigin(
  value: string,
): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !QUICK_TUNNEL_HOST.test(url.hostname)
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function parseQuickTunnelUrl(
  output: string,
): string | undefined {
  const clean = output.replace(ANSI_ESCAPE, "");
  for (const candidate of clean.match(HTTPS_URL) ?? []) {
    const origin = validQuickTunnelOrigin(
      candidate.replace(/[),.;:\]]+$/, ""),
    );
    if (origin) {
      return origin;
    }
  }
  return undefined;
}

export function hasRegisteredQuickTunnelConnection(
  output: string,
): boolean {
  return output
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/)
    .some((line) =>
      REGISTERED_TUNNEL_CONNECTION.test(line.trim()),
    );
}
