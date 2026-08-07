import { expect, test } from "@playwright/test";
import {
  conversationScrollport,
  dispatchFixtureAction,
  loadScenario,
  promptInput,
  sendButton,
} from "./helpers.js";

test.describe("conversation behaviour", () => {
  test("shows an outgoing prompt immediately", async ({ page }) => {
    await loadScenario(page);
    const message =
      "Keep this exact conversation when returning to my laptop.";
    await promptInput(page).fill(message);
    await sendButton(page).click();
    await expect(
      page.locator("#conversation").getByText(message, {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("keeps a rejected outgoing prompt visible", async ({ page }) => {
    await loadScenario(page, "prompt-failed");
    const message = "Retry this request after reconnecting.";
    await promptInput(page).fill(message);
    await sendButton(page).click();
    const failed = page.locator(
      '#conversation [data-delivery="failed"]',
    ).filter({ hasText: message });
    await expect(failed).toContainText(message);
    await expect(failed).toContainText(/not sent/i);
  });

  test("does not steal scroll position while new content streams", async ({
    page,
  }) => {
    await loadScenario(page, "long-conversation");
    const scrollport = conversationScrollport(page);
    await scrollport.evaluate((element) => {
      element.scrollTop = Math.max(1, element.scrollHeight / 3);
    });
    const before = await scrollport.evaluate(
      (element) => element.scrollTop,
    );

    await dispatchFixtureAction(page, "stream-delta");
    await page.waitForTimeout(100);

    const after = await scrollport.evaluate(
      (element) => element.scrollTop,
    );
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);

    const updates = page.locator(
      '[data-testid="new-updates"], #new-updates',
    );
    await expect(updates).toBeVisible();
    await updates.click();
    await expect
      .poll(async () =>
        scrollport.evaluate(
          (element) =>
            Math.abs(
              element.scrollHeight -
                element.clientHeight -
                element.scrollTop,
            ),
        ),
      )
      .toBeLessThanOrEqual(2);
  });

  test("blocks input for a provider transaction and resumes after commit", async ({
    page,
  }) => {
    await loadScenario(page, "switching-provider");
    await expect(promptInput(page)).toBeDisabled();
    await expect(page.locator("#task-phase")).toContainText(/switching/i);

    await dispatchFixtureAction(page, "provider-switch-complete");
    await expect(promptInput(page)).toBeEnabled();
    await expect(page.locator("#route-label")).toContainText(
      /OpenAI via Codex/i,
    );
  });

  test("restores a queued provider switch as blocking after reconnect", async ({
    page,
  }) => {
    await loadScenario(page, "provider-switch-waiting");

    await expect(promptInput(page)).toBeDisabled();
    await expect(page.locator("#task-phase")).toHaveText(
      "Switching provider after this response",
    );
    await expect(page.locator("#connection-state")).toHaveText(
      "Secure",
    );
    await expect(promptInput(page)).toHaveAttribute(
      "placeholder",
      "Switching provider…",
    );
  });

  test("keeps the authoritative completed lease ahead of replayed request phases", async ({
    page,
  }) => {
    await loadScenario(page);
    await dispatchFixtureAction(page, "complete-after-stale-events");

    await expect(page.locator("#task-phase")).toHaveText("Ready");
    await expect(promptInput(page)).toBeEnabled();
    await expect(
      page
        .locator("#activity-timeline-full")
        .getByText("Request sent", { exact: true }),
    ).toHaveCount(1);
  });

  test("reconstructs replayed notifications without showing stale toasts", async ({
    page,
  }) => {
    await loadScenario(page);
    await dispatchFixtureAction(page, "replay-transient-notification");

    await expect(
      page.locator("#toast-region .toast"),
    ).toHaveCount(0);
  });

  test("completes a desktop request in its activity row without a popup", async ({
    page,
  }) => {
    await loadScenario(page);
    await dispatchFixtureAction(page, "host-action-complete");
    await page.locator("#tab-activity").click();

    const completed = page
      .locator("#activity-timeline-full .activity-item")
      .filter({ hasText: "Completed on your Mac." });
    await expect(completed).toHaveCount(1);
    await expect(page.locator("#toast-region .toast")).toHaveCount(0);
  });

  test("deduplicates approval alerts and opens one approval sheet", async ({
    page,
  }) => {
    await loadScenario(page, "approval");
    await dispatchFixtureAction(page, "duplicate-approval");
    await expect(
      page.locator('[data-request-id="fixture-approval"]'),
    ).toHaveCount(1);
    await expect(
      page.getByText("Remote verification needs approval", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("offers authoritative slash commands", async ({ page }) => {
    await loadScenario(page, "slash-commands");
    await promptInput(page).fill("/");
    const suggestions = page.locator("#suggestions");
    await expect(suggestions).toBeVisible();
    await expect(
      suggestions.getByRole("option", { name: /compact/i }),
    ).toBeVisible();
  });

  test("opens the exact approval selected by its notification", async ({
    page,
  }) => {
    await loadScenario(page, "approval-notification");
    await page.locator("#tab-settings").click();
    await page.locator("#notification-button").click();
    await page.locator("#tab-chat").click();
    await dispatchFixtureAction(page, "inject-approval");
    await expect(
      page.locator('[data-request-id="fixture-approval"]'),
    ).toBeVisible();
    await dispatchFixtureAction(page, "hide-approval");
    await expect(
      page.locator("#pending-permissions"),
    ).toBeHidden();
    await dispatchFixtureAction(page, "notification-click");
    await expect(
      page.locator('[data-request-id="fixture-approval"]'),
    ).toBeVisible();
  });

  test("renders a structured Claude question", async ({ page }) => {
    await loadScenario(page, "question");
    await expect(
      page.getByRole("dialog").getByText("Which verification should run next?"),
    ).toBeVisible();
    await expect(
      page.getByRole("radio", {
        name: /Mobile browser matrix/i,
      }),
    ).toBeVisible();
  });
});
