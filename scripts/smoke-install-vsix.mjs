import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";

const projectRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const vsixPath = path.join(
  projectRoot,
  `modelhop-for-claude-code-${manifest.version}.vsix`,
);
const editorCli =
  process.env.MODELHOP_EDITOR_CLI ??
  (await firstAvailable(["cursor", "code"]));
if (!editorCli) {
  throw new Error(
    "No Cursor or VS Code CLI was found. Set MODELHOP_EDITOR_CLI to run the disposable-profile smoke install.",
  );
}

const disposableProfile = await mkdtemp(
  path.join(os.tmpdir(), "modelhop-vsix-smoke-"),
);
const extensionDirectory = path.join(
  disposableProfile,
  "extensions",
);
const userDataDirectory = path.join(
  disposableProfile,
  "user-data",
);
await Promise.all([
  mkdir(extensionDirectory, { recursive: true }),
  mkdir(userDataDirectory, { recursive: true }),
]);
try {
  await run(editorCli, [
    "--user-data-dir",
    userDataDirectory,
    "--extensions-dir",
    extensionDirectory,
    "--install-extension",
    vsixPath,
    "--force",
  ]);
  const installed = await capture(editorCli, [
    "--user-data-dir",
    userDataDirectory,
    "--extensions-dir",
    extensionDirectory,
    "--list-extensions",
    "--show-versions",
  ]);
  const expected =
    `${manifest.publisher}.${manifest.name}@${manifest.version}`.toLowerCase();
  if (
    !installed
      .split(/\r?\n/u)
      .map((entry) => entry.trim().toLowerCase())
      .includes(expected)
  ) {
    throw new Error(
      `Disposable profile did not report ${expected} after installation.`,
    );
  }
  const installedExtensionPath = await findInstalledExtension(
    extensionDirectory,
    manifest.publisher,
    manifest.name,
    manifest.version,
  );
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "compile:integration"],
  );
  await runTests({
    version: "1.130.0",
    extensionDevelopmentPath: [
      installedExtensionPath,
      path.join(
        projectRoot,
        "test",
        "fixtures",
        "claude-code-mock",
      ),
    ],
    extensionTestsPath: path.join(
      projectRoot,
      "dist-test",
      "test",
      "integration",
      "index.js",
    ),
    extensionTestsEnv: {
      MODELHOP_PACKAGED_SMOKE: "1",
      MODELHOP_EXPECTED_EXTENSION_PATH: installedExtensionPath,
    },
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--user-data-dir",
      userDataDirectory,
    ],
  });
  console.log(
    `Smoke-installed and activated ${expected} with ${path.basename(editorCli)}.`,
  );
} finally {
  await rm(disposableProfile, { recursive: true, force: true });
}

async function findInstalledExtension(
  directory,
  publisher,
  name,
  version,
) {
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    try {
      const candidateManifest = JSON.parse(
        await readFile(
          path.join(candidate, "package.json"),
          "utf8",
        ),
      );
      if (
        candidateManifest.publisher === publisher &&
        candidateManifest.name === name &&
        candidateManifest.version === version
      ) {
        return candidate;
      }
    } catch {
      // Ignore editor metadata and unrelated extension folders.
    }
  }
  throw new Error(
    `Could not locate the installed ${publisher}.${name}@${version} package.`,
  );
}

async function firstAvailable(commands) {
  for (const command of commands) {
    try {
      await run("which", [command], true);
      return command;
    } catch {
      // Try the next supported editor.
    }
  }
  return undefined;
}

function run(command, argumentsList, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      stdio: quiet ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

function capture(command, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}
