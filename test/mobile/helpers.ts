import {
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

export async function loadScenario(
  page: Page,
  scenario = "normal",
): Promise<void> {
  await page.goto(`/?scenario=${encodeURIComponent(scenario)}&controls=0`);
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.modelhopFixture === "ready",
  );
  await expect(page.locator("#app")).toBeVisible();
}

export function conversationScrollport(page: Page): Locator {
  return page.locator(
    '[data-testid="conversation-scroll"], #conversation',
  ).first();
}

export function promptInput(page: Page): Locator {
  return page.locator(
    '[data-testid="prompt-input"], #prompt-input',
  ).first();
}

export function sendButton(page: Page): Locator {
  return page.locator(
    '[data-testid="send"], #send-button',
  ).first();
}

export async function dispatchFixtureAction(
  page: Page,
  action: string,
): Promise<void> {
  await page.evaluate((actionName) => {
    const fixture = (
      window as unknown as {
        modelHopFixture?: {
          dispatch(action: string): void | Promise<void>;
        };
      }
    ).modelHopFixture;
    if (!fixture) {
      throw new Error("The ModelHop fixture controller is unavailable.");
    }
    return fixture.dispatch(actionName);
  }, action);
}

export async function expectNoViewportOverflow(
  page: Page,
): Promise<void> {
  const metrics = await page.evaluate(() => {
    const viewportWidth =
      window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight =
      window.visualViewport?.height ?? window.innerHeight;
    const visibleElements = [
      ...document.body.querySelectorAll<HTMLElement>("*"),
    ].filter((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        bounds.width > 0 &&
        bounds.height > 0
      );
    });
    const overflow = visibleElements
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          element:
            element.id ||
            element.getAttribute("data-testid") ||
            element.className ||
            element.tagName,
          left: bounds.left,
          right: bounds.right,
        };
      })
      .filter(
        ({ left, right }) =>
          left < -1 || right > viewportWidth + 1,
      );
    return {
      documentWidth: document.documentElement.scrollWidth,
      overflow,
      viewportHeight,
      viewportWidth,
    };
  });

  expect(
    metrics.documentWidth,
    `overflow elements: ${JSON.stringify(metrics.overflow.slice(0, 8))}`,
  ).toBeLessThanOrEqual(Math.ceil(metrics.viewportWidth) + 1);
  expect(metrics.overflow).toEqual([]);
}

export async function expectPrimaryControlsReachable(
  page: Page,
): Promise<void> {
  const approvalVisible = await page
    .locator("#pending-permissions")
    .isVisible();
  const selector = approvalVisible
    ? [
        "#pending-permissions .permission-card",
        "#pending-permissions button:not([hidden])",
      ].join(", ")
    : [
        '[data-testid="composer"]',
        "#prompt-form",
        '[data-testid="composer"] button:not([hidden])',
        "#prompt-form button:not([hidden])",
        '[data-testid="bottom-nav"]',
        ".bottom-tabs",
        '[data-testid="bottom-nav"] button:not([hidden])',
        ".bottom-tabs button:not([hidden])",
      ].join(", ");
  const controls = page.locator(selector);
  await expect(controls.first()).toBeVisible();

  const viewport = await page.evaluate(() => ({
    height: window.visualViewport?.height ?? window.innerHeight,
    left: window.visualViewport?.offsetLeft ?? 0,
    top: window.visualViewport?.offsetTop ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
  }));
  const boxes = await controls.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          left: bounds.left,
          name:
            element.id ||
            element.getAttribute("data-testid") ||
            element.getAttribute("aria-label") ||
            element.textContent?.trim().slice(0, 60) ||
            element.tagName,
          requiresHitTarget:
            element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement,
          reachable: (() => {
            const hit = document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            );
            return hit === element || element.contains(hit);
          })(),
          right: bounds.right,
          top: bounds.top,
        };
      }),
  );
  for (const box of boxes) {
    const label =
      `${box.name} viewport=${JSON.stringify(viewport)} ` +
      `bounds=${JSON.stringify({
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        top: box.top,
      })}`;
    expect(box.left, label).toBeGreaterThanOrEqual(viewport.left - 1);
    expect(box.right, label).toBeLessThanOrEqual(
      viewport.left + viewport.width + 1,
    );
    expect(box.top, label).toBeGreaterThanOrEqual(viewport.top - 1);
    expect(box.bottom, label).toBeLessThanOrEqual(
      viewport.top + viewport.height + 1,
    );
    if (box.requiresHitTarget) {
      expect(box.reachable, label).toBe(true);
    }
  }
}

export async function expectTouchTargets(
  page: Page,
): Promise<void> {
  const undersized = await page.evaluate(() => {
    const selectors = [
      '[data-touch-target="true"]',
      ".bottom-tabs button",
      "#send-button",
      "#cancel-button:not([hidden])",
      "#notification-button",
      "#handback-button",
      ".permission-actions button",
      ".work-graph-actions button",
    ].join(",");
    return [...document.querySelectorAll<HTMLElement>(selectors)]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      })
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          name:
            element.getAttribute("aria-label") ??
            element.textContent?.trim() ??
            element.id,
          width: bounds.width,
          height: bounds.height,
        };
      })
      .filter(
        ({ width, height }) => width < 44 || height < 44,
      );
  });
  expect(undersized).toEqual([]);
}
