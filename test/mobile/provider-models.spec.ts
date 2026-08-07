import { expect, test } from "@playwright/test";
import { loadScenario } from "./helpers.js";

test.describe("provider model identity", () => {
  test("uses Anthropic selectors while showing canonical resolved models", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers provider selector identity.",
    );

    await loadScenario(page, "models-anthropic");
    await page.locator("#route-button").click();

    const modelSelect = page.locator("#model-select");
    await expect(modelSelect.locator("option")).toHaveText([
      "Default Claude model · claude-opus-5",
      "Opus · claude-opus-5",
      "Fable · claude-fable-5",
      "Sonnet · claude-sonnet-4-5",
      "Haiku · claude-haiku-4-5",
    ]);
    await expect(modelSelect).toHaveValue("default");
    await expect(page.locator("#model-capability-summary")).toContainText(
      "claude-opus-5",
    );

    const optionValues = await modelSelect.evaluate((element) =>
      Array.from((element as HTMLSelectElement).options).map(
        (option) => option.value,
      ),
    );
    expect(optionValues).toEqual([
      "default",
      "opus",
      "claude-fable-5[1m]",
      "sonnet",
      "haiku",
    ]);
    expect(optionValues).not.toContain("Default Claude model");

    await modelSelect.selectOption("claude-fable-5[1m]");
    await expect(modelSelect).toBeDisabled();
    await expect(page.locator("#model-change-status")).toHaveText(
      "Change accepted. Waiting for the active model to confirm…",
    );
    await expect(page.locator("#model-capability-summary")).toContainText(
      "claude-fable-5",
    );
    const commands = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: {
            commands(): Array<Record<string, unknown>>;
          };
        }
      ).modelHopFixture.commands(),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "model.change",
        model: "claude-fable-5[1m]",
      }),
    );
  });
});
