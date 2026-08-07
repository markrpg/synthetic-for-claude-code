import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROGRAMMATIC_ENTRYPOINTS = new Set([
  "sdk-cli",
  "sdk-ts",
  "sdk-py",
]);

interface TranscriptLine {
  content: string;
  ending: string;
}

interface TranscriptVisibilityAnalysis {
  records: number;
  sessionRecords: number;
  sdkTsEntrypoints: number;
  claudeVscodeEntrypoints: number;
}

export interface ModelHopTranscriptVisibilityRepair {
  changed: boolean;
  backupPath?: string;
  records: number;
  sessionRecords: number;
  repairedEntrypoints: number;
  visibleToClaudeIde: true;
}

export interface ModelHopTranscriptVisibilityOptions {
  backupDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function* transcriptLines(
  transcriptPath: string,
): AsyncGenerator<TranscriptLine> {
  const stream = createReadStream(transcriptPath, {
    encoding: "utf8",
  });
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const hasCarriageReturn =
        newline > 0 && buffered[newline - 1] === "\r";
      yield {
        content: buffered.slice(
          0,
          hasCarriageReturn ? newline - 1 : newline,
        ),
        ending: hasCarriageReturn ? "\r\n" : "\n",
      };
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered.length > 0) {
    yield { content: buffered, ending: "" };
  }
}

function parseTranscriptRow(
  content: string,
  lineNumber: number,
): Record<string, unknown> | undefined {
  if (!content.trim()) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error(
      `The ModelHop transcript is malformed at JSONL line ${lineNumber}.`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(
      `The ModelHop transcript contains a non-object JSONL record at line ${lineNumber}.`,
    );
  }
  return value;
}

function validateSessionBearingRecord(
  row: Record<string, unknown>,
  targetSessionId: string,
  lineNumber: number,
): boolean {
  let sessionBearing = false;
  for (const key of ["sessionId", "session_id"] as const) {
    if (!Object.hasOwn(row, key)) {
      continue;
    }
    sessionBearing = true;
    if (row[key] !== targetSessionId) {
      throw new Error(
        `The ModelHop transcript contains a different session ID at JSONL line ${lineNumber}.`,
      );
    }
  }
  return sessionBearing;
}

async function analyseTranscriptVisibility(
  transcriptPath: string,
  targetSessionId: string,
): Promise<TranscriptVisibilityAnalysis> {
  let records = 0;
  let sessionRecords = 0;
  let sdkTsEntrypoints = 0;
  let claudeVscodeEntrypoints = 0;
  let lineNumber = 0;
  for await (const line of transcriptLines(transcriptPath)) {
    lineNumber += 1;
    const row = parseTranscriptRow(line.content, lineNumber);
    if (!row) {
      continue;
    }
    records += 1;
    const sessionBearing = validateSessionBearingRecord(
      row,
      targetSessionId,
      lineNumber,
    );
    if (sessionBearing) {
      sessionRecords += 1;
    }
    if (Object.hasOwn(row, "sessionKind")) {
      if (
        row.sessionKind === "daemon" ||
        row.sessionKind === "daemon-worker"
      ) {
        throw new Error(
          "The target transcript is a daemon session, not a ModelHop Claude Code conversation.",
        );
      }
    }
    if (!Object.hasOwn(row, "entrypoint")) {
      continue;
    }
    if (!sessionBearing) {
      throw new Error(
        `The ModelHop transcript has an unscoped entrypoint at JSONL line ${lineNumber}.`,
      );
    }
    if (row.entrypoint === "sdk-ts") {
      sdkTsEntrypoints += 1;
      continue;
    }
    if (row.entrypoint === "claude-vscode") {
      claudeVscodeEntrypoints += 1;
      continue;
    }
    if (
      typeof row.entrypoint !== "string" ||
      PROGRAMMATIC_ENTRYPOINTS.has(row.entrypoint)
    ) {
      throw new Error(
        `The ModelHop transcript has an unexpected programmatic entrypoint at JSONL line ${lineNumber}.`,
      );
    }
    throw new Error(
      `The ModelHop transcript has an unexpected entrypoint at JSONL line ${lineNumber}.`,
    );
  }
  if (records === 0) {
    throw new Error("The ModelHop transcript is empty.");
  }
  if (sessionRecords === 0) {
    throw new Error(
      "The ModelHop transcript does not contain its target session ID.",
    );
  }
  if (sdkTsEntrypoints + claudeVscodeEntrypoints === 0) {
    throw new Error(
      "The ModelHop transcript has no verifiable Claude Code entrypoint.",
    );
  }
  return {
    records,
    sessionRecords,
    sdkTsEntrypoints,
    claudeVscodeEntrypoints,
  };
}

async function fileHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  value: string,
  position: number,
): Promise<number> {
  const buffer = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("ModelHop could not write the repaired transcript.");
    }
    offset += result.bytesWritten;
  }
  return position + buffer.length;
}

async function writeVisibleTranscript(
  sourcePath: string,
  temporaryPath: string,
): Promise<void> {
  const handle = await open(temporaryPath, "wx", 0o600);
  let position = 0;
  try {
    let lineNumber = 0;
    for await (const line of transcriptLines(sourcePath)) {
      lineNumber += 1;
      const row = parseTranscriptRow(line.content, lineNumber);
      const content =
        row?.entrypoint === "sdk-ts"
          ? JSON.stringify({
              ...row,
              entrypoint: "claude-vscode",
            })
          : line.content;
      position = await writeAll(
        handle,
        `${content}${line.ending}`,
        position,
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Makes a ModelHop-owned Claude SDK fork discoverable by Claude Code's IDE
 * session picker. Claude's IDE deliberately excludes `sdk-ts` transcripts.
 * The target filename and every session-bearing record are validated before
 * any write, and the original bytes are backed up before an atomic replace.
 */
export async function repairModelHopTranscriptVisibility(
  transcriptPath: string,
  targetSessionId: string,
  options: ModelHopTranscriptVisibilityOptions = {},
): Promise<ModelHopTranscriptVisibilityRepair> {
  if (!CLAUDE_SESSION_ID.test(targetSessionId)) {
    throw new Error("The ModelHop target session ID is invalid.");
  }
  if (path.basename(transcriptPath) !== `${targetSessionId}.jsonl`) {
    throw new Error(
      "The ModelHop target transcript filename does not match its session ID.",
    );
  }
  const details = await lstat(transcriptPath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(
      "The ModelHop target transcript must be a regular, non-symlink file.",
    );
  }
  const analysis = await analyseTranscriptVisibility(
    transcriptPath,
    targetSessionId,
  );
  if (analysis.sdkTsEntrypoints === 0) {
    return {
      changed: false,
      records: analysis.records,
      sessionRecords: analysis.sessionRecords,
      repairedEntrypoints: 0,
      visibleToClaudeIde: true,
    };
  }

  const originalHash = await fileHash(transcriptPath);
  const backupDirectory =
    options.backupDirectory ??
    path.join(path.dirname(transcriptPath), ".modelhop-backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(
    backupDirectory,
    `${targetSessionId}.${Date.now()}-${randomUUID()}.jsonl.bak`,
  );
  await copyFile(
    transcriptPath,
    backupPath,
    fsConstants.COPYFILE_EXCL,
  );
  await chmod(backupPath, 0o600);
  const backupHandle = await open(backupPath, "r+");
  try {
    await backupHandle.sync();
  } finally {
    await backupHandle.close();
  }
  if ((await fileHash(backupPath)) !== originalHash) {
    throw new Error(
      "The ModelHop transcript changed while its recovery backup was being created.",
    );
  }

  const temporaryPath = path.join(
    path.dirname(transcriptPath),
    `.${path.basename(transcriptPath)}.${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeVisibleTranscript(transcriptPath, temporaryPath);
    const repaired = await analyseTranscriptVisibility(
      temporaryPath,
      targetSessionId,
    );
    if (
      repaired.sdkTsEntrypoints !== 0 ||
      repaired.claudeVscodeEntrypoints === 0
    ) {
      throw new Error(
        "The repaired transcript is still hidden from Claude Code.",
      );
    }
    if ((await fileHash(transcriptPath)) !== originalHash) {
      throw new Error(
        "The ModelHop transcript changed before its visibility repair could be committed.",
      );
    }
    await rename(temporaryPath, transcriptPath);
    return {
      changed: true,
      backupPath,
      records: repaired.records,
      sessionRecords: repaired.sessionRecords,
      repairedEntrypoints: analysis.sdkTsEntrypoints,
      visibleToClaudeIde: true,
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function activeTranscriptPath(
  sourceTranscriptPath: string,
  sessionId: string,
): string {
  return path.join(path.dirname(sourceTranscriptPath), `${sessionId}.jsonl`);
}

export async function transcriptTailSignature(
  transcriptPath: string,
): Promise<string> {
  const details = await stat(transcriptPath);
  if (!details.isFile() || details.size <= 0) {
    throw new Error("The Claude conversation transcript is empty.");
  }
  const size = Math.min(details.size, TRANSCRIPT_TAIL_BYTES);
  const buffer = Buffer.alloc(size);
  const handle = await open(transcriptPath, "r");
  try {
    await handle.read(
      buffer,
      0,
      size,
      Math.max(0, details.size - size),
    );
  } finally {
    await handle.close();
  }
  return createHash("sha256")
    .update(String(details.size))
    .update("\0")
    .update(buffer)
    .digest("hex");
}

export interface TranscriptStabilityObservation {
  size: number;
  signature: string;
  observedAt: number;
}

export interface TranscriptStabilityOptions {
  requiredObservations?: number;
  minimumStableMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  observe?: (
    transcriptPath: string,
  ) => Promise<Omit<TranscriptStabilityObservation, "observedAt">>;
  /**
   * Cancels only the current observation window. Callers may safely restart
   * stabilization afterwards; an abort never turns an unstable transcript
   * into an accepted one.
   */
  signal?: AbortSignal;
}

function transcriptStabilityAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Transcript stabilization was restarted.");
}

async function waitForTranscriptStabilityPoll(
  wait: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await wait(milliseconds);
    return;
  }
  if (signal.aborted) {
    throw transcriptStabilityAbortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(transcriptStabilityAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void wait(milliseconds).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      },
    );
  });
}

/**
 * Waits until both transcript length and tail signature are identical across
 * three observations spanning at least two seconds. There is deliberately no
 * elapsed-time success fallback: ongoing writes remain a visible hand-back
 * blocker instead of being truncated or mistaken for completion.
 */
export async function waitForStableTranscript(
  transcriptPath: string,
  options: TranscriptStabilityOptions = {},
): Promise<TranscriptStabilityObservation> {
  const requiredObservations = Math.max(
    3,
    options.requiredObservations ?? 3,
  );
  const minimumStableMs = Math.max(
    2_000,
    options.minimumStableMs ?? 2_000,
  );
  const pollIntervalMs = Math.max(
    100,
    options.pollIntervalMs ?? 1_000,
  );
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const observe =
    options.observe ??
    (async (target: string) => {
      const details = await stat(target);
      if (!details.isFile() || details.size <= 0) {
        throw new Error("The Claude conversation transcript is empty.");
      }
      return {
        size: details.size,
        signature: await transcriptTailSignature(target),
      };
    });
  const signal = options.signal;

  let baseline: TranscriptStabilityObservation | undefined;
  let matchingObservations = 0;
  for (;;) {
    if (signal?.aborted) {
      throw transcriptStabilityAbortError(signal);
    }
    const measured = await observe(transcriptPath);
    if (signal?.aborted) {
      throw transcriptStabilityAbortError(signal);
    }
    const observation: TranscriptStabilityObservation = {
      ...measured,
      observedAt: now(),
    };
    if (
      baseline &&
      baseline.size === observation.size &&
      baseline.signature === observation.signature
    ) {
      matchingObservations += 1;
      if (
        matchingObservations >= requiredObservations &&
        observation.observedAt - baseline.observedAt >= minimumStableMs
      ) {
        return observation;
      }
    } else {
      baseline = observation;
      matchingObservations = 1;
    }
    await waitForTranscriptStabilityPoll(
      wait,
      pollIntervalMs,
      signal,
    );
  }
}
