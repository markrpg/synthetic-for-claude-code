import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

describe("remote reliability gate", () => {
  it("derives package output from the current manifest version", async () => {
    const manifest = await readManifest();
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/remote-reliability-gate.mjs", "--list"],
      { cwd: projectRoot },
    );

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(manifest.scripts["remote:reliability-gate"]).toContain(
      "remote-reliability-gate.mjs",
    );
    expect(manifest.scripts.package).toBe(
      "npm run remote:reliability-gate",
    );
    expect(stdout).toContain(
      `modelhop-for-claude-code-${manifest.version}.vsix`,
    );
    expect(stdout).toContain("accessibility tests");
    expect(stdout).toContain("VS Code integration tests");
  });

  it("adds smoke installation only to the accepted local-release path", async () => {
    const manifest = await readManifest();
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/remote-reliability-gate.mjs", "--release", "--list"],
      { cwd: projectRoot },
    );

    expect(stdout).toContain(
      `Smoke-install modelhop-for-claude-code-${manifest.version}.vsix`,
    );
  });

  it("prevents macOS maintenance sleep for the duration of the gate", async () => {
    const source = await readFile(
      path.join(projectRoot, "scripts/remote-reliability-gate.mjs"),
      "utf8",
    );

    expect(source).toContain('["-s", "-i", "-w", String(process.pid)]');
  });

  it("keeps manifest, lockfile, changelog, and current release notes aligned", async () => {
    const manifest = await readManifest();
    const lock = JSON.parse(
      await readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
    ) as { packages?: Record<string, { version?: string }>; version?: string };
    const releaseNotes = await readFile(
      path.join(
        projectRoot,
        "docs",
        `release-notes-v${manifest.version}.md`,
      ),
      "utf8",
    );
    const changelog = await readFile(
      path.join(projectRoot, "CHANGELOG.md"),
      "utf8",
    );

    expect(lock.version).toBe(manifest.version);
    expect(lock.packages?.[""]?.version).toBe(manifest.version);
    expect(releaseNotes).toMatch(
      new RegExp(`^# ModelHop for Claude Code ${manifest.version}\\n`, "u"),
    );
    expect(changelog).toContain(`\n## ${manifest.version}\n`);
  });

  it("refuses direct packaging when production build provenance is stale", async () => {
    const packageSource = await readFile(
      path.join(projectRoot, "scripts/package-vsix.mjs"),
      "utf8",
    );
    const buildSource = await readFile(
      path.join(projectRoot, "esbuild.mjs"),
      "utf8",
    );

    expect(packageSource).toContain("await assertBuildProvenance(projectRoot)");
    expect(buildSource).toContain("await writeBuildProvenance()");
  });

  it("refuses local release preparation without manual and real-phone evidence", async () => {
    await expect(
      execFileAsync(process.execPath, ["scripts/release-local.mjs"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          MODELHOP_MOBILE_ACCEPTANCE_CONFIRMED: "",
          MODELHOP_REAL_PHONE_SMOKE_CONFIRMED: "",
        },
      }),
    ).rejects.toThrow("cannot be prepared locally");
  });
});

async function readManifest(): Promise<{
  scripts: Record<string, string>;
  version: string;
}> {
  return JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string>; version: string };
}
