import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as tar from "tar";
import * as vscode from "vscode";
import {
  CLOUDFLARED_PACKAGES,
  CLOUDFLARED_VERSION,
  cloudflaredPlatformKey,
  type CloudflaredPackage,
} from "./cloudflaredManifest.js";

const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

interface InstallMarker {
  version: string;
  sha256: string;
  executableSha256: string;
}

class ByteLimit extends Transform {
  private bytes = 0;

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_DOWNLOAD_BYTES) {
      callback(
        new Error(
          "The cloudflared download exceeded ModelHop's size limit.",
        ),
      );
      return;
    }
    callback(null, chunk);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function validateCloudflaredExecutable(
  executable: string,
  requiredVersion?: string,
): Promise<void> {
  let output = "";
  try {
    const result = await execFileAsync(executable, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    throw new Error(
      `ModelHop could not run cloudflared: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
  if (!/\bcloudflared version \d{4}\.\d{1,2}\.\d+\b/i.test(output)) {
    throw new Error(
      "The selected executable did not identify itself as cloudflared.",
    );
  }
  if (
    requiredVersion &&
    !new RegExp(
      `\\bcloudflared version ${requiredVersion.replaceAll(".", "\\.")}\\b`,
      "i",
    ).test(output)
  ) {
    throw new Error(
      `The managed cloudflared runtime is not version ${requiredVersion}.`,
    );
  }
}

export class CloudflaredRuntimeManager {
  private readonly packageInfo: CloudflaredPackage | undefined;
  private readonly root: string;

  public constructor(context: vscode.ExtensionContext) {
    const platform = cloudflaredPlatformKey();
    this.packageInfo = CLOUDFLARED_PACKAGES[platform];
    this.root = vscode.Uri.joinPath(
      context.globalStorageUri,
      "cloudflared",
      CLOUDFLARED_VERSION,
      platform,
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
    const executable = path.join(this.root, packageInfo.executable);
    try {
      const marker = JSON.parse(
        await readFile(
          path.join(this.root, "modelhop-install.json"),
          "utf8",
        ),
      ) as Partial<InstallMarker>;
      if (
        marker.version !== CLOUDFLARED_VERSION ||
        marker.sha256 !== packageInfo.sha256 ||
        typeof marker.executableSha256 !== "string" ||
        !(await exists(executable))
      ) {
        return undefined;
      }
      if (
        (await sha256File(executable)) !== marker.executableSha256
      ) {
        return undefined;
      }
      await validateCloudflaredExecutable(
        executable,
        CLOUDFLARED_VERSION,
      );
      return executable;
    } catch {
      return undefined;
    }
  }

  public async ensureInstalled(
    report: (message: string) => void = () => undefined,
  ): Promise<string> {
    const existing = await this.getInstalledExecutable();
    if (existing) {
      return existing;
    }
    const packageInfo = this.packageInfo;
    if (!packageInfo) {
      throw new Error(
        `ModelHop's managed cloudflared runtime is not available for ${cloudflaredPlatformKey()}. Set modelHop.remote.cloudflaredPath to a compatible executable.`,
      );
    }
    const parent = path.dirname(this.root);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const lockPath = path.join(parent, "modelhop-install.lock");
    const lockDeadline = Date.now() + 10 * 60 * 1000;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
      try {
        const candidate = await open(lockPath, "wx", 0o600);
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
        const installedByOtherWindow =
          await this.getInstalledExecutable();
        if (installedByOtherWindow) {
          return installedByOtherWindow;
        }
        try {
          const ownerPid = Number(await readFile(lockPath, "utf8"));
          if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
          process.kill(ownerPid, 0);
        } catch (ownerError) {
          if (
            errorCode(ownerError) === "ESRCH" ||
            errorCode(ownerError) === "ENOENT"
          ) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        }
        if (Date.now() >= lockDeadline) {
          throw new Error(
            "Timed out waiting for another ModelHop window to install cloudflared.",
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
      `cloudflared-${CLOUDFLARED_VERSION}-${cloudflaredPlatformKey()}.download`,
    );
    try {
      report("Downloading the official pinned cloudflared runtime…");
      const response = await fetch(packageInfo.url, {
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      const declaredSize = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (
        !response.ok ||
        !response.body ||
        (declaredSize > 0 && declaredSize > MAX_DOWNLOAD_BYTES)
      ) {
        throw new Error(
          `cloudflared download failed with status ${response.status}.`,
        );
      }
      await pipeline(
        Readable.from(
          response.body as unknown as AsyncIterable<Uint8Array>,
        ),
        new ByteLimit(),
        createWriteStream(archivePath, { mode: 0o600 }),
      );
      report("Verifying Cloudflare's published SHA-256 digest…");
      if ((await sha256File(archivePath)) !== packageInfo.sha256) {
        throw new Error(
          "The downloaded cloudflared runtime failed its integrity check.",
        );
      }
      await rm(temporaryRoot, { recursive: true, force: true });
      await mkdir(temporaryRoot, {
        recursive: true,
        mode: 0o700,
      });
      const executable = path.join(
        temporaryRoot,
        packageInfo.executable,
      );
      report("Installing the verified cloudflared runtime…");
      if (packageInfo.format === "tgz") {
        await tar.x({
          file: archivePath,
          cwd: temporaryRoot,
          strict: true,
          filter: (entryPath) =>
            entryPath.replace(/^\.\//, "") ===
            packageInfo.executable,
        });
      } else {
        await copyFile(archivePath, executable);
      }
      if (!(await exists(executable))) {
        throw new Error(
          "The verified cloudflared package did not contain its expected executable.",
        );
      }
      if (process.platform !== "win32") {
        await chmod(executable, 0o755);
      }
      await validateCloudflaredExecutable(
        executable,
        CLOUDFLARED_VERSION,
      );
      const executableSha256 = await sha256File(executable);
      await writeFile(
        path.join(temporaryRoot, "modelhop-install.json"),
        JSON.stringify({
          version: CLOUDFLARED_VERSION,
          sha256: packageInfo.sha256,
          executableSha256,
        } satisfies InstallMarker),
        { encoding: "utf8", mode: 0o600 },
      );
      await rm(this.root, { recursive: true, force: true });
      await rename(temporaryRoot, this.root);
      return path.join(this.root, packageInfo.executable);
    } finally {
      await rm(archivePath, { force: true });
      await rm(temporaryRoot, { recursive: true, force: true });
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
