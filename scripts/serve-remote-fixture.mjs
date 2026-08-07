import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(
  projectRoot,
  "dist-test",
  "remote-mobile",
);
const shouldBuild = process.argv.includes("--build");
const requestedPort = readPort(process.argv);

if (shouldBuild) {
  await runNodeScript(
    path.join(projectRoot, "scripts", "build-remote-fixture.mjs"),
  );
}

await access(path.join(fixtureRoot, "index.html"));

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    );

    if (url.pathname === "/__health") {
      respond(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ ready: true }),
      );
      return;
    }

    const requestedPath =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const decodedPath = decodeURIComponent(requestedPath);
    const resolvedPath = path.resolve(fixtureRoot, decodedPath);
    const relativePath = path.relative(fixtureRoot, resolvedPath);
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      respond(response, 403, "text/plain; charset=utf-8", "Forbidden");
      return;
    }

    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) {
      respond(response, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }

    if (path.extname(resolvedPath) === ".html") {
      const nonce = randomBytes(24).toString("base64");
      const body = (await readFile(resolvedPath, "utf8")).replace(
        "<head>",
        `<head>\n    <meta name="modelhop-csp-nonce" content="${nonce}" />`,
      );
      response.writeHead(200, securityHeaders({
        "Cache-Control": "no-store",
        "Content-Length": String(Buffer.byteLength(body)),
        "Content-Type": "text/html; charset=utf-8",
      }, nonce));
      response.end(body);
      return;
    }

    response.writeHead(200, securityHeaders({
      "Cache-Control": "no-store",
      "Content-Length": String(fileStat.size),
      "Content-Type":
        mimeTypes.get(path.extname(resolvedPath)) ??
        "application/octet-stream",
    }));
    createReadStream(resolvedPath).pipe(response);
  } catch {
    respond(response, 404, "text/plain; charset=utf-8", "Not found");
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : requestedPort;
  console.log(
    `ModelHop Remote fixture: http://127.0.0.1:${port}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

function readPort(argumentsList) {
  const portIndex = argumentsList.indexOf("--port");
  const raw =
    portIndex >= 0 ? argumentsList[portIndex + 1] : "4177";
  const port = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid fixture port: ${raw}`);
  }
  return port;
}

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
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
          `Fixture build failed (${signal ?? `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

function securityHeaders(headers, nonce) {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  };
}

function respond(response, status, contentType, body) {
  response.writeHead(
    status,
    securityHeaders({
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    }),
  );
  response.end(body);
}
