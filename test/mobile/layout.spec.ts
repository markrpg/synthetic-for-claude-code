import { expect, test } from "@playwright/test";
import {
  expectNoViewportOverflow,
  expectPrimaryControlsReachable,
  expectTouchTargets,
  loadScenario,
} from "./helpers.js";

test.describe("mobile layout", () => {
  test("minimises the header without losing route or status context", async ({
    page,
  }) => {
    await loadScenario(page);
    const header = page.locator("#task-header");
    const summary = page.locator("#task-summary");
    const viewTabs = page.locator("#task-view-tabs");
    const compactRoute = page.locator("#compact-route-button");
    const toggle = page.getByRole("button", { name: "Minimise header" });
    const expandedHeight = await header.evaluate(
      (element) => element.getBoundingClientRect().height,
    );

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(summary).toBeVisible();
    await expect(viewTabs).toBeVisible();
    await expect(compactRoute).toBeHidden();

    await toggle.click();
    const expand = page.getByRole("button", { name: "Expand header" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(summary).toBeHidden();
    await expect(viewTabs).toBeHidden();
    await expect(compactRoute).toBeVisible();
    await expect(compactRoute).toContainText(/OpenAI via Codex/i);
    await expect(page.locator("#compact-phase-label")).not.toBeEmpty();
    await expect
      .poll(() =>
        header.evaluate(
          (element) => element.getBoundingClientRect().height,
        ),
      )
      .toBeLessThan(expandedHeight);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              modelHopFixture?: { state(): { headerCollapsed?: boolean } };
            }
          ).modelHopFixture?.state().headerCollapsed,
        ),
      )
      .toBe(true);
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);
    await expectTouchTargets(page);

    await compactRoute.click();
    await expect(page.locator("#route-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expand.click();
    await expect(summary).toBeVisible();
    await expect(viewTabs).toBeVisible();
  });

  test("tracks fullscreen state and keeps its controls accessible", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers the Fullscreen API contract.",
    );
    await page.addInitScript(() => {
      let activeElement: Element | null = null;
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        get: () => true,
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => activeElement,
      });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: async function requestFullscreen(): Promise<void> {
          activeElement = this as Element;
          document.dispatchEvent(new Event("fullscreenchange"));
        },
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: async (): Promise<void> => {
          activeElement = null;
          document.dispatchEvent(new Event("fullscreenchange"));
        },
      });
    });
    await loadScenario(page);

    const enter = page.getByRole("button", { name: "Enter fullscreen" });
    await expect(enter).toBeVisible();
    await expect(enter).toHaveAttribute("aria-pressed", "false");
    await enter.click();

    const exit = page.getByRole("button", { name: "Exit fullscreen" });
    await expect(exit).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#app")).toHaveAttribute(
      "data-fullscreen",
      "true",
    );
    await expectNoViewportOverflow(page);
    await expectTouchTargets(page);

    await exit.click();
    await expect(enter).toHaveAttribute("aria-pressed", "false");
  });

  test("retains compact mode when fullscreen is unsupported", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers the unsupported fallback.",
    );
    await page.addInitScript(() => {
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        get: () => false,
      });
    });
    await loadScenario(page);
    await expect(page.locator("#fullscreen-button")).toBeHidden();
    await page.getByRole("button", { name: "Minimise header" }).click();
    await expect(
      page.getByRole("button", { name: "Expand header" }),
    ).toBeVisible();
    await expectNoViewportOverflow(page);
  });

  test("fits the visual viewport with reachable controls", async ({
    page,
  }) => {
    await loadScenario(page);
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);
    await expectTouchTargets(page);
  });

  test("contains long approval content without horizontal escape", async ({
    page,
  }) => {
    await loadScenario(page, "approval");
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);
    await expectTouchTargets(page);
  });

  test("survives 200 percent browser reflow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-se-375x667",
      "One deterministic zoom run is sufficient.",
    );
    await page.setViewportSize({
      width: Math.floor(375 / 2),
      height: Math.floor(667 / 2),
    });
    await loadScenario(page);
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);
    await expectTouchTargets(page);
  });
});
