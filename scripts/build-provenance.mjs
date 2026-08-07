import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_PROVENANCE_SCHEMA_VERSION = 1;
export const BUILD_PROVENANCE_PATH = "dist/modelhop-build.json";
export const PRODUCTION_BUILD_OUTPUTS = Object.freeze([
  "dist/extension.js",
  "dist/bridge-daemon.js",
  "dist/remote-daemon.mjs",
  "dist/remote/index.html",
  "dist/remote/styles.css",
  "dist/remote/chat-mesh.svg",
  "dist/remote/app.js",
]);

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceInputs = Object.freeze([
  "esbuild.mjs",
  "package.json",
  "package-lock.json",
]);

export async function writeBuildProvenance(root = projectRoot) {
  const provenance = await createBuildProvenance(root);
  await writeFile(
    path.join(root, BUILD_PROVENANCE_PATH),
    `${JSON.stringify(provenance, undefined, 2)}\n`,
    "utf8",
  );
  return provenance;
}

export async function assertBuildProvenance(root = projectRoot) {
  const provenancePath = path.join(root, BUILD_PROVENANCE_PATH);
  let stored;
  try {
    stored = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch (error) {
    throw new Error(
      "Production build provenance is missing or unreadable. Run npm run compile before packaging.",
      { cause: error },
    );
  }

  const expected = await createBuildProvenance(root);
  assertProvenanceShape(stored);
  if (stored.packageVersion !== expected.packageVersion) {
    throw new Error(
      `Production build version ${String(stored.packageVersion)} does not match package.json ${expected.packageVersion}. Run npm run compile again.`,
    );
  }
  if (stored.sourceHash !== expected.sourceHash) {
    throw new Error(
      "Production sources changed after the last compile. Run npm run compile again before packaging.",
    );
  }
  const expectedOutputNames = Object.keys(expected.outputs).sort();
  const storedOutputNames = Object.keys(stored.outputs).sort();
  if (JSON.stringify(storedOutputNames) !== JSON.stringify(expectedOutputNames)) {
    throw new Error(
      "Production build provenance has an unexpected output set. Run npm run compile again.",
    );
  }
  for (const outputName of expectedOutputNames) {
    if (stored.outputs[outputName] !== expected.outputs[outputName]) {
      throw new Error(
        `Production output ${outputName} changed after compilation. Run npm run compile again.`,
      );
    }
  }
  return stored;
}

export async function assertReleaseMetadataConsistency(root = projectRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const version = manifest.version;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error(
      `package.json contains an invalid release version: ${String(version)}`,
    );
  }
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error(
      `package-lock.json does not match package.json version ${version}.`,
    );
  }

  const releaseNotesPath = path.join(
    root,
    "docs",
    `release-notes-v${version}.md`,
  );
  let releaseNotes;
  try {
    releaseNotes = await readFile(releaseNotesPath, "utf8");
  } catch (error) {
    throw new Error(
      `Current release notes are missing: docs/release-notes-v${version}.md.`,
      { cause: error },
    );
  }
  if (!releaseNotes.startsWith(`# ModelHop for Claude Code ${version}\n`)) {
    throw new Error(
      `Current release notes do not identify ModelHop ${version} in their title.`,
    );
  }

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## ${escapeRegExp(version)}$`, "mu").test(changelog)) {
    throw new Error(`CHANGELOG.md does not contain a ${version} section.`);
  }
  return { manifest, releaseNotes, version };
}

export async function computeProductionSourceHash(root = projectRoot) {
  const relativeFiles = [
    ...sourceInputs,
    ...(await listFiles(path.join(root, "src"))).map((file) =>
      path.relative(root, file).replaceAll(path.sep, "/"),
    ),
  ].sort();
  const hash = createHash("sha256");
  for (const relativeFile of relativeFiles) {
    const content = await readFile(path.join(root, relativeFile));
    hash.update(relativeFile, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(content.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function createBuildProvenance(root) {
  const { version } = await assertReleaseMetadataConsistency(root);
  const outputs = {};
  for (const outputName of PRODUCTION_BUILD_OUTPUTS) {
    outputs[outputName] = sha256(await readFile(path.join(root, outputName)));
  }
  return {
    schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
    packageVersion: version,
    sourceHash: await computeProductionSourceHash(root),
    outputs,
  };
}

function assertProvenanceShape(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION ||
    typeof value.packageVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceHash ?? "") ||
    typeof value.outputs !== "object" ||
    value.outputs === null ||
    Array.isArray(value.outputs)
  ) {
    throw new Error(
      "Production build provenance has an invalid format. Run npm run compile again.",
    );
  }
  for (const digest of Object.values(value.outputs)) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error(
        "Production build provenance contains an invalid output digest. Run npm run compile again.",
      );
    }
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--source-hash") {
    console.log(await computeProductionSourceHash(projectRoot));
  } else if (process.argv[2] === "--check-metadata") {
    const { version } = await assertReleaseMetadataConsistency(projectRoot);
    console.log(`Release metadata is consistent for ${version}.`);
  } else if (process.argv.length > 2) {
    throw new Error(`Unknown build-provenance option: ${process.argv[2]}`);
  }
}
