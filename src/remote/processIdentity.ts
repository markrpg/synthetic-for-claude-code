import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { RemoteTunnelState } from "./types.js";

const execFileAsync = promisify(execFile);

export function cloudflaredCommandMatches(
  tunnel: RemoteTunnelState,
  command: string,
): boolean {
  return (
    typeof tunnel.configPath === "string" &&
    command.includes(path.basename(tunnel.executable)) &&
    command.includes(tunnel.configPath) &&
    command.includes(
      `--url http://127.0.0.1:${tunnel.originPort}`,
    )
  );
}

export async function readProcessCommand(
  pid: number,
): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    if (process.platform === "win32") {
      const result = await execFileAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { timeout: 3_000, windowsHide: true },
      );
      const command = `${result.stdout}${result.stderr}`.trim();
      return command || undefined;
    }
    const result = await execFileAsync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      { timeout: 3_000 },
    );
    const command = `${result.stdout}${result.stderr}`.trim();
    return command || undefined;
  } catch {
    return undefined;
  }
}
