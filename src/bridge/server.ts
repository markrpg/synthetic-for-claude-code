import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeActivitySnapshot,
  type BridgeConfiguration,
  type BridgeHealth,
} from "./types.js";
import type { AnthropicRequest } from "./anthropicOpenAITranslator.js";
import { BridgeRequestError, isContextWindowError } from "./bridgeError.js";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import {
  ContextManager,
  EncryptedContextStore,
} from "./contextManager.js";
import { OpenAIResponsesClient } from "./openAIResponsesClient.js";
import { EncryptedReasoningStore } from "./reasoningStore.js";
import { SyntheticMessagesClient } from "./syntheticMessagesClient.js";
import { estimateAnthropicRequestTokens } from "./tokenBudget.js";
import { UsageTracker } from "./usageTracker.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const IDLE_EXIT_MS = 24 * 60 * 60 * 1000;

interface Arguments {
  port: number;
  stateDirectory: string;
}

function parseArguments(argv: readonly string[]): Arguments {
  const portIndex = argv.indexOf("--port");
  const stateIndex = argv.indexOf("--state-dir");
  const port = Number(argv[portIndex + 1]);
  const stateDirectory = argv[stateIndex + 1];
  if (
    portIndex < 0 ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    stateIndex < 0 ||
    !stateDirectory
  ) {
    throw new Error("ModelHop bridge requires --port and --state-dir.");
  }
  return { port, stateDirectory };
}

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    let length = 0;
    request.on("data", (chunk: unknown) => {
      const buffer =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? new Uint8Array(chunk)
            : undefined;
      if (!buffer) {
        reject(new Error("Request contained an unsupported body chunk."));
        request.destroy();
        return;
      }
      length += buffer.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds ModelHop's 32 MB limit."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", resolve);
    request.once("error", reject);
  });
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function errorResponse(response: ServerResponse, error: unknown): void {
  const message =
    error instanceof Error ? error.message : "The ModelHop bridge failed.";
  const status =
    error instanceof BridgeRequestError ? error.status : 500;
  const type =
    error instanceof BridgeRequestError
      ? error.anthropicType
      : "api_error";
  json(response, status, {
    type: "error",
    error: {
      type,
      message,
      ...(error instanceof BridgeRequestError && error.code
        ? { code: error.code }
        : {}),
    },
  });
}

function bearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7);
  }
  const apiKey = request.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : undefined;
}

function anthropicSSE(responseBody: Record<string, unknown>): string[] {
  const frames: string[] = [];
  const content = Array.isArray(responseBody.content)
    ? responseBody.content
    : [];
  frames.push(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { ...responseBody, content: [], stop_reason: null },
    })}\n\n`,
  );
  content.forEach((block, index) => {
    if (typeof block !== "object" || block === null) {
      return;
    }
    const item = block as Record<string, unknown>;
    if (item.type === "text") {
      frames.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index,
          delta: {
            type: "text_delta",
            text: typeof item.text === "string" ? item.text : "",
          },
        })}\n\n`,
      );
    } else if (item.type === "tool_use") {
      frames.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: item.id,
            name: item.name,
            input: {},
          },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(item.input ?? {}),
          },
        })}\n\n`,
      );
    }
    frames.push(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index,
      })}\n\n`,
    );
  });
  frames.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: responseBody.stop_reason ?? "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens:
          typeof (responseBody.usage as Record<string, unknown> | undefined)
            ?.output_tokens === "number"
            ? (responseBody.usage as Record<string, unknown>).output_tokens
            : 0,
      },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({
      type: "message_stop",
    })}\n\n`,
  );
  return frames;
}

class BridgeServer {
  private configuration: BridgeConfiguration | undefined;
  private codex: CodexAppServerClient | undefined;
  private synthetic: SyntheticMessagesClient | undefined;
  private readonly usage = new UsageTracker();
  private lastActivity = Date.now();
  private activityUpdatedAt = Date.now();
  private readonly reasoningStore: EncryptedReasoningStore;
  private readonly contextStore: EncryptedContextStore;
  private readonly contextManager: ContextManager;
  private readonly activeRequests = new Map<
    string,
    BridgeActivitySnapshot
  >();

  public constructor(
    private readonly args: Arguments,
    private readonly controlToken: string,
  ) {
    this.reasoningStore = new EncryptedReasoningStore(
      path.join(args.stateDirectory, "encrypted-reasoning.json"),
      controlToken,
    );
    this.contextStore = new EncryptedContextStore(
      path.join(args.stateDirectory, "encrypted-context.json"),
      controlToken,
    );
    this.contextManager = new ContextManager(this.contextStore);
  }

  public async start(): Promise<void> {
    await mkdir(this.args.stateDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      this.reasoningStore.load(),
      this.contextStore.load(),
    ]);
    const server = createServer((request, response) => {
      this.lastActivity = Date.now();
      void this.handle(request, response);
    });
    server.listen(this.args.port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      void writeFile(
        path.join(this.args.stateDirectory, "daemon-state.json"),
        JSON.stringify({
          pid: process.pid,
          port: address.port,
          version: BRIDGE_PROTOCOL_VERSION,
          startedAt: Date.now(),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
    });
    setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_EXIT_MS) {
        server.close(() => process.exit(0));
      }
    }, 60_000).unref();
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      if (request.method === "GET" && url.pathname === "/health") {
        const health: BridgeHealth = {
          name: "modelhop-bridge",
          version: BRIDGE_PROTOCOL_VERSION,
          provider: this.configuration?.provider,
          ready: Boolean(this.configuration),
        };
        json(response, 200, health);
        return;
      }
      if (url.pathname.startsWith("/control/")) {
        if (
          !safeEqual(
            request.headers["x-modelhop-control"] as string | undefined,
            this.controlToken,
          )
        ) {
          json(response, 401, { error: "Unauthorized control request." });
          return;
        }
        await this.handleControl(url.pathname, request, response);
        return;
      }
      if (
        !this.configuration ||
        !safeEqual(bearer(request), this.configuration.bridgeAuthToken)
      ) {
        json(response, 401, {
          type: "error",
          error: {
            type: "authentication_error",
            message: "ModelHop bridge authentication failed.",
          },
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/messages/count_tokens"
      ) {
        const body = (await readJson(request)) as AnthropicRequest;
        const upstreamCount =
          this.configuration?.provider === "synthetic"
            ? await this.synthetic?.countTokens(body)
            : undefined;
        json(response, 200, {
          input_tokens:
            upstreamCount ?? estimateAnthropicRequestTokens(body),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        await this.handleMessages(
          (await readJson(request)) as AnthropicRequest,
          response,
          request,
        );
        return;
      }
      json(response, 404, {
        type: "error",
        error: { type: "not_found_error", message: "Unknown bridge route." },
      });
    } catch (error) {
      errorResponse(response, error);
    }
  }

  private async handleControl(
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "POST" && pathname === "/control/configure") {
      const configuration = (await readJson(request)) as BridgeConfiguration;
      if (!["synthetic", "openai-api", "openai-codex"].includes(
        configuration.provider,
      )) {
        throw new Error("Unsupported bridge provider.");
      }
      const previous = this.configuration;
      this.usage.setProvider(configuration.provider);
      if (configuration.provider === "synthetic") {
        this.codex?.dispose();
        this.codex = undefined;
        this.synthetic = new SyntheticMessagesClient(
          configuration.syntheticToken,
          configuration.syntheticSettings,
        );
      } else if (configuration.provider === "openai-codex") {
        this.synthetic = undefined;
        const canReuse =
          previous?.provider === "openai-codex" &&
          previous.codexExecutable === configuration.codexExecutable &&
          previous.codexWorkingDirectory ===
            configuration.codexWorkingDirectory &&
          this.codex !== undefined;
        if (!canReuse) {
          this.codex?.dispose();
          this.codex = new CodexAppServerClient(
            configuration.codexExecutable,
            configuration.codexWorkingDirectory,
          );
          await this.codex.start();
        }
      } else {
        this.codex?.dispose();
        this.codex = undefined;
        this.synthetic = undefined;
      }
      this.configuration = configuration;
      json(response, 200, { configured: true });
      return;
    }
    if (request.method === "POST" && pathname === "/control/shutdown") {
      json(response, 200, { shuttingDown: true });
      setTimeout(() => process.exit(0), 25).unref();
      return;
    }
    if (request.method === "GET" && pathname === "/control/usage") {
      if (this.configuration?.provider === "openai-codex" && this.codex) {
        const current = await this.codex.usage();
        this.usage.setCodex(current.rateLimits, current.usage);
      }
      json(response, 200, this.usage.snapshot());
      return;
    }
    if (request.method === "GET" && pathname === "/control/activity") {
      json(response, 200, this.activitySnapshot());
      return;
    }
    if (request.method === "GET" && pathname === "/control/codex/account") {
      json(response, 200, await this.requireCodex().account());
      return;
    }
    if (request.method === "GET" && pathname === "/control/codex/models") {
      json(response, 200, { data: await this.requireCodex().models() });
      return;
    }
    if (request.method === "POST" && pathname === "/control/codex/login") {
      json(response, 200, await this.requireCodex().startLogin());
      return;
    }
    if (request.method === "POST" && pathname === "/control/codex/logout") {
      await this.requireCodex().logout();
      json(response, 200, { loggedOut: true });
      return;
    }
    if (request.method === "POST" && pathname === "/control/codex/reset") {
      const body = (await readJson(request)) as Record<string, unknown>;
      json(
        response,
        200,
        await this.requireCodex().consumeReset(
          typeof body.idempotencyKey === "string"
            ? body.idempotencyKey
            : randomUUID(),
          typeof body.creditId === "string" ? body.creditId : undefined,
        ),
      );
      return;
    }
    json(response, 404, { error: "Unknown control route." });
  }

  private async handleMessages(
    request: AnthropicRequest,
    response: ServerResponse,
    incoming: IncomingMessage,
  ): Promise<void> {
    const configuration = this.configuration;
    if (!configuration) {
      json(response, 503, {
        type: "error",
        error: {
          type: "api_error",
          message: "ModelHop is starting. Retry the request.",
        },
      });
      return;
    }
    const abortController = new AbortController();
    const activityId = this.beginActivity();
    incoming.once("aborted", () => abortController.abort());
    response.once("close", () => {
      if (!response.writableEnded) {
        abortController.abort();
      }
    });
    const openAIClient =
      configuration.provider === "openai-api"
        ? new OpenAIResponsesClient(
        configuration.openAIApiKey,
        configuration.openAISettings,
        this.reasoningStore,
        this.usage,
        )
        : undefined;
    const liveCodexToolContinuation =
      configuration.provider === "openai-codex" &&
      this.hasToolResults(request);

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
        const contextWindow =
          configuration.provider === "synthetic"
            ? await this.requireSynthetic().contextWindow(request.model)
            : configuration.provider === "openai-codex"
              ? this.requireCodex().contextWindow(request.model)
              : undefined;
        const prepared = liveCodexToolContinuation
          ? request
          : (
              await this.contextManager.prepare(request, {
                settings: configuration.contextManagement,
                contextWindow,
                signal: abortController.signal,
                force: attempt === 1,
                tokenCounter:
                  configuration.provider === "synthetic"
                    ? (value, signal) =>
                        this.requireSynthetic().countTokens(
                          value,
                          signal,
                        )
                    : undefined,
                summarizer: (transcript, signal) => {
                  if (configuration.provider === "synthetic") {
                    return this.requireSynthetic().summarize(
                      transcript,
                      signal,
                    );
                  }
                  if (configuration.provider === "openai-api") {
                    return openAIClient!.summarize(transcript, signal);
                  }
                  return this.requireCodex().summarize(
                    transcript,
                    configuration.openAISettings,
                    signal,
                  );
                },
                onProgress: (progress) => {
                  this.updateActivity(activityId, {
                    phase:
                      progress.phase === "ready"
                        ? "requesting"
                        : progress.phase,
                    estimatedInputTokens:
                      progress.estimatedInputTokens,
                    contextWindow: progress.contextWindow,
                    threshold: progress.threshold,
                    compacted: progress.compacted,
                  });
                },
              })
            ).request;
        this.updateActivity(activityId, {
          phase: "requesting",
        });

          if (configuration.provider === "synthetic") {
          if (request.stream === true) {
            const upstream = await this.requireSynthetic().fetchStream(
              prepared,
              abortController.signal,
            );
            response.writeHead(200, {
              "Content-Type":
                upstream.headers.get("content-type") ??
                "text/event-stream",
              "Cache-Control": "no-cache, no-store",
              Connection: "keep-alive",
            });
            await this.pipeResponse(upstream, response);
          } else {
            json(
              response,
              200,
              await this.requireSynthetic().complete(
                prepared,
                abortController.signal,
              ),
            );
          }
          return;
        }

          if (configuration.provider === "openai-api") {
          if (request.stream === true) {
            const stream = openAIClient!.stream(
              prepared,
              abortController.signal,
            );
            const first = await stream.next();
            response.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-store",
              Connection: "keep-alive",
            });
            if (!first.done) {
              response.write(first.value);
            }
            for await (const frame of stream) {
              response.write(frame);
            }
            response.end();
          } else {
            json(
              response,
              200,
              await openAIClient!.complete(
                prepared,
                abortController.signal,
              ),
            );
          }
          return;
        }

          const result = await this.requireCodex().run(
          prepared,
          configuration.openAISettings,
          abortController.signal,
        );
          if (request.stream === true) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store",
            Connection: "keep-alive",
          });
          for (const frame of anthropicSSE(result)) {
            response.write(frame);
          }
          response.end();
          } else {
            json(response, 200, result);
          }
          return;
        } catch (error) {
          if (
            attempt === 0 &&
            !liveCodexToolContinuation &&
            !response.headersSent &&
            isContextWindowError(error)
          ) {
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.activeRequests.delete(activityId);
      this.activityUpdatedAt = Date.now();
    }
  }

  private beginActivity(): string {
    const id = randomUUID();
    const now = Date.now();
    this.activityUpdatedAt = now;
    this.activeRequests.set(id, {
      requestId: id,
      phase: "counting",
      activeRequests: this.activeRequests.size + 1,
      startedAt: now,
      updatedAt: now,
    });
    return id;
  }

  private updateActivity(
    id: string,
    update: Partial<
      Omit<
        BridgeActivitySnapshot,
        "requestId" | "activeRequests" | "startedAt" | "updatedAt"
      >
    >,
  ): void {
    const current = this.activeRequests.get(id);
    if (!current) {
      return;
    }
    const now = Date.now();
    this.activityUpdatedAt = now;
    this.activeRequests.set(id, {
      ...current,
      ...update,
      activeRequests: this.activeRequests.size,
      updatedAt: now,
    });
  }

  private activitySnapshot(): BridgeActivitySnapshot {
    const current = [...this.activeRequests.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    )[0];
    if (!current) {
      return {
        phase: "idle",
        activeRequests: 0,
        updatedAt: this.activityUpdatedAt,
      };
    }
    return {
      ...current,
      activeRequests: this.activeRequests.size,
    };
  }

  private requireCodex(): CodexAppServerClient {
    if (!this.codex) {
      throw new Error("The Codex bridge is not configured.");
    }
    return this.codex;
  }

  private requireSynthetic(): SyntheticMessagesClient {
    if (!this.synthetic) {
      throw new Error("The Synthetic bridge is not configured.");
    }
    return this.synthetic;
  }

  private hasToolResults(request: AnthropicRequest): boolean {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      return false;
    }
    const messages = request.messages as unknown[];
    const last: unknown = messages.at(-1);
    if (typeof last !== "object" || last === null) {
      return false;
    }
    const content = (last as Record<string, unknown>).content;
    return (
      Array.isArray(content) &&
      content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_result",
      )
    );
  }

  private async pipeResponse(
    upstream: Response,
    response: ServerResponse,
  ): Promise<void> {
    if (!upstream.body) {
      throw new BridgeRequestError(
        "Synthetic returned an empty streaming response.",
        502,
        "api_error",
      );
    }
    const reader = (
      upstream.body as unknown as {
        getReader(): {
          read(): Promise<{ done: boolean; value?: Uint8Array }>;
        };
      }
    ).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        response.write(value);
      }
    }
    response.end();
  }
}

const args = parseArguments(process.argv.slice(2));
const controlToken = process.env.MODELHOP_CONTROL_TOKEN;
if (!controlToken) {
  throw new Error("MODELHOP_CONTROL_TOKEN is required.");
}
void new BridgeServer(args, controlToken).start().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "ModelHop bridge failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
