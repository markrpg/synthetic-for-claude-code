import type * as vscode from "vscode";
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
}

export class SnapshotService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getSyntheticBaseUrl?: () => string,
    private readonly registerSecretForRedaction?: (secret: string) => void,
  ) {}

  public capture(
    environmentVariables: readonly EnvironmentVariable[],
  ): ConfigurationSnapshot {
    const token = environmentVariables.find(
      (variable) => variable.name === "ANTHROPIC_AUTH_TOKEN",
    )?.value;
    if (token) {
      this.registerSecretForRedaction?.(token);
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
    let protectedToken: string | undefined;
    const sanitisedVariables = snapshot.environmentVariables.map((variable) => {
      if (variable.name !== "ANTHROPIC_AUTH_TOKEN") {
        return { ...variable };
      }
      protectedToken = variable.value;
      return { name: variable.name, value: TOKEN_PLACEHOLDER };
    });

    const protectedTokenSecretKey =
      protectedToken === undefined
        ? undefined
        : `${SNAPSHOT_TOKEN_SECRET_PREFIX}.${snapshot.createdAt}`;
    const stored: StoredConfigurationSnapshot = {
      ...snapshot,
      environmentVariables: sanitisedVariables,
      protectedTokenSecretKey,
    };

    if (protectedToken !== undefined && protectedTokenSecretKey) {
      await this.context.secrets.store(
        protectedTokenSecretKey,
        protectedToken,
      );
    }
    try {
      await this.context.globalState.update(SNAPSHOT_STATE_KEY, stored);
    } catch (error) {
      if (protectedTokenSecretKey) {
        await this.context.secrets.delete(protectedTokenSecretKey);
      }
      throw error;
    }

    if (
      previous?.protectedTokenSecretKey &&
      previous.protectedTokenSecretKey !== protectedTokenSecretKey
    ) {
      try {
        await this.context.secrets.delete(
          previous.protectedTokenSecretKey,
        );
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

    let protectedToken: string | undefined;
    if (stored.protectedTokenSecretKey) {
      protectedToken = await this.context.secrets.get(
        stored.protectedTokenSecretKey,
      );
      if (!protectedToken) {
        throw new Error(
          "The previous configuration snapshot requires a credential that is no longer available.",
        );
      }
      this.registerSecretForRedaction?.(protectedToken);
    }

    return {
      createdAt: stored.createdAt,
      target: "global",
      detectedProvider: stored.detectedProvider,
      environmentVariables: stored.environmentVariables.map((variable) => {
        if (
          variable.name === "ANTHROPIC_AUTH_TOKEN" &&
          variable.value === TOKEN_PLACEHOLDER
        ) {
          return { name: variable.name, value: protectedToken ?? "" };
        }
        return { ...variable };
      }),
    };
  }
}
