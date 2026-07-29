import { rm } from "node:fs/promises";

await Promise.all([
  rm("dist", { force: true, recursive: true }),
  rm("dist-test", { force: true, recursive: true }),
  rm("modelhop-for-claude-code-2.0.0.vsix", { force: true }),
]);
