import { describe, expect, it } from "vitest";
import {
  parseMarkdownReference,
  plainTextWorkspaceReferences,
} from "../../src/remote/web/markdown.js";

describe("remote Markdown references", () => {
  it("parses workspace paths and supported line suffixes", () => {
    expect(parseMarkdownReference("src/remote/web/mobileApp.ts:1644")).toEqual({
      kind: "workspace",
      path: "src/remote/web/mobileApp.ts",
      line: 1644,
    });
    expect(parseMarkdownReference("@Docs/Guide%20One.md#L12-L20")).toEqual({
      kind: "workspace",
      path: "@Docs/Guide One.md",
      line: 12,
      endLine: 20,
    });
    expect(parseMarkdownReference("README.md#installation")).toEqual({
      kind: "workspace",
      path: "README.md",
    });
    expect(
      parseMarkdownReference("C:\\workspace\\src\\main.ts#L8-L12"),
    ).toEqual({
      kind: "workspace",
      path: "C:\\workspace\\src\\main.ts",
      line: 8,
      endLine: 12,
    });
    expect(
      parseMarkdownReference("C:/workspace/src/main.ts:21"),
    ).toEqual({
      kind: "workspace",
      path: "C:/workspace/src/main.ts",
      line: 21,
    });
  });

  it("accepts local file URLs but leaves workspace authority to file.read", () => {
    expect(
      parseMarkdownReference(
        "file:///Volumes/Drive/Project/My%20Image.png#L3",
      ),
    ).toEqual({
      kind: "workspace",
      path: "/Volumes/Drive/Project/My Image.png",
      line: 3,
    });
    expect(
      parseMarkdownReference("file://another-host/Project/file.ts"),
    ).toBeUndefined();
    expect(
      parseMarkdownReference("file:///C:/workspace/My%20File.ts#L4-L6"),
    ).toEqual({
      kind: "workspace",
      path: "C:/workspace/My File.ts",
      line: 4,
      endLine: 6,
    });
  });

  it("normalizes only HTTP and HTTPS as external destinations", () => {
    expect(parseMarkdownReference("https://example.com/docs?q=1#part")).toEqual({
      kind: "external",
      href: "https://example.com/docs?q=1#part",
    });
    expect(parseMarkdownReference("http://localhost:4177/help")).toEqual({
      kind: "external",
      href: "http://localhost:4177/help",
    });
  });

  it("rejects executable, ambiguous, and traversing destinations", () => {
    for (const destination of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1):12",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "blob:https://example.com/id",
      "mailto:user@example.com",
      "//example.com/path",
      "../secret.txt",
      "src/../../secret.txt",
      "src/%2e%2e/secret.txt",
      "C:\\workspace\\..\\secret.txt",
      "file:///Volumes/Drive/Project/src/%2e%2e/secret.txt",
      "file:////server/share/secret.txt",
      "src/remote/%00secret.ts",
      "src/remote/%0Asecret.ts",
      "\\\\example.com\\share\\secret.txt",
      "%5C%5Cexample.com%5Cshare%5Csecret.txt",
      "C:workspace\\relative.ts",
      "README.md\nhttps://example.com",
      "",
    ]) {
      expect(parseMarkdownReference(destination), destination).toBeUndefined();
    }
  });

  it("rejects invalid line ranges without redirecting to another scheme", () => {
    expect(parseMarkdownReference("README.md#L20-L10")).toBeUndefined();
    expect(parseMarkdownReference("README.md#L0")).toBeUndefined();
    expect(
      parseMarkdownReference("src/remote/web/mobileApp.ts#L2-L99999999"),
    ).toBeUndefined();
    expect(
      parseMarkdownReference("src/remote/web/mobileApp.ts:99999999"),
    ).toBeUndefined();
    expect(parseMarkdownReference("README.md:99999999")).toBeUndefined();
    expect(
      parseMarkdownReference("file:///Volumes/Drive/Project/README.md?raw=1"),
    ).toBeUndefined();
  });

  it("finds conservative bare file references in prose", () => {
    expect(
      plainTextWorkspaceReferences(
        "Updated src/remote/web/mobileApp.ts:42 and README.md. See @Docs/Guide.md#L4-L8 next.",
      ),
    ).toEqual([
      {
        start: 8,
        end: 38,
        label: "src/remote/web/mobileApp.ts:42",
        reference: {
          kind: "workspace",
          path: "src/remote/web/mobileApp.ts",
          line: 42,
        },
      },
      {
        start: 43,
        end: 52,
        label: "README.md",
        reference: { kind: "workspace", path: "README.md" },
      },
      {
        start: 58,
        end: 78,
        label: "@Docs/Guide.md#L4-L8",
        reference: {
          kind: "workspace",
          path: "@Docs/Guide.md",
          line: 4,
          endLine: 8,
        },
      },
    ]);
  });

  it("does not turn domains, email addresses, or unsupported tokens into files", () => {
    expect(
      plainTextWorkspaceReferences(
        "Visit example.com, email dev@example.com, keep v2.3.0, and run package.",
      ),
    ).toEqual([]);
  });
});
