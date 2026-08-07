/// <reference lib="dom" />

// markdown-it is bundled into the remote client. The small parser surface
// used here is narrowed below before any tokens reach the DOM renderer.
import MarkdownItPackage from "markdown-it";

const MAX_REFERENCE_LENGTH = 4_096;
const MAX_LINE_NUMBER = 10_000_000;
const PLAIN_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "dart",
  "diff",
  "env",
  "gif",
  "go",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "less",
  "lock",
  "log",
  "lua",
  "m",
  "md",
  "mdx",
  "mjs",
  "mm",
  "php",
  "plist",
  "png",
  "proto",
  "ps1",
  "py",
  "rb",
  "rs",
  "rst",
  "sass",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zig",
]);
const SPECIAL_PLAIN_FILE_NAMES = new Set([
  "changelog",
  "containerfile",
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

interface MarkdownToken {
  type: string;
  tag: string;
  content: string;
  info: string;
  hidden: boolean;
  children: MarkdownToken[] | null;
  attrGet(name: string): string | null;
}

interface MarkdownParser {
  parse(source: string, environment: Record<string, never>): MarkdownToken[];
  parseInline(
    source: string,
    environment: Record<string, never>,
  ): MarkdownToken[];
}

type MarkdownParserConstructor = new (options: {
  html: boolean;
  linkify: boolean;
  typographer: boolean;
  breaks: boolean;
}) => MarkdownParser;

const MarkdownIt = MarkdownItPackage as unknown as MarkdownParserConstructor;

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

export interface MarkdownWorkspaceReference {
  kind: "workspace";
  path: string;
  line?: number;
  endLine?: number;
}

export interface MarkdownExternalReference {
  kind: "external";
  href: string;
}

export type MarkdownReference =
  | MarkdownWorkspaceReference
  | MarkdownExternalReference;

export interface MarkdownRenderCallbacks {
  onWorkspaceFile?: (
    reference: MarkdownWorkspaceReference,
  ) => void | Promise<void>;
  onWorkspaceImage?: (
    reference: MarkdownWorkspaceReference,
  ) => void | Promise<void>;
  onActionError?: (error: unknown) => void;
}

export interface SafeMarkdownRenderer {
  renderBlock(target: HTMLElement, source: string): void;
  renderInline(target: HTMLElement, source: string): void;
}

interface RenderFrame {
  node: Node;
  tokenType: string;
}

const BLOCK_ELEMENTS: Readonly<Record<string, keyof HTMLElementTagNameMap>> = {
  paragraph_open: "p",
  blockquote_open: "blockquote",
  bullet_list_open: "ul",
  ordered_list_open: "ol",
  list_item_open: "li",
  table_open: "table",
  thead_open: "thead",
  tbody_open: "tbody",
  tr_open: "tr",
  th_open: "th",
  td_open: "td",
};

const INLINE_ELEMENTS: Readonly<Record<string, keyof HTMLElementTagNameMap>> = {
  em_open: "em",
  strong_open: "strong",
  s_open: "del",
};

const BLOCK_CLOSE_TO_OPEN: Readonly<Record<string, string>> = {
  paragraph_close: "paragraph_open",
  heading_close: "heading_open",
  blockquote_close: "blockquote_open",
  bullet_list_close: "bullet_list_open",
  ordered_list_close: "ordered_list_open",
  list_item_close: "list_item_open",
  table_close: "table_open",
  thead_close: "thead_open",
  tbody_close: "tbody_open",
  tr_close: "tr_open",
  th_close: "th_open",
  td_close: "td_open",
};

const INLINE_CLOSE_TO_OPEN: Readonly<Record<string, string>> = {
  em_close: "em_open",
  strong_close: "strong_open",
  s_close: "s_open",
  link_close: "link_open",
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validLine(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,8}$/u.test(value)) {
    return undefined;
  }
  const line = Number(value);
  return Number.isSafeInteger(line) && line >= 1 && line <= MAX_LINE_NUMBER
    ? line
    : undefined;
}

function localPathAndLines(value: string): {
  path: string;
  line?: number;
  endLine?: number;
  invalidLineSuffix?: boolean;
} {
  let path = value;
  let line: number | undefined;
  let endLine: number | undefined;
  let invalidLineSuffix = false;

  const hashIndex = path.lastIndexOf("#");
  if (hashIndex >= 0) {
    const fragment = path.slice(hashIndex + 1);
    path = path.slice(0, hashIndex);
    const match = /^L(\d{1,8})(?:-L?(\d{1,8}))?$/iu.exec(fragment);
    const first = validLine(match?.[1]);
    const last = validLine(match?.[2]);
    const hasLast = match?.[2] !== undefined;
    if (
      first !== undefined &&
      (!hasLast || (last !== undefined && last >= first))
    ) {
      line = first;
      endLine = last;
    } else if (/^L\d/iu.test(fragment)) {
      invalidLineSuffix = true;
    }
  }

  if (line === undefined && !invalidLineSuffix) {
    const match = /^(.*):(\d{1,12})$/u.exec(path);
    const parsedLine = validLine(match?.[2]);
    if (match?.[1] && parsedLine !== undefined) {
      path = match[1];
      line = parsedLine;
    } else if (match?.[1]) {
      invalidLineSuffix = true;
    }
  }

  return {
    path: safeDecode(path),
    line,
    endLine,
    invalidLineSuffix,
  };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) {
      return true;
    }
  }
  return false;
}

function workspaceReference(
  local: ReturnType<typeof localPathAndLines>,
): MarkdownWorkspaceReference | undefined {
  const normalizedPath = local.path.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/");
  const isWindowsDriveAbsolute = /^[a-z]:\//iu.test(normalizedPath);
  if (
    !local.path ||
    local.invalidLineSuffix ||
    hasControlCharacters(local.path) ||
    local.path === "." ||
    local.path === ".." ||
    pathSegments.includes("..") ||
    normalizedPath.startsWith("//") ||
    (!isWindowsDriveAbsolute &&
      /^[a-z][a-z\d+.-]*:/iu.test(local.path))
  ) {
    return undefined;
  }
  return {
    kind: "workspace",
    path: local.path,
    ...(local.line === undefined ? {} : { line: local.line }),
    ...(local.endLine === undefined ? {} : { endLine: local.endLine }),
  };
}

/**
 * Classifies a Markdown destination without ever turning a workspace path
 * into a browser URL. Only HTTP(S) is considered externally navigable.
 */
export function parseMarkdownReference(
  destination: string,
): MarkdownReference | undefined {
  let value = destination.trim();
  if (
    value.length === 0 ||
    value.length > MAX_REFERENCE_LENGTH ||
    hasControlCharacters(value)
  ) {
    return undefined;
  }
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        !url.hostname
      ) {
        return undefined;
      }
      return { kind: "external", href: url.href };
    } catch {
      return undefined;
    }
  }

  if (/^file:/iu.test(value)) {
    try {
      const rawFilePath = safeDecode(value.slice("file:".length))
        .split(/[?#]/u, 1)[0]
        ?.replaceAll("\\", "/");
      if (rawFilePath?.split("/").includes("..")) {
        return undefined;
      }
      const url = new URL(value);
      if (
        url.protocol !== "file:" ||
        url.search ||
        (url.hostname && url.hostname !== "localhost")
      ) {
        return undefined;
      }
      const decodedPathname = safeDecode(url.pathname);
      const platformPathname = /^\/[a-z]:\//iu.test(decodedPathname)
        ? decodedPathname.slice(1)
        : decodedPathname;
      const local = localPathAndLines(`${platformPathname}${url.hash}`);
      return workspaceReference(local);
    } catch {
      return undefined;
    }
  }

  const local = localPathAndLines(value);
  return workspaceReference(local);
}

function inlineCodeWorkspaceReference(
  value: string,
): MarkdownWorkspaceReference | undefined {
  const reference = parseMarkdownReference(value);
  if (reference?.kind !== "workspace") {
    return undefined;
  }
  const basename = reference.path.split(/[\\/]/u).at(-1) ?? "";
  const recognisableFile =
    /\.[a-z\d]{1,16}$/iu.test(basename) ||
    /^(?:readme|license|makefile|dockerfile|changelog)$/iu.test(basename);
  return recognisableFile ? reference : undefined;
}

function recognisablePlainFileReference(
  value: string,
): MarkdownWorkspaceReference | undefined {
  const reference = parseMarkdownReference(value);
  if (reference?.kind !== "workspace") {
    return undefined;
  }
  const basename = reference.path.split(/[\\/]/u).at(-1) ?? "";
  const normalizedBasename = basename.toLowerCase();
  const extension = normalizedBasename.includes(".")
    ? normalizedBasename.split(".").at(-1)
    : undefined;
  return (extension && PLAIN_FILE_EXTENSIONS.has(extension)) ||
    SPECIAL_PLAIN_FILE_NAMES.has(normalizedBasename)
    ? reference
    : undefined;
}

export interface PlainTextWorkspaceReferenceMatch {
  start: number;
  end: number;
  label: string;
  reference: MarkdownWorkspaceReference;
}

/**
 * Finds conservative, whitespace-free file references in ordinary prose.
 * Paths containing spaces remain supported through Markdown links/backticks,
 * where the parser provides an unambiguous destination.
 */
export function plainTextWorkspaceReferences(
  value: string,
): PlainTextWorkspaceReferenceMatch[] {
  const matches: PlainTextWorkspaceReferenceMatch[] = [];
  const candidatePattern =
    /(?:file:\/\/\/|\/[\w@%+.,~:-]+\/|@[\w.-]+\/|[a-z]:[\\/]|(?:\.{1,2}[\\/])?|[\w@%+.,~-]+[\\/])?[\w@%+.,~(){}-]+(?:[\\/][\w@%+.,~(){}-]+)*\.[a-z\d]{1,12}(?:(?:#L\d{1,8})(?:-L?\d{1,8})?|:\d{1,8})?|(?:README|CHANGELOG|LICENSE|Makefile|Dockerfile|Containerfile|Gemfile|Procfile)(?:(?:#L\d{1,8})(?:-L?\d{1,8})?|:\d{1,8})?/giu;
  for (const match of value.matchAll(candidatePattern)) {
    if (match.index === undefined) {
      continue;
    }
    const label = match[0];
    const before = value[match.index - 1];
    const after = value[match.index + label.length];
    const afterNext = value[match.index + label.length + 1];
    // Avoid matching the path portion of URLs, email addresses, identifiers,
    // or a longer token that the expression deliberately stopped parsing.
    if (
      (before && /[\w@:/.-]/u.test(before)) ||
      (after && /[\w@/-]/u.test(after)) ||
      (after === "." && afterNext !== undefined && /[a-z\d]/iu.test(afterNext))
    ) {
      continue;
    }
    const reference = recognisablePlainFileReference(label);
    if (!reference) {
      continue;
    }
    matches.push({
      start: match.index,
      end: match.index + label.length,
      label,
      reference,
    });
  }
  return matches;
}

function popFrame(
  frames: RenderFrame[],
  expectedOpenType: string | undefined,
): void {
  if (!expectedOpenType || frames.length <= 1) {
    return;
  }
  const top = frames.at(-1);
  if (top?.tokenType === expectedOpenType) {
    frames.pop();
  }
}

function appendText(document: Document, parent: Node, value: string): void {
  parent.appendChild(document.createTextNode(value));
}

function appendTextWithWorkspaceReferences(
  document: Document,
  parent: Node,
  value: string,
  callbacks: MarkdownRenderCallbacks,
): void {
  if (hasInteractiveAncestor(parent)) {
    appendText(document, parent, value);
    return;
  }
  const matches = plainTextWorkspaceReferences(value);
  if (matches.length === 0) {
    appendText(document, parent, value);
    return;
  }
  let offset = 0;
  for (const match of matches) {
    appendText(document, parent, value.slice(offset, match.start));
    const button = workspaceButton(
      document,
      match.reference,
      "file",
      callbacks,
    );
    button.classList.add("markdown-bare-reference");
    button.textContent = match.label;
    button.setAttribute("aria-label", `Open file ${match.label}`);
    parent.appendChild(button);
    offset = match.end;
  }
  appendText(document, parent, value.slice(offset));
}

function hasInteractiveAncestor(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === 1) {
      const tagName = (current as Element).tagName.toLowerCase();
      if (tagName === "a" || tagName === "button") {
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

function imageLabel(
  document: Document,
  alternative: string,
): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "markdown-image-label";
  const icon = document.createElement("span");
  icon.className = "markdown-image-icon";
  icon.setAttribute("aria-hidden", "true");
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("focusable", "false");
  const frame = document.createElementNS(namespace, "path");
  frame.setAttribute(
    "d",
    "M5.25 4.5h13.5c.97 0 1.75.78 1.75 1.75v11.5c0 .97-.78 1.75-1.75 1.75H5.25c-.97 0-1.75-.78-1.75-1.75V6.25c0-.97.78-1.75 1.75-1.75Z",
  );
  const landscape = document.createElementNS(namespace, "path");
  landscape.setAttribute(
    "d",
    "m5.25 17 4.1-4.1 2.65 2.65 2.15-2.15 4.6 4.6M16.25 9.1h.01",
  );
  svg.append(frame, landscape);
  icon.append(svg);
  const label = document.createElement("span");
  label.textContent = alternative;
  wrap.append(icon, label);
  return wrap;
}

function invokeAction(
  callback: (() => void | Promise<void>) | undefined,
  onError: ((error: unknown) => void) | undefined,
): void {
  if (!callback) {
    return;
  }
  try {
    const result = callback();
    if (result instanceof Promise) {
      void result.catch((error: unknown) => onError?.(error));
    }
  } catch (error) {
    onError?.(error);
  }
}

function workspaceButton(
  document: Document,
  reference: MarkdownWorkspaceReference,
  kind: "file" | "image",
  callbacks: MarkdownRenderCallbacks,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `markdown-workspace-${kind}`;
  button.dataset.path = reference.path;
  if (reference.line !== undefined) {
    button.dataset.line = String(reference.line);
  }
  if (reference.endLine !== undefined) {
    button.dataset.endLine = String(reference.endLine);
  }
  button.addEventListener("click", () => {
    const callback =
      kind === "image"
        ? callbacks.onWorkspaceImage
        : callbacks.onWorkspaceFile;
    invokeAction(
      callback ? () => callback(reference) : undefined,
      callbacks.onActionError,
    );
  });
  return button;
}

function externalAnchor(
  document: Document,
  reference: MarkdownExternalReference,
  title: string | null,
): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = reference.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.referrerPolicy = "no-referrer";
  anchor.className = "markdown-external-link";
  if (title) {
    anchor.title = title.slice(0, 512);
  }
  return anchor;
}

function renderImageToken(
  document: Document,
  parent: Node,
  token: MarkdownToken,
  callbacks: MarkdownRenderCallbacks,
): void {
  const destination = token.attrGet("src") ?? "";
  const reference = parseMarkdownReference(destination);
  const suppliedAlternative = token.content.trim();
  const alternative =
    suppliedAlternative ||
    (reference?.kind === "workspace"
      ? reference.path.split("/").at(-1) ?? reference.path
      : "Image");
  if (hasInteractiveAncestor(parent)) {
    parent.appendChild(imageLabel(document, alternative));
    return;
  }
  if (reference?.kind === "workspace") {
    const button = workspaceButton(
      document,
      reference,
      "image",
      callbacks,
    );
    button.setAttribute("aria-label", `Open image ${alternative}`);
    button.appendChild(imageLabel(document, alternative));
    parent.appendChild(button);
    return;
  }
  if (reference?.kind === "external") {
    const anchor = externalAnchor(
      document,
      reference,
      token.attrGet("title"),
    );
    anchor.textContent = `Image: ${alternative}`;
    parent.appendChild(anchor);
    return;
  }
  appendText(document, parent, `[Image: ${alternative}]`);
}

function renderInlineTokens(
  document: Document,
  tokens: readonly MarkdownToken[],
  parent: Node,
  callbacks: MarkdownRenderCallbacks,
): void {
  const frames: RenderFrame[] = [
    { node: parent, tokenType: "inline_root" },
  ];
  for (const token of tokens) {
    const current = frames.at(-1)?.node ?? parent;
    const elementName = INLINE_ELEMENTS[token.type];
    if (elementName) {
      const element = document.createElement(elementName);
      current.appendChild(element);
      frames.push({ node: element, tokenType: token.type });
      continue;
    }
    const closeType = INLINE_CLOSE_TO_OPEN[token.type];
    if (closeType) {
      popFrame(frames, closeType);
      continue;
    }
    switch (token.type) {
      case "text":
      case "text_special":
        appendTextWithWorkspaceReferences(
          document,
          current,
          token.content,
          callbacks,
        );
        break;
      case "code_inline": {
        const reference = inlineCodeWorkspaceReference(token.content);
        if (reference) {
          const button = workspaceButton(
            document,
            reference,
            "file",
            callbacks,
          );
          button.classList.add("markdown-code-reference");
          const code = document.createElement("code");
          code.textContent = token.content;
          button.appendChild(code);
          current.appendChild(button);
          break;
        }
        const code = document.createElement("code");
        code.textContent = token.content;
        current.appendChild(code);
        break;
      }
      case "softbreak":
        appendText(document, current, "\n");
        break;
      case "hardbreak":
        current.appendChild(document.createElement("br"));
        break;
      case "link_open": {
        const destination = token.attrGet("href") ?? "";
        const reference = parseMarkdownReference(destination);
        if (reference?.kind === "workspace") {
          const button = workspaceButton(
            document,
            reference,
            "file",
            callbacks,
          );
          current.appendChild(button);
          frames.push({ node: button, tokenType: token.type });
        } else if (reference?.kind === "external") {
          const anchor = externalAnchor(
            document,
            reference,
            token.attrGet("title"),
          );
          current.appendChild(anchor);
          frames.push({ node: anchor, tokenType: token.type });
        } else {
          const span = document.createElement("span");
          span.className = "markdown-invalid-link";
          current.appendChild(span);
          frames.push({ node: span, tokenType: token.type });
        }
        break;
      }
      case "image":
        renderImageToken(document, current, token, callbacks);
        break;
      case "html_inline":
        appendText(document, current, token.content);
        break;
      default:
        if (token.content) {
          appendText(document, current, token.content);
        }
        break;
    }
  }
}

function renderBlockTokens(
  document: Document,
  tokens: readonly MarkdownToken[],
  parent: Node,
  callbacks: MarkdownRenderCallbacks,
): void {
  const frames: RenderFrame[] = [
    { node: parent, tokenType: "block_root" },
  ];
  for (const token of tokens) {
    const current = frames.at(-1)?.node ?? parent;
    if (token.type === "heading_open") {
      const headingName =
        token.tag === "h1"
          ? "h3"
          : token.tag === "h2"
            ? "h4"
            : token.tag === "h3"
              ? "h5"
              : "h6";
      const heading = document.createElement(headingName);
      current.appendChild(heading);
      frames.push({ node: heading, tokenType: token.type });
      continue;
    }
    if (token.type === "heading_close") {
      popFrame(frames, "heading_open");
      continue;
    }
    const elementName = BLOCK_ELEMENTS[token.type];
    if (elementName) {
      const element = token.hidden
        ? current
        : document.createElement(elementName);
      if (!token.hidden) {
        if (token.type === "ordered_list_open") {
          const start = validLine(token.attrGet("start") ?? undefined);
          if (start !== undefined && element instanceof HTMLOListElement) {
            element.start = start;
          }
        }
        current.appendChild(element);
      }
      frames.push({ node: element, tokenType: token.type });
      continue;
    }
    const closeType = BLOCK_CLOSE_TO_OPEN[token.type];
    if (closeType) {
      popFrame(frames, closeType);
      continue;
    }
    switch (token.type) {
      case "inline":
        renderInlineTokens(
          document,
          token.children ?? [],
          current,
          callbacks,
        );
        break;
      case "fence":
      case "code_block": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        const language = token.info
          .trim()
          .split(/\s+/u)[0]
          ?.replace(/[^a-z\d_-]/giu, "")
          .slice(0, 64);
        if (language) {
          code.className = `language-${language}`;
        }
        code.textContent = token.content;
        pre.appendChild(code);
        current.appendChild(pre);
        break;
      }
      case "hr":
        current.appendChild(document.createElement("hr"));
        break;
      case "html_block":
        appendText(document, current, token.content);
        break;
      default:
        if (token.content) {
          appendText(document, current, token.content);
        }
        break;
    }
  }
}

/**
 * Creates a Markdown renderer that never materialises parser-produced HTML.
 * Every element and attribute is created from the fixed allowlists above.
 */
export function createSafeMarkdownRenderer(
  document: Document,
  callbacks: MarkdownRenderCallbacks = {},
): SafeMarkdownRenderer {
  return {
    renderBlock(target, source) {
      const fragment = document.createDocumentFragment();
      renderBlockTokens(
        document,
        parser.parse(source, {}),
        fragment,
        callbacks,
      );
      target.replaceChildren(fragment);
    },
    renderInline(target, source) {
      const fragment = document.createDocumentFragment();
      const tokens = parser.parseInline(source, {});
      for (const token of tokens) {
        if (token.type === "inline") {
          renderInlineTokens(
            document,
            token.children ?? [],
            fragment,
            callbacks,
          );
        } else if (token.content) {
          appendText(document, fragment, token.content);
        }
      }
      target.replaceChildren(fragment);
    },
  };
}
