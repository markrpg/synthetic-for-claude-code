import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedactingLogger } from "../../src/logging/redactingLogger.js";
import {
  CLOUDFLARED_PACKAGES,
  CLOUDFLARED_VERSION,
  cloudflaredPlatformKey,
} from "../../src/remote/cloudflaredManifest.js";
import { RemoteSetupCancelledError } from "../../src/remote/cancellation.js";
import { QuickTunnelManager } from "../../src/remote/quickTunnelManager.js";
import type { RemoteTunnelState } from "../../src/remote/types.js";

const temporaryDirectories: string[] = [];

async function readAttemptCount(filePath: string): Promise<number> {
  try {
    return Number((await readFile(filePath, "utf8")).trim());
  } catch {
    return 0;
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("managed cloudflared runtime", () => {
  it("pins official packages with SHA-256 digests", () => {
    expect(CLOUDFLARED_VERSION).toBe("2026.7.3");
    expect(
      CLOUDFLARED_PACKAGES[cloudflaredPlatformKey("darwin", "arm64")]
        ?.sha256,
    ).toBe(
      "90c5a4f914d705fd70c135dba6d80b1791d254b08d6d4136301941f88330dd09",
    );
    for (const packageInfo of Object.values(CLOUDFLARED_PACKAGES)) {
      expect(packageInfo.url).toContain(
        `/releases/download/${CLOUDFLARED_VERSION}/`,
      );
      expect(packageInfo.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "Cloudflare Quick Tunnel lifecycle",
  () => {
    it("rejects a missing executable without an unhandled process error", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(directory, logger);
      await expect(
        manager.start(
          path.join(directory, "missing-cloudflared"),
          18_796,
        ),
      ).rejects.toThrow();
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.endsWith(".yml"),
        ),
      ).toEqual([]);
    });

    it("captures the public origin and stops only its matching process", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const argumentsPath = path.join(directory, "arguments");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > '${argumentsPath}'`,
          "echo 'INF https://test-link.trycloudflare.com' >&2",
          "echo 'INF Registered tunnel connection connIndex=0 connection=e64ff147-88dd-43e8-a22f-0486c1f9c32b event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic' >&2",
          "remaining=60",
          "while [ \"$remaining\" -gt 0 ]; do",
          "  sleep 1",
          "  remaining=$((remaining - 1))",
          "done",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(directory, logger);
      let tunnel: RemoteTunnelState | undefined;
      try {
        tunnel = await manager.start(executable, 18_796);
        expect(tunnel.baseUrl).toBe(
          "https://test-link.trycloudflare.com",
        );
        const argumentsList = (
          await readFile(argumentsPath, "utf8")
        )
          .trim()
          .split("\n");
        expect(argumentsList).toContain("--edge-ip-version");
        expect(
          argumentsList[
            argumentsList.indexOf("--edge-ip-version") + 1
          ],
        ).toBe("4");
        expect(path.basename(tunnel.configPath)).toMatch(
          /^cloudflared-quick-[a-f0-9-]+\.yml$/,
        );
        expect(await manager.isRunning(tunnel)).toBe(true);
        const restoredManager = new QuickTunnelManager(
          directory,
          logger,
          async () =>
            `${executable} tunnel --config ${tunnel?.configPath ?? ""} --url http://127.0.0.1:18796`,
        );
        expect(await restoredManager.isRunning(tunnel)).toBe(true);
        expect(
          await restoredManager.stop({
            ...tunnel,
            configPath: path.join(
              directory,
              "cloudflared-quick-wrong-owner.yml",
            ),
          }),
        ).toBe(false);
        expect(await manager.isRunning(tunnel)).toBe(true);
        expect(await restoredManager.stop(tunnel)).toBe(true);
        tunnel = undefined;
      } finally {
        await manager.stop(tunnel);
      }
    });

    it("force-stops a cancelled detached startup before forgetting ownership", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const pidPath = path.join(directory, "fake.pid");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `echo $$ > '${pidPath}'`,
          "trap '' TERM",
          "echo 'INF https://never-registered.trycloudflare.com' >&2",
          "while true; do sleep 1; done",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(
        directory,
        logger,
        undefined,
        {
          stopGraceMs: 100,
          forceStopGraceMs: 1_000,
        },
      );

      await expect(
        manager.start(
          executable,
          18_796,
          () => existsSync(pidPath),
        ),
      ).rejects.toBeInstanceOf(RemoteSetupCancelledError);
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.endsWith(".yml"),
        ),
      ).toEqual([]);
    });

    it("stops the detached connector when startup is cancelled", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const pidPath = path.join(directory, "fake.pid");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `echo $$ > '${pidPath}'`,
          "echo 'INF https://cancelled.trycloudflare.com' >&2",
          "while true; do sleep 1; done",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(
        directory,
        logger,
        undefined,
        {
          stopGraceMs: 1_000,
        },
      );
      await expect(
        manager.start(
          executable,
          18_796,
          () => existsSync(pidPath),
        ),
      ).rejects.toBeInstanceOf(RemoteSetupCancelledError);
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow();
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.endsWith(".yml"),
        ),
      ).toEqual([]);
    });

    it("retries a transient Quick Tunnel allocation timeout and then succeeds", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const attemptsPath = path.join(directory, "attempts");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `attempts_path='${attemptsPath}'`,
          "attempt=0",
          'if [ -f "$attempts_path" ]; then attempt=$(cat "$attempts_path"); fi',
          "attempt=$((attempt + 1))",
          'printf \'%s\\n\' "$attempt" > "$attempts_path"',
          'if [ "$attempt" -eq 1 ]; then',
          "  echo '2026-07-31T12:10:47Z INF Requesting new quick Tunnel on trycloudflare.com...' >&2",
          "  echo '2026-07-31T12:10:47Z ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)' >&2",
          "  exit 1",
          "fi",
          "echo 'INF https://retry-worked.trycloudflare.com' >&2",
          "echo 'INF Registered tunnel connection connIndex=0 connection=e64ff147-88dd-43e8-a22f-0486c1f9c32b event=0 ip=2606:4700:a0::6 location=lhr19 protocol=quic' >&2",
          "while true; do sleep 1; done",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(
        directory,
        logger,
        undefined,
        { retryDelaysMs: [1, 1] },
      );
      const report = vi.fn();
      let tunnel: RemoteTunnelState | undefined;
      try {
        tunnel = await manager.start(
          executable,
          18_796,
          undefined,
          report,
        );
        expect(tunnel.baseUrl).toBe(
          "https://retry-worked.trycloudflare.com",
        );
        expect(await readAttemptCount(attemptsPath)).toBe(2);
        expect(await manager.isRunning(tunnel)).toBe(true);
        expect(report).toHaveBeenCalledWith(
          "Cloudflare timed out; retrying secure link (2/3)…",
        );
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining("context deadline exceeded"),
        );
      } finally {
        await manager.stop(tunnel);
      }
    });

    it("cleans up every process and config after transient retries are exhausted", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const attemptsPath = path.join(directory, "attempts");
      const pidsPath = path.join(directory, "pids");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `attempts_path='${attemptsPath}'`,
          `pids_path='${pidsPath}'`,
          "attempt=0",
          'if [ -f "$attempts_path" ]; then attempt=$(cat "$attempts_path"); fi',
          "attempt=$((attempt + 1))",
          'printf \'%s\\n\' "$attempt" > "$attempts_path"',
          'printf \'%s\\n\' "$$" >> "$pids_path"',
          "echo '2026-07-31T12:10:47Z ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)' >&2",
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(
        directory,
        logger,
        undefined,
        { retryDelaysMs: [1, 1] },
      );

      await expect(manager.start(executable, 18_796)).rejects.toThrow(
        /after 3 attempts.*No phone access was opened/i,
      );
      expect(await readAttemptCount(attemptsPath)).toBe(3);
      expect(logger.info).toHaveBeenCalledTimes(3);
      const pids = (await readFile(pidsPath, "utf8"))
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(pids).toHaveLength(3);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.endsWith(".yml"),
        ),
      ).toEqual([]);
    });

    it("cancels during retry backoff without launching another process", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const attemptsPath = path.join(directory, "attempts");
      const pidPath = path.join(directory, "fake.pid");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `attempts_path='${attemptsPath}'`,
          `pid_path='${pidPath}'`,
          "attempt=0",
          'if [ -f "$attempts_path" ]; then attempt=$(cat "$attempts_path"); fi',
          "attempt=$((attempt + 1))",
          'printf \'%s\\n\' "$attempt" > "$attempts_path"',
          'printf \'%s\\n\' "$$" > "$pid_path"',
          "echo '2026-07-31T12:10:47Z ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)' >&2",
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(
        directory,
        logger,
        undefined,
        { retryDelaysMs: [500, 500] },
      );
      let cancelled = false;
      const startup = manager
        .start(executable, 18_796, () => cancelled)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await waitForCondition(async () => {
        const entries = await readdir(directory);
        return (
          (await readAttemptCount(attemptsPath)) === 1 &&
          !entries.some((entry) => entry.endsWith(".yml"))
        );
      });
      cancelled = true;

      expect(await startup).toBeInstanceOf(RemoteSetupCancelledError);
      expect(await readAttemptCount(attemptsPath)).toBe(1);
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      expect(() => process.kill(pid, 0)).toThrow();
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.endsWith(".yml"),
        ),
      ).toEqual([]);
    });

    it("does not retry a non-transient startup failure", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "modelhop-quick-tunnel-"),
      );
      temporaryDirectories.push(directory);
      const executable = path.join(directory, "fake-cloudflared");
      const attemptsPath = path.join(directory, "attempts");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          `attempts_path='${attemptsPath}'`,
          "attempt=0",
          'if [ -f "$attempts_path" ]; then attempt=$(cat "$attempts_path"); fi',
          "attempt=$((attempt + 1))",
          'printf \'%s\\n\' "$attempt" > "$attempts_path"',
          "echo 'ERR invalid tunnel configuration: malformed ingress rule' >&2",
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(executable, 0o755);
      const logger = {
        info: vi.fn(),
      } as unknown as RedactingLogger;
      const manager = new QuickTunnelManager(
        directory,
        logger,
        undefined,
        { retryDelaysMs: [1, 1] },
      );

      await expect(manager.start(executable, 18_796)).rejects.toThrow(
        /cloudflared stopped before creating a Quick Tunnel/i,
      );
      expect(await readAttemptCount(attemptsPath)).toBe(1);
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.endsWith(".yml"),
        ),
      ).toEqual([]);
    });
  },
);
