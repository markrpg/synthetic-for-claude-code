import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  decryptLocalStore,
  encryptLocalStore,
} from "./crypto.js";

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform. The manifest file
    // itself was synced before the atomic rename.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class RemoteRuntimeStoreCorruptionError extends Error {
  public constructor(
    message: string,
    public readonly quarantinePath: string,
  ) {
    super(message);
    this.name = "RemoteRuntimeStoreCorruptionError";
  }
}

export class EncryptedRemoteRuntimeStore<T> {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly storePath: string,
    private readonly encryptionKey: string,
  ) {}

  public async load(): Promise<T | undefined> {
    let source: string;
    try {
      source = await readFile(this.storePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    try {
      return decryptLocalStore<T>(this.encryptionKey, source);
    } catch (error) {
      const quarantinePath = `${this.storePath}.corrupt-${String(
        Date.now(),
      )}-${randomUUID()}`;
      await copyFile(this.storePath, quarantinePath);
      throw new RemoteRuntimeStoreCorruptionError(
        `The encrypted remote runtime manifest is damaged or cannot be decrypted: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        quarantinePath,
      );
    }
  }

  public save(value: T): Promise<void> {
    return this.persist(async () => {
      await mkdir(path.dirname(this.storePath), {
        recursive: true,
        mode: 0o700,
      });
      const temporaryPath = `${this.storePath}.tmp-${process.pid}-${randomUUID()}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(
          encryptLocalStore(this.encryptionKey, value),
          "utf8",
        );
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, this.storePath);
        await syncDirectory(path.dirname(this.storePath));
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
  }

  public clear(): Promise<void> {
    return this.persist(async () => {
      await unlink(this.storePath).catch((error) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
      await syncDirectory(path.dirname(this.storePath));
    });
  }

  public flush(): Promise<void> {
    return this.writeChain;
  }

  private async persist(operation: () => Promise<void>): Promise<void> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.catch(() => undefined);
    await pending;
  }
}
