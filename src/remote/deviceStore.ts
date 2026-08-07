import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  decryptLocalStore,
  encryptLocalStore,
} from "./crypto.js";
import type { PairedDevice } from "./types.js";

interface StoredDevices {
  version: 1;
  devices: PairedDevice[];
}

export class RemoteDeviceStore {
  private devices: PairedDevice[] = [];

  public constructor(
    private readonly storePath: string,
    private readonly encryptionKey: string,
  ) {}

  public async initialize(): Promise<void> {
    await mkdir(path.dirname(this.storePath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      const encrypted = await readFile(this.storePath, "utf8");
      const stored = decryptLocalStore<StoredDevices>(
        this.encryptionKey,
        encrypted,
      );
      this.devices = stored.version === 1 ? stored.devices : [];
    } catch {
      this.devices = [];
    }
  }

  public list(): PairedDevice[] {
    return this.devices
      .map((device) => ({ ...device }))
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  public findActive(deviceId: string): PairedDevice | undefined {
    const device = this.devices.find(
      (candidate) =>
        candidate.id === deviceId && candidate.revokedAt === undefined,
    );
    return device ? { ...device } : undefined;
  }

  public async pair(device: PairedDevice): Promise<void> {
    this.devices = [
      ...this.devices.filter(
        (candidate) => candidate.id !== device.id,
      ),
      { ...device, revokedAt: undefined },
    ];
    await this.save();
  }

  public async touch(deviceId: string): Promise<void> {
    const device = this.devices.find(
      (candidate) => candidate.id === deviceId,
    );
    if (!device) {
      return;
    }
    device.lastUsedAt = Date.now();
    await this.save();
  }

  public async revoke(deviceId: string): Promise<boolean> {
    const device = this.devices.find(
      (candidate) =>
        candidate.id === deviceId && candidate.revokedAt === undefined,
    );
    if (!device) {
      return false;
    }
    device.revokedAt = Date.now();
    await this.save();
    return true;
  }

  /** Explicit administrative reset; normal lease changes retain trust. */
  public async reset(): Promise<void> {
    this.devices = [];
    await this.save();
  }

  private async save(): Promise<void> {
    const temporary = `${this.storePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      encryptLocalStore(this.encryptionKey, {
        version: 1,
        devices: this.devices,
      } satisfies StoredDevices),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.storePath);
  }
}
