import type * as vscode from "vscode";
import { randomUUID } from "node:crypto";

export const SYNTHETIC_TOKEN_SECRET_KEY =
  "claudeProvider.synthetic.apiToken";
export const ANTHROPIC_API_KEY_SECRET_KEY =
  "claudeProvider.anthropic.apiKey";
export const OPENAI_API_KEY_SECRET_KEY = "modelHop.openai.apiKey";
export const BRIDGE_AUTH_TOKEN_SECRET_KEY =
  "modelHop.bridge.authToken";
export const BRIDGE_CONTROL_TOKEN_SECRET_KEY =
  "modelHop.bridge.controlToken";

export class MissingCredentialError extends Error {
  public constructor(provider = "Synthetic") {
    super(`${provider} credential is not configured in ModelHop.`);
    this.name = "MissingCredentialError";
  }
}

export class CredentialService {
  public constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly registerSecretForRedaction?: (secret: string) => void,
  ) {}

  public async getSyntheticToken(): Promise<string> {
    const token = await this.secrets.get(SYNTHETIC_TOKEN_SECRET_KEY);
    if (!token?.trim()) {
      throw new MissingCredentialError();
    }
    this.registerSecretForRedaction?.(token);
    return token;
  }

  public async hasSyntheticToken(): Promise<boolean> {
    const token = await this.secrets.get(SYNTHETIC_TOKEN_SECRET_KEY);
    if (token) {
      this.registerSecretForRedaction?.(token);
    }
    return Boolean(token?.trim());
  }

  public async setSyntheticToken(token: string): Promise<void> {
    const normalisedToken = token.trim();
    if (!normalisedToken) {
      throw new Error("Synthetic API token cannot be empty.");
    }
    this.registerSecretForRedaction?.(normalisedToken);
    await this.secrets.store(SYNTHETIC_TOKEN_SECRET_KEY, normalisedToken);
  }

  public async clearSyntheticToken(): Promise<void> {
    await this.secrets.delete(SYNTHETIC_TOKEN_SECRET_KEY);
  }

  public async getAnthropicApiKey(): Promise<string | undefined> {
    const apiKey = await this.secrets.get(ANTHROPIC_API_KEY_SECRET_KEY);
    if (!apiKey?.trim()) {
      return undefined;
    }
    this.registerSecretForRedaction?.(apiKey);
    return apiKey;
  }

  public async rememberAnthropicApiKey(
    apiKey: string | undefined,
  ): Promise<void> {
    const normalisedApiKey = apiKey?.trim();
    if (!normalisedApiKey) {
      await this.secrets.delete(ANTHROPIC_API_KEY_SECRET_KEY);
      return;
    }
    this.registerSecretForRedaction?.(normalisedApiKey);
    await this.secrets.store(
      ANTHROPIC_API_KEY_SECRET_KEY,
      normalisedApiKey,
    );
  }

  public async getOpenAIApiKey(): Promise<string> {
    const apiKey = await this.secrets.get(OPENAI_API_KEY_SECRET_KEY);
    if (!apiKey?.trim()) {
      throw new MissingCredentialError("OpenAI API");
    }
    this.registerSecretForRedaction?.(apiKey);
    return apiKey;
  }

  public async hasOpenAIApiKey(): Promise<boolean> {
    const apiKey = await this.secrets.get(OPENAI_API_KEY_SECRET_KEY);
    if (apiKey) {
      this.registerSecretForRedaction?.(apiKey);
    }
    return Boolean(apiKey?.trim());
  }

  public async setOpenAIApiKey(apiKey: string): Promise<void> {
    const normalised = apiKey.trim();
    if (!normalised) {
      throw new Error("OpenAI API key cannot be empty.");
    }
    this.registerSecretForRedaction?.(normalised);
    await this.secrets.store(OPENAI_API_KEY_SECRET_KEY, normalised);
  }

  public async clearOpenAIApiKey(): Promise<void> {
    await this.secrets.delete(OPENAI_API_KEY_SECRET_KEY);
  }

  public async getOrCreateBridgeAuthToken(): Promise<string> {
    return this.getOrCreateSecret(BRIDGE_AUTH_TOKEN_SECRET_KEY);
  }

  public async getOrCreateBridgeControlToken(): Promise<string> {
    return this.getOrCreateSecret(BRIDGE_CONTROL_TOKEN_SECRET_KEY);
  }

  private async getOrCreateSecret(key: string): Promise<string> {
    const existing = await this.secrets.get(key);
    if (existing?.trim()) {
      this.registerSecretForRedaction?.(existing);
      return existing;
    }
    const generated = randomUUID().replaceAll("-", "");
    this.registerSecretForRedaction?.(generated);
    await this.secrets.store(key, generated);
    return generated;
  }
}
