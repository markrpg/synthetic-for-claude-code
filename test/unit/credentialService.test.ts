import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_API_KEY_SECRET_KEY,
  BRIDGE_AUTH_TOKEN_SECRET_KEY,
  BRIDGE_CONTROL_TOKEN_SECRET_KEY,
  CredentialService,
  OPENAI_API_KEY_SECRET_KEY,
  REMOTE_CONTROL_TOKEN_SECRET_KEY,
  REMOTE_DEVICE_STORE_KEY_SECRET_KEY,
  REMOTE_HOST_IDENTITY_SECRET_KEY,
  REMOTE_LAUNCH_TOKEN_SECRET_KEY,
} from "../../src/credentials/credentialService.js";

function createSecrets(): {
  secrets: vscode.SecretStorage;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  const secrets = {
    get(key: string): Thenable<string | undefined> {
      return Promise.resolve(values.get(key));
    },
    store(key: string, value: string): Thenable<void> {
      values.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Thenable<void> {
      values.delete(key);
      return Promise.resolve();
    },
    onDidChange: vi.fn(),
  } as unknown as vscode.SecretStorage;
  return { secrets, values };
}

describe("CredentialService", () => {
  it("protects and restores a native Anthropic API key", async () => {
    const { secrets, values } = createSecrets();
    const registerSecret = vi.fn();
    const service = new CredentialService(secrets, registerSecret);

    await service.rememberAnthropicApiKey(" native-key ");

    expect(values.get(ANTHROPIC_API_KEY_SECRET_KEY)).toBe("native-key");
    await expect(service.getAnthropicApiKey()).resolves.toBe(
      "native-key",
    );
    expect(registerSecret).toHaveBeenCalledWith("native-key");
  });

  it("forgets a stale native Anthropic API key when none is active", async () => {
    const { secrets, values } = createSecrets();
    const service = new CredentialService(secrets);
    values.set(ANTHROPIC_API_KEY_SECRET_KEY, "stale-key");

    await service.rememberAnthropicApiKey(undefined);

    expect(values.has(ANTHROPIC_API_KEY_SECRET_KEY)).toBe(false);
  });

  it("keeps OpenAI and bridge credentials independently in SecretStorage", async () => {
    const { secrets, values } = createSecrets();
    const service = new CredentialService(secrets);

    await service.setOpenAIApiKey(" sk-openai ");
    const bridge = await service.getOrCreateBridgeAuthToken();
    const control = await service.getOrCreateBridgeControlToken();

    expect(values.get(OPENAI_API_KEY_SECRET_KEY)).toBe("sk-openai");
    expect(values.get(BRIDGE_AUTH_TOKEN_SECRET_KEY)).toBe(bridge);
    expect(values.get(BRIDGE_CONTROL_TOKEN_SECRET_KEY)).toBe(control);
    expect(bridge).not.toBe(control);

    await service.clearOpenAIApiKey();
    expect(values.has(OPENAI_API_KEY_SECRET_KEY)).toBe(false);
    expect(values.get(BRIDGE_AUTH_TOKEN_SECRET_KEY)).toBe(bridge);
    expect(values.get(BRIDGE_CONTROL_TOKEN_SECRET_KEY)).toBe(control);
  });

  it("keeps independent remote control, store, and host identity secrets", async () => {
    const { secrets, values } = createSecrets();
    const service = new CredentialService(secrets);

    const control = await service.getOrCreateRemoteControlToken();
    const storeKey = await service.getOrCreateRemoteDeviceStoreKey();
    const identity = await service.getOrCreateRemoteHostIdentity();
    const launch = await service.getOrCreateRemoteLaunchToken("lease-1");

    expect(values.get(REMOTE_CONTROL_TOKEN_SECRET_KEY)).toBe(control);
    expect(values.get(REMOTE_DEVICE_STORE_KEY_SECRET_KEY)).toBe(
      storeKey,
    );
    expect(values.get(REMOTE_HOST_IDENTITY_SECRET_KEY)).toContain(
      identity.privateKey,
    );
    expect(values.get(REMOTE_LAUNCH_TOKEN_SECRET_KEY)).toContain(
      launch,
    );
    expect(control).not.toBe(storeKey);
    expect(identity.privateKey).not.toBe(identity.publicKey);
    await service.clearRemoteLaunchToken();
    expect(values.has(REMOTE_LAUNCH_TOKEN_SECRET_KEY)).toBe(false);
  });
});
