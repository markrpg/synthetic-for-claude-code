import { createHash } from "node:crypto";

const SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_TOOL_ID = /^[a-zA-Z0-9_-]+$/;
const RESERVED_TOOL_NAMES = new Set([
  "api_tool",
  "browser",
  "collaboration",
  "computer",
  "container",
  "file_search",
  "functions",
  "image_gen",
  "multi_tool_use",
  "python",
  "python_user_visible",
  "submodel_delegator",
  "terminal",
  "tool_search",
  "web",
]);
const RESERVED_TOOL_PREFIXES = ["codex_apps__", "mcp__"];

export interface ToolNameMapping {
  toOpenAI: ReadonlyMap<string, string>;
  fromOpenAI: ReadonlyMap<string, string>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isReservedToolName(name: string): boolean {
  return (
    RESERVED_TOOL_NAMES.has(name) ||
    RESERVED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function mappedToolName(original: string): string {
  if (!SAFE_TOOL_NAME.test(original)) {
    return `modelhop_${hash(original)}`;
  }
  if (!isReservedToolName(original)) {
    return original;
  }
  const prefixed = `modelhop_${original}`;
  return SAFE_TOOL_NAME.test(prefixed)
    ? prefixed
    : `modelhop_${hash(original)}`;
}

export function buildToolNameMapping(
  names: readonly string[],
): ToolNameMapping {
  const toOpenAI = new Map<string, string>();
  const fromOpenAI = new Map<string, string>();
  for (const original of names) {
    let mapped = mappedToolName(original);
    let suffix = 0;
    while (
      fromOpenAI.has(mapped) &&
      fromOpenAI.get(mapped) !== original
    ) {
      suffix += 1;
      mapped = `modelhop_${hash(original)}_${suffix}`;
    }
    toOpenAI.set(original, mapped);
    fromOpenAI.set(mapped, original);
  }
  return { toOpenAI, fromOpenAI };
}

export function toAnthropicToolId(id: string): string {
  if (SAFE_TOOL_ID.test(id)) {
    return id;
  }
  const encoded = Buffer.from(id, "utf8").toString("base64url");
  return encoded.length <= 220
    ? `mh_${encoded}`
    : `mh_hash_${hash(id)}`;
}

export function fromAnthropicToolId(id: string): string {
  if (!id.startsWith("mh_") || id.startsWith("mh_hash_")) {
    return id;
  }
  try {
    return Buffer.from(id.slice(3), "base64url").toString("utf8");
  } catch {
    return id;
  }
}
