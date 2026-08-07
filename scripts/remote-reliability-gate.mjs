import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { assertReleaseMetadataConsistency } from "./build-provenance.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
await assertReleaseMetadataConsistency(projectRoot);
const requestedArguments = new Set(process.argv.slice(2));
const supportedArguments = new Set(["--list", "--release"]);
const unknownArguments = [...requestedArguments].filter(
  (argument) => !supportedArguments.has(argument),
);

if (unknownArguments.length > 0) {
  throw new Error(
    `Unknown reliability-gate option${unknownArguments.length === 1 ? "" : "s"}: ${unknownArguments.join(", ")}`,
  );
}
if (
  typeof manifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
) {
  throw new Error(
    `package.json contains an invalid release version: ${String(manifest.version)}`,
  );
}

const packageFilename = `modelhop-for-claude-code-${manifest.version}.vsix`;
const isRelease = requestedArguments.has("--release");
const steps = [
  npmStep("Clean generated outputs", "clean"),
  npmStep("Type-check extension, web, and mobile test code", "typecheck"),
  npmStep("Lint production and remote test code", "lint"),
  npmStep("Run unit and fault-injection tests", "test"),
  npmStep("Build production extension and remote assets", "compile"),
  nodeStep(
    "Smoke-test remote daemon routes",
    "scripts/smoke-remote-routes.mjs",
  ),
  npmStep("Run VS Code integration tests", "test:integration"),
  npmStep(
    "Run mobile, visual, responsive, and accessibility tests",
    "test:mobile",
  ),
  nodeStep(
    `Build and verify ${packageFilename}`,
    "scripts/package-vsix.mjs",
  ),
];

if (isRelease) {
  steps.push(
    nodeStep(
      `Smoke-install ${packageFilename} in a disposable editor profile`,
      "scripts/smoke-install-vsix.mjs",
    ),
  );
}

if (requestedArguments.has("--list")) {
  console.log(
    [
      `ModelHop Remote reliability gate for ${manifest.version}:`,
      ...steps.map((step, index) => `  ${index + 1}. ${step.label}`),
    ].join("\n"),
  );
  process.exit(0);
}
if (isRelease) {
  assertManualAcceptance();
}

const startedAt = Date.now();
const releasePowerAssertion = keepMacAwakeDuringGate();
console.log(
  `ModelHop Remote reliability gate ${manifest.version} (${isRelease ? "local release" : "package"})`,
);

try {
  for (const [index, step] of steps.entries()) {
    const stepStartedAt = Date.now();
    console.log(`\n[${index + 1}/${steps.length}] ${step.label}`);
    try {
      await run(step.command, step.argumentsList);
    } catch (error) {
      throw new Error(
        `Reliability gate failed at “${step.label}”.`,
        { cause: error },
      );
    }
    console.log(`Passed in ${formatDuration(Date.now() - stepStartedAt)}.`);
  }

  await access(path.join(projectRoot, packageFilename));
  console.log(
    `\nReliability gate passed in ${formatDuration(Date.now() - startedAt)}.`,
  );
  console.log(`Verified local package: ${packageFilename}`);
  console.log("Nothing was pushed, tagged, published, or released.");
} finally {
  releasePowerAssertion();
}

function assertManualAcceptance() {
  if (process.env.MODELHOP_MOBILE_ACCEPTANCE_CONFIRMED !== "1") {
    throw new Error(
      "Local release requires reviewed visual snapshots, manual fixture interaction, and user acceptance. Set MODELHOP_MOBILE_ACCEPTANCE_CONFIRMED=1 only after those checks pass.",
    );
  }
  if (process.env.MODELHOP_REAL_PHONE_SMOKE_CONFIRMED !== "1") {
    throw new Error(
      "Local release requires a real-phone smoke test covering pairing, prompt delivery, approval, provider switching, link recreation, reconnection, and exact-session hand-back. Set MODELHOP_REAL_PHONE_SMOKE_CONFIRMED=1 only after it passes.",
    );
  }
}

function npmStep(label, script) {
  return {
    label,
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    argumentsList: ["run", script],
  };
}

function nodeStep(label, relativeScriptPath) {
  return {
    label,
    command: process.execPath,
    argumentsList: [path.join(projectRoot, relativeScriptPath)],
  };
}

function keepMacAwakeDuringGate() {
  if (process.platform !== "darwin") {
    return () => undefined;
  }
  const assertion = spawn(
    "/usr/bin/caffeinate",
    // `-i` prevents ordinary idle sleep. `-s` is also required when the gate
    // begins during a macOS maintenance dark-wake; without it the machine can
    // re-enter maintenance sleep even though test work is actively running.
    ["-s", "-i", "-w", String(process.pid)],
    {
      stdio: "ignore",
    },
  );
  assertion.once("error", (error) => {
    console.warn(
      `Could not hold the macOS idle-sleep assertion: ${error.message}`,
    );
  });
  assertion.unref();
  return () => {
    if (assertion.exitCode === null && assertion.signalCode === null) {
      assertion.kill("SIGTERM");
    }
  };
}

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

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
