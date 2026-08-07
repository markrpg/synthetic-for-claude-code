import { realpath } from "node:fs/promises";
import { discoverWorkspaceSessions } from "./sessionDiscovery.js";

interface VisibleClaudeSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  transcriptPath?: string;
}

interface VisibleClaudeSessionListOptions {
  dir: string;
  includeWorktrees: false;
  includeProgrammatic: false;
  limit: number;
  offset: number;
}

type SessionLister = (
  options: VisibleClaudeSessionListOptions,
) => Promise<VisibleClaudeSession[]>;

export const LEGACY_EXACT_SESSION_UI_CONFIRMATION_ERROR =
  "Claude Code created a panel but did not confirm that the exact remote conversation opened. ModelHop kept remote access and the recovery record active.";

export const EXACT_SESSION_UI_CONFIRMATION_ERROR =
  "Claude Code did not confirm that the attributed tab opened the exact remote conversation before the timeout. ModelHop kept remote access and the recovery record active.";

const localSessionLister: SessionLister = async (options) => {
  const sessions = await discoverWorkspaceSessions(options.dir);
  return sessions
    .filter((session) => session.visibleToClaudeIde)
    .slice(options.offset, options.offset + options.limit)
    .map((session) => ({
      sessionId: session.sessionId,
      summary: session.title,
      lastModified: session.modifiedAt,
      customTitle: session.customTitle,
      transcriptPath: session.transcriptPath,
    }));
};

export async function requireVisibleClaudeSession(
  sessionId: string,
  workspacePath: string,
  list?: SessionLister,
  expectedTranscriptPath?: string,
): Promise<VisibleClaudeSession> {
  // Keep this extension-host path independent from the Claude Agent SDK.
  // The SDK is bundled into the detached remote daemon, but bundling its
  // lazy session reader into a CommonJS VS Code extension can break its
  // internal ESM initialisation. Claude's IDE visibility rule is small and
  // deterministic, so sessionDiscovery mirrors it locally instead.
  const sessionLister = list ?? localSessionLister;
  const pageSize = 200;
  for (let offset = 0; offset < 5_000; offset += pageSize) {
    const sessions = await sessionLister({
      dir: workspacePath,
      includeWorktrees: false,
      includeProgrammatic: false,
      limit: pageSize,
      offset,
    });
    const target = sessions.find(
      (session) => session.sessionId === sessionId,
    );
    if (target) {
      if (expectedTranscriptPath && target.transcriptPath) {
        const [expected, discovered] = await Promise.all([
          realpath(expectedTranscriptPath),
          realpath(target.transcriptPath),
        ]);
        if (expected !== discovered) {
          throw new Error(
            "Claude Code resolved the requested session ID to a different transcript. ModelHop kept the recovery record instead of risking the wrong conversation.",
          );
        }
      }
      return target;
    }
    if (sessions.length < pageSize) {
      break;
    }
  }
  throw new Error(
    "The exact remote conversation is not visible to the Claude Code extension. ModelHop kept remote access active instead of opening a blank conversation.",
  );
}

export interface ExactClaudeSessionHost {
  activateClaudeExtension: () => Promise<boolean>;
  listCommands: () => Promise<readonly string[]>;
  executeCommand: (
    command: "claude-vscode.editor.open",
    sessionId: string,
  ) => Promise<unknown>;
  /**
   * Supplied only after the caller has independently verified that the
   * session ID resolves to the expected Claude-visible transcript. The
   * callback runs only after an attributed Claude tab visibly confirms that
   * exact conversation. Command acceptance alone is never confirmation.
   */
  onExactSessionCommandAccepted?: () => Promise<void>;
  confirmSessionOpen: (sessionId: string) => Promise<boolean>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export function claudeTabTitle(summary: string): string {
  const title = summary?.trim();
  if (!title || title === "Claude Code") {
    throw new Error(
      "The exact Claude conversation does not have a distinctive title, so ModelHop cannot safely distinguish it from a blank Claude Code panel.",
    );
  }
  return title.length > 25
    ? `${title.substring(0, 24)}…`
    : title;
}

export async function openExactClaudeSession(
  sessionId: string,
  host: ExactClaudeSessionHost,
  timeoutMs = 30_000,
): Promise<void> {
  if (!(await host.activateClaudeExtension())) {
    throw new Error(
      "The Claude Code extension is not installed or is unavailable in this editor.",
    );
  }
  const command = "claude-vscode.editor.open" as const;
  const now = host.now ?? Date.now;
  const wait =
    host.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, milliseconds),
      ));
  const deadline = now() + timeoutMs;
  do {
    if ((await host.listCommands()).includes(command)) {
      type CommandOutcome =
        | { kind: "accepted" }
        | { kind: "rejected"; error: unknown };
      const commandOutcome = Promise.resolve()
        .then(() => host.executeCommand(command, sessionId))
        .then<CommandOutcome, CommandOutcome>(
          () => ({ kind: "accepted" }),
          (error: unknown) => ({ kind: "rejected", error }),
        );
      let commandFailure: unknown;
      let commandSettled = false;

      // Claude's command can reject (or never settle) after it has already
      // created the requested panel. Poll the caller's attributed-tab proof
      // while the command is in flight instead of trusting its Promise as the
      // sole source of truth.
      for (;;) {
        const remaining = Math.max(0, deadline - now());
        const outcome = commandSettled
          ? (remaining > 0
              ? await wait(Math.min(200, remaining)).then(
                  () => ({ kind: "poll" }) as const,
                )
              : ({ kind: "poll" } as const))
          : await Promise.race([
              commandOutcome,
              (remaining > 0
                ? wait(Math.min(200, remaining))
                : Promise.resolve()
              ).then(() => ({ kind: "poll" }) as const),
        ]);
        if (outcome.kind === "accepted") {
          commandSettled = true;
        }
        if (await host.confirmSessionOpen(sessionId)) {
          await host.onExactSessionCommandAccepted?.();
          return;
        }
        if (outcome.kind === "rejected") {
          commandSettled = true;
          commandFailure = outcome.error;
        }
        if (now() >= deadline) {
          break;
        }
      }
      throw new Error(EXACT_SESSION_UI_CONFIRMATION_ERROR, {
        cause: commandFailure,
      });
    }
    await wait(200);
  } while (now() < deadline);
  throw new Error(
    "Claude Code did not register its exact-session open command. ModelHop kept the recovery record and did not open a blank conversation.",
  );
}
