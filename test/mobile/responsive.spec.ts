import { expect, test, type Page } from "@playwright/test";
import {
  expectNoViewportOverflow,
  expectPrimaryControlsReachable,
  loadScenario,
} from "./helpers.js";

const responsiveProjects = new Set([
  "tablet-portrait-768x1024",
  "tablet-landscape-1024x768",
  "desktop-1440x900",
  "desktop-hd-1920x1080",
  "ultrawide-2560x1440",
]);

const desktopProjects = new Set([
  "desktop-1440x900",
  "desktop-hd-1920x1080",
  "ultrawide-2560x1440",
]);

const compactHeaderProjects = new Set([
  "tablet-landscape-1024x768",
]);

const normalVisualProjects = new Set([
  "tablet-portrait-768x1024",
  "tablet-landscape-1024x768",
  "desktop-1440x900",
  "ultrawide-2560x1440",
]);

const approvalVisualProjects = new Set([
  "tablet-landscape-1024x768",
  "desktop-1440x900",
]);

const strictScreenshot = {
  animations: "disabled" as const,
  caret: "hide" as const,
  maxDiffPixelRatio: 0.001,
  maxDiffPixels: 60,
};

test.beforeEach(({ browserName }, testInfo) => {
  void browserName;
  test.skip(
    !responsiveProjects.has(testInfo.project.name),
    "The wide-screen regression harness runs in dedicated projects.",
  );
});

test.describe("responsive application shell", () => {
  test("keeps the header, content, route, and navigation on bounded rails", async ({
    page,
  }, testInfo) => {
    await loadScenario(page, "normal");
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);

    const geometry = await page.evaluate(() => {
      function bounds(selector: string): DOMRect {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) {
          throw new Error(`Missing responsive element: ${selector}`);
        }
        return element.getBoundingClientRect();
      }

      const viewportWidth =
        window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      const app = bounds("#app");
      const header = bounds(".task-header");
      const workspace = bounds(".workspace");
      const chat = bounds(".chat-panel");
      const headerRow = bounds(".task-header-row");
      const headerTools = bounds(".task-header-tools");
      const brandLockup = bounds(".connection-lockup");
      const brandWordmark = bounds(".brand-wordmark");
      const brandStatus = bounds(".brand-status-line");
      const summary = bounds(".task-summary");
      const tabs = bounds(".view-tabs");
      const routeLabel = bounds("#route-label");
      const usage = bounds("#usage-value");
      const disclosure = bounds("#route-button > span:last-child");
      const nav = bounds(".bottom-tabs");
      const navButtons = [
        ...document.querySelectorAll<HTMLElement>(
          ".bottom-tabs button",
        ),
      ].map((element) => element.getBoundingClientRect());
      const navUnion = {
        bottom: Math.max(...navButtons.map((item) => item.bottom)),
        left: Math.min(...navButtons.map((item) => item.left)),
        right: Math.max(...navButtons.map((item) => item.right)),
        top: Math.min(...navButtons.map((item) => item.top)),
      };

      return {
        app: rectangle(app),
        chat: rectangle(chat),
        disclosureGap: disclosure.left - usage.right,
        header: rectangle(header),
        headerRow: rectangle(headerRow),
        headerTools: rectangle(headerTools),
        brandLockup: rectangle(brandLockup),
        brandStatus: rectangle(brandStatus),
        brandWordmark: rectangle(brandWordmark),
        nav: rectangle(nav),
        navButtonSizes: navButtons.map((item) => ({
          height: item.height,
          width: item.width,
        })),
        navUnion,
        routeGap: usage.left - routeLabel.right,
        summary: rectangle(summary),
        tabs: rectangle(tabs),
        viewportHeight,
        viewportWidth,
        workspace: rectangle(workspace),
      };

      function rectangle(rect: DOMRect) {
        return {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
          xCentre: rect.left + rect.width / 2,
          yCentre: rect.top + rect.height / 2,
        };
      }
    });

    const desktop = desktopProjects.has(testInfo.project.name);
    expect(Math.abs(geometry.app.xCentre - geometry.viewportWidth / 2)).toBeLessThanOrEqual(1);
    expect(geometry.app.width).toBeLessThanOrEqual(1600.5);
    expect(Math.abs(geometry.header.left - geometry.workspace.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.header.right - geometry.workspace.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.chat.xCentre - geometry.workspace.xCentre)).toBeLessThanOrEqual(1);
    expect(geometry.routeGap).toBeGreaterThanOrEqual(0);
    expect(geometry.routeGap).toBeLessThanOrEqual(128);
    expect(geometry.disclosureGap).toBeGreaterThanOrEqual(0);
    expect(geometry.disclosureGap).toBeLessThanOrEqual(16);
    expect(geometry.brandLockup.left).toBeGreaterThanOrEqual(
      geometry.headerRow.left,
    );
    expect(geometry.brandLockup.right).toBeLessThanOrEqual(
      geometry.headerRow.right,
    );
    expect(geometry.brandWordmark.right).toBeLessThanOrEqual(
      geometry.brandLockup.right,
    );
    expect(geometry.brandStatus.right).toBeLessThanOrEqual(
      geometry.brandLockup.right,
    );
    expect(geometry.brandWordmark.height).toBeLessThanOrEqual(24);
    expect(geometry.brandStatus.height).toBeLessThanOrEqual(18);

    if (desktop) {
      expect(geometry.workspace.left - geometry.app.left).toBeCloseTo(96, 0);
      expect(geometry.nav.width).toBeCloseTo(96, 0);
      expect(geometry.nav.height).toBeCloseTo(geometry.app.height, 0);
      expect(geometry.nav.left).toBeCloseTo(geometry.app.left, 0);
      for (const size of geometry.navButtonSizes) {
        expect(size.width).toBeGreaterThanOrEqual(64);
        expect(size.width).toBeLessThanOrEqual(80);
        expect(size.height).toBeGreaterThanOrEqual(64);
        expect(size.height).toBeLessThanOrEqual(80);
      }
      expect(geometry.headerRow.right).toBeLessThanOrEqual(
        geometry.summary.left - 16,
      );
      expect(geometry.summary.right).toBeLessThanOrEqual(
        geometry.tabs.left - 16,
      );
      expect(geometry.tabs.right).toBeLessThanOrEqual(
        geometry.headerTools.left - 8,
      );
    } else if (compactHeaderProjects.has(testInfo.project.name)) {
      const headerContentLeft = Math.min(
        geometry.headerRow.left,
        geometry.summary.left,
        geometry.tabs.left,
        geometry.headerTools.left,
      );
      const headerContentRight = Math.max(
        geometry.headerRow.right,
        geometry.summary.right,
        geometry.tabs.right,
        geometry.headerTools.right,
      );
      expect(
        Math.abs(
          (headerContentLeft + headerContentRight) / 2 -
            geometry.workspace.xCentre,
        ),
      ).toBeLessThanOrEqual(1);
      expect(geometry.headerRow.right).toBeLessThanOrEqual(
        geometry.summary.left - 8,
      );
      expect(geometry.summary.right).toBeLessThanOrEqual(
        geometry.tabs.left - 8,
      );
      expect(geometry.tabs.right).toBeLessThanOrEqual(
        geometry.headerTools.left - 8,
      );
      expect(geometry.nav.width).toBeLessThanOrEqual(920.5);
      expect(
        Math.abs(geometry.nav.xCentre - geometry.viewportWidth / 2),
      ).toBeLessThanOrEqual(1);
      expect(
        geometry.navUnion.right - geometry.navUnion.left,
      ).toBeLessThanOrEqual(920.5);
      for (const size of geometry.navButtonSizes) {
        expect(size.width).toBeLessThanOrEqual(230.5);
      }
    } else {
      expect(Math.abs(geometry.tabs.xCentre - geometry.workspace.xCentre)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.summary.xCentre - geometry.workspace.xCentre)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.headerRow.xCentre - geometry.workspace.xCentre)).toBeLessThanOrEqual(1);
      expect(geometry.nav.width).toBeLessThanOrEqual(920.5);
      expect(Math.abs(geometry.nav.xCentre - geometry.viewportWidth / 2)).toBeLessThanOrEqual(1);
      expect(geometry.navUnion.right - geometry.navUnion.left).toBeLessThanOrEqual(920.5);
      for (const size of geometry.navButtonSizes) {
        expect(size.width).toBeLessThanOrEqual(230.5);
      }
    }
  });

  test("keeps composer controls grouped, reachable, and centred", async ({
    page,
  }, testInfo) => {
    await loadScenario(page, "normal");
    await expectPrimaryControlsReachable(page);
    await expect(
      page.getByRole("button", { name: "Stop Claude", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible();

    const geometry = await page.evaluate(() => {
      const composer = required("#prompt-form");
      const chat = required(".chat-panel");
      const trailing = required(".composer-trailing");
      const cancel = required("#cancel-button");
      const send = required("#send-button");
      const attachment = required("#attachment-button");
      const controls = [attachment, cancel, send].filter(
        (element) => getComputedStyle(element).display !== "none",
      );
      const composerBounds = composer.getBoundingClientRect();
      const chatBounds = chat.getBoundingClientRect();
      const trailingBounds = trailing.getBoundingClientRect();
      const cancelBounds = cancel.getBoundingClientRect();
      const sendBounds = send.getBoundingClientRect();

      return {
        cancelSendGap:
          getComputedStyle(cancel).display === "none"
            ? 0
            : sendBounds.left - cancelBounds.right,
        chatCentre: chatBounds.left + chatBounds.width / 2,
        composer: {
          left: composerBounds.left,
          right: composerBounds.right,
          width: composerBounds.width,
          xCentre: composerBounds.left + composerBounds.width / 2,
        },
        controls: controls.map((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
          return {
            bottom: bounds.bottom,
            height: bounds.height,
            hit: hit === element || element.contains(hit),
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            width: bounds.width,
          };
        }),
        trailing: {
          left: trailingBounds.left,
          right: trailingBounds.right,
          width: trailingBounds.width,
        },
      };

      function required(selector: string): HTMLElement {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) {
          throw new Error(`Missing responsive element: ${selector}`);
        }
        return element;
      }
    });

    const maximumComposerWidth = desktopProjects.has(testInfo.project.name)
      ? 840.5
      : 760.5;
    expect(geometry.composer.width).toBeLessThanOrEqual(maximumComposerWidth);
    expect(Math.abs(geometry.composer.xCentre - geometry.chatCentre)).toBeLessThanOrEqual(1);
    expect(geometry.trailing.right).toBeLessThanOrEqual(
      geometry.composer.right - 7,
    );
    expect(geometry.trailing.left).toBeGreaterThan(
      geometry.composer.left,
    );
    expect(geometry.cancelSendGap).toBeGreaterThanOrEqual(0);
    expect(geometry.cancelSendGap).toBeLessThanOrEqual(12);
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(geometry.composer.left);
      expect(control.right).toBeLessThanOrEqual(geometry.composer.right);
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.hit).toBe(true);
    }
  });
});

test.describe("responsive repository layout", () => {
  test("uses space progressively and keeps both file columns parallel", async ({
    page,
  }, testInfo) => {
    await loadScenario(page, "normal");
    const chatWidth = await page
      .locator(".chat-panel")
      .evaluate((element) => element.getBoundingClientRect().width);

    await loadDeepRepository(page);
    await expectNoViewportOverflow(page);

    const geometry = await page.evaluate(() => {
      const files = required(".files-panel").getBoundingClientRect();
      const card = required(".constellation-card").getBoundingClientRect();
      const preview = required(".file-preview").getBoundingClientRect();
      const searchInput = required(".search-bar input").getBoundingClientRect();
      const searchButton = required(".search-bar button").getBoundingClientRect();
      return {
        card: rectangle(card),
        files: rectangle(files),
        preview: rectangle(preview),
        searchButton: rectangle(searchButton),
        searchInput: rectangle(searchInput),
      };

      function required(selector: string): HTMLElement {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) {
          throw new Error(`Missing responsive element: ${selector}`);
        }
        return element;
      }

      function rectangle(rect: DOMRect) {
        return {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        };
      }
    });

    const aspect = geometry.card.width / geometry.card.height;
    expect(aspect).toBeGreaterThanOrEqual(0.75);
    expect(aspect).toBeLessThanOrEqual(1.4);

    if (desktopProjects.has(testInfo.project.name)) {
      expect(geometry.files.width).toBeGreaterThanOrEqual(chatWidth + 160);
      expect(geometry.searchInput.height).toBeLessThanOrEqual(64);
      expect(geometry.searchButton.height).toBeLessThanOrEqual(64);
      expect(geometry.preview.left).toBeGreaterThanOrEqual(
        geometry.card.right + 16,
      );
      expect(Math.abs(geometry.preview.top - geometry.card.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.preview.bottom - geometry.card.bottom)).toBeLessThanOrEqual(1);
      expect(geometry.card.width).toBeGreaterThanOrEqual(440);
      expect(geometry.preview.width).toBeGreaterThanOrEqual(500);
    } else {
      expect(Math.abs(geometry.files.width - chatWidth)).toBeLessThanOrEqual(1);
      expect(geometry.preview.top).toBeGreaterThanOrEqual(
        geometry.card.bottom + 10,
      );
      expect(geometry.preview.left).toBeCloseTo(geometry.files.left + 16, 0);
    }
  });

  test("contains every constellation node with readable labels and clear spacing", async ({
    page,
  }) => {
    await loadDeepRepository(page);
    const geometry = await page
      .locator("#constellation-view")
      .evaluate((card) => {
        const cardBounds = card.getBoundingClientRect();
        const allNodes = [
          ...card.querySelectorAll<HTMLElement>(".constellation-node"),
        ];
        const circularNodes = allNodes
          .filter((element) => !element.classList.contains("constellation-more"))
          .map(readNode);
        const overlaps: string[] = [];
        let minimumClearance = Number.POSITIVE_INFINITY;

        circularNodes.forEach((node, index) => {
          circularNodes.slice(index + 1).forEach((other) => {
            const distance = Math.hypot(
              node.xCentre - other.xCentre,
              node.yCentre - other.yCentre,
            );
            const clearance = distance - node.radius - other.radius;
            minimumClearance = Math.min(minimumClearance, clearance);
            if (clearance < 0) {
              overlaps.push(`${node.name} / ${other.name}`);
            }
          });
        });

        const current = circularNodes.find(
          (node) => node.relation === "current",
        );
        const containmentFailures = allNodes
          .map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              bottom: bounds.bottom - cardBounds.bottom,
              left: cardBounds.left - bounds.left,
              name: element.getAttribute("aria-label") ?? "node",
              right: bounds.right - cardBounds.right,
              top: cardBounds.top - bounds.top,
            };
          })
          .filter(
            (entry) =>
              entry.bottom > 0.5 ||
              entry.left > 0.5 ||
              entry.right > 0.5 ||
              entry.top > 0.5,
          );

        return {
          centreDelta: current
            ? {
                x:
                  current.xCentre -
                  (cardBounds.left + cardBounds.width / 2),
                y:
                  current.yCentre -
                  (cardBounds.top + cardBounds.height / 2),
              }
            : undefined,
          clippedLabels: circularNodes
            .filter((node) => node.labelClipped)
            .map((node) => node.name),
          containmentFailures,
          minimumClearance,
          overlaps,
        };

        function readNode(element: HTMLElement) {
          const bounds = element.getBoundingClientRect();
          const label =
            element.querySelector<HTMLElement>(".node-label");
          return {
            labelClipped: Boolean(
              label &&
                (label.scrollWidth > label.clientWidth + 1 ||
                  label.scrollHeight > label.clientHeight + 1),
            ),
            name: element.getAttribute("aria-label") ?? "node",
            radius: Math.min(bounds.width, bounds.height) / 2,
            relation: element.dataset.relation,
            xCentre: bounds.left + bounds.width / 2,
            yCentre: bounds.top + bounds.height / 2,
          };
        }
      });

    expect(geometry.overlaps).toEqual([]);
    expect(geometry.minimumClearance).toBeGreaterThanOrEqual(4);
    expect(geometry.containmentFailures).toEqual([]);
    expect(geometry.clippedLabels).toEqual([]);
    expect(Math.abs(geometry.centreDelta?.x ?? 999)).toBeLessThan(1);
    expect(Math.abs(geometry.centreDelta?.y ?? 999)).toBeLessThan(1);
  });
});

test("centres approval and attachment dialogs on desktop", async ({
  page,
}, testInfo) => {
  test.skip(
    !desktopProjects.has(testInfo.project.name),
    "Tablet approvals remain touch-first bottom sheets.",
  );

  await loadScenario(page, "approval");
  await expectNoViewportOverflow(page);
  await expectCentredDialog(page, ".permission-card", 720);

  await loadScenario(page, "attachments");
  await expectNoViewportOverflow(page);
  await expectCentredDialog(page, "#attachment-dialog", 620);
});

test("matches the reviewed responsive chat shell", async ({
  page,
}, testInfo) => {
  test.skip(
    !normalVisualProjects.has(testInfo.project.name),
    "Only representative wide shells need visual baselines.",
  );
  await loadScenario(page, "normal");
  await expect(page.locator("#app")).toHaveScreenshot(
    "normal-responsive.png",
    strictScreenshot,
  );
});

test("matches the reviewed responsive repository layout", async ({
  page,
}, testInfo) => {
  test.skip(
    !normalVisualProjects.has(testInfo.project.name),
    "Only representative file layouts need visual baselines.",
  );
  await loadDeepRepository(page);
  await expect(page.locator(".files-panel")).toHaveScreenshot(
    "repository-responsive.png",
    strictScreenshot,
  );
});

test("matches the reviewed responsive approval", async ({
  page,
}, testInfo) => {
  test.skip(
    !approvalVisualProjects.has(testInfo.project.name),
    "The tablet-landscape and desktop approval states are reviewed.",
  );
  await loadScenario(page, "approval");
  await expect(page.locator(".permission-card")).toHaveScreenshot(
    "approval-responsive.png",
    strictScreenshot,
  );
});

async function loadDeepRepository(page: Page): Promise<void> {
  await loadScenario(page, "multi-root-files");
  for (const name of ["Folder ModelHop", "Folder src", "Folder remote"]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  await expect(
    page.getByRole("button", {
      name: "File sessionController.ts",
      exact: true,
    }),
  ).toBeVisible();
}

async function expectCentredDialog(
  page: Page,
  selector: string,
  maximumWidth: number,
): Promise<void> {
  const geometry = await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      height: bounds.height,
      viewportHeight:
        window.visualViewport?.height ?? window.innerHeight,
      viewportWidth:
        window.visualViewport?.width ?? window.innerWidth,
      width: bounds.width,
      xCentre: bounds.left + bounds.width / 2,
      yCentre: bounds.top + bounds.height / 2,
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(maximumWidth + 0.5);
  expect(geometry.height).toBeLessThanOrEqual(
    geometry.viewportHeight - 63,
  );
  expect(Math.abs(geometry.xCentre - geometry.viewportWidth / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.yCentre - geometry.viewportHeight / 2)).toBeLessThanOrEqual(1);
}
