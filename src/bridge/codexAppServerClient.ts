import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { OpenAIProviderSettings } from "../providers/types.js";
import {
  systemToText,
  translateAnthropicMessages,
  type AnthropicRequest,
} from "./anthropicOpenAITranslator.js";
import {
  buildToolNameMapping,
  toAnthropicToolId,
  type ToolNameMapping,
} from "./toolMapping.js";
import type { BridgeModel } from "./types.js";

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface CodexToolCall {
  rpcId: string | number;
  callId: string;
  anthropicId: string;
  name: string;
  arguments: unknown;
}

interface CodexPhase {
  text: string;
  toolCalls: CodexToolCall[];
  completed: boolean;
  usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function contentBlocks(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function lastUserInput(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ type: "text", text: "Continue." }];
  }
  const last = record(messages.at(-1));
  const result: Array<Record<string, unknown>> = [];
  for (const block of contentBlocks(last.content)) {
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
    } else if (block.type === "image" && isRecord(block.source)) {
      const mediaType =
        typeof block.source.media_type === "string"
          ? block.source.media_type
          : undefined;
      const data =
        typeof block.source.data === "string"
          ? block.source.data
          : undefined;
      if (mediaType && data) {
        result.push({
          type: "image",
          url: `data:${mediaType};base64,${data}`,
        });
      }
    }
  }
  return result.length > 0
    ? result
    : [{ type: "text", text: "Continue from the supplied history." }];
}

function previousMessages(messages: unknown): unknown[] {
  return Array.isArray(messages) ? messages.slice(0, -1) : [];
}

function dynamicTools(
  tools: unknown,
  names: ToolNameMapping,
): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.filter(isRecord).map((tool) => {
    const original =
      typeof tool.name === "string" ? tool.name : "tool";
    return {
      type: "function",
      name: names.toOpenAI.get(original) ?? original,
      description:
        typeof tool.description === "string" ? tool.description : "",
      inputSchema: isRecord(tool.input_schema)
        ? tool.input_schema
        : { type: "object", additionalProperties: true },
    };
  });
}

function toolResults(
  messages: unknown,
): Array<{ id: string; contentItems: Array<Record<string, unknown>>; success: boolean }> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const last = record(messages.at(-1));
  return contentBlocks(last.content)
    .filter((block) => block.type === "tool_result")
    .map((block) => {
      const contentItems: Array<Record<string, unknown>> = [];
      const content = block.content;
      const blocks = contentBlocks(content);
      for (const item of blocks) {
        if (item.type === "text" && typeof item.text === "string") {
          contentItems.push({ type: "inputText", text: item.text });
        } else if (item.type === "image" && isRecord(item.source)) {
          const mediaType =
            typeof item.source.media_type === "string"
              ? item.source.media_type
              : undefined;
          const data =
            typeof item.source.data === "string"
              ? item.source.data
              : undefined;
          if (mediaType && data) {
            contentItems.push({
              type: "inputImage",
              imageUrl: `data:${mediaType};base64,${data}`,
            });
          }
        }
      }
      if (contentItems.length === 0) {
        contentItems.push({
          type: "inputText",
          text:
            typeof content === "string"
              ? content
              : JSON.stringify(content ?? ""),
        });
      }
      return {
        id:
          typeof block.tool_use_id === "string"
            ? block.tool_use_id
            : "",
        contentItems,
        success: block.is_error !== true,
      };
    });
}

class CodexSession {
  public readonly calls = new Map<string, CodexToolCall>();
  private text = "";
  private phaseCalls: CodexToolCall[] = [];
  private completed = false;
  private usage: unknown;
  private waiter:
    | {
        resolve(value: CodexPhase): void;
        reject(error: Error): void;
      }
    | undefined;
  private toolTimer: NodeJS.Timeout | undefined;

  public constructor(
    public readonly threadId: string,
    public readonly model: string,
    public readonly names: ToolNameMapping,
    public turnId?: string,
  ) {}

  public appendText(delta: string): void {
    this.text += delta;
  }

  public addToolCall(call: CodexToolCall): void {
    this.calls.set(call.anthropicId, call);
    this.phaseCalls.push(call);
    if (this.toolTimer) {
      clearTimeout(this.toolTimer);
    }
    this.toolTimer = setTimeout(() => {
      this.resolvePhase();
    }, 60);
  }

  public finish(usage: unknown): void {
    this.completed = true;
    this.usage = usage;
    this.resolvePhase();
  }

  public fail(error: Error): void {
    this.waiter?.reject(error);
    this.waiter = undefined;
  }

  public waitForPhase(): Promise<CodexPhase> {
    if (this.completed || this.phaseCalls.length > 0) {
      return Promise.resolve(this.takePhase());
    }
    return new Promise<CodexPhase>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private resolvePhase(): void {
    if (!this.waiter) {
      return;
    }
    this.waiter.resolve(this.takePhase());
    this.waiter = undefined;
  }

  private takePhase(): CodexPhase {
    if (this.toolTimer) {
      clearTimeout(this.toolTimer);
      this.toolTimer = undefined;
    }
    const phase: CodexPhase = {
      text: this.text,
      toolCalls: this.phaseCalls,
      completed: this.completed,
      usage: this.usage,
    };
    this.text = "";
    this.phaseCalls = [];
    return phase;
  }
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly sessions = new Map<string, CodexSession>();
  private readonly toolCallSessions = new Map<string, CodexSession>();

  public constructor(
    private readonly executable: string,
    private readonly cwd: string,
  ) {}

  public async start(): Promise<void> {
    if (this.process && !this.process.killed) {
      return;
    }
    const codexHome = path.join(this.cwd, ".modelhop-codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
    };
    delete childEnvironment.OPENAI_API_KEY;
    delete childEnvironment.ANTHROPIC_API_KEY;
    delete childEnvironment.ANTHROPIC_AUTH_TOKEN;
    this.process = spawn(
      this.executable,
      [
        "-c",
        "forced_login_method=\"chatgpt\"",
        "-c",
        "cli_auth_credentials_store=\"file\"",
        "-c",
        "history.persistence=\"none\"",
        "-c",
        "mcp_servers={}",
        "-c",
        "agents.enabled=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.remote_plugin=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.hooks=false",
        "-c",
        "features.memories=false",
        "-c",
        "features.personality=false",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "web_search=\"disabled\"",
        "-c",
        "tools.view_image=false",
        "app-server",
      ],
      {
        cwd: this.cwd,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    this.process.stderr.resume();
    this.process.once("exit", (code) => {
      const error = new Error(
        `Codex app-server exited unexpectedly${code === null ? "" : ` (${code})`}.`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const session of this.sessions.values()) {
        session.fail(error);
      }
      this.sessions.clear();
      this.toolCallSessions.clear();
      this.process = undefined;
    });
    await this.request("initialize", {
      clientInfo: {
        name: "modelhop",
        title: "ModelHop for Claude Code",
        version: "2.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  public async account(): Promise<unknown> {
    await this.start();
    return this.request("account/read", { refreshToken: false });
  }

  public async logout(): Promise<void> {
    await this.start();
    await this.request("account/logout");
  }

  public async startLogin(): Promise<unknown> {
    await this.start();
    return this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "chatgpt",
    });
  }

  public async models(): Promise<BridgeModel[]> {
    await this.start();
    const response = record(
      await this.request("model/list", {
        limit: 100,
        includeHidden: false,
      }),
    );
    const data = Array.isArray(response.data) ? response.data : [];
    return data.filter(isRecord).map((model) => ({
      id: typeof model.id === "string" ? model.id : "unknown",
      displayName:
        typeof model.displayName === "string"
          ? model.displayName
          : typeof model.id === "string"
            ? model.id
            : "Unknown model",
      description:
        typeof model.description === "string" ? model.description : "",
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
            .filter(isRecord)
            .map((effort) =>
              typeof effort.reasoningEffort === "string"
                ? effort.reasoningEffort
                : "",
            )
            .filter(Boolean)
        : [],
      isDefault: model.isDefault === true,
    }));
  }

  public async usage(): Promise<{
    rateLimits: unknown;
    usage: unknown;
  }> {
    await this.start();
    const [rateLimits, usage] = await Promise.all([
      this.request("account/rateLimits/read"),
      this.request("account/usage/read").catch(() => undefined),
    ]);
    return { rateLimits, usage };
  }

  public async consumeReset(
    idempotencyKey: string,
    creditId?: string,
  ): Promise<unknown> {
    await this.start();
    return this.request("account/rateLimitResetCredit/consume", {
      idempotencyKey,
      ...(creditId ? { creditId } : {}),
    });
  }

  public async run(
    request: AnthropicRequest,
    settings: OpenAIProviderSettings,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.start();
    const results = toolResults(request.messages);
    if (results.length > 0) {
      return this.continueWithToolResults(results, signal);
    }

    const toolRecords = Array.isArray(request.tools)
      ? request.tools.filter(isRecord)
      : [];
    const names = buildToolNameMapping(
      toolRecords.map((tool) =>
        typeof tool.name === "string" ? tool.name : "tool",
      ),
    );
    const model =
      typeof request.model === "string" && request.model.trim()
        ? request.model
        : settings.defaultModel;
    const start = record(
      await this.request("thread/start", {
        model,
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "readOnly",
        personality: "none",
        ephemeral: true,
        allowProviderModelFallback: false,
        baseInstructions:
          "You are the model backend for Claude Code. Follow the supplied developer and user instructions. Use only the dynamic tools supplied by the client. Never claim a tool ran unless the client returned its result.",
        developerInstructions: systemToText(request.system),
        serviceName: "modelhop_claude_code",
        dynamicTools: dynamicTools(request.tools, names),
      }),
    );
    const thread = record(start.thread);
    const threadId =
      typeof thread.id === "string" ? thread.id : undefined;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread ID.");
    }
    const session = new CodexSession(threadId, model, names);
    this.sessions.set(threadId, session);
    const history = translateAnthropicMessages(
      previousMessages(request.messages),
      names,
    );
    if (history.length > 0) {
      await this.request("thread/inject_items", {
        threadId,
        items: history,
      });
    }
    const turnStart = record(await this.request("turn/start", {
      threadId,
      input: lastUserInput(request.messages),
      model,
    }));
    const turn = record(turnStart.turn);
    session.turnId =
      typeof turn.id === "string"
        ? turn.id
        : typeof turnStart.turnId === "string"
          ? turnStart.turnId
          : undefined;
    return this.waitForPhase(session, signal);
  }

  public dispose(): void {
    this.process?.kill();
    this.process = undefined;
  }

  private async continueWithToolResults(
    results: Array<{
      id: string;
      contentItems: Array<Record<string, unknown>>;
      success: boolean;
    }>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const sessions = new Set(
      results
        .map((result) => this.toolCallSessions.get(result.id))
        .filter((session): session is CodexSession => Boolean(session)),
    );
    if (sessions.size !== 1) {
      throw new Error(
        "The Codex tool continuation could not be matched to its pending turn.",
      );
    }
    const session = [...sessions][0];
    if (!session) {
      throw new Error("The Codex tool continuation is missing.");
    }
    for (const result of results) {
      const call = session.calls.get(result.id);
      if (!call) {
        throw new Error(`Unknown Codex tool call: ${result.id}`);
      }
      this.respond(call.rpcId, {
        contentItems: result.contentItems,
        success: result.success,
      });
      session.calls.delete(result.id);
      this.toolCallSessions.delete(result.id);
    }
    return this.waitForPhase(session, signal);
  }

  private phaseToAnthropic(
    phase: CodexPhase,
    session: CodexSession,
  ): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = [];
    if (phase.text) {
      content.push({ type: "text", text: phase.text });
    }
    for (const call of phase.toolCalls) {
      this.toolCallSessions.set(call.anthropicId, session);
      content.push({
        type: "tool_use",
        id: call.anthropicId,
        name: call.name,
        input: call.arguments,
      });
    }
    if (phase.completed) {
      this.sessions.delete(session.threadId);
    }
    const usageRecord = record(phase.usage);
    return {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model: session.model,
      content,
      stop_reason: phase.toolCalls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens:
          typeof usageRecord.inputTokens === "number"
            ? usageRecord.inputTokens
            : 0,
        output_tokens:
          typeof usageRecord.outputTokens === "number"
            ? usageRecord.outputTokens
            : 0,
      },
    };
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (
      message.id !== undefined &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const id =
        typeof message.id === "string" || typeof message.id === "number"
          ? message.id
          : undefined;
      if (id === undefined) {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(`Codex app-server error: ${JSON.stringify(message.error)}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "item/tool/call" && message.id !== undefined) {
      this.handleToolCall(message);
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleToolCall(message: JsonRpcMessage): void {
    const params = record(message.params);
    const threadId =
      typeof params.threadId === "string" ? params.threadId : "";
    const session = this.sessions.get(threadId);
    const rpcId =
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : undefined;
    if (!session || rpcId === undefined) {
      if (rpcId !== undefined) {
        this.respond(rpcId, {
          contentItems: [
            {
              type: "inputText",
              text: "ModelHop could not match this tool call to a Claude turn.",
            },
          ],
          success: false,
        });
      }
      return;
    }
    const callId =
      typeof params.callId === "string"
        ? params.callId
        : `call_${rpcId}`;
    const openAIName =
      typeof params.tool === "string" ? params.tool : "tool";
    const call: CodexToolCall = {
      rpcId,
      callId,
      anthropicId: toAnthropicToolId(callId),
      name: session.names.fromOpenAI.get(openAIName) ?? openAIName,
      arguments: params.arguments ?? {},
    };
    if (
      session.calls.has(call.anthropicId) ||
      this.toolCallSessions.has(call.anthropicId)
    ) {
      this.respond(rpcId, {
        contentItems: [
          {
            type: "inputText",
            text: "ModelHop suppressed a duplicate Claude tool call.",
          },
        ],
        success: false,
      });
      return;
    }
    session.addToolCall(call);
  }

  private handleNotification(method: string, paramsValue: unknown): void {
    const params = record(paramsValue);
    const threadId =
      typeof params.threadId === "string" ? params.threadId : "";
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    if (
      method === "item/agentMessage/delta" &&
      typeof params.delta === "string"
    ) {
      session.appendText(params.delta);
    } else if (method === "turn/completed") {
      const turn = record(params.turn);
      if (turn.status === "failed") {
        session.fail(
          new Error(
            `Codex turn failed: ${JSON.stringify(turn.error ?? "unknown error")}`,
          ),
        );
      } else {
        session.finish(turn.usage);
      }
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const process = this.process;
    if (!process?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    process.stdin.write(
      `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    this.process?.stdin.write(
      `${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`,
    );
  }

  private respond(id: string | number, result: unknown): void {
    this.process?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private async waitForPhase(
    session: CodexSession,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const abort = (): void => {
      void this.interrupt(session);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    try {
      return this.phaseToAnthropic(await session.waitForPhase(), session);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async interrupt(session: CodexSession): Promise<void> {
    if (!session.turnId) {
      return;
    }
    await this.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.turnId,
    }).catch(() => undefined);
  }
}
