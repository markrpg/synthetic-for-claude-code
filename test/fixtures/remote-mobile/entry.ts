import {
  mountRemoteApp,
  type MountedRemoteApp,
  type RemoteClock,
  type RemoteNotificationAdapter,
  type RemoteStateStore,
  type RemoteTransport,
  type RemoteUiStateSnapshot,
  type RemoteWebCommand,
} from "../../../src/remote/web/mobileApp.js";
import type {
  RemoteJournalEvent,
  RemoteProviderContext,
  RemoteSessionLease,
} from "../../../src/remote/types.js";
import {
  defaultFixtureScenario,
  FIXTURE_NOW,
  fixtureApproval,
  fixtureScenarioList,
  fixtureScenarios,
  type FixtureScenario,
} from "./scenarios.js";

declare const __MODELHOP_FIXTURE_BUILD__: boolean;

interface FixtureController {
  dispatch(action: string): void | Promise<void>;
  commands(): RemoteWebCommand[];
  state(): RemoteUiStateSnapshot | undefined;
}

declare global {
  interface Window {
    modelHopFixture?: FixtureController;
  }
}

if (!__MODELHOP_FIXTURE_BUILD__) {
  throw new Error(
    "The deterministic transport may only run in the fixture build.",
  );
}

const parameters = new URLSearchParams(location.search);
const scenario =
  fixtureScenarios.get(parameters.get("scenario") ?? "") ??
  defaultFixtureScenario;
const controlsVisible = parameters.get("controls") !== "0";
const fixedClock = createFixedClock(window);
let appController: MountedRemoteApp | undefined;
let nextEventId =
  Math.max(0, ...scenario.events.map((event) => event.id)) + 1;

class FixtureTransport implements RemoteTransport {
  readonly commands: RemoteWebCommand[] = [];
  private activeProvider: RemoteProviderContext;
  private handbackAttempts = 0;

  constructor(
    private readonly controller: () => MountedRemoteApp | undefined,
    private readonly clock: RemoteClock,
    private readonly scenario: FixtureScenario,
  ) {
    this.activeProvider = structuredClone(scenario.provider);
  }

  async send<T = unknown>(command: RemoteWebCommand): Promise<T> {
    this.commands.push(command);
    const response = await this.handle(command);
    return response as T;
  }

  private async handle(
    command: RemoteWebCommand,
  ): Promise<unknown> {
    const commandType = String(command.type);
    if (
      commandType === "session.handback.continue" ||
      commandType === "session.handback.cancel-request"
    ) {
      return { accepted: true };
    }
    const reasoningCommand = command as unknown as {
      type: string;
      thinkingEnabled?: boolean;
      effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      workflowsEnabled?: boolean;
      ultraEnabled?: boolean;
    };
    if (reasoningCommand.type === "reasoning.change") {
      const provider = this.activeProvider as RemoteProviderContext & {
        reasoning?: {
          thinkingSupported: boolean;
          thinkingEnabled: boolean;
          supportedEffortLevels: Array<
            "none" | "low" | "medium" | "high" | "xhigh" | "max"
          >;
          effectiveEffort?:
            | "none"
            | "low"
            | "medium"
            | "high"
            | "xhigh"
            | "max";
          workflows: {
            available: boolean;
            enabled: boolean;
            unavailableReason?: string;
          };
          ultra: {
            available: boolean;
            enabled: boolean;
            unavailableReason?: string;
          };
        };
      };
      if (!provider.reasoning) {
        throw new Error("The fixture model did not report reasoning metadata.");
      }
      const nextReasoning = structuredClone(provider.reasoning);
      if (reasoningCommand.thinkingEnabled !== undefined) {
        nextReasoning.thinkingEnabled = reasoningCommand.thinkingEnabled;
      }
      if (reasoningCommand.effort !== undefined) {
        nextReasoning.effectiveEffort = reasoningCommand.effort;
      }
      if (reasoningCommand.workflowsEnabled !== undefined) {
        nextReasoning.workflows.enabled =
          reasoningCommand.workflowsEnabled;
      }
      if (reasoningCommand.ultraEnabled !== undefined) {
        nextReasoning.ultra.enabled = reasoningCommand.ultraEnabled;
      }
      this.activeProvider = {
        ...provider,
        reasoningEffort:
          reasoningCommand.effort ?? provider.reasoningEffort,
        reasoning: nextReasoning,
        updatedAt: this.clock.now(),
      };
      this.controller()?.updateProvider(this.activeProvider);
      return { accepted: true, provider: this.activeProvider };
    }
    switch (command.type) {
      case "prompt.send":
        if (this.scenario.id === "prompt-failed") {
          throw Object.assign(
            new Error("The fixture transport rejected this prompt."),
            { authoritative: true },
          );
        }
        if (this.scenario.id === "delivery-unknown") {
          throw new Error(
            "The encrypted response was lost after the Mac accepted the command.",
          );
        }
        this.clock.setTimeout(() => {
          this.controller()?.applyEvent(
            event("activity.event", {
              id: `request-${command.id}`,
              category: "status",
              phase: "requesting",
              title: "Claude received your message",
              detail: "Preparing the model request.",
              createdAt: FIXTURE_NOW,
              updatedAt: FIXTURE_NOW,
            }),
          );
        }, 20);
        return { accepted: true, messageId: command.id };
      case "files.search": {
        const query = command.query?.toLowerCase() ?? "";
        return {
          files: fixtureFiles.filter((file) =>
            file.toLowerCase().includes(query),
          ),
        };
      }
      case "files.list":
        return fixtureDirectoryPage(
          command.rootId ?? "primary",
          command.path ?? "",
          command.cursor,
        );
      case "file.read":
        return fixtureFilePreview(command.path);
      case "file.reference.read": {
        const parsed = fixtureReference(command.reference);
        const preview = fixtureFilePreview(parsed.path);
        const secondary = parsed.path.startsWith("@ModelHopDocs/");
        return {
          ...preview,
          rootId: secondary ? "ModelHopDocs" : "primary",
          relativePath: secondary
            ? parsed.path.slice("@ModelHopDocs/".length)
            : parsed.path,
          line: parsed.line,
          endLine: parsed.endLine,
        };
      }
      case "symbols.search":
        return {
          symbols: [
            {
              name: "RemoteSessionLease",
              kind: "interface",
              path: "src/remote/types.ts",
              line: 44,
              preview:
                "export interface RemoteSessionLease {",
            },
          ],
        };
      case "git.status":
        return {
          content:
            " M src/remote/web/mobileApp.ts\n?? test/mobile/",
        };
      case "git.diff":
        return {
          content:
            "diff --git a/src/remote/web/mobileApp.ts b/src/remote/web/mobileApp.ts\n+// deterministic fixture",
        };
      case "attachment.upload":
        return {
          attachmentId: command.id,
          name: command.name,
        };
      case "permission.resolve":
        this.controller()?.applyEvent(
          event("permission.resolved", {
            requestId: command.requestId,
            decision: command.decision,
          }),
        );
        return { resolved: true };
      case "question.resolve":
        this.controller()?.applyEvent(
          event("question.resolved", {
            requestId: command.requestId,
          }),
        );
        return { resolved: true };
      case "turn.cancel":
        this.controller()?.applyEvent(
          event("activity.event", {
            id: "turn-cancelled",
            category: "lifecycle",
            phase: "complete",
            title: "Turn cancelled",
            createdAt: FIXTURE_NOW,
            updatedAt: FIXTURE_NOW,
          }),
        );
        return { cancelled: true };
      case "usage.refresh":
        return { refreshed: true };
      case "codex.reset":
        return { consumed: true };
      case "permission.mode.set":
        if (this.scenario.id === "permission-change-failed") {
          throw Object.assign(
            new Error("The Mac rejected the permission-mode change."),
            { authoritative: true },
          );
        }
        this.controller()?.updateLease({
          ...this.scenario.lease,
          permissionMode: command.mode,
        });
        this.controller()?.applyEvent(
          event("session.capabilities", {
            kind: "session.capabilities",
            model: this.activeProvider.model,
            permissionMode: command.mode,
            tools: [],
            commands: [],
            skills: [],
            protocolCapabilities: [],
            updatedAt: this.clock.now(),
          }),
        );
        return { changed: true, mode: command.mode };
      case "provider.change":
      case "model.change":
        return { accepted: true };
      case "session.handback":
        this.handbackAttempts += 1;
        if (
          this.scenario.id === "handback-delivery-unknown" &&
          this.handbackAttempts === 1
        ) {
          return {
            deliveryState: "unknown",
            message: "Checking the durable command receipt on the Mac.",
          };
        }
        return { accepted: true };
      case "session.terminal.ack":
        return { acknowledged: true };
    }
  }
}

class FixtureNotifications implements RemoteNotificationAdapter {
  private currentPermission: NotificationPermission = "default";
  readonly notifications = new Map<
    string,
    {
      title: string;
      body: string;
      onClick?: () => void;
    }
  >();

  supported(): boolean {
    return true;
  }

  permission(): NotificationPermission {
    return this.currentPermission;
  }

  async requestPermission(): Promise<NotificationPermission> {
    this.currentPermission = "granted";
    return this.currentPermission;
  }

  notify(input: {
    id: string;
    title: string;
    body: string;
    onClick?: () => void;
  }): void {
    this.notifications.set(input.id, input);
  }

  vibrate(): void {
    // Intentionally silent and deterministic in browser tests.
  }
}

class FixtureStateStore implements RemoteStateStore {
  private snapshot: RemoteUiStateSnapshot | undefined;

  read(): RemoteUiStateSnapshot | undefined {
    return this.snapshot === undefined
      ? undefined
      : structuredClone(this.snapshot);
  }

  write(snapshot: RemoteUiStateSnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }
}

function createFixedClock(view: Window): RemoteClock {
  return {
    now: () => FIXTURE_NOW,
    setTimeout: (callback, milliseconds) =>
      view.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => view.clearTimeout(handle),
    setInterval: (callback, milliseconds) =>
      view.setInterval(callback, milliseconds),
    clearInterval: (handle) => view.clearInterval(handle),
    requestAnimationFrame: (callback) =>
      view.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) =>
      view.cancelAnimationFrame(handle),
  };
}

async function dispatchFixtureAction(
  action: string,
  activeScenario: FixtureScenario,
): Promise<void> {
  if (!appController) {
    return;
  }
  switch (action) {
    case "legacy-control-and-tool": {
      appController.applyEvent(
        event("claude.message", {
          type: "user",
          uuid: "legacy-task-notification",
          origin: { kind: "task-notification" },
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "<task-notification><status>stopped</status></task-notification>",
              },
            ],
          },
        }),
      );
      appController.applyEvent(
        event("claude.message", {
          type: "user",
          uuid: "legacy-human-xml",
          origin: { kind: "human" },
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "<command-name> is the XML tag I am debugging",
              },
            ],
          },
        }),
      );
      appController.applyEvent(
        event("claude.message", {
          type: "assistant",
          uuid: "legacy-tool-message",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "legacy-read-one",
                name: "Read",
                input: { file_path: "src/remote/web/mobileApp.ts" },
              },
            ],
          },
        }),
      );
      appController.applyEvent(
        event("claude.message", {
          type: "user",
          uuid: "legacy-tool-result",
          parent_tool_use_id: "legacy-read-one",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "legacy-read-one",
                content: "read complete",
              },
            ],
          },
        }),
      );
      break;
    }
    case "stream-delta": {
      const id = "fixture-stream-message";
      appController.applyEvent(
        event("conversation.item", {
          kind: "conversation.item",
          operation: "upsert",
          item: {
            id,
            role: "assistant",
            status: "streaming",
            content: "",
            createdAt: FIXTURE_NOW,
            updatedAt: FIXTURE_NOW,
          },
        }),
      );
      appController.applyEvent(
        event("conversation.item", {
          kind: "conversation.item",
          operation: "delta",
          item: {
            id,
            role: "assistant",
            status: "streaming",
            content: "",
            createdAt: FIXTURE_NOW,
            updatedAt: FIXTURE_NOW,
          },
          delta: {
            kind: "text",
            text: "A new streamed update arrived without moving your reading position.",
          },
        }),
      );
      break;
    }
    case "provider-switch-complete": {
      const nextProvider = fixtureProvider("openai-codex");
      const nextLease: RemoteSessionLease = {
        ...activeScenario.lease,
        state: "running",
        turnPhase: "idle",
        provider: nextProvider,
        operation: undefined,
        providerChanged: true,
      };
      appController.updateLease(nextLease);
      appController.updateProvider(nextProvider);
      break;
    }
    case "turn-complete": {
      appController.updateLease({
        ...activeScenario.lease,
        state: "running",
        turnPhase: "complete",
        turnStartedAt: FIXTURE_NOW - 42_000,
        turnCompletedAt: FIXTURE_NOW - 17_000,
      });
      break;
    }
    case "handback-complete": {
      appController.applyBatch({
        events: [
          event("session.state", {
            ...activeScenario.lease,
            state: "handing-back",
            turnPhase: "handing-back",
          } satisfies RemoteSessionLease),
        ],
        lease: {
          ...activeScenario.lease,
          state: "stopped",
          turnPhase: "idle",
          operation: undefined,
        },
      });
      break;
    }
    case "late-handback-state": {
      appController.applyEvent(
        event("session.state", {
          ...activeScenario.lease,
          state: "handing-back",
          turnPhase: "handing-back",
        } satisfies RemoteSessionLease),
      );
      break;
    }
    case "cancel-handback-operation": {
      appController.updateLease({
        ...activeScenario.lease,
        state: "running",
        turnPhase: "idle",
        operation: undefined,
      });
      break;
    }
    case "complete-last-handback-command": {
      const command = [...transport.commands]
        .reverse()
        .find((candidate) => candidate.type === "session.handback");
      if (command) {
        appController.applyEvent(
          event("command.receipt", {
            commandId: command.id,
            requestHash: "fixture-handback-request",
            state: "completed",
            acceptedAt: FIXTURE_NOW - 500,
            updatedAt: FIXTURE_NOW,
          }),
        );
      }
      break;
    }
    case "terminal-notification": {
      appController.applyEvent(
        event("notification", {
          message: "The exact Claude conversation is open on your laptop.",
          terminal: true,
          ended: true,
        }),
      );
      break;
    }
    case "complete-after-stale-events": {
      const older = event("activity.event", {
        id: "stale-requesting-phase",
        category: "status",
        phase: "requesting",
        title: "Request sent",
        createdAt: FIXTURE_NOW - 2_000,
        updatedAt: FIXTURE_NOW - 2_000,
      });
      const newer = event("activity.event", {
        id: "stale-streaming-phase",
        category: "status",
        phase: "streaming",
        title: "Model response started",
        createdAt: FIXTURE_NOW - 1_000,
        updatedAt: FIXTURE_NOW - 1_000,
      });
      appController.applyBatch({
        lease: {
          ...activeScenario.lease,
          state: "paired",
          turnPhase: "complete",
          turnCompletedAt: FIXTURE_NOW,
        },
        provider: activeScenario.provider,
        // Deliberately reversed with a duplicate to model a reconnecting
        // transport replaying journal history around an authoritative lease.
        events: [newer, older, older],
        latestEventId: newer.id,
      });
      break;
    }
    case "replay-transient-notification": {
      const replayed = event("notification", {
        message: "Historical request sent",
      });
      appController.applyBatch({
        events: [replayed],
        replayThroughEventId: replayed.id,
      });
      break;
    }
    case "host-action-complete": {
      const actionId = "fixture-host-action";
      appController.applyBatch({
        events: [
          event("host.action", {
            id: actionId,
            type: "usage.refresh",
          }),
          event("host.action.state", {
            id: actionId,
            state: "complete",
            message: "Completed on your Mac.",
          }),
        ],
      });
      break;
    }
    case "duplicate-approval": {
      const source = activeScenario.events.find(
        (candidate) => candidate.type === "permission.request",
      );
      if (source) {
        appController.applyEvent({
          ...source,
          id: nextEventId++,
        });
      }
      break;
    }
    case "inject-approval":
      appController.applyEvent(
        event("permission.request", fixtureApproval),
      );
      break;
    case "hide-approval":
      document.getElementById("pending-permissions")!.hidden = true;
      break;
    case "notification-click":
      notifications.notifications
        .get(fixtureApproval.requestId)
        ?.onClick?.();
      break;
    case "open-files":
      document.getElementById("tab-files")?.click();
      break;
    case "enable-notifications":
      document.getElementById("tab-settings")?.click();
      document.getElementById("notification-button")?.click();
      break;
  }
}

function renderPairingScenario(
  activeScenario: FixtureScenario,
): void {
  const app = document.getElementById("app")!;
  const pairing = document.getElementById("pairing-view")!;
  const message = document.getElementById("pairing-message")!;
  const codeWrap = document.getElementById("pairing-code-wrap")!;
  const code = document.getElementById("pairing-code")!;
  app.hidden = true;
  pairing.hidden = false;

  if (activeScenario.presentation === "pairing-error") {
    message.textContent =
      "This private launch link has expired. Return to ModelHop on your laptop and create a new QR code.";
    codeWrap.hidden = true;
    return;
  }
  message.textContent =
    "PAIR 482 731 WITH IPHONE? Compare this code with your laptop.";
  code.textContent = "482 731";
  codeWrap.hidden = false;
}

function renderFixtureControls(
  activeScenario: FixtureScenario,
  visible: boolean,
): void {
  const target = document.getElementById("fixture-controls")!;
  target.hidden = !visible;
  if (!visible) {
    return;
  }
  const style = document.createElement("style");
  style.textContent = `
    #fixture-controls {
      position: fixed;
      z-index: 10000;
      inset: 8px 8px auto auto;
      display: grid;
      gap: 6px;
      max-width: min(280px, calc(100vw - 16px));
      padding: 8px;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 12px;
      background: rgba(12,15,17,.94);
      box-shadow: 0 8px 30px rgba(0,0,0,.4);
      color: #f4f5f5;
      font: 14px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #fixture-controls select,
    #fixture-controls button {
      min-height: 44px;
      font: inherit;
    }
  `;
  document.head.append(style);

  const label = document.createElement("label");
  label.textContent = "Fixture scenario";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Fixture scenario");
  for (const candidate of fixtureScenarioList()) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidate.label;
    option.selected = candidate.id === activeScenario.id;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const next = new URL(location.href);
    next.searchParams.set("scenario", select.value);
    location.assign(next);
  });
  const description = document.createElement("small");
  description.textContent = activeScenario.description;
  const stream = document.createElement("button");
  stream.type = "button";
  stream.textContent = "Inject streamed update";
  stream.addEventListener("click", () => {
    void dispatchFixtureAction("stream-delta", activeScenario);
  });
  label.append(select);
  target.append(label, description, stream);
}

function event(
  type: RemoteJournalEvent["type"],
  payload: unknown,
): RemoteJournalEvent {
  return {
    id: nextEventId++,
    type,
    payload,
    createdAt: FIXTURE_NOW,
  };
}

function fixtureProvider(
  providerId: RemoteProviderContext["provider"],
): RemoteProviderContext {
  if (providerId === "openai-codex") {
    return {
      provider: providerId,
      label: "OpenAI via Codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      roleModels: {
        default: "gpt-5.6-sol",
        opus: "gpt-5.6-sol",
        sonnet: "gpt-5.6-terra",
        haiku: "gpt-5.6-luna",
        subagent: "gpt-5.6-terra",
      },
      usage: {
        codex: {
          rateLimits: {
            primary: { usedPercent: 40 },
            secondary: { usedPercent: 14 },
            rateLimitResetCredits: {
              availableCount: 1,
              credits: [
                { id: "fixture-reset", status: "available" },
              ],
            },
          },
        },
      },
      updatedAt: FIXTURE_NOW,
    };
  }
  throw new Error(`Unsupported fixture provider: ${providerId}`);
}

const fixtureFiles = [
  "README.md",
  "preview.html",
  "src/extension.ts",
  "src/remote/types.ts",
  "src/remote/sessionController.ts",
  "src/remote/web/mobileApp.ts",
  "src/remote/web/styles.css",
  "test/mobile/layout.spec.ts",
  "test/mobile/conversation.spec.ts",
  "docs/release-notes-v2.3.0.md",
  "docs/modelhop-preview.png",
  "ModelHopDocs/remote-security.md",
];

interface FixtureDirectoryNode {
  rootId: string;
  name: string;
  path: string;
  displayPath: string;
  kind: "directory" | "file";
  extension?: string;
  size?: number;
  hasChildren: boolean;
}

const fixtureRoots = [
  { id: "primary", label: "ModelHop" },
  { id: "ModelHopDocs", label: "ModelHopDocs" },
];

function fixtureDirectoryPage(
  rootId: string,
  requestedPath: string,
  cursor?: string,
): {
  roots: typeof fixtureRoots;
  page: {
    root: { id: string; label: string };
    path: string;
    parentPath?: string;
    nodes: FixtureDirectoryNode[];
    totalEntries: number;
    omittedEntries: {
      protected: number;
      unavailable: number;
      unsupported: number;
    };
    nextCursor?: string;
  };
} {
  const root =
    fixtureRoots.find((candidate) => candidate.id === rootId) ??
    fixtureRoots[0]!;
  const path = requestedPath.replace(/^\/+|\/+$/gu, "");
  const prefix =
    root.id === "primary" ? "" : `@${root.label}/`;
  const allNodes = fixtureNodes(root.id, path, prefix);
  const offset =
    cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const fixturePageSize =
    path === "" && root.id === "primary" ? 3 : 50;
  const nodes = allNodes.slice(offset, offset + fixturePageSize);
  const nextOffset = offset + nodes.length;
  return {
    roots: fixtureRoots,
    page: {
      root,
      path,
      parentPath:
        path.length === 0
          ? undefined
          : path.split("/").slice(0, -1).join("/"),
      nodes,
      totalEntries: allNodes.length,
      omittedEntries: {
        protected: 0,
        unavailable: 0,
        unsupported: 0,
      },
      nextCursor:
        nextOffset < allNodes.length
          ? String(nextOffset)
          : undefined,
    },
  };
}

function fixtureNodes(
  rootId: string,
  path: string,
  prefix: string,
): FixtureDirectoryNode[] {
  const directoryMap: Record<
    string,
    Array<{
      name: string;
      kind: "directory" | "file";
      size?: number;
    }>
  > =
    rootId === "primary"
      ? {
          "": [
            { name: "src", kind: "directory" },
            { name: "test", kind: "directory" },
            { name: "README.md", kind: "file", size: 8_192 },
            { name: "preview.html", kind: "file", size: 1_240 },
            { name: "docs", kind: "directory" },
            { name: "package.json", kind: "file", size: 14_820 },
            { name: "CHANGELOG.md", kind: "file", size: 9_400 },
            { name: "LICENSE", kind: "file", size: 1_100 },
            { name: "tsconfig.json", kind: "file", size: 960 },
          ],
          src: [
            { name: "remote", kind: "directory" },
            { name: "extension.ts", kind: "file", size: 12_000 },
          ],
          "src/remote": [
            { name: "web", kind: "directory" },
            { name: "sessionController.ts", kind: "file", size: 31_200 },
            { name: "types.ts", kind: "file", size: 18_400 },
          ],
          "src/remote/web": [
            { name: "mobileApp.ts", kind: "file", size: 84_000 },
            { name: "styles.css", kind: "file", size: 37_000 },
          ],
          test: [{ name: "mobile", kind: "directory" }],
          "test/mobile": [
            { name: "layout.spec.ts", kind: "file", size: 4_800 },
            {
              name: "conversation.spec.ts",
              kind: "file",
              size: 7_200,
            },
          ],
          docs: [
            {
              name: "modelhop-preview.png",
              kind: "file",
              size: 68,
            },
            {
              name: "release-notes-v2.3.0.md",
              kind: "file",
              size: 6_400,
            },
          ],
        }
      : {
          "": [
            {
              name: "remote-security.md",
              kind: "file",
              size: 5_200,
            },
            { name: "guides", kind: "directory" },
          ],
          guides: [
            {
              name: "continue-on-phone.md",
              kind: "file",
              size: 4_200,
            },
          ],
        };
  return (directoryMap[path] ?? []).map((entry) => {
    const nodePath = [path, entry.name].filter(Boolean).join("/");
    const extension =
      entry.kind === "file"
        ? entry.name.split(".").at(-1)
        : undefined;
    return {
      rootId,
      name: entry.name,
      path: nodePath,
      displayPath: `${prefix}${nodePath}`,
      kind: entry.kind,
      extension,
      size: entry.size,
      hasChildren: entry.kind === "directory",
    };
  });
}

function fixtureFileContent(path: string): string {
  if (path.endsWith(".html")) {
    return [
      "<!doctype html>",
      '<html><head><meta http-equiv="refresh" content="0; url=https://example.com">',
      '<link rel="stylesheet" href="https://example.com/remote.css">',
      "<style>body{font:16px system-ui;padding:24px;background:#f4f1ea;color:#151719}button{padding:12px 16px}</style>",
      "</head><body>",
      '<main><h1 id="preview-title">ModelHop live preview</h1>',
      '<p>Self-contained HTML can be reviewed on the phone.</p>',
      '<button id="preview-action">Try interaction</button>',
      '<img src="https://example.com/tracker.png" alt="Blocked remote image">',
      "</main>",
      '<script>(async()=>{const root=document.documentElement;root.dataset.scriptReady="true";try{void parent.document;root.dataset.parentAccess="allowed";}catch{root.dataset.parentAccess="blocked";}root.dataset.popupBlocked=String(window.open("https:"+"//example.com/popup")===null);try{await fetch("https:"+"//example.com/runtime");root.dataset.networkBlocked="false";}catch{root.dataset.networkBlocked="true";}document.querySelector("#preview-action")?.addEventListener("click",()=>{document.querySelector("#preview-title").textContent="Interaction works";});})();</script>',
      "</body></html>",
    ].join("\n");
  }
  if (path.endsWith(".md")) {
    return [
      "# ModelHop Remote",
      "",
      "The phone receives encrypted session events. Provider credentials stay on the Mac.",
    ].join("\n");
  }
  if (path.endsWith(".json")) {
    return JSON.stringify(
      { fixture: true, deterministic: true },
      null,
      2,
    );
  }
  return [
    'import type { RemoteSessionLease } from "./types.js";',
    "",
    "export interface RemoteRecoveryState {",
    "  lease: RemoteSessionLease;",
    "  transcriptSignature: string;",
    "}",
    "",
    "export function canRecover(state: RemoteRecoveryState): boolean {",
    "  return Boolean(state.lease.activeSessionId);",
    "}",
  ].join("\n");
}

function fixtureReference(reference: string): {
  path: string;
  line?: number;
  endLine?: number;
} {
  const match = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?)?$/u.exec(reference);
  return {
    path: match?.[1] ?? reference,
    line: match?.[2] ? Number(match[2]) : undefined,
    endLine: match?.[3] ? Number(match[3]) : undefined,
  };
}

function fixtureFilePreview(path: string): {
  path: string;
  content: string;
  size: number;
  language: string;
  mediaType?: string;
  encoding: "utf8" | "base64";
} {
  if (path.endsWith(".png")) {
    return {
      path,
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      size: 68,
      language: "image",
      mediaType: "image/png",
      encoding: "base64",
    };
  }
  const content = fixtureFileContent(path);
  return {
    path,
    content,
    size: new TextEncoder().encode(content).byteLength,
    language: path.endsWith(".md")
      ? "markdown"
      : path.endsWith(".html")
        ? "html"
      : path.endsWith(".json")
        ? "json"
        : "typescript",
    encoding: "utf8",
  };
}

const notifications = new FixtureNotifications();
const stateStore = new FixtureStateStore();
const transport = new FixtureTransport(
  () => appController,
  fixedClock,
  scenario,
);

renderFixtureControls(scenario, controlsVisible);

if (
  scenario.presentation === "pairing" ||
  scenario.presentation === "pairing-error"
) {
  renderPairingScenario(scenario);
} else {
  document.getElementById("pairing-view")!.hidden = true;
  appController = mountRemoteApp({
    document,
    transport,
    clock: fixedClock,
    notifications,
    stateStore,
  });
  appController.applyBatch({
    lease: scenario.lease,
    provider: scenario.provider,
    events: scenario.events,
    latestEventId: nextEventId - 1,
    ...scenario.batch,
  });
  const fixtureTransportState = String(
    (
      scenario.lease as unknown as {
        transport?: { state?: string };
      }
    ).transport?.state ?? "",
  );
  appController.setConnection(
    scenario.id === "reconnecting"
      ? "reconnecting"
      : fixtureTransportState === "link-lost"
        ? "link-lost"
        : fixtureTransportState === "expired"
          ? "expired"
          : fixtureTransportState === "revoked"
            ? "revoked"
            : "secure",
    undefined,
  );
  if (scenario.id === "attachments") {
    document.getElementById("attachment-button")?.click();
  } else if (scenario.id === "git-changes") {
    document.getElementById("tab-activity")?.click();
  } else if (scenario.id === "multi-root-files") {
    document.getElementById("tab-files")?.click();
  }
}

window.modelHopFixture = {
  dispatch: async (action) => {
    await dispatchFixtureAction(action, scenario);
  },
  commands: () => [...transport.commands],
  state: () => stateStore.read(),
};
document.documentElement.dataset.modelhopFixture = "ready";
document.getElementById("fixture-status")!.textContent =
  `Fixture ready: ${scenario.label}`;
