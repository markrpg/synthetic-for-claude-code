import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);

if (process.env.MODELHOP_MOBILE_ACCEPTANCE_CONFIRMED !== "1") {
  throw new Error(
    `ModelHop ${String(manifest.version)} cannot be prepared locally until visual snapshots, manual fixture interaction, and user acceptance are complete. Set MODELHOP_MOBILE_ACCEPTANCE_CONFIRMED=1 only after that evidence is reviewed.`,
  );
}
if (process.env.MODELHOP_REAL_PHONE_SMOKE_CONFIRMED !== "1") {
  throw new Error(
    `ModelHop ${String(manifest.version)} cannot be prepared locally until a real-phone smoke test passes pairing, prompt delivery, approval, provider switching, link recreation, reconnection, and exact-session hand-back. Set MODELHOP_REAL_PHONE_SMOKE_CONFIRMED=1 only after that evidence is reviewed.`,
  );
}

await run(process.execPath, [
  path.join(projectRoot, "scripts", "remote-reliability-gate.mjs"),
  "--release",
]);

console.log(
  `Local ${String(manifest.version)} release preparation passed. No files were published.`,
);

function run(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      env: process.env,
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
