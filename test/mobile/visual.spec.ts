import { expect, test } from "@playwright/test";
import { loadScenario } from "./helpers.js";

for (const scenario of [
  "normal",
  "approval",
  "compacting",
  "tools-running",
  "handback-failed",
  "handback-overdue",
  "final-record-reconciliation",
  "tunnel-lost-active-work",
]) {
  test(`matches the reviewed ${scenario} mobile surface`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "Principal visual baselines use the modern iPhone viewport.",
    );
    await loadScenario(page, scenario);
    await expect(page).toHaveScreenshot(`${scenario}.png`, {
      fullPage: false,
    });
  });
}

test("matches the reviewed repository constellation", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-modern-393x852",
    "The repository visual baseline uses the modern iPhone viewport.",
  );
  await loadScenario(page, "multi-root-files");
  await page
    .getByRole("button", { name: "Folder ModelHop", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Folder src", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Folder remote", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "File sessionController.ts",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="file-constellation"]'),
  ).toHaveScreenshot("repository-constellation.png");
});

test("matches the reviewed repository overflow control", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-modern-393x852",
    "The repository overflow baseline uses the modern iPhone viewport.",
  );
  await loadScenario(page, "multi-root-files");
  await page
    .getByRole("button", { name: "Folder ModelHop", exact: true })
    .click();
  await expect(
    page.locator('[data-testid="file-constellation"]'),
  ).toHaveScreenshot("repository-overflow.png");
});

test("matches the reviewed compact header controls", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-modern-393x852",
    "The compact header baseline uses the modern iPhone viewport.",
  );
  await loadScenario(page, "normal");
  await page.getByRole("button", { name: "Minimise header" }).click();
  await expect(page.locator("#task-header")).toHaveScreenshot(
    "compact-header.png",
  );
});

test("matches the reviewed rich Markdown conversation", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "iphone-modern-393x852",
    "The rich Markdown baseline uses the modern iPhone viewport.",
  );
  await loadScenario(page, "markdown-rich");
  await page
    .locator("#task-header, #task-view-tabs, .composer, .bottom-tabs")
    .evaluateAll((elements) => {
      elements.forEach((element) => {
        (element as HTMLElement).style.display = "none";
      });
    });
  await expect(
    page.locator('[data-message-id="markdown-assistant"]'),
  ).toHaveScreenshot("rich-markdown-message.png");
});
