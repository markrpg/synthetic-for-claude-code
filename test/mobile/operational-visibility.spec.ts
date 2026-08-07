import { expect, test } from "@playwright/test";
import {
  expectNoViewportOverflow,
  expectTouchTargets,
  loadScenario,
  promptInput,
  sendButton,
} from "./helpers.js";

test.describe("remote operational visibility", () => {
  test("names long-running hand-back work and keeps separate timers", async ({
    page,
  }) => {
    await loadScenario(page, "handback-long-workflow");

    await expect(page.locator("#task-phase")).toHaveText(
      "Returning after 1 workflow finishes",
    );
    await expect(page.locator("#work-graph")).toBeVisible();
    await expect(page.locator("#work-graph")).toContainText(
      "Audit GNM rights evidence",
    );
    await expect(page.locator("#work-graph")).toContainText(
      "3 of 4",
    );
    await expect(page.locator("#task-elapsed")).not.toHaveText("—");
    await expect(page.locator("#operation-elapsed-item")).toBeVisible();
    await expect(page.locator("#operation-elapsed-item")).toContainText(
      "Return",
    );
    await expect(promptInput(page)).toBeDisabled();
    await expectNoViewportOverflow(page);
  });

  test("shows overdue hand-back choices without implying cancellation", async ({
    page,
  }) => {
    await loadScenario(page, "handback-overdue");

    await expect(page.locator("#work-graph-summary")).toContainText(
      "You may lock this phone",
    );
    const actions = page.locator("#work-graph-actions");
    await expect(actions).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue waiting" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Keep working remotely" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel work and return now" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue waiting" }).click();
    const commands = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: { commands(): Array<Record<string, unknown>> };
        }
      ).modelHopFixture.commands(),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "session.handback.continue",
        operationId: "handoff-overdue",
      }),
    );
    await expectTouchTargets(page);
    await expectNoViewportOverflow(page);
  });

  test("cancels overdue work directly with one confirmation", async ({
    page,
  }) => {
    await loadScenario(page, "handback-overdue");
    let confirmations = 0;
    page.on("dialog", async (dialog) => {
      confirmations += 1;
      await dialog.accept();
    });

    await page
      .getByRole("button", { name: "Cancel work and return now" })
      .click();

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as {
              modelHopFixture: {
                commands(): Array<Record<string, unknown>>;
              };
            }
          ).modelHopFixture.commands(),
        ),
      )
      .toContainEqual(
        expect.objectContaining({
          type: "session.handback",
          strategy: "cancel",
          cancelActive: true,
        }),
      );
    expect(confirmations).toBe(1);
  });

  test("clears stale hand-back presentation after keeping work remote", async ({
    page,
  }) => {
    await loadScenario(page, "handback-overdue");
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Keep working remotely" })
      .click();
    await page.evaluate(async () => {
      await (
        window as unknown as {
          modelHopFixture: { dispatch(action: string): Promise<void> };
        }
      ).modelHopFixture.dispatch("cancel-handback-operation");
    });

    await expect(page.locator("#work-graph-actions")).toBeHidden();
    await expect(promptInput(page)).toBeEnabled();
    await expect(page.locator("#task-phase")).not.toContainText(
      /return|hand-back|checking mac/i,
    );
  });

  test("retries an ambiguous hand-back with the same durable command ID", async ({
    page,
  }) => {
    await loadScenario(page, "handback-delivery-unknown");
    await page.locator("#tab-settings").click();
    page.on("dialog", (dialog) => dialog.accept());
    const returnButton = page.locator("#handback-button");

    await returnButton.click();
    await expect(page.locator("#task-phase")).toHaveText("Checking Mac");
    await expect(returnButton).toBeEnabled();
    await returnButton.click();

    const commands = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: {
            commands(): Array<{ id: string; type: string }>;
          };
        }
      ).modelHopFixture
        .commands()
        .filter((command) => command.type === "session.handback"),
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]?.id).toBe(commands[1]?.id);
    const state = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: { state(): Record<string, unknown> };
        }
      ).modelHopFixture.state(),
    );
    expect(state.pendingHandbackCommand).toBeUndefined();
  });

  test("renders a terminal compatibility notification as an ended session", async ({
    page,
  }) => {
    await loadScenario(page, "normal");
    await page.evaluate(async () => {
      await (
        window as unknown as {
          modelHopFixture: { dispatch(action: string): Promise<void> };
        }
      ).modelHopFixture.dispatch("terminal-notification");
    });

    await expect(page.locator('[data-testid="session-ended"]')).toBeVisible();
    await expect(page.locator("#main-content")).toBeHidden();
    await expect(page.locator("#prompt-input")).toBeDisabled();
  });

  test("keeps final-record reconciliation visibly non-terminal", async ({
    page,
  }) => {
    await loadScenario(page, "final-record-reconciliation");
    await expect(page.locator("#task-phase")).toHaveText(
      "Final workflow record pending",
    );
    await expect(page.locator("#work-graph")).toContainText(
      "All child agents finished",
    );
    await expect(page.locator("#work-graph")).toContainText(
      "final record pending",
    );
  });

  test("distinguishes link loss, expiry, and non-owner monitoring", async ({
    page,
  }) => {
    await loadScenario(page, "tunnel-lost-active-work");
    await expect(page.locator("#connection-state")).toHaveText("Link lost");
    await expect(page.locator("#task-phase")).toHaveText(
      "Phone link lost · work continues",
    );
    await expect(page.locator("#work-graph")).toContainText(
      "Run mobile reliability gate",
    );

    await loadScenario(page, "expired-poll");
    await expect(page.locator("#connection-state")).toHaveText("Expired");
    await expect(page.locator("#task-phase")).toHaveText(
      "This phone link has expired",
    );

    await loadScenario(page, "non-owner-window");
    await expect(page.locator("#task-phase")).toContainText(
      "another device",
    );
    await expect(promptInput(page)).toBeDisabled();
  });

  test("marks uncertain prompt delivery as Checking Mac", async ({ page }) => {
    await loadScenario(page, "delivery-unknown");
    await promptInput(page).fill("Continue the reliability audit");
    await sendButton(page).click();

    const message = page.locator(".message-user").last();
    await expect(message).toHaveAttribute("data-delivery", "checking");
    await expect(message.locator(".delivery-state")).toHaveText(
      "Checking Mac…",
    );
    await expect(page.locator("#task-phase")).toHaveText("Checking Mac");
  });

  test("shows multiple approvals and ignores stale provider usage", async ({
    page,
  }) => {
    await loadScenario(page, "multiple-approvals");
    await expect(page.locator("#pending-permissions")).toBeVisible();
    await expect(page.locator("#approval-alert")).toBeVisible();
    await expect(page.locator("#task-phase")).toHaveText(
      "Your approval is needed",
    );

    await loadScenario(page, "stale-model-usage");
    await expect(page.locator("#route-label")).toContainText(
      "OpenAI via Codex",
    );
    await expect(page.locator("#usage-value")).toContainText("32,480 tok");
    await expect(page.locator("#usage-value")).not.toContainText("5h");
  });

  test("renders journal-gap recovery and restored work together", async ({
    page,
  }) => {
    await loadScenario(page, "journal-gap-resync");
    await expect(page.locator("#connection-state")).toHaveText("Secure");
    await expect(page.locator("#work-graph")).toContainText(
      "Rebuild encrypted activity view",
    );
    await expect(promptInput(page)).toBeEnabled();
  });
});
