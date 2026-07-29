import type * as vscode from "vscode";

export const SYNTHETIC_TOKEN_SECRET_KEY =
  "claudeProvider.synthetic.apiToken";
export const ANTHROPIC_API_KEY_SECRET_KEY =
  "claudeProvider.anthropic.apiKey";

export class MissingCredentialError extends Error {
  public constructor() {
    super(
      "Synthetic API token is not configured. Run “Synthetic for Claude Code: Set API Token” first.",
    );
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
}
