import { createHash } from "node:crypto";

const SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

export interface ToolNameMapping {
  toOpenAI: ReadonlyMap<string, string>;
  fromOpenAI: ReadonlyMap<string, string>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function buildToolNameMapping(
  names: readonly string[],
): ToolNameMapping {
  const toOpenAI = new Map<string, string>();
  const fromOpenAI = new Map<string, string>();
  for (const original of names) {
    let mapped = SAFE_TOOL_NAME.test(original)
      ? original
      : `modelhop_${hash(original)}`;
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
