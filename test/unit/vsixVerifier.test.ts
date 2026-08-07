import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());
const temporaryDirectories: string[] = [];

const productionOutputs = [
  "dist/extension.js",
  "dist/bridge-daemon.js",
  "dist/remote-daemon.mjs",
  "dist/remote/index.html",
  "dist/remote/styles.css",
  "dist/remote/chat-mesh.svg",
  "dist/remote/app.js",
] as const;

const reviewedImages = [
  "extension/docs/images/claude-code-kimi-k3-confirmation.png",
  "extension/docs/images/codex-model-picker.png",
  "extension/docs/images/codex-status-bar.png",
  "extension/docs/images/modelhop-icon.png",
  "extension/docs/images/modelhop-logo.png",
  "extension/docs/images/status-bar.png",
  "extension/media/modelhop-icon.png",
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("VSIX production verifier", () => {
  it("accepts only the reviewed production package surface", async () => {
    const vsixPath = await createVsix();

    await expect(runVerifier(vsixPath)).resolves.toBeUndefined();
  });

  it.each([
    "extension/docs/private-screenshot.png",
    "extension/docs/product-overview.docx",
    "extension/docs/session.log",
    "extension/docs/debug.zip",
    "extension/test/mobile/__screenshots__/chat.png",
  ])("rejects unreviewed archive entry %s", async (unexpectedEntry) => {
    const vsixPath = await createVsix({
      extraEntries: new Map([[unexpectedEntry, "private fixture data"]]),
    });

    await expect(runVerifier(vsixPath)).rejects.toThrow(
      "outside the reviewed production allowlist",
    );
  });

  it.each([
    "extension/readme.md",
    "extension/media/modelhop-icon.png",
    "extension/dist/remote/app.js",
  ])("rejects a package missing required entry %s", async (missingEntry) => {
    const vsixPath = await createVsix({ missingEntry });

    await expect(runVerifier(vsixPath)).rejects.toThrow(
      "missing required production entry",
    );
  });

  it("rejects a package missing the current release notes", async () => {
    const manifest = await readManifest();
    const vsixPath = await createVsix({
      missingEntry:
        `extension/docs/release-notes-v${manifest.version}.md`,
    });

    await expect(runVerifier(vsixPath)).rejects.toThrow(
      "missing required production entry",
    );
  });

  it("rejects stale packaged release notes", async () => {
    const manifest = await readManifest();
    const releaseNotesEntry =
      `extension/docs/release-notes-v${manifest.version}.md`;
    const vsixPath = await createVsix({
      replaceEntries: new Map([[releaseNotesEntry, "# stale notes\n"]]),
    });

    await expect(runVerifier(vsixPath)).rejects.toThrow(
      "does not match the reviewed local release notes",
    );
  });

  it("rejects an unreviewed replacement at an approved image path", async () => {
    const vsixPath = await createVsix({
      replaceEntries: new Map([
        [
          "extension/media/modelhop-icon.png",
          Buffer.from("unreviewed private screenshot"),
        ],
      ]),
    });

    await expect(runVerifier(vsixPath)).rejects.toThrow(
      "Reviewed binary asset",
    );
  });

  it("rejects a production bundle changed after provenance was recorded", async () => {
    const vsixPath = await createVsix({
      replaceEntries: new Map([
        ["extension/dist/remote/app.js", "changed after compile"],
      ]),
    });

    await expect(runVerifier(vsixPath)).rejects.toThrow(
      "does not match its build provenance",
    );
  });
});

interface VsixOptions {
  extraEntries?: ReadonlyMap<string, string | Buffer>;
  missingEntry?: string;
  replaceEntries?: ReadonlyMap<string, string | Buffer>;
}

async function createVsix(options: VsixOptions = {}): Promise<string> {
  const manifest = await readManifest();
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "modelhop-vsix-verifier-"),
  );
  temporaryDirectories.push(directory);
  const staging = path.join(directory, "staging");
  await mkdir(staging, { recursive: true });
  const outputContent = Object.fromEntries(
    productionOutputs.map((output, index) => [
      output,
      `production output ${String(index)}\n`,
    ]),
  );
  const { stdout: sourceHashOutput } = await execFileAsync(
    process.execPath,
    ["scripts/build-provenance.mjs", "--source-hash"],
    { cwd: projectRoot },
  );
  const provenance = {
    schemaVersion: 1,
    packageVersion: manifest.version,
    sourceHash: sourceHashOutput.trim(),
    outputs: Object.fromEntries(
      Object.entries(outputContent).map(([entry, content]) => [
        entry,
        sha256(content),
      ]),
    ),
  };
  const releaseNotes = await readFile(
    path.join(
      projectRoot,
      "docs",
      `release-notes-v${manifest.version}.md`,
    ),
    "utf8",
  );
  const entries = new Map<string, string | Buffer>([
    ["[Content_Types].xml", "<Types />\n"],
    ["extension.vsixmanifest", "<PackageManifest />\n"],
    ["extension/LICENSE.txt", "MIT\n"],
    ["extension/THIRD_PARTY_NOTICES.md", "# Notices\n"],
    ["extension/changelog.md", `## ${manifest.version}\n`],
    ["extension/package.json", `${JSON.stringify(manifest)}\n`],
    ["extension/readme.md", "# ModelHop\n"],
    [
      "extension/dist/modelhop-build.json",
      `${JSON.stringify(provenance)}\n`,
    ],
    [
      `extension/docs/release-notes-v${manifest.version}.md`,
      releaseNotes,
    ],
    [
      "extension/docs/remote-retention-and-support.md",
      "# Remote retention\n",
    ],
    ...Object.entries(outputContent).map(
      ([entry, content]) => [`extension/${entry}`, content] as const,
    ),
  ]);
  for (const entry of reviewedImages) {
    entries.set(
      entry,
      await readFile(path.join(projectRoot, entry.replace(/^extension\//u, ""))),
    );
  }
  for (const [entry, content] of options.extraEntries ?? []) {
    entries.set(entry, content);
  }
  for (const [entry, content] of options.replaceEntries ?? []) {
    entries.set(entry, content);
  }
  if (options.missingEntry) {
    entries.delete(options.missingEntry);
  }
  for (const [entry, content] of entries) {
    const destination = path.join(staging, entry);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  const vsixPath = path.join(
    directory,
    `modelhop-for-claude-code-${manifest.version}.vsix`,
  );
  await execFileAsync("zip", ["-q", vsixPath, ...entries.keys()], {
    cwd: staging,
  });
  return vsixPath;
}

async function runVerifier(vsixPath: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["scripts/verify-vsix.mjs", vsixPath],
    { cwd: projectRoot },
  );
}

async function readManifest(): Promise<{
  name: string;
  publisher: string;
  version: string;
}> {
  return JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { name: string; publisher: string; version: string };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
