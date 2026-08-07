import {
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { claudeProjectDirectoryName } from "../transcripts/claudeTranscriptRepairService.js";
import {
  classifyTranscriptFrame,
  isHumanTranscriptNarrativeFrame,
  isTranscriptControlEnvelopeText,
  isVisibleTranscriptFrame,
  transcriptTextFromContent,
} from "./transcriptFrameClassifier.js";

const SLICE_BYTES = 192 * 1024;
const HISTORY_SLICE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PREVIEW_OPERATION_ROWS = 24;

function takeLastIndexes(
  indexes: readonly number[],
  limit: number,
): number[] {
  return limit === 0 ? [] : indexes.slice(-limit);
}

export interface ClaudeWorkspaceSession {
  sessionId: string;
  transcriptPath: string;
  workspacePath: string;
  title: string;
  customTitle?: string;
  model?: string;
  visibleToClaudeIde: boolean;
  modifiedAt: number;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseLines(source: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) {
        rows.push(value);
      }
    } catch {
      // Slices can begin or end in the middle of a JSONL row.
    }
  }
  return rows;
}

function assistantMessageId(
  row: Record<string, unknown>,
): string | undefined {
  return row.type === "assistant" &&
    isRecord(row.message) &&
    typeof row.message.id === "string"
    ? row.message.id
    : undefined;
}

function mergeAssistantTranscriptRows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];
  for (const row of rows) {
    const messageId = assistantMessageId(row);
    const previous = merged.at(-1);
    const previousMessage = isRecord(previous?.message)
      ? previous.message
      : undefined;
    const rowMessage = isRecord(row.message)
      ? row.message
      : undefined;
    const previousContent: unknown[] | undefined = Array.isArray(
      previousMessage?.content,
    )
      ? previousMessage.content
      : undefined;
    const rowContent: unknown[] | undefined = Array.isArray(
      rowMessage?.content,
    )
      ? rowMessage.content
      : undefined;
    if (
      !messageId ||
      !previous ||
      assistantMessageId(previous) !== messageId ||
      !previousMessage ||
      !rowMessage ||
      !previousContent ||
      !rowContent
    ) {
      merged.push(row);
      continue;
    }
    merged[merged.length - 1] = {
      ...previous,
      message: {
        ...previousMessage,
        ...rowMessage,
        content: [...previousContent, ...rowContent],
      },
    };
  }
  return merged;
}

function latestTextMetadata(
  rows: readonly Record<string, unknown>[],
  key: "customTitle" | "aiTitle" | "lastPrompt" | "summary",
): string | undefined {
  for (const row of [...rows].reverse()) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ");
      if (
        key !== "customTitle" &&
        isTranscriptControlEnvelopeText(text)
      ) {
        continue;
      }
      if (
        key === "lastPrompt" &&
        row.type === "user" &&
        !isHumanTranscriptNarrativeFrame(row)
      ) {
        continue;
      }
      return text.slice(0, 100);
    }
  }
  return undefined;
}

function sessionTitle(
  headRows: readonly Record<string, unknown>[],
  tailRows: readonly Record<string, unknown>[],
): { title: string; customTitle?: string } {
  const rows = [...headRows, ...tailRows];
  const customTitle = latestTextMetadata(rows, "customTitle");
  const generatedTitle = latestTextMetadata(rows, "aiTitle");
  const lastPrompt = latestTextMetadata(rows, "lastPrompt");
  const summary = latestTextMetadata(rows, "summary");
  if (customTitle) {
    return { title: customTitle, customTitle };
  }
  if (generatedTitle ?? lastPrompt ?? summary) {
    return {
      title: (generatedTitle ?? lastPrompt ?? summary) as string,
    };
  }
  for (const row of rows) {
    if (!isHumanTranscriptNarrativeFrame(row) || !isRecord(row.message)) {
      continue;
    }
    const text = transcriptTextFromContent(row.message.content);
    if (text) {
      return {
        title: text.replace(/\s+/g, " ").slice(0, 100),
      };
    }
  }
  return { title: "Untitled Claude Code conversation" };
}

const PROGRAMMATIC_ENTRYPOINTS = new Set([
  "sdk-cli",
  "sdk-ts",
  "sdk-py",
]);

function visibleToClaudeIde(
  headRows: readonly Record<string, unknown>[],
  tailRows: readonly Record<string, unknown>[],
): boolean {
  const firstHeadEntrypoint = headRows.find(
    (row) => typeof row.entrypoint === "string",
  )?.entrypoint;
  const lastTailEntrypoint = [...tailRows]
    .reverse()
    .find((row) => typeof row.entrypoint === "string")?.entrypoint;
  const entrypoint = firstHeadEntrypoint ?? lastTailEntrypoint;
  if (
    typeof entrypoint === "string" &&
    PROGRAMMATIC_ENTRYPOINTS.has(entrypoint)
  ) {
    return false;
  }
  const sessionKindRow =
    headRows.find((row) => Object.hasOwn(row, "parentUuid")) ??
    headRows.find((row) => Object.hasOwn(row, "sessionKind"));
  return (
    sessionKindRow?.sessionKind !== "daemon" &&
    sessionKindRow?.sessionKind !== "daemon-worker"
  );
}

function latestModel(
  rows: readonly Record<string, unknown>[],
): string | undefined {
  for (const row of [...rows].reverse()) {
    if (
      isRecord(row.message) &&
      typeof row.message.model === "string"
    ) {
      return row.message.model;
    }
  }
  return undefined;
}

async function readTranscriptSlices(
  transcriptPath: string,
  size: number,
): Promise<{ head: string; tail: string }> {
  const handle = await open(transcriptPath, "r");
  try {
    const headSize = Math.min(size, SLICE_BYTES);
    const head = Buffer.alloc(headSize);
    await handle.read(head, 0, headSize, 0);
    if (size <= SLICE_BYTES) {
      const source = head.toString("utf8");
      return { head: source, tail: source };
    }
    const tailSize = Math.min(size, SLICE_BYTES);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    return {
      head: head.toString("utf8"),
      tail: tail.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

async function candidateProjectDirectories(
  workspacePath: string,
  claudeHome: string,
): Promise<string[]> {
  const paths = new Set<string>([workspacePath]);
  try {
    paths.add(await realpath(workspacePath));
  } catch {
    // The lexical workspace path remains a useful fallback.
  }
  return [...paths].map((candidate) =>
    path.join(
      claudeHome,
      "projects",
      claudeProjectDirectoryName(candidate),
    ),
  );
}

export async function discoverWorkspaceSessions(
  workspacePath: string,
  claudeHome = path.join(homedir(), ".claude"),
): Promise<ClaudeWorkspaceSession[]> {
  const sessions = new Map<string, ClaudeWorkspaceSession>();
  for (const directory of await candidateProjectDirectories(
    workspacePath,
    claudeHome,
  )) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const transcriptPath = path.join(directory, entry.name);
      const details = await stat(transcriptPath);
      const slices = await readTranscriptSlices(
        transcriptPath,
        details.size,
      );
      const headRows = parseLines(slices.head);
      const tailRows = parseLines(slices.tail);
      const sessionId = entry.name.slice(0, -".jsonl".length);
      const title = sessionTitle(headRows, tailRows);
      const candidate: ClaudeWorkspaceSession = {
        sessionId,
        transcriptPath,
        workspacePath,
        title: title.title,
        customTitle: title.customTitle,
        model: latestModel(tailRows),
        visibleToClaudeIde: visibleToClaudeIde(
          headRows,
          tailRows,
        ),
        modifiedAt: details.mtimeMs,
        size: details.size,
      };
      const existing = sessions.get(sessionId);
      if (!existing || candidate.modifiedAt > existing.modifiedAt) {
        sessions.set(sessionId, candidate);
      }
    }
  }
  return [...sessions.values()].sort(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );
}

export async function loadTranscriptPreview(
  transcriptPath: string,
  maximumNarrativeRows = 80,
  maximumOperationRows = DEFAULT_PREVIEW_OPERATION_ROWS,
): Promise<Record<string, unknown>[]> {
  const details = await stat(transcriptPath);
  const handle = await open(transcriptPath, "r");
  try {
    const size = Math.min(details.size, HISTORY_SLICE_BYTES);
    const buffer = Buffer.alloc(size);
    await handle.read(
      buffer,
      0,
      size,
      Math.max(0, details.size - size),
    );
    const rows = mergeAssistantTranscriptRows(
      parseLines(buffer.toString("utf8")).filter(
        isVisibleTranscriptFrame,
      ),
    );
    const narrativeLimit = Math.max(
      0,
      Math.floor(maximumNarrativeRows),
    );
    const operationLimit = Math.max(
      0,
      Math.floor(maximumOperationRows),
    );
    const classifiedRows = rows
      .map((row, index) => ({
        index,
        frameClass: classifyTranscriptFrame(row),
      }));
    const narrativeIndexes = takeLastIndexes(
      classifiedRows
      .filter(
        ({ frameClass }) =>
          frameClass === "human-narrative" ||
          frameClass === "assistant-narrative",
      )
      .map(({ index }) => index),
      narrativeLimit,
    );
    const operationIndexes = takeLastIndexes(
      classifiedRows
      .filter(({ frameClass }) => frameClass === "operation")
      .map(({ index }) => index),
      operationLimit,
    );
    const selectedIndexes = new Set([
      ...narrativeIndexes,
      ...operationIndexes,
    ]);
    return rows.filter((_row, index) => selectedIndexes.has(index));
  } finally {
    await handle.close();
  }
}
