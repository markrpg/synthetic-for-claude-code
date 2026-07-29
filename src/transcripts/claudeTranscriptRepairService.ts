import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const ANTHROPIC_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;
const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_WRITE_ATTEMPTS = 3;

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedLine {
  raw: string;
  record?: JsonRecord;
  remove: boolean;
  changed: boolean;
}

export interface TranscriptContentRepair {
  content: string;
  changed: boolean;
  toolUseIdsRepaired: number;
  toolResultIdsRepaired: number;
  thinkingBlocksRemoved: number;
  assistantRecordsRemoved: number;
  parentLinksRepaired: number;
}

export interface TranscriptRepairSummary {
  filesScanned: number;
  filesChanged: number;
  toolUseIdsRepaired: number;
  toolResultIdsRepaired: number;
  thinkingBlocksRemoved: number;
  assistantRecordsRemoved: number;
  parentLinksRepaired: number;
}

export class TranscriptCompatibilityError extends Error {
  public constructor(public readonly issueCount: number) {
    super(
      `Found ${issueCount} Synthetic tool block compatibility issue${
        issueCount === 1 ? "" : "s"
      } that cannot be repaired without guessing. Wait for active tools to finish, then try the provider switch again.`,
    );
    this.name = "TranscriptCompatibilityError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function messageContent(record: JsonRecord): unknown[] | undefined {
  const message = record.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  return message.content as unknown[];
}

function messageModel(record: JsonRecord): string | undefined {
  const message = record.message;
  return isRecord(message) && typeof message.model === "string"
    ? message.model
    : undefined;
}

function isToolUseBlock(block: JsonRecord): boolean {
  return (
    block.type === "tool_use" ||
    block.type === "server_tool_use"
  );
}

function addReferencedToolIds(
  block: JsonRecord,
  add: (id: string) => void,
): void {
  if (isToolUseBlock(block) && typeof block.id === "string") {
    add(block.id);
  }
  if (typeof block.tool_use_id === "string") {
    add(block.tool_use_id);
  }
  if (
    isRecord(block.caller) &&
    typeof block.caller.tool_id === "string"
  ) {
    add(block.caller.tool_id);
  }
}

function isIncompatibleThinkingBlock(
  block: JsonRecord,
  model: string | undefined,
): boolean {
  if (
    block.type !== "thinking" &&
    block.type !== "redacted_thinking"
  ) {
    return false;
  }
  if (model && !model.startsWith("claude-")) {
    return true;
  }
  return (
    block.type === "thinking" &&
    (typeof block.signature !== "string" ||
      block.signature.length === 0)
  );
}

function isPlainObject(value: unknown): value is JsonRecord {
  return isRecord(value) && !Array.isArray(value);
}

function countUnsupportedToolIssues(lines: readonly ParsedLine[]): number {
  const toolUses = new Map<string, number>();
  const toolResults = new Map<string, number>();
  let issues = 0;

  for (const line of lines) {
    if (!line.record) {
      continue;
    }
    for (const value of messageContent(line.record) ?? []) {
      if (!isRecord(value)) {
        continue;
      }
      if (isToolUseBlock(value)) {
        if (typeof value.id !== "string") {
          issues += 1;
        } else if (value.type === "tool_use") {
          toolUses.set(value.id, (toolUses.get(value.id) ?? 0) + 1);
        }
        if (
          typeof value.name !== "string" ||
          !ANTHROPIC_TOOL_NAME.test(value.name)
        ) {
          issues += 1;
        }
        if (!isPlainObject(value.input)) {
          issues += 1;
        }
      }
      if (value.type === "tool_result") {
        if (typeof value.tool_use_id !== "string") {
          issues += 1;
        } else {
          toolResults.set(
            value.tool_use_id,
            (toolResults.get(value.tool_use_id) ?? 0) + 1,
          );
        }
      }
    }
  }

  for (const [id, count] of toolUses) {
    if (count !== 1 || toolResults.get(id) !== 1) {
      issues += 1;
    }
  }
  for (const id of toolResults.keys()) {
    if (!toolUses.has(id)) {
      issues += 1;
    }
  }
  return issues;
}

function compatibleToolUseId(
  sourceId: string,
  usedIds: Set<string>,
): string {
  const digest = createHash("sha256")
    .update(sourceId)
    .digest("hex")
    .slice(0, 40);
  const base = `synthetic_${digest}`;
  let candidate = base;
  let suffix = 1;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function resolveParentUuid(
  parentUuid: string,
  removedParents: ReadonlyMap<string, unknown>,
): unknown {
  let current: unknown = parentUuid;
  const visited = new Set<string>();
  while (
    typeof current === "string" &&
    removedParents.has(current) &&
    !visited.has(current)
  ) {
    visited.add(current);
    current = removedParents.get(current);
  }
  return current;
}

export function repairTranscriptContent(
  source: string,
): TranscriptContentRepair {
  const hasTrailingNewline = source.endsWith("\n");
  const rawLines = source.split("\n");
  if (hasTrailingNewline) {
    rawLines.pop();
  }

  const lines: ParsedLine[] = rawLines.map((raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return {
        raw,
        record: isRecord(parsed) ? parsed : undefined,
        remove: false,
        changed: false,
      };
    } catch {
      return { raw, remove: false, changed: false };
    }
  });

  const invalidIds = new Set<string>();
  const usedIds = new Set<string>();
  let hasIncompatibleThinking = false;
  for (const line of lines) {
    if (!line.record) {
      continue;
    }
    const model = messageModel(line.record);
    for (const value of messageContent(line.record) ?? []) {
      if (!isRecord(value)) {
        continue;
      }
      if (isIncompatibleThinkingBlock(value, model)) {
        hasIncompatibleThinking = true;
      }
      addReferencedToolIds(value, (id) => {
        if (ANTHROPIC_TOOL_USE_ID.test(id)) {
          usedIds.add(id);
        } else {
          invalidIds.add(id);
        }
      });
    }
  }
  if (invalidIds.size === 0 && !hasIncompatibleThinking) {
    return {
      content: source,
      changed: false,
      toolUseIdsRepaired: 0,
      toolResultIdsRepaired: 0,
      thinkingBlocksRemoved: 0,
      assistantRecordsRemoved: 0,
      parentLinksRepaired: 0,
    };
  }
  const unsupportedToolIssues = countUnsupportedToolIssues(lines);
  if (unsupportedToolIssues > 0) {
    throw new TranscriptCompatibilityError(unsupportedToolIssues);
  }

  const replacements = new Map(
    [...invalidIds].map((id) => [
      id,
      compatibleToolUseId(id, usedIds),
    ]),
  );
  const removedParents = new Map<string, unknown>();
  let toolUseIdsRepaired = 0;
  let toolResultIdsRepaired = 0;
  let thinkingBlocksRemoved = 0;
  let assistantRecordsRemoved = 0;
  let parentLinksRepaired = 0;

  for (const line of lines) {
    if (!line.record) {
      continue;
    }
    const content = messageContent(line.record);
    if (!content) {
      continue;
    }

    const filteredContent: unknown[] = [];
    const model = messageModel(line.record);
    for (const value of content) {
      if (!isRecord(value)) {
        filteredContent.push(value);
        continue;
      }
      if (isIncompatibleThinkingBlock(value, model)) {
        thinkingBlocksRemoved += 1;
        line.changed = true;
        continue;
      }

      if (isToolUseBlock(value) && typeof value.id === "string") {
        const replacement = replacements.get(value.id);
        if (replacement) {
          value.id = replacement;
          toolUseIdsRepaired += 1;
          line.changed = true;
        }
      }
      if (typeof value.tool_use_id === "string") {
        const replacement = replacements.get(value.tool_use_id);
        if (replacement) {
          value.tool_use_id = replacement;
          toolResultIdsRepaired += 1;
          line.changed = true;
        }
      }
      if (
        isRecord(value.caller) &&
        typeof value.caller.tool_id === "string"
      ) {
        const replacement = replacements.get(value.caller.tool_id);
        if (replacement) {
          value.caller.tool_id = replacement;
          toolResultIdsRepaired += 1;
          line.changed = true;
        }
      }
      filteredContent.push(value);
    }

    if (
      content.length > 0 &&
      filteredContent.length === 0 &&
      line.record.type === "assistant"
    ) {
      line.remove = true;
      assistantRecordsRemoved += 1;
      if (typeof line.record.uuid === "string") {
        removedParents.set(
          line.record.uuid,
          line.record.parentUuid,
        );
      }
    } else if (filteredContent.length !== content.length) {
      const message = line.record.message;
      if (isRecord(message)) {
        message.content = filteredContent;
      }
    }
  }

  for (const line of lines) {
    if (
      !line.record ||
      line.remove ||
      typeof line.record.parentUuid !== "string"
    ) {
      continue;
    }
    const resolved = resolveParentUuid(
      line.record.parentUuid,
      removedParents,
    );
    if (resolved !== line.record.parentUuid) {
      line.record.parentUuid = resolved;
      line.changed = true;
      parentLinksRepaired += 1;
    }
  }

  const changed =
    replacements.size > 0 || thinkingBlocksRemoved > 0;
  const repairedLines = lines
    .filter((line) => !line.remove)
    .map((line) =>
      line.changed && line.record
        ? JSON.stringify(line.record)
        : line.raw,
    );
  const content = `${repairedLines.join("\n")}${
    hasTrailingNewline ? "\n" : ""
  }`;

  return {
    content,
    changed,
    toolUseIdsRepaired,
    toolResultIdsRepaired,
    thinkingBlocksRemoved,
    assistantRecordsRemoved,
    parentLinksRepaired,
  };
}

export function claudeProjectDirectoryName(
  workspacePath: string,
): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
}

function sameFileVersion(
  left: { size: number; mtimeMs: number },
  right: { size: number; mtimeMs: number },
): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function emptySummary(): TranscriptRepairSummary {
  return {
    filesScanned: 0,
    filesChanged: 0,
    toolUseIdsRepaired: 0,
    toolResultIdsRepaired: 0,
    thinkingBlocksRemoved: 0,
    assistantRecordsRemoved: 0,
    parentLinksRepaired: 0,
  };
}

export class ClaudeTranscriptRepairService {
  private readonly projectsRoot: string;

  public constructor(
    private readonly backupRoot: string,
    claudeHome = path.join(homedir(), ".claude"),
  ) {
    this.projectsRoot = path.join(claudeHome, "projects");
  }

  public async repairWorkspaceTranscripts(
    workspacePaths: readonly string[],
  ): Promise<TranscriptRepairSummary> {
    const projectDirectories = new Set<string>();
    for (const workspacePath of workspacePaths) {
      projectDirectories.add(
        path.join(
          this.projectsRoot,
          claudeProjectDirectoryName(workspacePath),
        ),
      );
      try {
        const resolved = await realpath(workspacePath);
        projectDirectories.add(
          path.join(
            this.projectsRoot,
            claudeProjectDirectoryName(resolved),
          ),
        );
      } catch {
        // The direct workspace path remains available as a fallback.
      }
    }

    const summary = emptySummary();
    for (const projectDirectory of projectDirectories) {
      let entries;
      try {
        entries = await readdir(projectDirectory, {
          withFileTypes: true,
        });
      } catch (error) {
        if (
          isRecord(error) &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }
        summary.filesScanned += 1;
        const repair = await this.repairFile(
          path.join(projectDirectory, entry.name),
          path.basename(projectDirectory),
        );
        if (!repair.changed) {
          continue;
        }
        summary.filesChanged += 1;
        summary.toolUseIdsRepaired += repair.toolUseIdsRepaired;
        summary.toolResultIdsRepaired +=
          repair.toolResultIdsRepaired;
        summary.thinkingBlocksRemoved +=
          repair.thinkingBlocksRemoved;
        summary.assistantRecordsRemoved +=
          repair.assistantRecordsRemoved;
        summary.parentLinksRepaired += repair.parentLinksRepaired;
      }
    }
    return summary;
  }

  private async repairFile(
    transcriptPath: string,
    projectDirectoryName: string,
  ): Promise<TranscriptContentRepair> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const before = await stat(transcriptPath);
      const source = await readFile(transcriptPath, "utf8");
      const afterRead = await stat(transcriptPath);
      if (!sameFileVersion(before, afterRead)) {
        continue;
      }

      const repair = repairTranscriptContent(source);
      if (!repair.changed) {
        return repair;
      }

      const backupDirectory = path.join(
        this.backupRoot,
        projectDirectoryName,
      );
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      const suffix = `${Date.now()}-${randomUUID()}`;
      const backupPath = path.join(
        backupDirectory,
        `${path.basename(transcriptPath)}.${suffix}.bak`,
      );
      const temporaryPath = path.join(
        path.dirname(transcriptPath),
        `.${path.basename(transcriptPath)}.${suffix}.tmp`,
      );
      await writeFile(backupPath, source, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(temporaryPath, repair.content, {
        encoding: "utf8",
        mode: before.mode & 0o777,
        flag: "wx",
      });

      const beforeRename = await stat(transcriptPath);
      if (!sameFileVersion(before, beforeRename)) {
        await Promise.all([
          unlink(backupPath),
          unlink(temporaryPath),
        ]);
        continue;
      }
      await rename(temporaryPath, transcriptPath);
      return repair;
    }

    throw new Error(
      "Claude conversation history is still changing. Wait for the active response to finish, then switch providers again.",
    );
  }
}
