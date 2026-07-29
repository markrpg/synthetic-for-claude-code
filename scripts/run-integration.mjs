import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.resolve(directory, "..");
const extensionDevelopmentPath = [
  projectPath,
  path.resolve(projectPath, "test/fixtures/claude-code-mock"),
];
const extensionTestsPath = path.resolve(
  projectPath,
  "dist-test/test/integration/index.js",
);

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--disable-extensions"],
  });
} catch (error) {
  console.error("VS Code integration tests failed.");
  process.exitCode = 1;
}
