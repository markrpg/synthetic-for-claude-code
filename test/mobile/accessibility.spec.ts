import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadScenario } from "./helpers.js";

for (const scenario of [
  "normal",
  "approval",
  "compacting",
  "reasoning-provider-private",
  "reasoning-loading",
  "handback-failed",
  "handback-success",
]) {
  test(`has no serious accessibility violations in ${scenario}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "Axe uses one canonical viewport; responsive geometry is covered separately.",
    );
    await loadScenario(page, scenario);
    const results = await new AxeBuilder({ page })
      .exclude("#fixture-controls")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const serious = results.violations.filter(
      (violation) =>
        violation.impact === "critical" ||
        violation.impact === "serious",
    );
    expect(serious).toEqual([]);
  });
}
