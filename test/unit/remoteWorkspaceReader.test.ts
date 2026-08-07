import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRemoteFileReference,
  RemoteWorkspaceReader,
} from "../../src/remote/workspaceReader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function readerFixture(): Promise<{
  root: string;
  reader: RemoteWorkspaceReader;
}> {
  const root = await mkdtemp(
    path.join(tmpdir(), "modelhop-workspace-test-"),
  );
  temporaryDirectories.push(root);
  return {
    root,
    reader: new RemoteWorkspaceReader(
      root,
      path.join(root, ".modelhop-remote"),
    ),
  };
}

describe("remote workspace reader", () => {
  it("normalizes chat file references and source locations", () => {
    expect(
      parseRemoteFileReference("src/remote/server.ts#L42-L57"),
    ).toEqual({
      path: "src/remote/server.ts",
      line: 42,
      endLine: 57,
      column: undefined,
    });
    expect(
      parseRemoteFileReference(
        "@ModelHopDocs/remote%20security.md:18:4",
      ),
    ).toEqual({
      path: "@ModelHopDocs/remote security.md",
      line: 18,
      endLine: undefined,
      column: 4,
    });
    expect(
      parseRemoteFileReference("C:\\workspace\\src\\main.ts#L8-L12"),
    ).toEqual({
      path: "C:\\workspace\\src\\main.ts",
      line: 8,
      endLine: 12,
      column: undefined,
    });

    const fileUrl = pathToFileURL(
      path.join(tmpdir(), "ModelHop reference.ts"),
    );
    fileUrl.hash = "L7-L9";
    expect(parseRemoteFileReference(fileUrl.href)).toEqual({
      path: path.join(tmpdir(), "ModelHop reference.ts"),
      line: 7,
      endLine: 9,
      column: undefined,
    });
  });

  it("rejects unsafe or malformed chat file references", () => {
    expect(() =>
      parseRemoteFileReference("https://example.com/source.ts"),
    ).toThrow("Unsupported file reference scheme");
    expect(() =>
      parseRemoteFileReference("javascript:alert(1)"),
    ).toThrow("Unsupported file reference scheme");
    expect(() =>
      parseRemoteFileReference("\\\\example.com\\share\\source.ts"),
    ).toThrow("Network file references are unsupported");
    expect(() =>
      parseRemoteFileReference("%5C%5Cexample.com%5Cshare%5Csource.ts"),
    ).toThrow("Network file references are unsupported");
    expect(() =>
      parseRemoteFileReference("file:///tmp/a.ts?raw=1"),
    ).toThrow("Invalid file URL");
    expect(() =>
      parseRemoteFileReference("src/%00secret.ts"),
    ).toThrow("Invalid file reference");
    expect(() =>
      parseRemoteFileReference("src/file.ts#L20-L10"),
    ).toThrow("precedes its starting line");
    expect(() =>
      parseRemoteFileReference("src/file.ts#L9007199254740991"),
    ).toThrow("Invalid file reference line");
    expect(() => parseRemoteFileReference("file:///tmp/a.ts#intro"))
      .toThrow("Unsupported file reference fragment");
  });

  it("finds code symbols with paths and line numbers", async () => {
    const { root, reader } = await readerFixture();
    await writeFile(
      path.join(root, "example.ts"),
      [
        "const otherValue = 1;",
        "export function continueOnPhone(): void {}",
      ].join("\n"),
    );

    await expect(reader.searchSymbols("continue")).resolves.toEqual([
      expect.objectContaining({
        name: "continueOnPhone",
        kind: "function",
        path: "example.ts",
        line: 2,
      }),
    ]);
  });

  it("returns supported images as bounded base64 previews", async () => {
    const { root, reader } = await readerFixture();
    await writeFile(
      path.join(root, "preview.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    await expect(reader.readFile("preview.png")).resolves.toMatchObject({
      path: "preview.png",
      content: "iVBORw==",
      mediaType: "image/png",
      encoding: "base64",
    });
  });

  it("previews text and images larger than the former 512 KB limit", async () => {
    const { root, reader } = await readerFixture();
    const text = Buffer.alloc(768 * 1024, 0x61);
    const image = Buffer.alloc(6 * 1024 * 1024, 0x00);
    const oversizedText = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    image.set([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(path.join(root, "large.log"), text);
    await writeFile(path.join(root, "large.png"), image);
    await writeFile(path.join(root, "oversized.log"), oversizedText);

    await expect(reader.readFile("large.log")).resolves.toMatchObject({
      size: text.length,
      content: text.toString("utf8"),
      encoding: "utf8",
    });
    await expect(reader.readFile("large.png")).resolves.toMatchObject({
      size: image.length,
      mediaType: "image/png",
      encoding: "base64",
    });
    await expect(reader.readFile("oversized.log")).rejects.toThrow(
      "Text files larger than 5 MB",
    );
  });

  it("returns additional browser-safe image formats as image previews", async () => {
    const { root, reader } = await readerFixture();
    await writeFile(
      path.join(root, "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    );
    await writeFile(path.join(root, "photo.avif"), Buffer.from("fixture"));

    await expect(reader.readFile("diagram.svg")).resolves.toMatchObject({
      mediaType: "image/svg+xml",
      encoding: "base64",
    });
    await expect(reader.readFile("photo.avif")).resolves.toMatchObject({
      mediaType: "image/avif",
      encoding: "base64",
    });
  });

  it("keeps additional workspace roots addressable", async () => {
    const { root } = await readerFixture();
    const secondary = path.join(root, "shared-services");
    await mkdir(secondary);
    await writeFile(
      path.join(secondary, "service.ts"),
      "export function sharedService(): void {}\n",
    );
    const reader = new RemoteWorkspaceReader(
      root,
      path.join(root, ".modelhop-remote"),
      [secondary],
    );

    await expect(reader.searchSymbols("shared")).resolves.toEqual([
      expect.objectContaining({
        name: "sharedService",
        path: "@shared-services/service.ts",
      }),
    ]);
    await expect(
      reader.readFile("@shared-services/service.ts"),
    ).resolves.toMatchObject({
      path: "@shared-services/service.ts",
      encoding: "utf8",
    });
    await expect(
      reader.readReference("@shared-services/service.ts:1:8"),
    ).resolves.toMatchObject({
      rootId: "shared-services",
      relativePath: "service.ts",
      path: "@shared-services/service.ts",
      line: 1,
      column: 8,
    });
  });

  it("resolves a unique nested file from a bare basename or path suffix", async () => {
    const { root, reader } = await readerFixture();
    await mkdir(path.join(root, "src", "remote"), { recursive: true });
    await writeFile(
      path.join(root, "src", "remote", "unique-reader.ts"),
      "export const uniqueReader = true;\n",
    );

    await expect(
      reader.readReference("unique-reader.ts#L1"),
    ).resolves.toMatchObject({
      rootId: "primary",
      relativePath: "src/remote/unique-reader.ts",
      path: "src/remote/unique-reader.ts",
      line: 1,
    });
    await expect(
      reader.readReference("remote/unique-reader.ts"),
    ).resolves.toMatchObject({
      relativePath: "src/remote/unique-reader.ts",
    });
  });

  it("fails clearly when an incomplete reference is ambiguous", async () => {
    const { root, reader } = await readerFixture();
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "test"));
    await writeFile(path.join(root, "src", "shared.ts"), "src\n");
    await writeFile(path.join(root, "test", "shared.ts"), "test\n");

    await expect(reader.readReference("shared.ts")).rejects.toThrow(
      /ambiguous.*src\/shared\.ts.*test\/shared\.ts.*longer workspace-relative path/iu,
    );
    await expect(
      reader.readReference("src/shared.ts"),
    ).resolves.toMatchObject({
      relativePath: "src/shared.ts",
      content: "src\n",
    });
  });

  it("finds an unqualified unique reference in a non-primary root", async () => {
    const { root } = await readerFixture();
    const secondary = await mkdtemp(
      path.join(tmpdir(), "modelhop-secondary-workspace-test-"),
    );
    temporaryDirectories.push(secondary);
    await mkdir(path.join(secondary, "packages", "widget"), {
      recursive: true,
    });
    await writeFile(
      path.join(secondary, "packages", "widget", "remote-model.ts"),
      "export const remoteModel = true;\n",
    );
    const secondaryLabel = path.basename(secondary);
    const reader = new RemoteWorkspaceReader(
      root,
      path.join(root, ".modelhop-remote"),
      [secondary],
    );

    await expect(
      reader.readReference("remote-model.ts"),
    ).resolves.toMatchObject({
      rootId: secondaryLabel,
      relativePath: "packages/widget/remote-model.ts",
      path: `@${secondaryLabel}/packages/widget/remote-model.ts`,
    });
    await expect(
      reader.readReference(`@${secondaryLabel}/widget/remote-model.ts`),
    ).resolves.toMatchObject({
      rootId: secondaryLabel,
      relativePath: "packages/widget/remote-model.ts",
    });
  });

  it("reports ambiguous basenames across workspace roots", async () => {
    const { root } = await readerFixture();
    const secondary = await mkdtemp(
      path.join(tmpdir(), "modelhop-ambiguous-workspace-test-"),
    );
    temporaryDirectories.push(secondary);
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(secondary, "src"));
    await writeFile(path.join(root, "src", "duplicate.ts"), "primary\n");
    await writeFile(
      path.join(secondary, "src", "duplicate.ts"),
      "secondary\n",
    );
    const reader = new RemoteWorkspaceReader(
      root,
      path.join(root, ".modelhop-remote"),
      [secondary],
    );

    await expect(reader.readReference("duplicate.ts")).rejects.toThrow(
      /ambiguous.*duplicate\.ts.*duplicate\.ts.*@workspace\/ prefix/iu,
    );
  });

  it("maps absolute references to the longest containing workspace root", async () => {
    const { root } = await readerFixture();
    const secondary = path.join(root, "shared-services");
    await mkdir(secondary);
    const source = path.join(secondary, "service.ts");
    await writeFile(source, "export const shared = true;\n");
    const reader = new RemoteWorkspaceReader(
      root,
      path.join(root, ".modelhop-remote"),
      [secondary],
    );

    await expect(
      reader.readReference(`${source}#L1`),
    ).resolves.toMatchObject({
      rootId: "shared-services",
      relativePath: "service.ts",
      path: "@shared-services/service.ts",
      line: 1,
      encoding: "utf8",
    });
  });

  it("reads encoded file URLs while retaining their line range", async () => {
    const { root, reader } = await readerFixture();
    const source = path.join(root, "remote notes.md");
    await writeFile(source, "# Notes\n\nSafe hand-back.\n");
    const reference = pathToFileURL(source);
    reference.hash = "L1-L3";

    await expect(reader.readReference(reference.href)).resolves.toMatchObject({
      rootId: "primary",
      relativePath: "remote notes.md",
      path: "remote notes.md",
      line: 1,
      endLine: 3,
      language: "md",
    });
  });

  it("keeps absolute references and escaped symlinks inside workspace policy", async () => {
    const { root, reader } = await readerFixture();
    const outside = await mkdtemp(
      path.join(tmpdir(), "modelhop-reference-outside-test-"),
    );
    temporaryDirectories.push(outside);
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "private");
    await symlink(secret, path.join(root, "escaped.txt"));

    await expect(reader.readReference(secret)).rejects.toThrow(
      "outside the workspace",
    );
    await expect(
      reader.readReference(path.join(root, "escaped.txt")),
    ).rejects.toThrow("outside the workspace");
  });

  it("lists bounded directory pages with directories first", async () => {
    const { root, reader } = await readerFixture();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "zeta.ts"), "export {};\n");
    await writeFile(path.join(root, "alpha.md"), "# Alpha\n");

    const firstPage = await reader.listDirectory(
      "primary",
      "",
      undefined,
      2,
    );
    expect(firstPage).toEqual({
      root: {
        id: "primary",
        label: path.basename(root),
      },
      path: "",
      parentPath: undefined,
      nodes: [
        expect.objectContaining({
          name: "src",
          kind: "directory",
          path: "src",
        }),
        expect.objectContaining({
          name: "alpha.md",
          kind: "file",
          extension: "md",
        }),
      ],
      totalEntries: 3,
      omittedEntries: {
        protected: 0,
        unavailable: 0,
        unsupported: 0,
      },
      nextCursor: firstPage.nextCursor,
    });
    expect(firstPage.nextCursor).toMatch(/^v1\.2\.[a-f\d]{32}$/u);
  });

  it("rejects a cursor when the directory changes between pages", async () => {
    const { root, reader } = await readerFixture();
    await writeFile(path.join(root, "alpha.txt"), "alpha");
    await writeFile(path.join(root, "bravo.txt"), "bravo");
    await writeFile(path.join(root, "charlie.txt"), "charlie");

    const first = await reader.listDirectory(
      "primary",
      "",
      undefined,
      2,
    );
    expect(first.nextCursor).toBeDefined();
    await writeFile(path.join(root, "aardvark.txt"), "aardvark");

    await expect(
      reader.listDirectory("primary", "", first.nextCursor, 2),
    ).rejects.toThrow("directory changed while it was being loaded");
  });

  it("keeps every child discoverable across large directory pages", async () => {
    const { root, reader } = await readerFixture();
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        writeFile(
          path.join(root, `file-${String(index).padStart(3, "0")}.txt`),
          String(index),
        ),
      ),
    );

    const names: string[] = [];
    let cursor: string | undefined;
    let reportedTotal = 0;
    do {
      const page = await reader.listDirectory(
        "primary",
        "",
        cursor,
        100,
      );
      names.push(...page.nodes.map((node) => node.name));
      reportedTotal = page.totalEntries;
      cursor = page.nextCursor;
    } while (cursor);

    expect(names).toHaveLength(205);
    expect(reportedTotal).toBe(205);
    expect(new Set(names).size).toBe(205);
    expect(names).toContain("file-000.txt");
    expect(names).toContain("file-204.txt");
  });

  it("lists dependencies while blocking credential-bearing metadata", async () => {
    const { root, reader } = await readerFixture();
    await mkdir(path.join(root, "node_modules", "fixture-package"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "node_modules", "fixture-package", "index.js"),
      "export {};\n",
    );
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "config"), "credential=secret\n");
    await symlink(path.join(root, ".git"), path.join(root, "metadata-alias"));

    const rootPage = await reader.listDirectory();
    expect(rootPage.nodes.map((node) => node.name)).toContain("node_modules");
    expect(rootPage.nodes.map((node) => node.name)).not.toContain(".git");
    expect(rootPage.nodes.map((node) => node.name)).not.toContain(
      "metadata-alias",
    );
    expect(rootPage.omittedEntries).toMatchObject({
      protected: 2,
      unavailable: 0,
    });
    await expect(
      reader.listDirectory("primary", "node_modules"),
    ).resolves.toMatchObject({
      nodes: [expect.objectContaining({ name: "fixture-package" })],
    });
    await expect(
      reader.readFile("node_modules/fixture-package/index.js"),
    ).resolves.toMatchObject({ encoding: "utf8" });
    await expect(
      reader.listDirectory("primary", ".git"),
    ).rejects.toThrow("Protected repository metadata");
    await expect(reader.readFile(".git/config")).rejects.toThrow(
      "Protected repository metadata",
    );
    await expect(reader.readFile(".GIT/config")).rejects.toThrow(
      "Protected repository metadata",
    );
    await expect(reader.readFile("metadata-alias/config")).rejects.toThrow(
      "Protected repository metadata",
    );
  });

  it("keeps directory traversal and escaped symlinks out of listings", async () => {
    const { root, reader } = await readerFixture();
    const outside = await mkdtemp(
      path.join(tmpdir(), "modelhop-outside-test-"),
    );
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "private");
    await symlink(outside, path.join(root, "escaped"));
    await writeFile(path.join(root, "visible.txt"), "visible");

    await expect(reader.listDirectory()).resolves.toMatchObject({
      nodes: [
        expect.objectContaining({
          name: "visible.txt",
        }),
      ],
      omittedEntries: {
        protected: 0,
        unavailable: 1,
        unsupported: 0,
      },
    });
    await expect(
      reader.listDirectory("primary", "../"),
    ).rejects.toThrow("outside the workspace");
  });
});
