export interface DirectoryOmissions {
  protected: number;
  unavailable: number;
  unsupported: number;
}

export interface DirectoryPageLike<Node extends { path: string }> {
  root: { id: string };
  path: string;
  nodes: readonly Node[];
  totalEntries?: number;
  omittedEntries?: DirectoryOmissions;
  nextCursor?: string;
}

export interface CompleteDirectoryListing<Node extends { path: string }> {
  nodes: Node[];
  totalEntries: number;
  omittedEntries: DirectoryOmissions;
}

export interface DirectoryListingStatus {
  loaded: number;
  totalEntries: number;
  omittedEntries: DirectoryOmissions;
}

const MAX_DIRECTORY_PAGES = 10_000;

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameOmissions(
  left: DirectoryOmissions,
  right: DirectoryOmissions,
): boolean {
  return (
    left.protected === right.protected &&
    left.unavailable === right.unavailable &&
    left.unsupported === right.unsupported
  );
}

function validatedOmissions(
  value: DirectoryOmissions | undefined,
): DirectoryOmissions {
  if (
    !value ||
    !nonNegativeInteger(value.protected) ||
    !nonNegativeInteger(value.unavailable) ||
    !nonNegativeInteger(value.unsupported)
  ) {
    throw new Error("The directory response omitted valid omission counts.");
  }
  return { ...value };
}

/**
 * Collects a bounded directory listing without accepting cursor loops,
 * duplicate paths, changing metadata, or a silently incomplete final page.
 */
export async function collectDirectoryListing<Node extends { path: string }>(
  firstPage: DirectoryPageLike<Node>,
  loadPage: (cursor: string) => Promise<DirectoryPageLike<Node>>,
  expected: { rootId: string; path: string },
): Promise<CompleteDirectoryListing<Node>> {
  const nodes: Node[] = [];
  const seenPaths = new Set<string>();
  const seenCursors = new Set<string>();
  let page = firstPage;
  let totalEntries: number | undefined;
  let omittedEntries: DirectoryOmissions | undefined;

  for (let pageNumber = 1; pageNumber <= MAX_DIRECTORY_PAGES; pageNumber += 1) {
    if (page.root.id !== expected.rootId || page.path !== expected.path) {
      throw new Error("The directory response did not match the requested folder.");
    }
    if (
      page.totalEntries === undefined ||
      !nonNegativeInteger(page.totalEntries)
    ) {
      throw new Error("The directory response omitted a valid total count.");
    }
    if (
      totalEntries !== undefined &&
      totalEntries !== page.totalEntries
    ) {
      throw new Error(
        "The directory changed while it was being loaded. Refresh the folder and try again.",
      );
    }
    totalEntries = page.totalEntries;

    const pageOmissions = validatedOmissions(page.omittedEntries);
    if (
      omittedEntries !== undefined &&
      !sameOmissions(omittedEntries, pageOmissions)
    ) {
      throw new Error(
        "The directory changed while it was being loaded. Refresh the folder and try again.",
      );
    }
    omittedEntries = pageOmissions;

    for (const node of page.nodes) {
      if (seenPaths.has(node.path)) {
        throw new Error(
          "The directory response repeated an item. Refresh the folder and try again.",
        );
      }
      seenPaths.add(node.path);
      nodes.push(node);
    }
    if (nodes.length > totalEntries) {
      throw new Error("The directory response contained too many items.");
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      if (nodes.length !== totalEntries) {
        throw new Error(
          `The directory response was incomplete: loaded ${String(nodes.length)} of ${String(totalEntries)} items.`,
        );
      }
      return {
        nodes,
        totalEntries,
        omittedEntries,
      };
    }
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error(
        "The directory response repeated its cursor. Refresh the folder and try again.",
      );
    }
    if (page.nodes.length === 0) {
      throw new Error(
        "The directory response did not advance. Refresh the folder and try again.",
      );
    }
    seenCursors.add(nextCursor);
    page = await loadPage(nextCursor);
  }

  throw new Error(
    "The directory contains too many pages to load safely. Narrow the folder and try again.",
  );
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

export function describeDirectoryListing(
  status: DirectoryListingStatus,
  visualViewIsSubset: boolean,
): string {
  const complete =
    status.loaded === status.totalEntries
      ? `All ${String(status.loaded)} available item${status.loaded === 1 ? "" : "s"} loaded.`
      : `${String(status.loaded)} of ${String(status.totalEntries)} available items loaded.`;
  const notes: string[] = [];
  if (visualViewIsSubset) {
    notes.push("Visual view prioritises nearby items; List shows every loaded item.");
  }
  if (status.omittedEntries.protected > 0) {
    notes.push(
      `${countLabel(status.omittedEntries.protected, "protected entry", "protected entries")} hidden.`,
    );
  }
  if (status.omittedEntries.unavailable > 0) {
    notes.push(
      `${countLabel(status.omittedEntries.unavailable, "unavailable entry", "unavailable entries")} could not be read.`,
    );
  }
  if (status.omittedEntries.unsupported > 0) {
    notes.push(
      `${countLabel(status.omittedEntries.unsupported, "unsupported filesystem entry", "unsupported filesystem entries")} not shown.`,
    );
  }
  return [complete, ...notes].join(" ");
}
