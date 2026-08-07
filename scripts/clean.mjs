import {
  readdir,
  rm,
  unlink,
} from "node:fs/promises";

await Promise.all([
  rm("dist", { force: true, recursive: true }),
  rm("dist-test", { force: true, recursive: true }),
  rm("playwright-report", { force: true, recursive: true }),
  rm("test-results", { force: true, recursive: true }),
]);

const packagePattern =
  /^modelhop-for-claude-code-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.vsix$/u;
for (const entry of await readdir(".")) {
  if (packagePattern.test(entry)) {
    await unlink(entry);
  }
}
