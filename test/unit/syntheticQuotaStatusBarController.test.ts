import type { ClaudeSettingsService } from "../../src/configuration/claudeSettingsService.js";
import type { CredentialService } from "../../src/credentials/credentialService.js";
import type { RedactingLogger } from "../../src/logging/redactingLogger.js";
import type { ProviderRegistry } from "../../src/providers/providerRegistry.js";
import type { SyntheticApiService } from "../../src/synthetic/syntheticApiService.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const vscodeMocks = vi.hoisted(() => {
  const statusItem = {
    text: "",
    tooltip: "",
    command: undefined as string | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    statusItem,
    usageRefreshMinutes: 1,
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
    openExternal: vi.fn(),
  };
});

vi.mock("vscode", () => ({
  StatusBarAlignment: {
    Right: 2,
  },
  window: {
    createStatusBarItem: vi.fn(() => vscodeMocks.statusItem),
    showInformationMessage: vscodeMocks.showInformationMessage,
    showErrorMessage: vscodeMocks.showErrorMessage,
    showInputBox: vscodeMocks.showInputBox,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(
        (key: string, defaultValue: unknown) =>
          key === "synthetic.usageRefreshMinutes"
            ? vscodeMocks.usageRefreshMinutes
            : defaultValue,
      ),
    })),
  },
  env: {
    openExternal: vscodeMocks.openExternal,
  },
  Uri: {
    parse: vi.fn((value: string) => value),
  },
}));

import { SyntheticQuotaStatusBarController } from "../../src/ui/syntheticQuotaStatusBarController.js";

const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";

function createController(getQuota = vi.fn()) {
  const settingsService = {
    read: vi.fn(() => ({
      effectiveRawValue: [
        {
          name: "ANTHROPIC_BASE_URL",
          value: SYNTHETIC_BASE_URL,
        },
      ],
    })),
  } as unknown as ClaudeSettingsService;
  const providerRegistry = {
    getSyntheticSettings: vi.fn(() => ({
      baseUrl: SYNTHETIC_BASE_URL,
    })),
  } as unknown as ProviderRegistry;
  const credentialService = {
    hasSyntheticToken: vi.fn(async () => true),
  } as unknown as CredentialService;
  const apiService = {
    getQuota,
  } as unknown as SyntheticApiService;
  const logger = {
    error: vi.fn(),
  } as unknown as RedactingLogger;

  return new SyntheticQuotaStatusBarController(
    settingsService,
    providerRegistry,
    credentialService,
    apiService,
    logger,
  );
}

describe("SyntheticQuotaStatusBarController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    vi.clearAllMocks();
    vscodeMocks.usageRefreshMinutes = 1;
    vscodeMocks.statusItem.text = "";
    vscodeMocks.statusItem.tooltip = "";
    vscodeMocks.statusItem.command = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes immediately and every minute by default", async () => {
    const getQuota = vi.fn(async () => ({
      fiveHour: {
        max: 500,
        remaining: 250,
        used: 250,
        remainingPercent: 50,
      },
    }));
    const controller = createController(getQuota);

    controller.start();
    await controller.refresh();
    expect(getQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(vscodeMocks.statusItem.text).toContain("5h 50% left");
    controller.dispose();
  });

  it("refreshes on focus once the displayed quota is 15 seconds old", async () => {
    const getQuota = vi.fn(async () => ({
      weekly: {
        percentRemaining: 50,
        usedPercent: 50,
      },
    }));
    const controller = createController(getQuota);

    await controller.refresh();
    expect(getQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_999);
    controller.handleWindowFocus();
    await Promise.resolve();
    expect(getQuota).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    controller.handleWindowFocus();
    await controller.refresh();

    expect(getQuota).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("uses the quota indicator as a direct refresh action", () => {
    const controller = createController();

    expect(vscodeMocks.statusItem.command).toBe(
      "claudeProvider.showSyntheticUsage",
    );
    controller.dispose();
  });
});
