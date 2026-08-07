import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_REMOTE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_REMOTE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function formattedByteLimit(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / 1024 / 1024} MB`;
  }
  return `${Math.ceil(bytes / 1024)} KB`;
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

export async function resolveWorkspaceFile(
  workspacePath: string,
  requestedPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  const workspace = await realpath(workspacePath);
  const lexical = path.resolve(workspace, requestedPath);
  if (!isInside(workspace, lexical)) {
    throw new Error("The requested path is outside the workspace.");
  }
  try {
    const resolved = await realpath(lexical);
    if (!isInside(workspace, resolved)) {
      throw new Error(
        "The requested path resolves outside the workspace.",
      );
    }
    return resolved;
  } catch (error) {
    if (options.allowMissing) {
      const parent = await realpath(path.dirname(lexical));
      if (!isInside(workspace, parent)) {
        throw new Error(
          "The requested path resolves outside the workspace.",
        );
      }
      return lexical;
    }
    throw error;
  }
}

export async function validateReadableFile(
  workspacePath: string,
  requestedPath: string,
  maximumBytes = MAX_REMOTE_FILE_BYTES,
): Promise<{ absolutePath: string; size: number }> {
  const absolutePath = await resolveWorkspaceFile(
    workspacePath,
    requestedPath,
  );
  const details = await stat(absolutePath);
  if (!details.isFile()) {
    throw new Error("The requested path is not a regular file.");
  }
  if (details.size > maximumBytes) {
    throw new Error(
      `Files larger than ${formattedByteLimit(maximumBytes)} cannot be previewed remotely.`,
    );
  }
  return { absolutePath, size: details.size };
}
