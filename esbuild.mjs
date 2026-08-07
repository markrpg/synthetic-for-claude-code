import * as esbuild from "esbuild";
import {
  copyFile,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import { writeBuildProvenance } from "./scripts/build-provenance.mjs";

const watch = process.argv.includes("--watch");
const commonOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

async function copyRemoteAssets() {
  await mkdir("dist/remote", { recursive: true });
  await Promise.all(
    [
      "index.html",
      "styles.css",
      "chat-mesh.svg",
    ].map((file) =>
      copyFile(
        path.join("src", "remote", "web", file),
        path.join("dist", "remote", file),
      ),
    ),
  );
}

const extensionBuild = {
  ...commonOptions,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
};
const bridgeBuild = {
  ...commonOptions,
  entryPoints: ["src/bridge/server.ts"],
  outfile: "dist/bridge-daemon.js",
};
const remoteBuild = {
  ...commonOptions,
  format: "esm",
  entryPoints: ["src/remote/server.ts"],
  outfile: "dist/remote-daemon.mjs",
};
const webBuild = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: true,
  logLevel: "info",
  entryPoints: ["src/remote/web/app.ts"],
  outfile: "dist/remote/app.js",
};
if (watch) {
  await copyRemoteAssets();
  const contexts = await Promise.all(
    [
      extensionBuild,
      bridgeBuild,
      remoteBuild,
      webBuild,
    ].map((options) => esbuild.context(options)),
  );
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await copyRemoteAssets();
  await Promise.all([
    esbuild.build(extensionBuild),
    esbuild.build(bridgeBuild),
    esbuild.build(remoteBuild),
    esbuild.build(webBuild),
  ]);
  await writeBuildProvenance();
}
