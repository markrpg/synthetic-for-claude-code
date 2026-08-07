import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertBuildProvenance } from "./build-provenance.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const outputName = `modelhop-for-claude-code-${manifest.version}.vsix`;
const vscePath = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vsce.cmd" : "vsce",
);

await assertBuildProvenance(projectRoot);

await run(vscePath, [
  "package",
  "--no-dependencies",
  "--allow-missing-repository",
  "--out",
  outputName,
]);
await run(process.execPath, [
  path.join(projectRoot, "scripts", "verify-vsix.mjs"),
  path.join(projectRoot, outputName),
]);

console.log(`Verified local package: ${outputName}`);

function run(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${path.basename(command)} failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}
