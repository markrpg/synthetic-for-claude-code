import { describe, expect, it } from "vitest";
import {
  collectDirectoryListing,
  describeDirectoryListing,
  type DirectoryPageLike,
} from "../../src/remote/web/directoryListing.js";

interface TestNode {
  path: string;
}

const noOmissions = {
  protected: 0,
  unavailable: 0,
  unsupported: 0,
};

function page(
  paths: string[],
  options: {
    cursor?: string;
    total?: number;
    omissions?: typeof noOmissions;
  } = {},
): DirectoryPageLike<TestNode> {
  return {
    root: { id: "primary" },
    path: "src",
    nodes: paths.map((path) => ({ path })),
    totalEntries: options.total ?? paths.length,
    omittedEntries: options.omissions ?? noOmissions,
    nextCursor: options.cursor,
  };
}

describe("remote directory page collection", () => {
  it("keeps every unique child discoverable across pages", async () => {
    const allPaths = Array.from(
      { length: 205 },
      (_, index) => `src/file-${String(index).padStart(3, "0")}.txt`,
    );
    const pages = new Map([
      ["page-2", page(allPaths.slice(64, 128), { cursor: "page-3", total: 205 })],
      ["page-3", page(allPaths.slice(128, 192), { cursor: "page-4", total: 205 })],
      ["page-4", page(allPaths.slice(192), { total: 205 })],
    ]);

    const result = await collectDirectoryListing(
      page(allPaths.slice(0, 64), { cursor: "page-2", total: 205 }),
      (cursor) => Promise.resolve(pages.get(cursor)!),
      { rootId: "primary", path: "src" },
    );

    expect(result.nodes.map((node) => node.path)).toEqual(allPaths);
    expect(new Set(result.nodes.map((node) => node.path)).size).toBe(205);
    expect(result.totalEntries).toBe(205);
  });

  it("rejects repeated cursors and duplicate paths", async () => {
    await expect(
      collectDirectoryListing(
        page(["src/one.ts"], { cursor: "again", total: 2 }),
        () =>
          Promise.resolve(
            page(["src/two.ts"], { cursor: "again", total: 2 }),
          ),
        { rootId: "primary", path: "src" },
      ),
    ).rejects.toThrow("repeated its cursor");

    await expect(
      collectDirectoryListing(
        page(["src/one.ts"], { cursor: "next", total: 2 }),
        () => Promise.resolve(page(["src/one.ts"], { total: 2 })),
        { rootId: "primary", path: "src" },
      ),
    ).rejects.toThrow("repeated an item");
  });

  it("rejects a silent short final page or changing page metadata", async () => {
    await expect(
      collectDirectoryListing(
        page(["src/one.ts"], { total: 2 }),
        () => Promise.reject(new Error("not reached")),
        { rootId: "primary", path: "src" },
      ),
    ).rejects.toThrow("loaded 1 of 2 items");

    await expect(
      collectDirectoryListing(
        page(["src/one.ts"], { cursor: "next", total: 2 }),
        () => Promise.resolve(page(["src/two.ts"], { total: 3 })),
        { rootId: "primary", path: "src" },
      ),
    ).rejects.toThrow("directory changed while it was being loaded");
  });

  it("describes each omitted entry category accurately", () => {
    expect(
      describeDirectoryListing(
        {
          loaded: 8,
          totalEntries: 8,
          omittedEntries: {
            protected: 1,
            unavailable: 2,
            unsupported: 3,
          },
        },
        true,
      ),
    ).toBe(
      "All 8 available items loaded. Visual view prioritises nearby items; List shows every loaded item. 1 protected entry hidden. 2 unavailable entries could not be read. 3 unsupported filesystem entries not shown.",
    );
  });
});
