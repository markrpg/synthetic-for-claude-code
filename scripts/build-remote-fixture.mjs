import * as esbuild from "esbuild";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(
  projectRoot,
  "dist-test",
  "remote-mobile",
);
const webSourceDirectory = path.join(
  projectRoot,
  "src",
  "remote",
  "web",
);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const sourceHtml = await readFile(
  path.join(webSourceDirectory, "index.html"),
  "utf8",
);
const fixtureHtml = sourceHtml
  .replace(
    '<script type="module" src="/app.js"></script>',
    '<script type="module" src="/fixture.js"></script>',
  )
  .replace(
    "</head>",
    [
      '<style id="modelhop-fixture-motion">',
      "*,*::before,*::after{animation:none!important;scroll-behavior:auto!important;transition:none!important}",
      "</style>",
      "</head>",
    ].join(""),
  )
  .replace(
    "</body>",
    [
      '<aside id="fixture-controls" aria-label="Fixture controls"></aside>',
      '<output id="fixture-status" class="sr-only" aria-live="polite"></output>',
      "</body>",
    ].join("\n"),
  );

if (fixtureHtml === sourceHtml) {
  throw new Error(
    "The production HTML no longer contains the expected app entrypoint.",
  );
}

await Promise.all([
  writeFile(
    path.join(outputDirectory, "index.html"),
    fixtureHtml,
    "utf8",
  ),
  copyFile(
    path.join(webSourceDirectory, "styles.css"),
    path.join(outputDirectory, "styles.css"),
  ),
  copyFile(
    path.join(webSourceDirectory, "chat-mesh.svg"),
    path.join(outputDirectory, "chat-mesh.svg"),
  ),
  copyFile(
    path.join(projectRoot, "media", "modelhop-icon.png"),
    path.join(outputDirectory, "icon.png"),
  ),
]);

await esbuild.build({
  bundle: true,
  entryPoints: [
    path.join(
      projectRoot,
      "test",
      "fixtures",
      "remote-mobile",
      "entry.ts",
    ),
  ],
  outfile: path.join(outputDirectory, "fixture.js"),
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  define: {
    __MODELHOP_FIXTURE_BUILD__: "true",
  },
});

console.log(
  `Built the deterministic remote fixture at ${outputDirectory}`,
);
