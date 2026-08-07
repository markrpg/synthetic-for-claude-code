import { realpath } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";

export type AutoSafeDecision =
  | {
      behavior: "allow";
      reason: string;
    }
  | {
      behavior: "ask";
      reason: string;
      sessionRememberable?: boolean;
    };

interface AutoSafeContext {
  workspacePath: string;
  workspacePaths?: readonly string[];
}

const WORKSPACE_READ_TOOLS = new Set([
  "glob",
  "grep",
  "lsp",
  "ls",
  "read",
  "search",
]);

const WORKSPACE_WRITE_TOOLS = new Set([
  "edit",
  "multiedit",
  "notebookedit",
  "write",
]);

const INTERNAL_TOOLS = new Set([
  "enterplanmode",
  "exitplanmode",
  "skill",
  "taskcreate",
  "taskget",
  "tasklist",
  "taskoutput",
  "taskupdate",
  "todowrite",
  "toolsearch",
]);

const ORCHESTRATION_TOOLS = new Set([
  "agent",
  "task",
  "workflow",
]);

const CREDENTIAL_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".gcloud",
  ".gnupg",
  ".kube",
  ".password-store",
  ".ssh",
  ".terraform.d",
]);

const CREDENTIAL_FILES = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".vault-token",
  "auth.json",
  "credentials",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function canonicalisePossiblyMissing(
  candidate: string,
): Promise<string> {
  let existing = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      return path.join(canonical, ...missing.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error("No existing ancestor could be canonicalised.");
      }
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

async function canonicalWorkspacePath(
  requestedPath: string,
  context: AutoSafeContext,
): Promise<string | undefined> {
  const roots = [
    context.workspacePath,
    ...(context.workspacePaths ?? []),
  ];
  const canonicalRoots = await Promise.all(
    [...new Set(roots)].map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  const lexical = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(canonicalRoots[0] ?? context.workspacePath, requestedPath);
  let canonical: string;
  try {
    canonical = await canonicalisePossiblyMissing(lexical);
  } catch {
    return undefined;
  }
  return canonicalRoots.some((root) => isInside(root, canonical))
    ? canonical
    : undefined;
}

function isCredentialPath(candidate: string): boolean {
  const segments = candidate
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) {
    return true;
  }
  if (
    segments.some(
      (segment, index) =>
        segment === ".config" && segments[index + 1] === "gh",
    )
  ) {
    return true;
  }
  const filename = segments.at(-1) ?? "";
  return (
    CREDENTIAL_FILES.has(filename) ||
    filename.startsWith(".env.") ||
    filename.endsWith(".pem") ||
    filename.endsWith(".key") ||
    filename.endsWith(".p12") ||
    filename.endsWith(".pfx") ||
    filename.startsWith("credentials.") ||
    filename.startsWith("secret.") ||
    filename.startsWith("secrets.")
  );
}

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function privateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1] ?? "0", 16);
    const low = Number.parseInt(mapped[2] ?? "0", 16);
    return privateIpv4(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
    );
  }
  const dottedMapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(host);
  if (dottedMapped) {
    return privateIpv4(dottedMapped[1] ?? "0.0.0.0");
  }
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb") ||
    host.startsWith("fec") ||
    host.startsWith("fed") ||
    host.startsWith("fee") ||
    host.startsWith("fef") ||
    host.startsWith("ff") ||
    host.startsWith("2001:db8:")
  );
}

export function isPublicResearchUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".corp") ||
    (!hostname.includes(".") && isIP(hostname) === 0)
  ) {
    return false;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return !privateIpv4(hostname);
  }
  if (ipVersion === 6) {
    return !privateIpv6(hostname);
  }
  return true;
}

async function isPublicResearchTarget(rawUrl: string): Promise<boolean> {
  if (!isPublicResearchUrl(rawUrl)) {
    return false;
  }
  const url = new URL(rawUrl);
  const sensitiveQueryName = [...url.searchParams.keys()].some((key) =>
    /(?:api[-_]?key|access[-_]?token|auth|credential|password|secret|signature)/iu.test(
      key,
    ),
  );
  if (sensitiveQueryName) {
    return false;
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname) !== 0) {
    return true;
  }
  try {
    const addresses = await lookup(hostname, {
      all: true,
      verbatim: true,
    });
    return (
      addresses.length > 0 &&
      addresses.every(({ address, family }) =>
        family === 4 ? !privateIpv4(address) : !privateIpv6(address),
      )
    );
  } catch {
    return false;
  }
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === "\n" ||
      character === "\r" ||
      character === ";" ||
      character === "|" ||
      character === ">" ||
      character === "<" ||
      character === "`" ||
      character === "&" ||
      character === "$" ||
      character === "{" ||
      character === "}"
    ) {
      return undefined;
    }
    if (/\s/u.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (escaped || quote) {
    return undefined;
  }
  if (word) {
    words.push(word);
  }
  return words;
}

type CurlOptionKind = "credential" | "external-write" | "network-override";

const CURL_RISK_OPTIONS = new Map<string, CurlOptionKind>([
  ["--aws-sigv4", "credential"],
  ["--cert", "credential"],
  ["--config", "credential"],
  ["--cookie", "credential"],
  ["--cookie-jar", "external-write"],
  ["--data", "external-write"],
  ["--data-ascii", "external-write"],
  ["--data-binary", "external-write"],
  ["--data-raw", "external-write"],
  ["--data-urlencode", "external-write"],
  ["--form", "external-write"],
  ["--form-string", "external-write"],
  ["--json", "external-write"],
  ["--key", "credential"],
  ["--oauth2-bearer", "credential"],
  ["--output", "external-write"],
  ["--proxy", "network-override"],
  ["--proxy-user", "credential"],
  ["--remote-header-name", "external-write"],
  ["--remote-name", "external-write"],
  ["--resolve", "network-override"],
  ["--connect-to", "network-override"],
  ["--upload-file", "external-write"],
  ["--user", "credential"],
  ["-F", "external-write"],
  ["-K", "credential"],
  ["-O", "external-write"],
  ["-T", "external-write"],
  ["-b", "credential"],
  ["-c", "external-write"],
  ["-d", "external-write"],
  ["-o", "external-write"],
  ["-u", "credential"],
  ["-x", "network-override"],
]);

const CURL_LONG_VALUE_OPTIONS = new Set([
  "--connect-timeout",
  "--header",
  "--max-time",
  "--referer",
  "--request",
  "--retry",
  "--retry-delay",
  "--url",
  "--user-agent",
]);

async function curlResearchDecision(
  command: string,
): Promise<AutoSafeDecision | undefined> {
  const words = shellWords(command);
  if (!words || path.basename(words[0] ?? "") !== "curl") {
    return undefined;
  }
  let method = "GET";
  const urls: string[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index] ?? "";
    const [option = "", inlineValue] = token.startsWith("--")
      ? token.split(/=(.*)/su, 2)
      : [token, undefined];
    const risk = CURL_RISK_OPTIONS.get(option);
    if (risk) {
      return {
        behavior: "ask",
        reason:
          risk === "credential"
            ? "The request may use credentials."
            : risk === "external-write"
              ? "The request may send data or write an external response to disk."
              : "The request overrides normal network routing.",
      };
    }
    if (option === "--request" || option === "-X" || /^-X.+/u.test(token)) {
      const requestedMethod =
        option === "-X" || option === "--request"
          ? inlineValue ?? words[(index += 1)]
          : token.slice(2);
      method = requestedMethod?.toUpperCase() ?? "";
      continue;
    }
    if (option === "--head" || token === "-I") {
      method = "HEAD";
      continue;
    }
    if (option === "--url") {
      const url = inlineValue ?? words[(index += 1)];
      if (url) {
        urls.push(url);
      }
      continue;
    }
    if (option === "--header" || token === "-H") {
      const header = inlineValue ?? words[(index += 1)] ?? "";
      if (
        header.startsWith("@") ||
        /^(?:authorization|cookie|proxy-authorization)\s*:/iu.test(header)
      ) {
        return {
          behavior: "ask",
          reason: "The request includes an authentication or cookie header.",
        };
      }
      continue;
    }
    if (CURL_LONG_VALUE_OPTIONS.has(option)) {
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--")) {
      const safeFlag = new Set([
        "--compressed",
        "--fail",
        "--fail-with-body",
        "--no-progress-meter",
        "--show-error",
        "--silent",
      ]).has(option);
      if (!safeFlag) {
        return {
          behavior: "ask",
          reason: `The curl option ${option} is not in ModelHop's read-only research allowlist.`,
        };
      }
      continue;
    }
    if (token.startsWith("-")) {
      if (!/^-?[sSfg]+$/u.test(token)) {
        return {
          behavior: "ask",
          reason: `The curl option ${token} is not in ModelHop's read-only research allowlist.`,
        };
      }
      continue;
    }
    urls.push(token);
  }
  if (method !== "GET" && method !== "HEAD") {
    return {
      behavior: "ask",
      reason: `The request uses ${method || "an unknown method"}, which can write externally.`,
    };
  }
  if (
    urls.length === 0 ||
    !(await Promise.all(urls.map(isPublicResearchTarget))).every(Boolean)
  ) {
    return {
      behavior: "ask",
      reason: "The request does not target an unambiguously public HTTP(S) URL.",
    };
  }
  return {
    behavior: "allow",
    reason: "Public read-only curl research is safe in Auto-safe mode.",
  };
}

async function shellPathIsSafe(
  candidate: string,
  context: AutoSafeContext,
): Promise<boolean> {
  if (!candidate || candidate === "-" || candidate.startsWith("~")) {
    return candidate === "-";
  }
  // Shell expansion happens after ModelHop's parser. Do not approve a path
  // whose concrete targets cannot be canonicalised before execution.
  if (/[*?[\]]/u.test(candidate)) {
    return false;
  }
  const canonical = await canonicalWorkspacePath(candidate, context);
  return Boolean(canonical && !isCredentialPath(canonical));
}

async function allShellPathsAreSafe(
  candidates: readonly string[],
  context: AutoSafeContext,
): Promise<boolean> {
  return (
    await Promise.all(
      candidates.map((candidate) => shellPathIsSafe(candidate, context)),
    )
  ).every(Boolean);
}

const SAFE_RG_FLAGS = new Set([
  "--case-sensitive",
  "--count",
  "--count-matches",
  "--files",
  "--files-with-matches",
  "--files-without-match",
  "--fixed-strings",
  "--heading",
  "--hidden",
  "--ignore-case",
  "--json",
  "--line-number",
  "--line-regexp",
  "--no-filename",
  "--no-heading",
  "--no-ignore",
  "--no-ignore-dot",
  "--no-ignore-global",
  "--no-ignore-parent",
  "--no-messages",
  "--smart-case",
  "--stats",
  "--text",
  "--with-filename",
  "--word-regexp",
]);

const SAFE_RG_VALUE_OPTIONS = new Set([
  "--after-context",
  "--before-context",
  "--context",
  "--glob",
  "--max-columns",
  "--max-count",
  "--regexp",
  "--threads",
  "--type",
  "--type-not",
]);

const SAFE_GREP_FLAGS = new Set([
  "--basic-regexp",
  "--byte-offset",
  "--count",
  "--extended-regexp",
  "--files-with-matches",
  "--files-without-match",
  "--fixed-strings",
  "--ignore-case",
  "--invert-match",
  "--line-number",
  "--line-regexp",
  "--no-filename",
  "--no-messages",
  "--only-matching",
  "--quiet",
  "--recursive",
  "--text",
  "--with-filename",
  "--word-regexp",
]);

const SAFE_GREP_VALUE_OPTIONS = new Set([
  "--after-context",
  "--before-context",
  "--context",
  "--exclude",
  "--exclude-dir",
  "--include",
  "--max-count",
  "--regexp",
]);

function optionName(token: string): string {
  return token.startsWith("--") ? token.split("=", 1)[0] ?? token : token;
}

async function searchCommandDecision(
  executable: "rg" | "grep",
  words: readonly string[],
  context: AutoSafeContext,
): Promise<AutoSafeDecision> {
  const paths: string[] = [];
  let patternProvided = false;
  let filesOnly = false;
  let endOptions = false;
  for (let index = 1; index < words.length; index += 1) {
    const token = words[index] ?? "";
    if (!endOptions && token === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && token.startsWith("--")) {
      const name = optionName(token);
      const inlineValue = token.includes("=");
      const flags = executable === "rg" ? SAFE_RG_FLAGS : SAFE_GREP_FLAGS;
      const valueOptions =
        executable === "rg" ? SAFE_RG_VALUE_OPTIONS : SAFE_GREP_VALUE_OPTIONS;
      if (flags.has(name)) {
        filesOnly ||= executable === "rg" && name === "--files";
        continue;
      }
      if (!valueOptions.has(name)) {
        return {
          behavior: "ask",
          reason: `${executable} option ${name} is outside ModelHop's audited read-only subset.`,
        };
      }
      const value = inlineValue
        ? token.slice(token.indexOf("=") + 1)
        : words[(index += 1)];
      if (!value) {
        return {
          behavior: "ask",
          reason: `${executable} option ${name} is missing its value.`,
        };
      }
      patternProvided ||= name === "--regexp";
      continue;
    }
    if (!endOptions && token.startsWith("-") && token !== "-") {
      if (executable === "rg") {
        if (/^-e.+/u.test(token)) {
          patternProvided = true;
          continue;
        }
        if (/^-(?:g|t|T|m|A|B|C|j).+/u.test(token)) {
          continue;
        }
        if (
          new Set([
            "-e",
            "-g",
            "-t",
            "-T",
            "-m",
            "-A",
            "-B",
            "-C",
            "-j",
          ]).has(token)
        ) {
          const value = words[(index += 1)];
          if (!value) {
            return {
              behavior: "ask",
              reason: `${token} is missing its value.`,
            };
          }
          patternProvided ||= token === "-e";
          continue;
        }
        if (/^-[0FHILNUShilnoqsvwxc]+$/u.test(token)) {
          continue;
        }
      } else {
        if (/^-e.+/u.test(token)) {
          patternProvided = true;
          continue;
        }
        if (/^-(?:m|A|B|C).+/u.test(token)) {
          continue;
        }
        if (
          new Set(["-e", "-m", "-A", "-B", "-C"]).has(token)
        ) {
          const value = words[(index += 1)];
          if (!value) {
            return {
              behavior: "ask",
              reason: `${token} is missing its value.`,
            };
          }
          patternProvided ||= token === "-e";
          continue;
        }
        if (
          /^-[EFHhILlcnqrsuvwxob]+$/u.test(token) &&
          !token.includes("R")
        ) {
          continue;
        }
      }
      return {
        behavior: "ask",
        reason: `${executable} option ${token} is outside ModelHop's audited read-only subset.`,
      };
    }
    if (!patternProvided && !filesOnly) {
      patternProvided = true;
    } else {
      paths.push(token);
    }
  }
  if (!patternProvided && !filesOnly) {
    return {
      behavior: "ask",
      reason: `${executable} is missing a search pattern.`,
    };
  }
  if (!(await allShellPathsAreSafe(paths, context))) {
    return {
      behavior: "ask",
      reason: `${executable} may read outside the registered workspace roots or from a credential path.`,
    };
  }
  return {
    behavior: "allow",
    reason: `${executable} is restricted to an audited read-only form inside the workspace.`,
  };
}

async function simpleReadCommandDecision(
  words: readonly string[],
  context: AutoSafeContext,
): Promise<AutoSafeDecision | undefined> {
  const executable = path.basename(words[0] ?? "");
  if (executable === "pwd") {
    return words.slice(1).every((token) => /^-[LP]+$/u.test(token))
      ? {
          behavior: "allow",
          reason: "pwd only reports the current workspace directory.",
        }
      : {
          behavior: "ask",
          reason: "pwd contains an unaudited option.",
        };
  }
  if (executable === "rg" || executable === "grep") {
    return searchCommandDecision(executable, words, context);
  }
  if (
    !new Set(["file", "head", "ls", "stat", "tail", "wc"]).has(
      executable,
    )
  ) {
    return undefined;
  }
  const paths: string[] = [];
  let endOptions = false;
  for (const token of words.slice(1)) {
    if (!endOptions && token === "--") {
      endOptions = true;
    } else if (!endOptions && token.startsWith("-") && token !== "-") {
      const name = optionName(token);
      const readsAnOptionFile =
        (executable === "file" &&
          (name === "-f" ||
            name.startsWith("-f") ||
            name === "-m" ||
            name.startsWith("-m") ||
            name === "--files-from" ||
            name === "--magic-file")) ||
        (executable === "wc" && name === "--files0-from") ||
        (executable === "ls" &&
          (name === "--dereference" || /^-[^-]*L/u.test(token)));
      if (readsAnOptionFile) {
        return {
          behavior: "ask",
          reason: `${executable} option ${name} can read an unaudited file or follow unresolved links.`,
        };
      }
      continue;
    } else {
      paths.push(token);
    }
  }
  if (!(await allShellPathsAreSafe(paths, context))) {
    return {
      behavior: "ask",
      reason: `${executable} may read outside the registered workspace roots or from a credential path.`,
    };
  }
  return {
    behavior: "allow",
    reason: `${executable} is a read-only inspection contained inside the workspace.`,
  };
}

function containsStrongSecret(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u.test(value) ||
    /\bsk-[A-Za-z0-9_-]{20,}\b/u.test(value) ||
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u.test(value) ||
    /\b(?:api[-_]?key|access[-_]?token|password|secret)\s*[:=]\s*[^\s]{16,}/iu.test(
      value,
    )
  );
}

async function pathToolDecision(
  toolName: string,
  input: Record<string, unknown>,
  context: AutoSafeContext,
): Promise<AutoSafeDecision> {
  const optionalPathTool =
    toolName === "glob" ||
    toolName === "grep" ||
    toolName === "ls" ||
    toolName === "search";
  const requestedPath =
    toolName === "lsp"
      ? stringValue(input, "filePath")
      : stringValue(input, "file_path", "path", "notebook_path");
  if (!requestedPath && !optionalPathTool) {
    return {
      behavior: "ask",
      reason: "The tool request is missing its canonical workspace path.",
    };
  }
  const canonical = await canonicalWorkspacePath(
    requestedPath ?? ".",
    context,
  );
  if (!canonical) {
    return {
      behavior: "ask",
      reason: "The requested path is outside the registered workspace roots.",
    };
  }
  if (isCredentialPath(canonical)) {
    return {
      behavior: "ask",
      reason: "The requested path may contain credentials or signing material.",
    };
  }
  return {
    behavior: "allow",
    reason: WORKSPACE_WRITE_TOOLS.has(toolName)
      ? "The edit is contained inside a registered workspace root."
      : "The read is contained inside a registered workspace root.",
  };
}

/**
 * Deterministic host-side policy for ModelHop Remote's Auto-safe mode.
 * Unknown or ambiguous actions always fail closed into a phone approval.
 */
export async function classifyAutoSafeTool(
  rawToolName: string,
  rawInput: unknown,
  context: AutoSafeContext,
): Promise<AutoSafeDecision> {
  const toolName = rawToolName.trim().toLowerCase();
  const input = isRecord(rawInput) ? rawInput : {};
  if (WORKSPACE_READ_TOOLS.has(toolName) || WORKSPACE_WRITE_TOOLS.has(toolName)) {
    return pathToolDecision(toolName, input, context);
  }
  if (toolName === "websearch") {
    const query = stringValue(input, "query");
    if (!query || containsStrongSecret(query)) {
      return {
        behavior: "ask",
        reason: "The search is empty or appears to contain credential material.",
      };
    }
    return {
      behavior: "allow",
      reason: "Web search is a read-only public research action.",
    };
  }
  if (toolName === "webfetch") {
    const url = stringValue(input, "url");
    return url && (await isPublicResearchTarget(url))
      ? {
          behavior: "allow",
          reason: "The fetch targets a public HTTP(S) URL and does not write externally.",
        }
      : {
          behavior: "ask",
          reason: "The fetch may target an internal, private, authenticated, or non-HTTP resource.",
        };
  }
  if (toolName === "bash") {
    const command = stringValue(input, "command") ?? "";
    const words = shellWords(command);
    const curlDecision = await curlResearchDecision(command);
    if (curlDecision) {
      return curlDecision;
    }
    const readDecision = words
      ? await simpleReadCommandDecision(words, context)
      : undefined;
    return (
      readDecision ?? {
        behavior: "ask",
        reason: "Shell commands run only when their effects are deterministically read-only; this command needs review.",
      }
    );
  }
  if (ORCHESTRATION_TOOLS.has(toolName)) {
    return {
      behavior: "ask",
      reason: "The first orchestration request needs confirmation; its child actions remain independently mediated.",
      sessionRememberable: true,
    };
  }
  if (INTERNAL_TOOLS.has(toolName)) {
    return {
      behavior: "allow",
      reason: "This action only updates Claude Code's in-session working state.",
    };
  }
  return {
    behavior: "ask",
    reason: "Unknown and dynamic tools require explicit approval.",
  };
}
