export type TranscriptFrameClass =
  | "human-narrative"
  | "assistant-narrative"
  | "operation"
  | "excluded";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CONTROL_ENVELOPE =
  /^\s*<(?:local-command-caveat|command-name|command-message|command-args|task-notification|system-reminder|ide_opened_file|ide_selection|teammate-message)(?:\s[^>]*)?>/i;

/**
 * Returns the human-readable text carried by a Claude transcript message.
 * Other blocks are intentionally left untouched by the classifier.
 */
export function transcriptTextFromContent(
  content: unknown,
): string | undefined {
  if (typeof content === "string") {
    const text = content.trim();
    return text || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) =>
      typeof block.text === "string" ? block.text : "",
    )
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * Detects Claude's private command/control wrappers when older transcripts do
 * not provide an origin. Explicit human provenance always takes precedence.
 */
export function isTranscriptControlEnvelopeText(
  text: string | undefined,
): boolean {
  return Boolean(text && CONTROL_ENVELOPE.test(text));
}

export function transcriptFrameHasToolResult(
  row: Record<string, unknown>,
): boolean {
  if (
    Object.hasOwn(row, "toolUseResult") ||
    Object.hasOwn(row, "tool_use_result") ||
    typeof row.parent_tool_use_id === "string"
  ) {
    return true;
  }
  if (!isRecord(row.message) || !Array.isArray(row.message.content)) {
    return false;
  }
  return row.message.content.some(
    (block) => isRecord(block) && block.type === "tool_result",
  );
}

function transcriptOriginKind(
  row: Record<string, unknown>,
): string | undefined {
  return isRecord(row.origin) && typeof row.origin.kind === "string"
    ? row.origin.kind
    : undefined;
}

function hasMessageContent(content: unknown): boolean {
  if (typeof content === "string") {
    return Boolean(content.trim());
  }
  return Array.isArray(content) && content.length > 0;
}

/**
 * Classifies raw Claude JSONL rows by provenance and presentation purpose.
 * This is deliberately independent of the mobile protocol so transcript
 * discovery and live-event normalization can share the same trust boundary.
 */
export function classifyTranscriptFrame(
  row: Record<string, unknown>,
): TranscriptFrameClass {
  if (
    (row.type !== "user" && row.type !== "assistant") ||
    !isRecord(row.message) ||
    row.isMeta === true ||
    row.isSynthetic === true
  ) {
    return "excluded";
  }

  const content = row.message.content;
  if (row.type === "user") {
    const originKind = transcriptOriginKind(row);
    if (originKind === "task-notification") {
      return "operation";
    }
    if (originKind && originKind !== "human") {
      return "excluded";
    }
    if (transcriptFrameHasToolResult(row)) {
      return "operation";
    }
    if (!hasMessageContent(content)) {
      return "excluded";
    }

    if (originKind === "human") {
      return "human-narrative";
    }
    return isTranscriptControlEnvelopeText(
      transcriptTextFromContent(content),
    )
      ? "excluded"
      : "human-narrative";
  }

  if (!hasMessageContent(content)) {
    return "excluded";
  }
  return transcriptTextFromContent(content)
    ? "assistant-narrative"
    : "operation";
}

export function isHumanTranscriptNarrativeFrame(
  row: Record<string, unknown>,
): boolean {
  return classifyTranscriptFrame(row) === "human-narrative";
}

export function isVisibleTranscriptFrame(
  row: Record<string, unknown>,
): boolean {
  return classifyTranscriptFrame(row) !== "excluded";
}
