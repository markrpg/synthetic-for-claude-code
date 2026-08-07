import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import { RemoteSetupCancelledError } from "./cancellation.js";
import {
  cloudflaredCommandMatches,
  readProcessCommand,
} from "./processIdentity.js";
import type { RemoteTunnelState } from "./types.js";
import {
  hasRegisteredQuickTunnelConnection,
  parseQuickTunnelUrl,
} from "./quickTunnelOutput.js";

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const QUICK_TUNNEL_ALLOCATION_FAILURE =
  /failed to request quick tunnel/i;
const RETRYABLE_ALLOCATION_FAILURE =
  /(?:api\.trycloudflare\.com|context deadline exceeded|client\.timeout|timed? out|timeout|temporary failure|connection reset|connection refused|unexpected eof|tls handshake|no such host|server misbehaving|\b(?:429|500|502|503|504)\b)/i;

class QuickTunnelAttemptError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly detail: string,
  ) {
    super(message);
    this.name = "QuickTunnelAttemptError";
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A ChildProcess owned by this manager is authoritative for its own lifetime.
 * Looking only at `kill(pid, 0)` is unsafe here: a very short-lived child may
 * already have emitted `exit`, while its PID can be observed again under heavy
 * process churn. Restored processes still use PID plus command-line identity.
 */
function childTerminated(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class QuickTunnelManager {
  private readonly children = new Map<number, ChildProcess>();

  public constructor(
    private readonly stateDirectory: string,
    private readonly logger: RedactingLogger,
    private readonly processCommand: (
      pid: number,
    ) => Promise<string | undefined> = readProcessCommand,
    private readonly timing: {
      startupTimeoutMs?: number;
      stopGraceMs?: number;
      forceStopGraceMs?: number;
      retryDelaysMs?: readonly number[];
    } = {},
  ) {}

  public async start(
    executable: string,
    originPort: number,
    cancelled: () => boolean = () => false,
    report?: (message: string) => void,
  ): Promise<RemoteTunnelState> {
    const retryDelays =
      this.timing.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const maximumAttempts = retryDelays.length + 1;
    for (let attemptIndex = 0; attemptIndex < maximumAttempts; attemptIndex += 1) {
      if (cancelled()) {
        throw new RemoteSetupCancelledError();
      }
      try {
        return await this.startAttempt(executable, originPort, cancelled);
      } catch (error) {
        if (error instanceof RemoteSetupCancelledError) {
          throw error;
        }
        const attempt = attemptIndex + 1;
        if (error instanceof QuickTunnelAttemptError) {
          this.logger.info(
            `Cloudflare Quick Tunnel attempt ${attempt}/${maximumAttempts} failed: ${error.detail}`,
          );
          if (error.retryable && attemptIndex < retryDelays.length) {
            report?.(
              `Cloudflare timed out; retrying secure link (${attempt + 1}/${maximumAttempts})…`,
            );
            await this.waitForRetry(
              retryDelays[attemptIndex] ?? 0,
              cancelled,
            );
            continue;
          }
          if (error.retryable) {
            throw new Error(
              `Cloudflare could not create a temporary phone link after ${maximumAttempts} attempts. No phone access was opened. Check your VPN, Cloudflare WARP, firewall, or network, then try again; technical details are in the ModelHop output.`,
            );
          }
          throw new Error(error.message);
        }
        throw error;
      }
    }
    throw new Error("Cloudflare did not create a temporary phone link.");
  }

  private async startAttempt(
    executable: string,
    originPort: number,
    cancelled: () => boolean,
  ): Promise<RemoteTunnelState> {
    await mkdir(this.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const configPath = path.join(
      this.stateDirectory,
      `cloudflared-quick-${randomUUID()}.yml`,
    );
    await writeFile(configPath, "{}\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const logPath = path.join(
      this.stateDirectory,
      "cloudflared-quick.log",
    );
    await appendFile(logPath, "", { mode: 0o600 });
    const log = await open(logPath, "w", 0o600);
    let child;
    let childError: Error | undefined;
    try {
      child = spawn(
        executable,
        [
          "tunnel",
          "--config",
          configPath,
          "--no-autoupdate",
          "--metrics",
          "127.0.0.1:0",
          "--loglevel",
          "info",
          "--transport-loglevel",
          "warn",
          "--edge-ip-version",
          "4",
          "--url",
          `http://127.0.0.1:${originPort}`,
        ],
        {
          cwd: this.stateDirectory,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          windowsHide: true,
        },
      );
      child.once("error", (error) => {
        childError = error;
      });
      child.unref();
    } finally {
      await log.close();
    }
    if (!child.pid) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await unlink(configPath).catch(() => undefined);
      throw new Error(
        childError?.message ??
          "The Cloudflare Quick Tunnel did not start.",
      );
    }
    const childPid = child.pid;
    this.children.set(childPid, child);
    child.once("exit", () => {
      this.children.delete(childPid);
    });
    try {
      const baseUrl = await this.waitForRegistration(
        logPath,
        child,
        () => childError,
        cancelled,
      );
      this.logger.info(
        `Cloudflare Quick Tunnel ready at ${new URL(baseUrl).hostname}.`,
      );
      return {
        transport: "cloudflare-quick",
        pid: childPid,
        baseUrl,
        executable,
        originPort,
        configPath,
        logPath,
        startedAt: Date.now(),
      };
    } catch (error) {
      const stopped = await this.terminateStartedChild(child);
      if (stopped) {
        this.children.delete(childPid);
        await unlink(configPath).catch(() => undefined);
      } else {
        throw new Error(
          `ModelHop could not stop the failed cloudflared process ${childPid}. Its ownership file was preserved at ${configPath}. Stop that process before starting another phone link.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async waitForRetry(
    delayMs: number,
    cancelled: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, delayMs);
    while (Date.now() < deadline) {
      if (cancelled()) {
        throw new RemoteSetupCancelledError();
      }
      const remaining = deadline - Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, remaining)),
      );
    }
    if (cancelled()) {
      throw new RemoteSetupCancelledError();
    }
  }

  public async isRunning(
    tunnel: RemoteTunnelState | undefined,
  ): Promise<boolean> {
    if (
      !tunnel?.pid ||
      tunnel.transport !== "cloudflare-quick"
    ) {
      return false;
    }
    const child = this.children.get(tunnel.pid);
    if (child) {
      return !childTerminated(child);
    }
    if (!processAlive(tunnel.pid)) {
      return false;
    }
    return this.processMatches(tunnel);
  }

  public async stop(
    tunnel: RemoteTunnelState | undefined,
  ): Promise<boolean> {
    if (
      !tunnel?.pid ||
      tunnel.transport !== "cloudflare-quick"
    ) {
      return true;
    }
    const child = this.children.get(tunnel.pid);
    if (child) {
      this.children.delete(tunnel.pid);
      const stopped = await this.terminateStartedChild(child);
      if (stopped) {
        await this.removeOwnedConfig(tunnel);
      }
      return stopped;
    }
    if (!processAlive(tunnel.pid)) {
      await this.removeOwnedConfig(tunnel);
      return true;
    }
    if (!(await this.processMatches(tunnel))) {
      return false;
    }
    try {
      process.kill(tunnel.pid, "SIGTERM");
    } catch {
      // The process has already exited.
    }
    const deadline =
      Date.now() + (this.timing.stopGraceMs ?? 5_000);
    while (processAlive(tunnel.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stopped = !processAlive(tunnel.pid);
    if (stopped) {
      await this.removeOwnedConfig(tunnel);
    }
    return stopped;
  }

  private async processMatches(
    tunnel: RemoteTunnelState,
  ): Promise<boolean> {
    if (
      !tunnel.pid ||
      !processAlive(tunnel.pid) ||
      !this.ownedConfigPath(tunnel)
    ) {
      return false;
    }
    const command = await this.processCommand(tunnel.pid);
    return Boolean(
      command && cloudflaredCommandMatches(tunnel, command),
    );
  }

  private ownedConfigPath(
    tunnel: RemoteTunnelState,
  ): string | undefined {
    if (typeof tunnel.configPath !== "string") {
      return undefined;
    }
    const resolved = path.resolve(tunnel.configPath);
    return path.dirname(resolved) === path.resolve(this.stateDirectory) &&
      /^cloudflared-quick-[a-f0-9-]+\.yml$/i.test(
        path.basename(resolved),
      )
      ? resolved
      : undefined;
  }

  private async removeOwnedConfig(
    tunnel: RemoteTunnelState,
  ): Promise<void> {
    const configPath = this.ownedConfigPath(tunnel);
    if (configPath) {
      await unlink(configPath).catch(() => undefined);
    }
  }

  private async terminateStartedChild(
    child: ChildProcess,
  ): Promise<boolean> {
    const pid = child.pid;
    if (!pid || childTerminated(child)) {
      return true;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Check the process directly below.
    }
    if (
      await this.waitForOwnedChildExit(
        child,
        this.timing.stopGraceMs ?? 5_000,
      )
    ) {
      return true;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Check the process directly below.
    }
    return this.waitForOwnedChildExit(
      child,
      this.timing.forceStopGraceMs ?? 2_000,
    );
  }

  private async waitForOwnedChildExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (childTerminated(child)) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolve(exited || childTerminated(child));
      };
      const onExit = (): void => finish(true);
      const timer = setTimeout(
        () => finish(false),
        Math.max(0, timeoutMs),
      );
      child.once("exit", onExit);
      child.once("close", onExit);
      if (childTerminated(child)) {
        finish(true);
      }
    });
  }

  private async waitForRegistration(
    logPath: string,
    child: ChildProcess,
    startupError: () => Error | undefined,
    cancelled: () => boolean,
  ): Promise<string> {
    const deadline =
      Date.now() + (this.timing.startupTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      if (cancelled()) {
        throw new RemoteSetupCancelledError();
      }
      const error = startupError();
      if (error) {
        throw new Error(
          `cloudflared could not start: ${error.message}`,
        );
      }
      const output = await readFile(logPath, "utf8").catch(() => "");
      const allocationFailure = this.allocationFailure(output);
      if (allocationFailure) {
        throw allocationFailure;
      }
      const url = parseQuickTunnelUrl(output);
      if (
        url &&
        hasRegisteredQuickTunnelConnection(output)
      ) {
        if (childTerminated(child)) {
          throw new Error(
            "cloudflared stopped immediately after registering the Quick Tunnel.",
          );
        }
        return url;
      }
      if (childTerminated(child)) {
        const detail = output.trim().slice(-4_000);
        throw new QuickTunnelAttemptError(
          "cloudflared stopped before creating a Quick Tunnel. See the ModelHop output for technical details.",
          false,
          detail || "cloudflared exited without diagnostic output.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new QuickTunnelAttemptError(
      "Cloudflare did not register the Quick Tunnel before startup timed out.",
      true,
      "cloudflared remained running but did not register a Quick Tunnel before the startup deadline.",
    );
  }

  private allocationFailure(
    output: string,
  ): QuickTunnelAttemptError | undefined {
    const detail = output.trim().slice(-4_000);
    if (!QUICK_TUNNEL_ALLOCATION_FAILURE.test(detail)) {
      return undefined;
    }
    const retryable = RETRYABLE_ALLOCATION_FAILURE.test(detail);
    return new QuickTunnelAttemptError(
      retryable
        ? "Cloudflare timed out while allocating the temporary phone link."
        : "Cloudflare rejected the temporary phone-link request. See the ModelHop output for technical details.",
      retryable,
      detail,
    );
  }
}
