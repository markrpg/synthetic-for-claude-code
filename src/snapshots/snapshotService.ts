import type * as vscode from "vscode";
import { SECRET_ENVIRONMENT_KEYS } from "../configuration/managedKeys.js";
import type {
  DetectedProvider,
  EnvironmentVariable,
} from "../providers/types.js";
import { detectProvider } from "../validation/providerDetector.js";

const SNAPSHOT_STATE_KEY = "claudeProvider.lastKnownGoodSnapshot";
const SNAPSHOT_TOKEN_SECRET_PREFIX = "claudeProvider.snapshot.authToken";
const TOKEN_PLACEHOLDER = "__CLAUDE_PROVIDER_SWITCHER_SECRET_REFERENCE__";

export interface ConfigurationSnapshot {
  createdAt: number;
  target: "global";
  environmentVariables: EnvironmentVariable[];
  detectedProvider: DetectedProvider;
}

interface StoredConfigurationSnapshot extends ConfigurationSnapshot {
  protectedTokenSecretKey?: string;
  protectedSecretKeys?: Record<string, string>;
}

export class SnapshotService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getSyntheticBaseUrl?: () => string,
    private readonly registerSecretForRedaction?: (secret: string) => void,
    private readonly getBridgeBaseUrl?: () => string,
  ) {}

  public capture(
    environmentVariables: readonly EnvironmentVariable[],
  ): ConfigurationSnapshot {
    for (const variable of environmentVariables) {
      if (SECRET_ENVIRONMENT_KEYS.has(variable.name) && variable.value) {
        this.registerSecretForRedaction?.(variable.value);
      }
    }
    return {
      createdAt: Date.now(),
      target: "global",
      environmentVariables: environmentVariables.map((variable) => ({
        ...variable,
      })),
      detectedProvider: detectProvider(
        environmentVariables,
        this.getSyntheticBaseUrl?.(),
        this.getBridgeBaseUrl?.(),
      ),
    };
  }

  public async saveLastKnownGood(
    snapshot: ConfigurationSnapshot,
  ): Promise<void> {
    const previous =
      this.context.globalState.get<StoredConfigurationSnapshot>(
        SNAPSHOT_STATE_KEY,
      );
    const protectedValues = new Map<string, string>();
    const sanitisedVariables = snapshot.environmentVariables.map((variable) => {
      if (!SECRET_ENVIRONMENT_KEYS.has(variable.name)) {
        return { ...variable };
      }
      protectedValues.set(variable.name, variable.value);
      return { name: variable.name, value: TOKEN_PLACEHOLDER };
    });

    const protectedSecretKeys = Object.fromEntries(
      [...protectedValues.keys()].map((name) => [
        name,
        `${SNAPSHOT_TOKEN_SECRET_PREFIX}.${snapshot.createdAt}.${name}`,
      ]),
    );
    const stored: StoredConfigurationSnapshot = {
      ...snapshot,
      environmentVariables: sanitisedVariables,
      protectedSecretKeys:
        Object.keys(protectedSecretKeys).length > 0
          ? protectedSecretKeys
          : undefined,
    };

    for (const [name, value] of protectedValues) {
      const secretKey = protectedSecretKeys[name];
      if (secretKey) {
        await this.context.secrets.store(secretKey, value);
      }
    }
    try {
      await this.context.globalState.update(SNAPSHOT_STATE_KEY, stored);
    } catch (error) {
      for (const secretKey of Object.values(protectedSecretKeys)) {
        await this.context.secrets.delete(secretKey);
      }
      throw error;
    }

    const previousKeys = [
      ...(previous?.protectedTokenSecretKey
        ? [previous.protectedTokenSecretKey]
        : []),
      ...Object.values(previous?.protectedSecretKeys ?? {}),
    ];
    for (const secretKey of previousKeys) {
      try {
        await this.context.secrets.delete(secretKey);
      } catch {
        // Cleanup failure must not invalidate the newly committed snapshot.
      }
    }
  }

  public async getLastKnownGood(): Promise<
    ConfigurationSnapshot | undefined
  > {
    const stored =
      this.context.globalState.get<StoredConfigurationSnapshot>(
        SNAPSHOT_STATE_KEY,
      );
    if (!stored) {
      return undefined;
    }

    const protectedValues = new Map<string, string>();
    if (stored.protectedTokenSecretKey) {
      const protectedToken = await this.context.secrets.get(
        stored.protectedTokenSecretKey,
      );
      if (!protectedToken) {
        throw new Error(
          "The previous configuration snapshot requires a credential that is no longer available.",
        );
      }
      this.registerSecretForRedaction?.(protectedToken);
      protectedValues.set("ANTHROPIC_AUTH_TOKEN", protectedToken);
    }
    for (const [name, secretKey] of Object.entries(
      stored.protectedSecretKeys ?? {},
    )) {
      const value = await this.context.secrets.get(secretKey);
      if (!value) {
        throw new Error(
          "The previous configuration snapshot requires a credential that is no longer available.",
        );
      }
      this.registerSecretForRedaction?.(value);
      protectedValues.set(name, value);
    }

    return {
      createdAt: stored.createdAt,
      target: "global",
      detectedProvider: stored.detectedProvider,
      environmentVariables: stored.environmentVariables.map((variable) => {
        if (
          SECRET_ENVIRONMENT_KEYS.has(variable.name) &&
          variable.value === TOKEN_PLACEHOLDER
        ) {
          return {
            name: variable.name,
            value: protectedValues.get(variable.name) ?? "",
          };
        }
        return { ...variable };
      }),
    };
  }
}
