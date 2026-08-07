import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteSupportBundle,
  writeRemoteSupportBundle,
} from "../../src/remote/supportBundle.js";
import type {
  RemoteDaemonStatus,
  RemoteHandoffRecord,
  RemoteWorkItem,
} from "../../src/remote/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "modelhop-support-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function unsafeStatus(): RemoteDaemonStatus {
  return {
    name: "modelhop-remote",
    version: "1.3.0",
    buildVersion: "2.2.4-remote.5",
    ready: true,
    configured: true,
    lease: {
      id: "lease-secret-id",
      sourceSessionId: "source-secret-id",
      activeSessionId: "active-secret-id",
      sourceTranscriptPath:
        "/Users/private-name/.claude/projects/private/transcript.jsonl",
      workspacePath: "/Users/private-name/Secret Project",
      workspacePaths: ["/Users/private-name/Secret Project"],
      workspaceName: "Secret Project",
      title: "My unreleased prompt text",
      ownerDeviceId: "phone-secret-id",
      state: "handing-back",
      provider: {
        provider: "openai-api",
        label: "OpenAI with sk-secret-api-key",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        roleModels: {
          default: "gpt-5.6-sol",
          opus: "gpt-5.6-sol",
          sonnet: "gpt-5.6-terra",
          haiku: "gpt-5.6-luna",
          subagent: "gpt-5.6-terra",
        },
        usage: {
          rawPrompt: "My unreleased prompt text",
          credential: "sk-secret-api-key",
        },
        updatedAt: 80,
      },
      createdAt: 10,
      lastActivityAt: 90,
      providerChanged: true,
      turnPhase: "settling",
      turnStartedAt: 20,
      backgroundTaskCount: 1,
      operation: {
        id: "operation-secret-id",
        kind: "handback",
        phase: "waiting-for-turn",
        leaseId: "lease-secret-id",
        ownerWorkspacePath: "/Users/private-name/Secret Project",
        requestedAt: 30,
        updatedAt: 90,
        attentionAt: 100,
        blockerIds: ["workflow-secret-id"],
        waitReason: "Raw tool args: rm -rf /private/path",
        error: "Bearer secret-token in /private/path",
        availableActions: ["continue-waiting"],
      },
    },
    pendingPairings: [
      {
        connectionId: "connection-secret-id",
        deviceId: "device-secret-id",
        deviceName: "Casey's private phone",
        sas: "123 456",
        createdAt: 10,
      },
    ],
    pairedDevices: [
      {
        id: "device-secret-id",
        name: "Casey's private phone",
        publicKey: "private-public-key-material",
        pairedAt: 1,
        lastUsedAt: 2,
      },
    ],
    hostActions: [
      {
        id: "host-action-secret-id",
        type: "session.handback",
        payload: {
          prompt: "My unreleased prompt text",
          arguments: "rm -rf /private/path",
        },
        createdAt: 3,
      },
    ],
    tunnel: {
      transport: "cloudflare-quick",
      pid: 123,
      baseUrl: "https://secret-link.trycloudflare.com/capability",
      executable: "/Users/private-name/bin/cloudflared",
      originPort: 18296,
      configPath: "/Users/private-name/private.yml",
      logPath: "/Users/private-name/private.log",
      startedAt: 20,
    },
    journal: {
      epoch: "journal-secret-epoch",
      earliestEventId: 8,
      latestEventId: 92,
      snapshotCursor: 80,
    },
    ownership: {
      workspaceOwnerId: "workspace-secret-id",
      deviceId: "device-secret-id",
      fencingGeneration: 7,
    },
    transport: {
      state: "link-lost",
      updatedAt: 91,
      detail: "Credential sk-secret-api-key failed at /private/path",
    },
    query: {
      generation: 4,
      state: "settling",
      lastProgressAt: 89,
      blockerIds: ["workflow-secret-id"],
    },
    recovery: {
      state: "recovering",
      savedAt: 88,
      transcriptRecoverable: true,
      error: "My unreleased prompt text at /private/path",
    },
  };
}

function unsafeHandoff(): RemoteHandoffRecord {
  return {
    version: 2,
    leaseId: "lease-secret-id",
    sessionId: "active-secret-id",
    transcriptPath: "/Users/private-name/private-transcript.jsonl",
    workspacePath: "/Users/private-name/Secret Project",
    title: "My unreleased prompt text",
    transcriptSignature: "private-transcript-signature",
    phase: "reconciling-final-record",
    actionId: "handoff-secret-id",
    createdAt: 30,
    updatedAt: 91,
    lastError: "sk-secret-api-key at /private/path",
  };
}

const unsafeWorkItem: RemoteWorkItem = {
  id: "workflow-secret-id",
  kind: "workflow",
  title: "Audit confidential customer rights evidence",
  phase: "settling",
  createdAt: 40,
  updatedAt: 90,
  lastProgressAt: 89,
  outputReferences: ["/Users/private-name/private-output.md"],
  cancellable: true,
};

describe("Remote support bundle", () => {
  it("uses a strict allow list and omits content, secrets, URLs, and paths", () => {
    const bundle = buildRemoteSupportBundle({
      extensionVersion: "2.2.4",
      generatedAt: 100,
      status: unsafeStatus(),
      handoff: unsafeHandoff(),
      workItems: [unsafeWorkItem],
      transitions: [
        {
          at: 90,
          axis: "execution",
          state: "settling",
          correlationId: "workflow-secret-id",
        },
        {
          at: 91,
          axis: "transport",
          state: "https://secret-link.trycloudflare.com/private",
        },
      ],
    });
    const serialized = JSON.stringify(bundle);

    for (const secret of [
      "sk-secret-api-key",
      "secret-token",
      "My unreleased prompt text",
      "Audit confidential customer rights evidence",
      "private-name",
      "Secret Project",
      "trycloudflare.com",
      "rm -rf",
      "private-output.md",
      "transcript.jsonl",
      "Casey's private phone",
      "123 456",
      "private-public-key-material",
      "lease-secret-id",
      "workflow-secret-id",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(bundle).toMatchObject({
      schema: "modelhop.remote.support",
      health: {
        transportState: "link-lost",
        executionState: "settling",
        transcriptRecoverable: true,
      },
      route: {
        provider: "openai-api",
      },
      privacy: { allowListOnly: true },
    });
    expect(
      (bundle.transitions as Array<{ state: string }>)[1]?.state,
    ).toBe("unrecognized");
    expect(
      (bundle.route as { modelCorrelationId?: string })
        .modelCorrelationId,
    ).toMatch(/^[a-f0-9]{20}$/u);
  });

  it("writes a private standalone JSON bundle", async () => {
    const directory = await temporaryDirectory();
    const result = await writeRemoteSupportBundle(directory, {
      extensionVersion: "2.2.4",
      generatedAt: Date.UTC(2026, 7, 3, 12, 0, 0),
      status: unsafeStatus(),
    });
    const details = await stat(result.path);
    const source = await readFile(result.path, "utf8");

    expect(path.dirname(result.path)).toBe(directory);
    expect(details.mode & 0o777).toBe(0o600);
    expect(JSON.parse(source)).toMatchObject({
      schema: "modelhop.remote.support",
      correlationId: result.correlationId,
    });
    expect(source).not.toContain("sk-secret-api-key");
  });
});
