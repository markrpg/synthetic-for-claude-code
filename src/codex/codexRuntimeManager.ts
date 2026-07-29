import { createHash } from "node:crypto";
import {
  chmod,
  createReadStream,
  createWriteStream,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs";
import { access } from "node:fs/promises";
import {
  open as openFile,
  readFile as readFilePromise,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import * as vscode from "vscode";
import {
  CODEX_RUNTIME_PACKAGES,
  CODEX_RUNTIME_VERSION,
} from "./runtimeManifest.js";

interface InstallMarker {
  version: string;
  integrity: string;
}

function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function verifyIntegrity(
  archivePath: string,
  expected: string,
): Promise<void> {
  const [algorithm, digest] = expected.split("-", 2);
  if (!algorithm || !digest) {
    throw new Error("The Codex runtime manifest has an invalid integrity value.");
  }
  const hash = createHash(algorithm);
  await pipeline(createReadStream(archivePath), hash);
  if (hash.digest("base64") !== digest) {
    throw new Error(
      "The downloaded Codex runtime failed its integrity check.",
    );
  }
}

export class CodexRuntimeManager {
  private readonly packageInfo =
    CODEX_RUNTIME_PACKAGES[platformKey()];
  private readonly root: string;

  public constructor(context: vscode.ExtensionContext) {
    this.root = vscode.Uri.joinPath(
      context.globalStorageUri,
      "codex-runtime",
      CODEX_RUNTIME_VERSION,
      platformKey(),
    ).fsPath;
  }

  public isSupported(): boolean {
    return Boolean(this.packageInfo);
  }

  public async getInstalledExecutable(): Promise<string | undefined> {
    const packageInfo = this.packageInfo;
    if (!packageInfo) {
      return undefined;
    }
    const markerPath = path.join(this.root, "modelhop-install.json");
    const executable = path.join(this.root, packageInfo.executable);
    try {
      const marker = JSON.parse(
        await new Promise<string>((resolve, reject) => {
          readFile(markerPath, "utf8", (error, data) => {
            if (error) {
              reject(error);
            } else {
              resolve(data);
            }
          });
        }),
      ) as InstallMarker;
      return marker.version === CODEX_RUNTIME_VERSION &&
        marker.integrity === packageInfo.integrity &&
        (await exists(executable))
        ? executable
        : undefined;
    } catch {
      return undefined;
    }
  }

  public async ensureInstalled(): Promise<string> {
    const existing = await this.getInstalledExecutable();
    if (existing) {
      return existing;
    }
    const packageInfo = this.packageInfo;
    if (!packageInfo) {
      throw new Error(
        `The managed Codex runtime is not available for ${platformKey()}.`,
      );
    }
    const parent = path.dirname(this.root);
    await new Promise<void>((resolve, reject) => {
      mkdir(parent, { recursive: true, mode: 0o700 }, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    const lockPath = path.join(parent, "modelhop-install.lock");
    const lockDeadline = Date.now() + 10 * 60 * 1000;
    let lock: Awaited<ReturnType<typeof openFile>> | undefined;
    while (!lock) {
      try {
        const candidate = await openFile(lockPath, "wx", 0o600);
        try {
          await candidate.writeFile(String(process.pid), "utf8");
          lock = candidate;
        } catch (error) {
          await candidate.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
        const installedByOtherWindow = await this.getInstalledExecutable();
        if (installedByOtherWindow) {
          return installedByOtherWindow;
        }
        try {
          const ownerPid = Number(
            await readFilePromise(lockPath, "utf8"),
          );
          if (Number.isInteger(ownerPid) && ownerPid > 0) {
            process.kill(ownerPid, 0);
          }
        } catch (ownerError) {
          if (errorCode(ownerError) === "ESRCH") {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        }
        if (Date.now() >= lockDeadline) {
          throw new Error(
            "Timed out waiting for another ModelHop window to install Codex.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const installedAfterLock = await this.getInstalledExecutable();
    if (installedAfterLock) {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
      return installedAfterLock;
    }
    const temporaryRoot = `${this.root}.installing-${process.pid}`;
    const archivePath = path.join(
      parent,
      `codex-${CODEX_RUNTIME_VERSION}-${platformKey()}.tgz`,
    );
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ModelHop: installing Codex ${CODEX_RUNTIME_VERSION}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({
            message: "Downloading the verified OpenAI package…",
          });
          const response = await fetch(packageInfo.url, {
            signal: AbortSignal.timeout(10 * 60 * 1000),
          });
          if (!response.ok || !response.body) {
            throw new Error(
              `Codex runtime download failed with status ${response.status}.`,
            );
          }
          await pipeline(
            Readable.fromWeb(response.body),
            createWriteStream(archivePath, { mode: 0o600 }),
          );
          progress.report({ message: "Verifying package integrity…" });
          await verifyIntegrity(archivePath, packageInfo.integrity);
          await new Promise<void>((resolve, reject) => {
            rm(
              temporaryRoot,
              { recursive: true, force: true },
              (error) => (error ? reject(error) : resolve()),
            );
          });
          await new Promise<void>((resolve, reject) => {
            mkdir(
              temporaryRoot,
              { recursive: true, mode: 0o700 },
              (error) => (error ? reject(error) : resolve()),
            );
          });
          progress.report({ message: "Extracting the managed runtime…" });
          await tar.x({
            file: archivePath,
            cwd: temporaryRoot,
            strip: 1,
          });
          const executable = path.join(
            temporaryRoot,
            packageInfo.executable,
          );
          if (!(await exists(executable))) {
            throw new Error(
              "The verified Codex package did not contain its expected executable.",
            );
          }
          if (process.platform !== "win32") {
            await new Promise<void>((resolve, reject) => {
              chmod(executable, 0o755, (error) =>
                error ? reject(error) : resolve(),
              );
            });
          }
          await new Promise<void>((resolve, reject) => {
            writeFile(
              path.join(temporaryRoot, "modelhop-install.json"),
              JSON.stringify({
                version: CODEX_RUNTIME_VERSION,
                integrity: packageInfo.integrity,
              } satisfies InstallMarker),
              { encoding: "utf8", mode: 0o600 },
              (error) => (error ? reject(error) : resolve()),
            );
          });
          await new Promise<void>((resolve, reject) => {
            rm(this.root, { recursive: true, force: true }, (error) =>
              error ? reject(error) : resolve(),
            );
          });
          await new Promise<void>((resolve, reject) => {
            rename(temporaryRoot, this.root, (error) =>
              error ? reject(error) : resolve(),
            );
          });
          return path.join(this.root, packageInfo.executable);
        },
      );
    } finally {
      await new Promise<void>((resolve) => {
        rm(archivePath, { force: true }, () => resolve());
      });
      await new Promise<void>((resolve) => {
        rm(temporaryRoot, { force: true, recursive: true }, () =>
          resolve(),
        );
      });
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
