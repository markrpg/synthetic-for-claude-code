import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  assertReleaseMetadataConsistency,
  BUILD_PROVENANCE_SCHEMA_VERSION,
  computeProductionSourceHash,
  PRODUCTION_BUILD_OUTPUTS,
  sha256,
} from "./build-provenance.mjs";
import {
  assertProductionEntryPolicy,
  REVIEWED_BINARY_DIGESTS,
} from "./vsix-production-policy.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const { manifest, releaseNotes } =
  await assertReleaseMetadataConsistency(projectRoot);
const expectedFilename =
  `modelhop-for-claude-code-${manifest.version}.vsix`;
const requestedPath =
  process.argv[2] ?? path.join(projectRoot, expectedFilename);
const vsixPath = path.resolve(projectRoot, requestedPath);

if (path.basename(vsixPath) !== expectedFilename) {
  throw new Error(
    `Expected ${expectedFilename}, received ${path.basename(vsixPath)}.`,
  );
}

const entries = splitLines(
  await capture("unzip", ["-Z1", vsixPath]),
);
const normalizedEntries = assertProductionEntryPolicy(
  entries,
  manifest.version,
);
for (const [entry, expectedDigest] of Object.entries(
  REVIEWED_BINARY_DIGESTS,
)) {
  const content = await captureBuffer("unzip", ["-p", vsixPath, entry]);
  if (sha256(content) !== expectedDigest) {
    throw new Error(
      `Reviewed binary asset ${entry} changed. Review it and update its pinned digest before packaging.`,
    );
  }
}

const packagedManifest = JSON.parse(
  await capture("unzip", [
    "-p",
    vsixPath,
    "extension/package.json",
  ]),
);
if (packagedManifest.version !== manifest.version) {
  throw new Error(
    `VSIX manifest version ${String(packagedManifest.version)} does not match ${manifest.version}.`,
  );
}

const releaseNotesEntry =
  `extension/docs/release-notes-v${manifest.version}.md`;
const packagedReleaseNotes = await capture("unzip", [
  "-p",
  vsixPath,
  releaseNotesEntry,
]);
if (packagedReleaseNotes !== releaseNotes) {
  throw new Error(
    `Packaged ${releaseNotesEntry} does not match the reviewed local release notes.`,
  );
}

const packagedProvenance = JSON.parse(
  await capture("unzip", [
    "-p",
    vsixPath,
    "extension/dist/modelhop-build.json",
  ]),
);
const currentSourceHash = await computeProductionSourceHash(projectRoot);
const packagedOutputNames = Object.keys(
  packagedProvenance.outputs ?? {},
).sort();
const expectedOutputNames = [...PRODUCTION_BUILD_OUTPUTS].sort();
if (
  packagedProvenance.schemaVersion !== BUILD_PROVENANCE_SCHEMA_VERSION ||
  packagedProvenance.packageVersion !== manifest.version ||
  packagedProvenance.sourceHash !== currentSourceHash ||
  JSON.stringify(packagedOutputNames) !== JSON.stringify(expectedOutputNames)
) {
  throw new Error(
    "Packaged build provenance does not match the current production sources and output set.",
  );
}
for (const [outputName, expectedDigest] of Object.entries(
  packagedProvenance.outputs,
)) {
  if (
    typeof expectedDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedDigest)
  ) {
    throw new Error(
      `Packaged build provenance contains an invalid digest for ${outputName}.`,
    );
  }
  const packagedOutput = await capture("unzip", [
    "-p",
    vsixPath,
    `extension/${outputName}`,
  ]);
  if (sha256(packagedOutput) !== expectedDigest) {
    throw new Error(
      `Packaged production output ${outputName} does not match its build provenance.`,
    );
  }
}

const productionWebBundle = await capture("unzip", [
  "-p",
  vsixPath,
  "extension/dist/remote/app.js",
]);
const extensionBundle = await capture("unzip", [
  "-p",
  vsixPath,
  "extension/dist/extension.js",
]);
if (extensionBundle.includes("@anthropic-ai/claude-agent-sdk")) {
  throw new Error(
    "The VS Code extension-host bundle contains the Claude Agent SDK. Keep that SDK isolated in the detached remote daemon so its ESM session reader cannot break exact-session recovery.",
  );
}
const fixtureMarkers = [
  "__MODELHOP_FIXTURE_BUILD__",
  "modelHopFixture",
  "fixture-controls",
  "Fixture scenario",
  "fixture-long-conversation",
  "multi-root-files",
];
for (const fixtureMarker of fixtureMarkers) {
  if (productionWebBundle.includes(fixtureMarker)) {
    throw new Error(
      `Production web bundle contains fixture marker: ${fixtureMarker}`,
    );
  }
}

const textEntries = normalizedEntries.filter((entry) =>
  entry.startsWith("extension/") &&
  /(?:\.(?:cjs|css|html|js|json|md|mjs|txt|xml|ya?ml)|\.vsixmanifest)$/u.test(
    entry,
  ),
);
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /(?:^|[\s"'(])\/Users\/[^/\s<]+/u,
  /(?:^|[\s"'(])\/Volumes\/[^/\s<]+/u,
  /\b[A-Za-z]:\\Users\\[^\\\s<]+/u,
];
const localUsername = os.userInfo().username;
if (localUsername) {
  secretPatterns.push(
    new RegExp(`\\b${localUsername.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu"),
  );
}
for (const entry of textEntries) {
  const content = await capture("unzip", ["-p", vsixPath, entry]);
  const fixtureMarker = fixtureMarkers.find((marker) =>
    content.includes(marker),
  );
  if (fixtureMarker) {
    throw new Error(
      `VSIX entry ${entry} contains fixture/test marker: ${fixtureMarker}`,
    );
  }
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    throw new Error(
      `VSIX entry ${entry} appears to contain a credential or private key.`,
    );
  }
}

console.log(
  `VSIX contents (${normalizedEntries.length} entries):\n${normalizedEntries
    .slice()
    .sort()
    .map((entry) => `  ${entry}`)
    .join("\n")}`,
);
console.log(
  `VSIX contents verified (version ${manifest.version}).`,
);

async function capture(command, argumentsList) {
  return (await captureBuffer(command, argumentsList)).toString("utf8");
}

function captureBuffer(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(
        new Error(
          `${command} failed (${signal ?? `exit ${String(code)}`}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

function splitLines(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}
