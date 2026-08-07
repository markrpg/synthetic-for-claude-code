import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  RemoteFilePreview,
  RemoteFileReferencePreview,
} from "./types.js";
import {
  MAX_REMOTE_ATTACHMENT_BYTES,
  MAX_REMOTE_FILE_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  resolveWorkspaceFile,
  validateReadableFile,
} from "./pathPolicy.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_RESULTS = 5_000;
const MAX_DIRECTORY_PAGE_SIZE = 100;
const MAX_SYMBOL_RESULTS = 500;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_REFERENCE_POSITION = 10_000_000;
const MAX_REFERENCE_SCAN_ENTRIES = 50_000;
const PREVIEW_READ_CHUNK_BYTES = 64 * 1024;
const DIRECTORY_CURSOR_VERSION = "v1";
const PROTECTED_REMOTE_DIRECTORIES = new Set([
  ".git",
  ".modelhop-remote",
]);
const IMAGE_MEDIA_TYPES = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function hasProtectedRemoteSegment(requestedPath: string): boolean {
  return requestedPath
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) =>
      PROTECTED_REMOTE_DIRECTORIES.has(segment.toLowerCase()),
    );
}

function parseDirectoryCursor(cursor: string | undefined): {
  offset: number;
  revision?: string;
} {
  if (cursor === undefined) {
    return { offset: 0 };
  }
  const match = /^v1\.([1-9]\d*)\.([a-f\d]{32})$/u.exec(cursor);
  const offset = match?.[1] === undefined ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || !match?.[2]) {
    throw new Error("The directory cursor is invalid.");
  }
  return { offset, revision: match[2] };
}

function directoryRevision(
  rootId: string,
  requestedPath: string,
  nodes: readonly RemoteWorkspaceNode[],
  omittedEntries: RemoteDirectoryPage["omittedEntries"],
): string {
  const hash = createHash("sha256");
  hash.update(DIRECTORY_CURSOR_VERSION);
  hash.update("\0");
  hash.update(rootId);
  hash.update("\0");
  hash.update(requestedPath);
  for (const node of nodes) {
    hash.update("\0");
    hash.update(node.kind);
    hash.update("\0");
    hash.update(node.path);
  }
  hash.update("\0");
  hash.update(String(omittedEntries.protected));
  hash.update("\0");
  hash.update(String(omittedEntries.unavailable));
  hash.update("\0");
  hash.update(String(omittedEntries.unsupported));
  return hash.digest("hex").slice(0, 32);
}

function directoryCursor(offset: number, revision: string): string {
  return `${DIRECTORY_CURSOR_VERSION}.${String(offset)}.${revision}`;
}

class ProtectedRemotePathError extends Error {
  public constructor() {
    super("Protected repository metadata cannot be viewed remotely.");
  }
}

function assertRemotePathIsBrowsable(requestedPath: string): void {
  if (hasProtectedRemoteSegment(requestedPath)) {
    throw new ProtectedRemotePathError();
  }
}

export interface RemoteWorkspaceSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  preview: string;
}

export interface RemoteWorkspaceRoot {
  id: string;
  label: string;
}

export interface RemoteWorkspaceNode {
  rootId: string;
  name: string;
  path: string;
  displayPath: string;
  kind: "directory" | "file";
  extension?: string;
  size?: number;
  hasChildren: boolean;
}

export interface RemoteDirectoryPage {
  root: RemoteWorkspaceRoot;
  path: string;
  parentPath?: string;
  nodes: RemoteWorkspaceNode[];
  totalEntries: number;
  omittedEntries: {
    protected: number;
    unavailable: number;
    unsupported: number;
  };
  nextCursor?: string;
}

interface WorkspaceRoot {
  id: string;
  path: string;
  prefix: string;
  label: string;
}

export interface ParsedRemoteFileReference {
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
}

function referencePosition(value: string, label: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_REFERENCE_POSITION
  ) {
    throw new Error(`Invalid file reference ${label}.`);
  }
  return parsed;
}

function parseLineFragment(
  value: string,
): Pick<ParsedRemoteFileReference, "line" | "endLine"> | undefined {
  const match = value.match(/^#L([1-9]\d*)(?:-L?([1-9]\d*))?$/iu);
  if (!match?.[1]) {
    return undefined;
  }
  const line = referencePosition(match[1], "line");
  const endLine = match[2]
    ? referencePosition(match[2], "ending line")
    : undefined;
  if (endLine !== undefined && endLine < line) {
    throw new Error(
      "The file reference ending line precedes its starting line.",
    );
  }
  return { line, endLine };
}

export function parseRemoteFileReference(
  reference: string,
): ParsedRemoteFileReference {
  let requestedPath = reference.trim();
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("Invalid file reference.");
  }
  let line: number | undefined;
  let endLine: number | undefined;
  let column: number | undefined;
  const fromFileUrl = /^file:/iu.test(requestedPath);
  if (fromFileUrl) {
    let fileUrl: URL;
    try {
      fileUrl = new URL(requestedPath);
    } catch {
      throw new Error("Invalid file URL.");
    }
    if (fileUrl.protocol !== "file:" || fileUrl.search) {
      throw new Error("Invalid file URL.");
    }
    if (fileUrl.hash) {
      const fragment = parseLineFragment(fileUrl.hash);
      if (!fragment) {
        throw new Error("Unsupported file reference fragment.");
      }
      ({ line, endLine } = fragment);
      fileUrl.hash = "";
    }
    try {
      requestedPath = fileURLToPath(fileUrl);
    } catch {
      throw new Error("Invalid file URL.");
    }
  } else {
    const fragmentMatch = requestedPath.match(
      /#L([1-9]\d*)(?:-L?([1-9]\d*))?$/iu,
    );
    if (fragmentMatch?.[1]) {
      const fragment = parseLineFragment(fragmentMatch[0]);
      if (fragment) {
        ({ line, endLine } = fragment);
      }
      requestedPath = requestedPath.slice(
        0,
        -fragmentMatch[0].length,
      );
    }
    const isWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(
      requestedPath,
    );
    if (
      !isWindowsAbsolute &&
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(requestedPath)
    ) {
      throw new Error("Unsupported file reference scheme.");
    }
  }

  if (line === undefined) {
    const suffix = requestedPath.match(
      /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/u,
    );
    if (suffix?.[1] && suffix[2]) {
      requestedPath = suffix[1];
      line = referencePosition(suffix[2], "line");
      column = suffix[3]
        ? referencePosition(suffix[3], "column")
        : undefined;
    }
  }

  if (!fromFileUrl) {
    try {
      requestedPath = decodeURIComponent(requestedPath);
    } catch {
      throw new Error("Invalid encoded file reference.");
    }
  }
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("Invalid file reference.");
  }
  if (requestedPath.replaceAll("\\", "/").startsWith("//")) {
    throw new Error("Network file references are unsupported.");
  }
  return { path: requestedPath, line, endLine, column };
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function hasBinaryBytes(value: Buffer): boolean {
  const sample = value.subarray(0, Math.min(value.length, 8_192));
  return sample.includes(0);
}

function unavailablePathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function readBoundedFile(
  absolutePath: string,
  maximumBytes: number,
  limitMessage: string,
): Promise<Buffer> {
  const handle = await open(
    absolutePath,
    fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
  );
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new Error("The requested path is not a regular file.");
    }

    const chunks: Buffer[] = [];
    let position = 0;
    while (position <= maximumBytes) {
      const remaining = maximumBytes + 1 - position;
      const chunk = Buffer.allocUnsafe(
        Math.min(PREVIEW_READ_CHUNK_BYTES, remaining),
      );
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        position,
      );
      if (bytesRead === 0) {
        return Buffer.concat(chunks, position);
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
      if (position > maximumBytes) {
        throw new Error(limitMessage);
      }
    }
    throw new Error(limitMessage);
  } finally {
    await handle.close();
  }
}

function normalizedReferenceSuffix(requestedPath: string): string {
  return path.posix
    .normalize(requestedPath.replaceAll("\\", "/"))
    .replace(/^\.\//u, "");
}

function referenceSuffixMatches(
  candidatePath: string,
  requestedSuffix: string,
): boolean {
  return (
    candidatePath === requestedSuffix ||
    candidatePath.endsWith(`/${requestedSuffix}`)
  );
}

function safeAttachmentName(name: string): string {
  const clean = path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 120);
  return clean || "attachment";
}

function workspaceLabel(workspacePath: string): string {
  return (
    path
      .basename(workspacePath)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 80) || "workspace"
  );
}

export class RemoteWorkspaceReader {
  private readonly roots: WorkspaceRoot[];

  public constructor(
    private readonly workspacePath: string,
    private readonly uploadDirectory: string,
    additionalWorkspacePaths: readonly string[] = [],
  ) {
    const uniquePaths = [
      workspacePath,
      ...additionalWorkspacePaths,
    ].filter(
      (candidate, index, all) =>
        candidate.length > 0 && all.indexOf(candidate) === index,
    );
    const usedLabels = new Set<string>();
    this.roots = uniquePaths.map((rootPath, index) => {
      const base = workspaceLabel(rootPath);
      let label = base;
      let suffix = 2;
      while (usedLabels.has(label)) {
        label = `${base}-${suffix}`;
        suffix += 1;
      }
      usedLabels.add(label);
      return {
        id: index === 0 ? "primary" : label,
        path: rootPath,
        label,
        prefix: index === 0 ? "" : `@${label}/`,
      };
    });
  }

  public workspaceRoots(): RemoteWorkspaceRoot[] {
    return this.roots.map(({ id, label }) => ({ id, label }));
  }

  public async listDirectory(
    rootId = "primary",
    requestedPath = "",
    cursor?: string,
    requestedPageSize = 64,
  ): Promise<RemoteDirectoryPage> {
    const root = this.roots.find((candidate) => candidate.id === rootId);
    if (!root) {
      throw new Error("The requested workspace root is unavailable.");
    }
    const relativePath = requestedPath
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, "");
    assertRemotePathIsBrowsable(relativePath);
    const directory = await resolveWorkspaceFile(
      root.path,
      relativePath || ".",
    );
    const details = await stat(directory);
    if (!details.isDirectory()) {
      throw new Error("The requested path is not a directory.");
    }
    const parsedCursor = parseDirectoryCursor(cursor);
    const pageSize = Math.max(
      1,
      Math.min(MAX_DIRECTORY_PAGE_SIZE, requestedPageSize),
    );
    const nodes: RemoteWorkspaceNode[] = [];
    const resolvedWorkspace = await realpath(root.path);
    let protectedEntries = 0;
    let unavailableEntries = 0;
    let unsupportedEntries = 0;
    for (const entry of await readdir(directory, {
      withFileTypes: true,
    })) {
      if (PROTECTED_REMOTE_DIRECTORIES.has(entry.name.toLowerCase())) {
        protectedEntries += 1;
        continue;
      }
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const entryRelativePath = path
        .join(relativePath, entry.name)
        .split(path.sep)
        .join("/");
      try {
        const absolutePath = await resolveWorkspaceFile(
          root.path,
          entryRelativePath,
        );
        assertRemotePathIsBrowsable(
          path.relative(resolvedWorkspace, absolutePath),
        );
        const entryDetails = await stat(absolutePath);
        if (!entryDetails.isDirectory() && !entryDetails.isFile()) {
          unsupportedEntries += 1;
          continue;
        }
        const kind = entryDetails.isDirectory()
          ? "directory"
          : "file";
        nodes.push({
          rootId: root.id,
          name: entry.name,
          path: entryRelativePath,
          displayPath: `${root.prefix}${entryRelativePath}`,
          kind,
          extension:
            kind === "file"
              ? path.extname(entry.name).slice(1).toLowerCase() ||
                undefined
              : undefined,
          size: kind === "file" ? entryDetails.size : undefined,
          hasChildren: kind === "directory",
        });
      } catch (error) {
        // Escaped, broken, or unreadable entries remain accounted for in
        // omittedEntries so the client never presents a silently partial list.
        if (error instanceof ProtectedRemotePathError) {
          protectedEntries += 1;
        } else {
          unavailableEntries += 1;
        }
      }
    }
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
    const omittedEntries = {
      protected: protectedEntries,
      unavailable: unavailableEntries,
      unsupported: unsupportedEntries,
    };
    const revision = directoryRevision(
      root.id,
      relativePath,
      nodes,
      omittedEntries,
    );
    if (
      parsedCursor.revision !== undefined &&
      parsedCursor.revision !== revision
    ) {
      throw new Error(
        "The directory changed while it was being loaded. Refresh the folder and try again.",
      );
    }
    const offset = parsedCursor.offset;
    if (offset > nodes.length) {
      throw new Error("The directory cursor is stale.");
    }
    const pageNodes = nodes.slice(offset, offset + pageSize);
    const nextOffset = offset + pageNodes.length;
    return {
      root: { id: root.id, label: root.label },
      path: relativePath,
      parentPath:
        relativePath.length > 0
          ? path
              .dirname(relativePath)
              .split(path.sep)
              .join("/")
              .replace(/^\.$/, "")
          : undefined,
      nodes: pageNodes,
      totalEntries: nodes.length,
      omittedEntries,
      nextCursor:
        nextOffset < nodes.length
          ? directoryCursor(nextOffset, revision)
          : undefined,
    };
  }

  public async searchFiles(query = ""): Promise<string[]> {
    const needle = query.trim().toLowerCase();
    const files: string[] = [];
    for (const root of this.roots) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          [
            "-C",
            root.path,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ],
          {
            encoding: "buffer",
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        for (const candidate of Buffer.from(stdout)
          .toString("utf8")
          .split("\0")
          .filter(Boolean)) {
          if (hasProtectedRemoteSegment(candidate)) {
            continue;
          }
          const displayed = `${root.prefix}${candidate}`;
          if (
            !needle ||
            displayed.toLowerCase().includes(needle)
          ) {
            files.push(displayed);
          }
          if (files.length >= MAX_FILE_RESULTS) {
            return files;
          }
        }
      } catch {
        // A non-git workspace root simply contributes no file results.
      }
    }
    return files;
  }

  public async readFile(requestedPath: string): Promise<RemoteFilePreview> {
    const { root, relativePath } =
      this.resolveRequestedPath(requestedPath);
    return this.readResolvedFile(root, relativePath);
  }

  public async readReference(
    reference: string,
  ): Promise<RemoteFileReferencePreview> {
    const parsed = parseRemoteFileReference(reference);
    const { root, relativePath } =
      await this.resolveReferencePath(parsed.path);
    const preview = await this.readResolvedFile(root, relativePath);
    return {
      ...preview,
      rootId: root.id,
      relativePath: relativePath.split(path.sep).join("/"),
      ...(parsed.line === undefined ? {} : { line: parsed.line }),
      ...(parsed.endLine === undefined
        ? {}
        : { endLine: parsed.endLine }),
      ...(parsed.column === undefined
        ? {}
        : { column: parsed.column }),
    };
  }

  private async readResolvedFile(
    root: WorkspaceRoot,
    relativePath: string,
  ): Promise<RemoteFilePreview> {
    assertRemotePathIsBrowsable(relativePath);
    const { absolutePath } = await validateReadableFile(
      root.path,
      relativePath,
      MAX_REMOTE_IMAGE_BYTES,
    );
    const workspace = await realpath(root.path);
    assertRemotePathIsBrowsable(path.relative(workspace, absolutePath));
    const displayedPath = `${root.prefix}${path.relative(
      workspace,
      absolutePath,
    )}`;
    const extension = path.extname(absolutePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES.get(extension);
    if (mediaType) {
      const content = await readBoundedFile(
        absolutePath,
        MAX_REMOTE_IMAGE_BYTES,
        `Files larger than ${MAX_REMOTE_IMAGE_BYTES / 1024 / 1024} MB cannot be previewed remotely.`,
      );
      return {
        path: displayedPath,
        content: content.toString("base64"),
        size: content.length,
        language: "image",
        mediaType,
        encoding: "base64",
      };
    }
    const content = await readBoundedFile(
      absolutePath,
      MAX_REMOTE_FILE_BYTES,
      `Text files larger than ${MAX_REMOTE_FILE_BYTES / 1024 / 1024} MB cannot be previewed remotely.`,
    );
    if (hasBinaryBytes(content)) {
      throw new Error(
        "Binary files cannot be shown in the text preview.",
      );
    }
    return {
      path: displayedPath,
      content: content.toString("utf8"),
      size: content.length,
      language: extension.slice(1) || "text",
      encoding: "utf8",
    };
  }

  public async searchSymbols(
    query: string,
  ): Promise<RemoteWorkspaceSymbol[]> {
    const needle = query.trim().slice(0, 200);
    if (!needle) {
      throw new Error("Enter a symbol name to search.");
    }
    const escaped = needle.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const identifier = `[A-Za-z0-9_$]*${escaped}[A-Za-z0-9_$]*`;
    const pattern = [
      `\\b(?:class|interface|type|function|def|fn|struct|enum|trait|func|const|let|var)[[:space:]]+${identifier}`,
      `\\b${identifier}[[:space:]]*\\(`,
    ].join("|");
    const symbols: RemoteWorkspaceSymbol[] = [];
    const seenMatches = new Set<string>();
    for (const root of [...this.roots].sort(
      (left, right) => right.path.length - left.path.length,
    )) {
      try {
        const workspace = await realpath(root.path);
        const { stdout } = await execFileAsync(
          "rg",
          [
            "--json",
            "--line-number",
            "--ignore-case",
            "--max-count",
            String(MAX_SYMBOL_RESULTS),
            "--glob",
            "*.{c,cc,cpp,cs,css,go,h,hpp,java,js,jsx,kt,kts,lua,m,mm,php,py,rb,rs,scala,swift,ts,tsx,vue}",
            pattern,
            workspace,
          ],
          {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        for (const entry of stdout.split("\n")) {
          if (!entry) {
            continue;
          }
          const parsed = JSON.parse(entry) as {
            type?: string;
            data?: {
              path?: { text?: string };
              lines?: { text?: string };
              line_number?: number;
            };
          };
          if (
            parsed.type !== "match" ||
            typeof parsed.data?.path?.text !== "string" ||
            typeof parsed.data.lines?.text !== "string" ||
            typeof parsed.data.line_number !== "number"
          ) {
            continue;
          }
          const matchKey = `${path.resolve(
            parsed.data.path.text,
          )}:${parsed.data.line_number}`;
          if (seenMatches.has(matchKey)) {
            continue;
          }
          seenMatches.add(matchKey);
          const preview = parsed.data.lines.text.trim().slice(0, 500);
          const declaration = preview.match(
            /\b(class|interface|type|function|def|fn|struct|enum|trait|func|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
          );
          const callable = preview.match(
            /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
          );
          symbols.push({
            name: declaration?.[2] ?? callable?.[1] ?? needle,
            kind: declaration?.[1] ?? "symbol",
            path: `${root.prefix}${path.relative(
              workspace,
              parsed.data.path.text,
            )}`,
            line: parsed.data.line_number,
            preview,
          });
          if (symbols.length >= MAX_SYMBOL_RESULTS) {
            return symbols;
          }
        }
      } catch {
        // Continue through other workspace roots.
      }
    }
    return symbols;
  }

  public async gitStatus(): Promise<string> {
    return this.gitAcrossRoots(["status", "--short", "--branch"]);
  }

  public async gitDiff(staged: boolean): Promise<string> {
    return this.gitAcrossRoots([
      "diff",
      "--no-ext-diff",
      "--unified=3",
      ...(staged ? ["--staged"] : []),
    ]);
  }

  public async storeAttachment(
    id: string,
    name: string,
    contentBase64: string,
  ): Promise<{ id: string; path: string; size: number }> {
    const content = Buffer.from(contentBase64, "base64");
    if (content.length === 0) {
      throw new Error("The attachment is empty.");
    }
    if (content.length > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments larger than ${MAX_REMOTE_ATTACHMENT_BYTES / 1024 / 1024} MB are not supported.`,
      );
    }
    await mkdir(this.uploadDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const requested = path.join(
      path.relative(this.workspacePath, this.uploadDirectory),
      `${id}-${safeAttachmentName(name)}`,
    );
    const absolutePath = await resolveWorkspaceFile(
      this.workspacePath,
      requested,
      { allowMissing: true },
    );
    await writeFile(absolutePath, content, {
      mode: 0o600,
      flag: "wx",
    });
    return { id, path: absolutePath, size: content.length };
  }

  private resolveRequestedPath(requestedPath: string): {
    root: WorkspaceRoot;
    relativePath: string;
  } {
    for (const root of this.roots.slice(1)) {
      if (requestedPath.startsWith(root.prefix)) {
        return {
          root,
          relativePath: requestedPath.slice(root.prefix.length),
        };
      }
    }
    return {
      root: this.roots[0]!,
      relativePath: requestedPath,
    };
  }

  private async resolveReferencePath(requestedPath: string): Promise<{
    root: WorkspaceRoot;
    relativePath: string;
  }> {
    if (!path.isAbsolute(requestedPath)) {
      const requested = this.resolveRequestedPath(requestedPath);
      const explicitlyScoped = requested.root.id !== "primary";
      const exact = await this.resolveExactReference(
        requested.root,
        requested.relativePath,
      );
      if (exact) {
        return exact;
      }

      if (
        requestedPath.startsWith("@") &&
        !explicitlyScoped
      ) {
        throw new Error("The referenced workspace root is unavailable.");
      }
      const candidates = await this.findReferenceSuffixMatches(
        explicitlyScoped ? [requested.root] : this.roots,
        requested.relativePath,
      );
      if (candidates.length === 0) {
        throw new Error("The referenced workspace file is unavailable.");
      }
      if (candidates.length > 1) {
        const displayed = candidates
          .map(
            ({ root, relativePath }) =>
              `${root.prefix}${relativePath.split(path.sep).join("/")}`,
          )
          .join(", ");
        throw new Error(
          `The file reference "${requestedPath}" is ambiguous (${displayed}). Use a longer workspace-relative path or an @workspace/ prefix.`,
        );
      }
      return candidates[0]!;
    }

    let candidate: string;
    try {
      candidate = await realpath(requestedPath);
    } catch {
      throw new Error("The referenced workspace file is unavailable.");
    }
    const matches: Array<{
      root: WorkspaceRoot;
      resolvedRoot: string;
    }> = [];
    for (const root of this.roots) {
      const resolvedRoot = await realpath(root.path);
      if (isInsidePath(resolvedRoot, candidate)) {
        matches.push({ root, resolvedRoot });
      }
    }
    matches.sort(
      (left, right) =>
        right.resolvedRoot.length - left.resolvedRoot.length,
    );
    const match = matches[0];
    if (!match) {
      throw new Error("The referenced path is outside the workspace.");
    }
    return {
      root: match.root,
      relativePath: path.relative(match.resolvedRoot, candidate),
    };
  }

  private async resolveExactReference(
    root: WorkspaceRoot,
    relativePath: string,
  ): Promise<
    | { root: WorkspaceRoot; relativePath: string }
    | undefined
  > {
    assertRemotePathIsBrowsable(relativePath);
    try {
      const [resolvedRoot, absolutePath] = await Promise.all([
        realpath(root.path),
        resolveWorkspaceFile(root.path, relativePath),
      ]);
      return {
        root,
        relativePath: path.relative(resolvedRoot, absolutePath),
      };
    } catch (error) {
      if (unavailablePathError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async findReferenceSuffixMatches(
    requestedRoots: readonly WorkspaceRoot[],
    requestedPath: string,
  ): Promise<Array<{ root: WorkspaceRoot; relativePath: string }>> {
    assertRemotePathIsBrowsable(requestedPath);
    const suffix = normalizedReferenceSuffix(requestedPath);
    const candidates = new Map<
      string,
      {
        root: WorkspaceRoot;
        relativePath: string;
        resolvedRoot: string;
      }
    >();
    const roots = await Promise.all(
      requestedRoots.map(async (root) => ({
        root,
        resolvedRoot: await realpath(root.path),
      })),
    );
    roots.sort(
      (left, right) =>
        right.resolvedRoot.length - left.resolvedRoot.length,
    );

    let scannedEntries = 0;
    for (const { root, resolvedRoot } of roots) {
      const pending = [""];
      for (
        let directoryIndex = 0;
        directoryIndex < pending.length;
        directoryIndex += 1
      ) {
        const directoryPath = pending[directoryIndex]!;
        let entries;
        try {
          entries = await readdir(
            path.join(resolvedRoot, directoryPath),
            { withFileTypes: true },
          );
        } catch {
          continue;
        }
        entries.sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
        for (const entry of entries) {
          scannedEntries += 1;
          if (scannedEntries > MAX_REFERENCE_SCAN_ENTRIES) {
            throw new Error(
              "That incomplete file reference matches a very large workspace. Use a longer workspace-relative path.",
            );
          }
          if (
            entry.name === "." ||
            entry.name === ".." ||
            PROTECTED_REMOTE_DIRECTORIES.has(
              entry.name.toLowerCase(),
            )
          ) {
            continue;
          }
          const relativePath = path.join(directoryPath, entry.name);
          if (entry.isDirectory()) {
            pending.push(relativePath);
            continue;
          }
          const displayedRelativePath = relativePath
            .split(path.sep)
            .join("/");
          if (!referenceSuffixMatches(displayedRelativePath, suffix)) {
            continue;
          }
          try {
            const absolutePath = await resolveWorkspaceFile(
              root.path,
              relativePath,
            );
            const details = await stat(absolutePath);
            if (!details.isFile()) {
              continue;
            }
            assertRemotePathIsBrowsable(
              path.relative(resolvedRoot, absolutePath),
            );
            const existing = candidates.get(absolutePath);
            if (
              !existing ||
              resolvedRoot.length > existing.resolvedRoot.length
            ) {
              candidates.set(absolutePath, {
                root,
                relativePath: path.relative(
                  resolvedRoot,
                  absolutePath,
                ),
                resolvedRoot,
              });
            }
          } catch {
            // Broken, escaped, or unreadable candidates are not resolvable
            // workspace references and must not weaken containment.
          }
        }
      }
    }

    return [...candidates.values()]
      .sort((left, right) => {
        const leftPath = `${left.root.prefix}${left.relativePath}`;
        const rightPath = `${right.root.prefix}${right.relativePath}`;
        return leftPath.localeCompare(rightPath, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      })
      .map(({ root, relativePath }) => ({ root, relativePath }));
  }

  private async gitAcrossRoots(args: string[]): Promise<string> {
    const sections: string[] = [];
    let lastError: unknown;
    for (const root of this.roots) {
      try {
        const { stdout, stderr } = await execFileAsync(
          "git",
          ["-C", root.path, ...args],
          {
            encoding: "utf8",
            maxBuffer: MAX_GIT_OUTPUT,
          },
        );
        const content = `${stdout}${stderr}`.trimEnd();
        if (this.roots.length === 1) {
          return content.slice(0, MAX_GIT_OUTPUT);
        }
        sections.push(
          `## ${root.label}\n${content || "No changes."}`,
        );
      } catch (error) {
        lastError = error;
      }
    }
    if (sections.length > 0) {
      return sections.join("\n\n").slice(0, MAX_GIT_OUTPUT);
    }
    const message =
      lastError instanceof Error
        ? lastError.message
        : "Git command failed.";
    throw new Error(message);
  }
}
