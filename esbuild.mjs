import * as esbuild from "esbuild";

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

if (watch) {
  const extensionContext = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  });
  const bridgeContext = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/bridge/server.ts"],
    outfile: "dist/bridge-daemon.js",
  });
  await Promise.all([extensionContext.watch(), bridgeContext.watch()]);
} else {
  await Promise.all([
    esbuild.build({
      ...commonOptions,
      entryPoints: ["src/extension.ts"],
      outfile: "dist/extension.js",
      external: ["vscode"],
    }),
    esbuild.build({
      ...commonOptions,
      entryPoints: ["src/bridge/server.ts"],
      outfile: "dist/bridge-daemon.js",
    }),
  ]);
}
