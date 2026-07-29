import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import * as vscode from "vscode";
import type { CodexRuntimeManager } from "../codex/codexRuntimeManager.js";
import type { CredentialService } from "../credentials/credentialService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { OpenAIModel } from "../openai/openAIModelService.js";
import type { OpenAIProviderSettings } from "../providers/types.js";
import type {
  BridgeConfiguration,
  BridgeHealth,
  BridgeModel,
  BridgeProviderId,
  BridgeUsageSnapshot,
} from "./types.js";

const BRIDGE_VERSION = "2.0.0";
const PORT_STATE_KEY = "modelHop.bridge.port";
const CODEX_WARNING_KEY = "modelHop.codex.experimentalAcknowledged";

function deterministicPort(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return 17_700 + digest.readUInt16BE(0) % 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export class BridgeManager {
  private readonly stateDirectory: string;
  private readonly codexWorkingDirectory: string;
  private port: number;
  private controlToken = "";
  private bridgeToken = "";

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credentials: CredentialService,
    private readonly runtimeManager: CodexRuntimeManager,
    private readonly logger: RedactingLogger,
  ) {
    this.stateDirectory = vscode.Uri.joinPath(
      context.globalStorageUri,
      "bridge",
    ).fsPath;
    this.codexWorkingDirectory = path.join(
      this.stateDirectory,
      "codex-empty-workspace",
    );
    this.port =
      context.globalState.get<number>(PORT_STATE_KEY) ??
      deterministicPort(context.globalStorageUri.fsPath);
  }

  public async initialize(): Promise<void> {
    this.controlToken =
      await this.credentials.getOrCreateBridgeControlToken();
    this.bridgeToken =
      await this.credentials.getOrCreateBridgeAuthToken();
    const existingBridge = await this.health();
    if (!existingBridge && !(await portAvailable(this.port))) {
      for (
        let candidate = this.port + 1;
        candidate < this.port + 25;
        candidate += 1
      ) {
        if (await portAvailable(candidate)) {
          this.port = candidate;
          break;
        }
      }
      if (!(await portAvailable(this.port))) {
        throw new Error(
          "ModelHop could not reserve a loopback port for its local bridge.",
        );
      }
    }
    await this.context.globalState.update(PORT_STATE_KEY, this.port);
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.codexWorkingDirectory, {
      recursive: true,
      mode: 0o700,
    });
  }

  public getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public async prepare(
    provider: BridgeProviderId,
    settings: OpenAIProviderSettings,
    options: { validateModels?: boolean } = {},
  ): Promise<void> {
    await this.ensureDaemon();
    const configuration: BridgeConfiguration = {
      provider,
      bridgeAuthToken: this.bridgeToken,
      openAISettings: settings,
    };
    if (provider === "openai-api") {
      configuration.openAIApiKey =
        await this.credentials.getOpenAIApiKey();
      if (options.validateModels !== false) {
        await this.validateOpenAIApiModels(
          configuration.openAIApiKey,
          settings,
        );
      }
    } else {
      await this.acknowledgeExperimentalCodex();
      configuration.codexExecutable =
        await this.runtimeManager.ensureInstalled();
      configuration.codexWorkingDirectory = this.codexWorkingDirectory;
    }
    await this.control<unknown>("/control/configure", {
      method: "POST",
      body: configuration,
      timeoutMs: 30_000,
    });
    if (provider === "openai-codex") {
      await this.ensureCodexAuthenticated();
      if (options.validateModels !== false) {
        const available = new Set(
          (await this.codexModels()).map((model) => model.id),
        );
        const configured = new Set([
          settings.defaultModel,
          settings.opusModel,
          settings.sonnetModel,
          settings.haikuModel,
          settings.subagentModel,
        ]);
        const missing = [...configured].filter(
          (model) => !available.has(model),
        );
        if (missing.length > 0) {
          throw new Error(
            `The signed-in Codex account does not currently offer: ${missing.join(", ")}. Run “ModelHop: Configure ChatGPT/Codex Models” and choose available models.`,
          );
        }
      }
    }
  }

  public async usage(): Promise<BridgeUsageSnapshot> {
    await this.ensureDaemon();
    return this.control<BridgeUsageSnapshot>("/control/usage");
  }

  public async codexModels(): Promise<OpenAIModel[]> {
    await this.ensureDaemon();
    const response = await this.control<{ data?: BridgeModel[] }>(
      "/control/codex/models",
    );
    return (response.data ?? []).map((model) => ({
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      supportedReasoningEfforts:
        model.supportedReasoningEfforts.filter(
          (effort): effort is OpenAIModel["supportedReasoningEfforts"][number] =>
            ["none", "low", "medium", "high", "xhigh", "max"].includes(
              effort,
            ),
        ),
    }));
  }

  public async consumeCodexReset(creditId?: string): Promise<unknown> {
    return this.control("/control/codex/reset", {
      method: "POST",
      body: { idempotencyKey: randomUUID(), creditId },
    });
  }

  public async logoutCodex(): Promise<void> {
    await this.ensureDaemon();
    await this.control("/control/codex/logout", {
      method: "POST",
      body: {},
    });
  }

  public async deactivate(): Promise<void> {
    const health = await this.health();
    if (!health) {
      return;
    }
    try {
      await this.control("/control/shutdown", {
        method: "POST",
        body: {},
        timeoutMs: 2_000,
      });
    } catch {
      // Switching away still removes Claude's bridge environment overrides.
    }
  }

  private async acknowledgeExperimentalCodex(): Promise<void> {
    if (this.context.globalState.get<boolean>(CODEX_WARNING_KEY)) {
      return;
    }
    if (!this.runtimeManager.isSupported()) {
      throw new Error(
        "The managed Codex runtime is unavailable on this platform.",
      );
    }
    const action = await vscode.window.showWarningMessage(
      "OpenAI via ChatGPT/Codex is experimental and downloads a verified OpenAI Codex runtime (roughly 100–150 MB). Dynamic-tool compatibility may change between Codex releases.",
      { modal: true },
      "Continue",
    );
    if (action !== "Continue") {
      throw new Error("Experimental Codex setup was cancelled.");
    }
    await this.context.globalState.update(CODEX_WARNING_KEY, true);
  }

  private async ensureCodexAuthenticated(): Promise<void> {
    const current = await this.control<unknown>("/control/codex/account");
    if (this.hasChatGPTAccount(current)) {
      return;
    }
    const login = await this.control<Record<string, unknown>>(
      "/control/codex/login",
      { method: "POST", body: {} },
    );
    const authUrl =
      typeof login.authUrl === "string" ? login.authUrl : undefined;
    if (!authUrl) {
      throw new Error("Codex did not return a ChatGPT sign-in URL.");
    }
    await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ModelHop: waiting for ChatGPT/Codex sign-in",
        cancellable: true,
      },
      async (_progress, token) => {
        const deadline = Date.now() + 5 * 60 * 1000;
        while (!token.isCancellationRequested && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          const account = await this.control<unknown>(
            "/control/codex/account",
          );
          if (this.hasChatGPTAccount(account)) {
            return;
          }
        }
        throw new Error(
          token.isCancellationRequested
            ? "ChatGPT/Codex sign-in was cancelled."
            : "Timed out waiting for ChatGPT/Codex sign-in.",
        );
      },
    );
  }

  private hasChatGPTAccount(value: unknown): boolean {
    if (!isRecord(value) || !isRecord(value.account)) {
      return false;
    }
    return (
      value.account.type === "chatgpt" ||
      value.account.type === "chatgptAuthTokens"
    );
  }

  private async validateOpenAIApiModels(
    apiKey: string,
    settings: OpenAIProviderSettings,
  ): Promise<void> {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "OpenAI rejected the stored API key. Run “ModelHop: Set OpenAI API Key”."
          : `OpenAI model validation failed with status ${response.status}.`,
      );
    }
    const body = await response.json();
    const data =
      isRecord(body) && Array.isArray(body.data) ? body.data : [];
    const available = new Set(
      data
        .filter(isRecord)
        .map((model) =>
          typeof model.id === "string" ? model.id : "",
        )
        .filter(Boolean),
    );
    const configured = new Set([
      settings.defaultModel,
      settings.opusModel,
      settings.sonnetModel,
      settings.haikuModel,
      settings.subagentModel,
    ]);
    const missing = [...configured].filter(
      (model) => !available.has(model),
    );
    if (missing.length > 0) {
      throw new Error(
        `The OpenAI API key cannot access: ${missing.join(", ")}. Run “ModelHop: Configure OpenAI API Models” and choose available models.`,
      );
    }
  }

  private async ensureDaemon(): Promise<void> {
    const health = await this.health();
    if (health?.version === BRIDGE_VERSION) {
      return;
    }
    if (health) {
      try {
        await this.control("/control/shutdown", {
          method: "POST",
          body: {},
          timeoutMs: 2_000,
        });
      } catch {
        // A stale bridge is replaced below.
      }
    }
    const daemonPath = path.join(
      this.context.extensionPath,
      "dist",
      "bridge-daemon.js",
    );
    const child = spawn(
      process.execPath,
      [
        daemonPath,
        "--port",
        String(this.port),
        "--state-dir",
        this.stateDirectory,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          MODELHOP_CONTROL_TOKEN: this.controlToken,
        },
      },
    );
    child.unref();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const ready = await this.health();
      if (ready?.version === BRIDGE_VERSION) {
        this.logger.info(
          `ModelHop bridge ready on 127.0.0.1:${this.port}`,
        );
        return;
      }
    }
    throw new Error(
      "The ModelHop compatibility bridge did not start. See the ModelHop output for details.",
    );
  }

  private async health(): Promise<BridgeHealth | undefined> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/health`, {
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) {
        return undefined;
      }
      const value = (await response.json()) as BridgeHealth;
      return value.name === "modelhop-bridge" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async control<T>(
    pathname: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const response = await fetch(`${this.getBaseUrl()}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        "x-modelhop-control": this.controlToken,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as Record<string, unknown>;
        detail =
          typeof body.error === "string"
            ? body.error
            : JSON.stringify(body.error ?? "");
      } catch {
        detail = "";
      }
      throw new Error(
        detail ||
          `ModelHop bridge request failed with status ${response.status}.`,
      );
    }
    return (await response.json()) as T;
  }
}
