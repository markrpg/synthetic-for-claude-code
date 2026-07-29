import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../../src/providers/types.js";

const vscodeMocks = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  update: vi.fn(),
}));

vi.mock("vscode", () => ({
  ConfigurationTarget: {
    Global: 1,
  },
  window: {
    showQuickPick: vscodeMocks.showQuickPick,
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      update: vscodeMocks.update,
    })),
  },
}));

import { confirmProviderSwitch } from "../../src/ui/confirmationDialog.js";

const syntheticProfile: ProviderProfile = {
  id: "synthetic",
  label: "Synthetic",
  shortLabel: "Synthetic",
  description: "Synthetic",
  requiresCredential: true,
  environmentVariables: [],
};

describe("confirmProviderSwitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMocks.update.mockResolvedValue(undefined);
  });

  it("switches without changing the preference when unchecked", async () => {
    vscodeMocks.showQuickPick.mockResolvedValue([]);

    await expect(
      confirmProviderSwitch("anthropic", syntheticProfile),
    ).resolves.toBe(true);
    expect(vscodeMocks.update).not.toHaveBeenCalled();
  });

  it("disables future confirmations when checked", async () => {
    vscodeMocks.showQuickPick.mockImplementation(
      async (items: readonly unknown[]) => [items[0]],
    );

    await expect(
      confirmProviderSwitch("anthropic", syntheticProfile),
    ).resolves.toBe(true);
    expect(vscodeMocks.update).toHaveBeenCalledWith(
      "confirmBeforeReload",
      false,
      1,
    );
  });

  it("cancels when the picker is dismissed", async () => {
    vscodeMocks.showQuickPick.mockResolvedValue(undefined);

    await expect(
      confirmProviderSwitch("anthropic", syntheticProfile),
    ).resolves.toBe(false);
    expect(vscodeMocks.update).not.toHaveBeenCalled();
  });
});
