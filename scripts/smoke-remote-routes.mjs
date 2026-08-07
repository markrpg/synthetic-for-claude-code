import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a remote smoke-test port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0 }),
        );
      },
    );
    call.setTimeout(3_000, () => {
      call.destroy(new Error(`Timed out requesting ${pathname}.`));
    });
    call.once("error", reject);
    if (options.headersOnly) {
      call.flushHeaders();
    } else {
      call.end(options.body);
    }
  });
}

async function waitForHealth(port, controlToken) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const result = await request(port, "/health", {
        headers: { "X-ModelHop-Control": controlToken },
      });
      if (result.status === 200) {
        return;
      }
    } catch {
      // The detached daemon is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The remote route smoke-test daemon did not start.");
}

function expectStatus(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(
      `${label} returned ${result.status}; expected ${expected}.`,
    );
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The remote route smoke-test daemon did not exit."));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

const stateDirectory = await mkdtemp(
  path.join(tmpdir(), "modelhop-remote-routes-"),
);
const port = await reservePort();
const controlToken = randomBytes(32).toString("base64url");
const daemon = spawn(
  process.execPath,
  [
    path.resolve("dist/remote-daemon.mjs"),
    "--port",
    String(port),
    "--state-dir",
    stateDirectory,
  ],
  {
    env: {
      ...process.env,
      MODELHOP_REMOTE_CONTROL_TOKEN: controlToken,
      MODELHOP_REMOTE_JOURNAL_KEY:
        randomBytes(32).toString("base64"),
    },
    stdio: "ignore",
  },
);
let gracefulShutdownRequested = false;

try {
  await waitForHealth(port, controlToken);
  expectStatus(
    await request(port, "/health"),
    401,
    "Unauthenticated health",
  );
  expectStatus(
    await request(port, "/health", {
      headers: { "X-ModelHop-Control": controlToken },
    }),
    200,
    "Authenticated health",
  );
  for (const pathname of ["/api/connect", "/api/command"]) {
    expectStatus(
      await request(port, pathname, {
        method: "POST",
        headers: { "Content-Length": String(16 * 1024 * 1024) },
        headersOnly: true,
      }),
      410,
      `${pathname} closed-session pre-body rejection`,
    );
  }
  expectStatus(
    await request(port, "/control/configure", {
      method: "POST",
      headers: { "Content-Length": String(2 * 1024 * 1024) },
      headersOnly: true,
    }),
    401,
    "Control pre-body authorization",
  );
  expectStatus(
    await request(port, "/control/shutdown", {
      method: "POST",
      headers: {
        "Content-Length": "0",
        "X-ModelHop-Control": controlToken,
      },
    }),
    200,
    "Authenticated shutdown",
  );
  gracefulShutdownRequested = true;
} finally {
  try {
    if (!gracefulShutdownRequested) {
      daemon.kill("SIGTERM");
    }
    await waitForExit(daemon, 5_000);
  } catch {
    daemon.kill("SIGKILL");
    await waitForExit(daemon, 2_000).catch(() => undefined);
  }
  await rm(stateDirectory, { recursive: true, force: true });
}
