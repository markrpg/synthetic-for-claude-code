import { BUILD_PROVENANCE_PATH } from "./build-provenance.mjs";

export const REVIEWED_BINARY_DIGESTS = Object.freeze({
  "extension/docs/images/claude-code-kimi-k3-confirmation.png":
    "72bc127479313eb2ae68c8beb77a7c35bb76d8ee27e961a680d3728fba3a8d1d",
  "extension/docs/images/codex-model-picker.png":
    "80df36ad7aa21dea11031bfbf2630a4f2f1bd9844417a15693395f1d1f5fbbad",
  "extension/docs/images/codex-status-bar.png":
    "60d67d86291b5817a1d21ce532df242082fbab6b18ff90bada134185a62a5113",
  "extension/docs/images/modelhop-icon.png":
    "511d5ae9bc500c3dc568bf4db20bee8625e4fa00f3e6cbc51d5973e7e9427fc0",
  "extension/docs/images/modelhop-logo.png":
    "9e6235947c05c1fb439da6fbbc5f841c5f99538edd54bf97284d972f260708aa",
  "extension/docs/images/status-bar.png":
    "c4d7a6b5f6185ba8869428439f021fd36f81b60f8e931f9d875f606c5bcba8e7",
  "extension/media/modelhop-icon.png":
    "8c886711250ccb818ea93dd9bbcc8392f2a3d553fe536e22997940da1682d9ea",
});

const baseRequiredEntries = Object.freeze([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES.md",
  "extension/changelog.md",
  "extension/package.json",
  "extension/readme.md",
  "extension/dist/extension.js",
  "extension/dist/bridge-daemon.js",
  "extension/dist/remote-daemon.mjs",
  "extension/dist/remote/index.html",
  "extension/dist/remote/styles.css",
  "extension/dist/remote/chat-mesh.svg",
  "extension/dist/remote/app.js",
  `extension/${BUILD_PROVENANCE_PATH}`,
  "extension/docs/remote-retention-and-support.md",
  ...Object.keys(REVIEWED_BINARY_DIGESTS),
]);

export function requiredProductionEntries(version) {
  return [
    ...baseRequiredEntries,
    `extension/docs/release-notes-v${version}.md`,
  ];
}

export function assertProductionEntryPolicy(entries, version) {
  const normalizedEntries = entries.map(normalizeEntry);
  const requiredEntries = requiredProductionEntries(version);
  for (const required of requiredEntries) {
    if (!normalizedEntries.includes(required)) {
      throw new Error(`VSIX is missing required production entry: ${required}`);
    }
  }

  const exactAllowedEntries = new Set(requiredEntries);
  const unexpectedEntries = normalizedEntries.filter(
    (entry) =>
      !exactAllowedEntries.has(entry) &&
      !isHistoricalReleaseNote(entry),
  );
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `VSIX contains entries outside the reviewed production allowlist:\n${unexpectedEntries.join("\n")}`,
    );
  }
  return normalizedEntries;
}

function isHistoricalReleaseNote(entry) {
  return /^extension\/docs\/release-notes-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.md$/u.test(
    entry,
  );
}

function normalizeEntry(entry) {
  return entry.replaceAll("\\", "/").replace(/^\.\//u, "");
}
