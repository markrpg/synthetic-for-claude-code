import { expect, test } from "@playwright/test";
import {
  dispatchFixtureAction,
  expectNoViewportOverflow,
  expectPrimaryControlsReachable,
  expectTouchTargets,
  loadScenario,
  promptInput,
} from "./helpers.js";

test.describe("remote feature surfaces", () => {
  test("reconciles all permission modes and rolls back a rejected change", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers authoritative permission state.",
    );

    for (const mode of [
      "auto-safe",
      "acceptEdits",
      "default",
      "plan",
    ] as const) {
      await loadScenario(page, `permission-${mode}`);
      await page.locator("#tab-settings").click();
      await expect(page.locator("#permission-mode")).toHaveValue(mode);
    }

    await loadScenario(page, "permission-default");
    await page.locator("#tab-settings").click();
    await page.locator("#permission-mode").selectOption("plan");
    await expect(page.locator("#permission-mode")).toHaveValue("plan");
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
          type: "permission.mode.set",
          mode: "plan",
        }),
      );

    await loadScenario(page, "permission-change-failed");
    await page.locator("#tab-settings").click();
    await page.locator("#permission-mode").selectOption("plan");
    await expect(page.locator("#permission-mode")).toHaveValue(
      "default",
    );
  });

  test("reconstructs historical activity without an unread badge", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers replay badge semantics.",
    );
    await loadScenario(page, "auto-safe");
    await expect(page.locator("#activity-count")).toBeHidden();
    await page.locator("#tab-activity").click();
    await expect(page.locator("#activity-timeline-full .activity-item")).toHaveCount(
      1,
    );
    await expect(page.locator("#activity-timeline-full")).toContainText(
      "Reading workspace files",
    );
  });

  test("keeps legacy control frames and tool-only artifacts out of chat", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers legacy journal recovery.",
    );
    await loadScenario(page, "normal");
    await dispatchFixtureAction(page, "legacy-control-and-tool");

    const conversation = page.locator("#conversation");
    await expect(conversation).not.toContainText("<task-notification>");
    await expect(conversation).toContainText(
      "<command-name> is the XML tag I am debugging",
    );
    await expect(
      conversation.locator('[data-message-id="legacy-tool-message"]'),
    ).toHaveCount(0);

    await page.locator("#tab-activity").click();
    const readActivity = page
      .locator("#activity-timeline-full .activity-item")
      .filter({ hasText: "Reading src/remote/web/mobileApp.ts" });
    await expect(readActivity).toHaveCount(1);
    await expect(readActivity).toHaveClass(/activity-success/);
  });

  test("runs the Vanta chat mesh and honours its fallback", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers the procedural canvas.",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await loadScenario(page, "normal");
    const fallbackCanvas = page.locator("#chat-mesh");
    const vantaCanvas = page.locator(
      "#chat-vanta canvas.vanta-canvas",
    );
    await expect(vantaCanvas).toBeVisible();
    await expect
      .poll(async () =>
        vantaCanvas.evaluate(
          (element: HTMLCanvasElement) =>
            element.height * element.width,
        ),
      )
      .toBeGreaterThan(10_000);
    const firstFrame = await vantaCanvas.screenshot();
    await page.waitForTimeout(420);
    const secondFrame = await vantaCanvas.screenshot();
    expect(secondFrame.equals(firstFrame)).toBe(false);

    await page.locator("#tab-files").click();
    await expect(vantaCanvas).toHaveCount(0);
    await page.locator("#tab-chat").click();
    await expect(vantaCanvas).toBeVisible();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(vantaCanvas).toHaveCount(0);
    await expect(fallbackCanvas).toBeVisible();
    const reducedFrame = await fallbackCanvas.evaluate(
      (element: HTMLCanvasElement) => element.toDataURL(),
    );
    await page.waitForTimeout(420);
    const settledReducedFrame = await fallbackCanvas.evaluate(
      (element: HTMLCanvasElement) => element.toDataURL(),
    );
    expect(settledReducedFrame).toBe(reducedFrame);
    const fallbackOpacity = await page.locator("#chat-panel").evaluate(
      (element) =>
        Number.parseFloat(
          getComputedStyle(element, "::before").opacity,
        ),
    );
    expect(fallbackOpacity).toBeGreaterThanOrEqual(0.1);
  });

  for (const [scenario, expected] of [
    ["usage-anthropic", /Anthropic|Claude/i],
    ["usage-synthetic", /35\.8|51\.79|Synthetic/i],
    ["usage-openai-api", /tokens|cost|OpenAI API/i],
    ["usage-openai-codex", /60|reset|Codex/i],
  ] as const) {
    test(`shows authoritative ${scenario} usage`, async ({ page }) => {
      await loadScenario(page, scenario);
      const usage = page.locator(
        '[data-testid="usage-summary"], #usage-value',
      );
      await expect(usage).not.toHaveText(/^0(?:\s+tok)?(?:\s*·\s*0\s+req)?$/);
      await expect(page.locator("#app")).toContainText(expected);
    });
  }

  test("shows only model-valid thinking and effort controls", async ({
    page,
  }) => {
    await loadScenario(page, "normal");
    await expect(page.locator("#reasoning-state-pill")).toHaveText(
      "Think · High",
    );

    await page.locator("#route-button").click();
    await expect(page.locator("#route-reasoning-title")).toHaveText(
      "Thinking on · High effort",
    );
    await expect(page.locator("#effort-select option")).toHaveText([
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
    await expect(
      page.locator('#effort-select option[value="ultra"]'),
    ).toHaveCount(0);

    await page.locator("#route-reasoning-summary").click();
    const thinking = page.getByTestId("thinking-toggle");
    const workflows = page.getByTestId("workflows-toggle");
    const ultra = page.getByTestId("ultra-toggle");
    await expect(thinking).toBeChecked();
    await expect(thinking).toBeEnabled();
    await expect(workflows).toBeEnabled();
    await expect(ultra).toBeEnabled();
    await expect(page.locator("#workflows-unavailable-reason")).toBeHidden();
    await expect(page.locator("#ultra-unavailable-reason")).toBeHidden();

    await page.getByTestId("reasoning-effort-control").selectOption("max");
    await expect(page.locator("#reasoning-state-pill")).toHaveText(
      "Think · Max",
    );
    await expect(page.locator("#reasoning-change-status")).toHaveText(
      "Reasoning settings updated.",
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
        type: "reasoning.change",
        effort: "max",
        thinkingEnabled: true,
      }),
    );
    await expectNoViewportOverflow(page);
    await expectTouchTargets(page);
  });

  test("enables Claude Ultra atomically when the session reports support", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers the Ultra command contract.",
    );
    await loadScenario(page, "reasoning-ultra-capable");
    await page.locator("#tab-settings").click();
    const ultra = page.getByTestId("ultra-toggle");
    await expect(ultra).toBeEnabled();
    await expect(ultra).not.toBeChecked();
    const ultraDialogPromise = page.waitForEvent("dialog");
    const ultraCheckPromise = ultra.check();
    const ultraDialog = await ultraDialogPromise;
    expect(ultraDialog.message()).toContain("Experimental Ultra");
    expect(ultraDialog.message()).toContain("several provider calls or subagents");
    expect(ultraDialog.message()).toContain(
      "first Workflow will still require approval",
    );
    await ultraDialog.accept();
    await ultraCheckPromise;
    await expect(ultra).toBeChecked();
    await expect(page.getByTestId("workflows-toggle")).toBeChecked();
    await expect(page.getByTestId("thinking-toggle")).toBeChecked();
    await expect(page.getByTestId("reasoning-effort-control")).toHaveValue(
      "xhigh",
    );
    await expect(page.getByTestId("reasoning-effort-control")).toBeDisabled();
    await expect(page.locator("#reasoning-state-pill")).toHaveText("Ultra");

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
        type: "reasoning.change",
        ultraEnabled: true,
        thinkingEnabled: true,
        workflowsEnabled: true,
        effort: "xhigh",
      }),
    );
    await expectNoViewportOverflow(page);
    await expectTouchTargets(page);
  });

  test("keeps provider effort available without Claude adaptive thinking", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers private provider reasoning.",
    );
    await loadScenario(page, "reasoning-provider-private");
    await expect(page.locator("#reasoning-state-pill")).toHaveText(
      "Reason · Max",
    );

    await page.locator("#route-button").click();
    await expect(page.locator("#route-reasoning-title")).toHaveText(
      "Provider reasoning · Max effort",
    );
    await expect(page.locator("#route-reasoning-detail")).toContainText(
      "without Claude-visible thinking blocks",
    );
    await expect(page.locator("#effort-select")).toBeEnabled();
    await expect(page.locator("#effort-select option")).toHaveText([
      "High",
      "Extra high",
      "Max",
    ]);

    await page.locator("#route-reasoning-summary").click();
    await expect(page.locator("#reasoning-settings-status")).toHaveText(
      "Max effort",
    );
    await expect(page.getByTestId("thinking-toggle")).toBeDisabled();
    await expect(page.locator("#thinking-unavailable-reason")).toContainText(
      "Provider reasoning remains active",
    );
    await expect(page.getByTestId("reasoning-effort-control")).toBeEnabled();
    await expect(page.getByTestId("workflows-toggle")).toBeEnabled();
    const ultra = page.getByTestId("ultra-toggle");
    await expect(ultra).toBeEnabled();
    await expect(page.locator("#ultra-unavailable-reason")).toBeHidden();

    const ultraDialogPromise = page.waitForEvent("dialog");
    const ultraCheckPromise = ultra.check();
    const ultraDialog = await ultraDialogPromise;
    expect(ultraDialog.message()).toContain("Claude thinking where");
    await ultraDialog.accept();
    await ultraCheckPromise;
    await expect(ultra).toBeChecked();
    await expect(page.getByTestId("thinking-toggle")).not.toBeChecked();
    await expect(page.getByTestId("workflows-toggle")).toBeChecked();
    await expect(page.getByTestId("reasoning-effort-control")).toHaveValue(
      "xhigh",
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
    const privateUltraCommand = commands.find(
      (command) =>
        command.type === "reasoning.change" &&
        command.ultraEnabled === true,
    );
    expect(privateUltraCommand).toEqual(
      expect.objectContaining({
        effort: "xhigh",
        workflowsEnabled: true,
      }),
    );
    expect(privateUltraCommand).not.toHaveProperty("thinkingEnabled");
    await expectNoViewportOverflow(page);
    await expectTouchTargets(page);
  });

  test("reports capability discovery as loading instead of unsupported", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers the capability-loading state.",
    );
    await loadScenario(page, "reasoning-loading");
    await expect(page.locator("#reasoning-state-pill")).toBeHidden();

    await page.locator("#route-button").click();
    await expect(page.locator("#route-reasoning-title")).toHaveText(
      "Checking model capabilities…",
    );
    await expect(page.locator("#model-select")).toBeDisabled();
    await expect(page.locator("#model-change-status")).toHaveText(
      "Loading current models and capabilities…",
    );
    await expect(page.locator("#model-capability-summary")).toHaveText(
      "Loading current model capabilities…",
    );

    await page.locator("#route-reasoning-summary").click();
    await expect(page.locator("#reasoning-settings-status")).toHaveText(
      "Checking…",
    );
    await expect(page.locator("#thinking-unavailable-reason")).toContainText(
      "Waiting for Claude Code",
    );
    await expect(page.locator("#effort-unavailable-reason")).toContainText(
      "Waiting for the active model's effort catalog",
    );
    await expect(page.locator("#workflows-unavailable-reason")).toContainText(
      "Waiting for Claude Code",
    );
    await expect(page.locator("#ultra-unavailable-reason")).toContainText(
      "Waiting for Claude Code",
    );
    await expectNoViewportOverflow(page);
    await expectTouchTargets(page);
  });

  test("asks once per session before enabling Experimental Workflows", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-modern-393x852",
      "One deterministic phone project covers workflow consent.",
    );
    await loadScenario(page, "usage-anthropic");
    await page.locator("#tab-settings").click();
    const workflows = page.getByTestId("workflows-toggle");
    await expect(workflows).toBeEnabled();
    await expect(workflows).not.toBeChecked();

    const dialogPromise = page.waitForEvent("dialog");
    const firstCheck = workflows.check();
    const dialog = await dialogPromise;
    expect(dialog.message()).toContain("Experimental Claude Workflows");
    expect(dialog.message()).toContain("use more allowance");
    expect(dialog.message()).toContain(
      "first Workflow will still require approval on your phone",
    );
    await dialog.accept();
    await firstCheck;
    await expect(workflows).toBeChecked();

    await workflows.uncheck();
    await workflows.check();
    await expect(workflows).toBeChecked();

    const commands = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: {
            commands(): Array<Record<string, unknown>>;
          };
        }
      ).modelHopFixture.commands(),
    );
    expect(
      commands.filter(
        (command) =>
          command.type === "reasoning.change" &&
          command.workflowsEnabled === true,
      ),
    ).toHaveLength(2);
  });

  test("keeps reasoning controls usable at 200 percent reflow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "iphone-se-375x667",
      "One deterministic 200 percent reasoning-control run is sufficient.",
    );
    await page.setViewportSize({
      width: Math.floor(375 / 2),
      height: Math.floor(667 / 2),
    });
    await loadScenario(page, "normal");
    await page.locator("#tab-settings").click();
    await expect(page.locator("#reasoning-settings-card")).toBeVisible();
    await expect(page.getByTestId("thinking-toggle")).toBeEnabled();
    await expect(page.getByTestId("reasoning-effort-control")).toBeEnabled();
    await expectNoViewportOverflow(page);
    await expectTouchTargets(page);
  });

  test("shows chat-only view controls only while Chat is selected", async ({
    page,
  }) => {
    await loadScenario(page, "normal");
    const taskViews = page.locator("#task-view-tabs");
    await expect(page.locator(".brand-wordmark")).toHaveText("ModelHop");
    if ((page.viewportSize()?.width ?? 0) <= 412) {
      await expect(page.locator(".brand-wordmark")).toBeVisible();
    }
    await expect(page.locator("#task-elapsed")).toHaveText("00:42");
    await expect(taskViews).toBeVisible();

    await page.locator("#tab-files").click();
    await expect(taskViews).toBeHidden();
    await expect(page.locator("#file-search-scope")).toHaveValue("files");
    await expect(
      page.locator("#file-search-form").getByRole("button", {
        name: "Search",
      }),
    ).toHaveCount(1);

    await page.locator("#tab-chat").click();
    await expect(taskViews).toBeVisible();

    await dispatchFixtureAction(page, "turn-complete");
    await expect(page.locator("#task-elapsed")).toHaveText("00:25");
    await page.waitForTimeout(1_100);
    await expect(page.locator("#task-elapsed")).toHaveText("00:25");
  });

  test("renders safe Markdown and opens chat files and images", async ({
    page,
  }) => {
    await loadScenario(page, "markdown-rich");
    const message = page.locator(
      '[data-message-id="markdown-assistant"]',
    );
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);
    await expectTouchTargets(page);
    await expect(message.getByRole("heading", { level: 3 })).toHaveText(
      "Remote update",
    );
    await expect(message.locator("strong")).toContainText([
      "encrypted hand-back",
    ]);
    await expect(message.locator("ul li")).toHaveCount(4);
    await expect(message.locator("pre code.language-ts")).toContainText(
      'const state = "connected";',
    );
    await expect(message.locator("table")).toContainText("Pairing");
    await expect(message.locator("script, style")).toHaveCount(0);
    await expect(message.locator(".markdown-image-icon svg")).toHaveCount(1);
    await expect(
      message.getByRole("button", { name: "Open file preview.html" }),
    ).toBeVisible();
    await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(message).toContainText(
      "<script>window.fixtureUnsafe = true</script>",
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { fixtureUnsafe?: boolean })
            .fixtureUnsafe,
      ),
    ).toBeUndefined();

    const external = message.getByRole("link", {
      name: "security guide",
    });
    await expect(external).toHaveAttribute(
      "href",
      "https://example.com/modelhop",
    );
    await expect(external).toHaveAttribute(
      "rel",
      /noopener.*noreferrer/u,
    );
    await page.locator("#view-activity").click();
    await expect(
      page.locator("#activity-timeline .markdown-inline strong"),
    ).toHaveText("Encrypted journal");
    await page.locator("#view-conversation").click();

    const commandsBefore = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: { commands(): Array<{ type: string }> };
        }
      ).modelHopFixture.commands(),
    );
    expect(
      commandsBefore.some(
        (command) => command.type === "file.reference.read",
      ),
    ).toBe(false);

    await message.getByRole("button", { name: "README.md" }).click();
    await expect(page.locator("#files-panel")).toBeVisible();
    await expect(page.locator("#file-viewer-dialog")).toBeVisible();
    await expect(page.locator("#file-title")).toHaveText("README.md:2–3");
    await expect(page.locator("#file-content")).toContainText(
      "ModelHop Remote",
    );
    await expect(
      page.locator('#file-content .code-line[aria-pressed="true"]'),
    ).toHaveCount(2);
    await expect(page.locator("#file-line-selection")).toHaveText(
      "Lines 2–3 selected",
    );
    await page.locator("#close-file-viewer").click();

    await page.locator("#tab-chat").click();
    await message
      .getByRole("button", { name: "Open image ModelHop preview" })
      .click();
    await expect(page.locator("#file-viewer-dialog")).toBeVisible();
    await expect(page.locator("#file-image")).toBeVisible();
    await expect(page.locator("#file-image")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/u,
    );
    await expect(page.locator("#file-viewer-image")).toBeVisible();
    await page.locator("#close-file-viewer").click();

    await page.locator("#tab-chat").click();
    await message
      .getByRole("button", { name: "Open file preview.html" })
      .click();
    await expect(page.locator("#file-viewer-dialog")).toBeVisible();
    await expect(page.locator("#file-viewer-title")).toHaveText(
      "preview.html",
    );
    await expect(page.locator("#file-viewer-code")).toContainText(
      "ModelHop live preview",
    );
    await page.locator("#close-file-viewer").click();
    await expectNoViewportOverflow(page);
  });

  test("keeps an expired active turn running while revoking new input", async ({
    page,
  }) => {
    await loadScenario(page, "maximum-active-turn");
    await expect(page.locator("#task-phase")).toContainText(
      "Claude is still working",
    );
    await expect(promptInput(page)).toBeDisabled();
    await expect(promptInput(page)).toHaveAttribute(
      "placeholder",
      /Eight-hour limit reached/u,
    );
    await expect(page.locator("#send-button")).toBeDisabled();
    await expect(page.locator("#attachment-button")).toBeDisabled();
    await expect(page.locator("#provider-select")).toBeDisabled();
    await expect(page.locator("#cancel-button")).toBeVisible();
    await expect(page.locator("#cancel-button")).toBeEnabled();
    await expectNoViewportOverflow(page);
    await expectPrimaryControlsReachable(page);
    await expectTouchTargets(page);

    await page.locator("#tab-files").click();
    await expect(
      page.getByRole("button", { name: "Folder ModelHop", exact: true }),
    ).toBeVisible();
  });

  test("navigates a multi-root file hierarchy and opens a preview", async ({
    page,
  }) => {
    await loadScenario(page, "normal");
    await page
      .locator('[data-panel="files-panel"], [data-testid="nav-files"]')
      .first()
      .click();
    await dispatchFixtureAction(page, "open-files");
    await page.locator("#tree-view-button").click();
    const tree = page.locator('[data-testid="file-tree"], [role="tree"]').first();
    await expect(tree).toBeVisible();
    await tree
      .getByRole("treeitem", { name: /src$/i })
      .first()
      .click();
    await tree
      .getByRole("treeitem", { name: /remote$/i })
      .first()
      .click();
    await tree
      .getByRole("treeitem", { name: /web$/i })
      .first()
      .click();
    await tree
      .getByRole("treeitem", { name: /mobileApp\.ts$/i })
      .first()
      .click();
    await expect(
      page.locator(
        '[data-testid="file-preview"], .file-preview',
      ),
    ).toContainText(/session|remote|export|interface/i);
    await page.locator('.code-line[data-line="2"]').click();
    await page.locator('.code-line[data-line="5"]').click();
    await expect(page.locator("#file-line-selection")).toHaveText(
      "Lines 2–5 selected",
    );
    await page.locator("#ask-file-lines").click();
    await expect(page.locator("#tab-chat")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(promptInput(page)).toHaveValue(
      /@src\/remote\/web\/mobileApp\.ts lines 2-5[\s\S]+export interface RemoteRecoveryState/,
    );
    await expectNoViewportOverflow(page);
  });

  test("reveals the file viewer after a constellation file is selected", async ({
    page,
  }) => {
    await loadScenario(page, "multi-root-files");
    await page
      .getByRole("button", { name: "Folder ModelHop", exact: true })
      .click();
    const filesPanel = page.locator("#files-panel");
    await filesPanel.evaluate((panel) => {
      panel.scrollTop = 0;
    });
    const fileBubble = page.getByRole("button", {
      name: "File README.md",
      exact: true,
    });
    await fileBubble.evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );

    await expect(page.locator("#file-title")).toContainText("README.md");
    await expect(
      page.getByRole("button", {
        name: "File README.md, selected",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await expect
      .poll(async () =>
        filesPanel.evaluate((panel) => panel.scrollTop),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const panel =
            document.querySelector<HTMLElement>("#files-panel");
          const preview =
            document.querySelector<HTMLElement>("#file-preview");
          if (!panel || !preview) {
            throw new Error("Missing file panel or preview.");
          }
          const panelBounds = panel.getBoundingClientRect();
          const previewBounds = preview.getBoundingClientRect();
          return (
            previewBounds.top + Math.min(56, previewBounds.height) <=
              panelBounds.bottom &&
            previewBounds.bottom > panelBounds.top
          );
        }),
      )
      .toBe(true);
  });

  test("opens source and an isolated interactive HTML preview full screen", async ({
    page,
  }) => {
    const externalPreviewRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://example.com/")) {
        externalPreviewRequests.push(request.url());
      }
    });
    await loadScenario(page, "multi-root-files");
    await page
      .getByRole("button", { name: "Folder ModelHop", exact: true })
      .click();
    await page.locator("#file-search").fill("preview.html");
    await page.locator("#file-search-form").getByRole("button", {
      name: "Search",
    }).click();
    await page.locator("#file-results").getByRole("button", {
      name: "preview.html",
      exact: true,
    }).click();
    await page.locator("#open-file-viewer").click();

    const dialog = page.locator("#file-viewer-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#file-viewer-title")).toHaveText(
      "preview.html",
    );
    await expect(page.locator("#file-viewer-code")).toContainText(
      "ModelHop live preview",
    );
    await expect(page.locator("#file-viewer-preview")).toBeVisible();
    await page.locator("#file-viewer-preview").click();

    const frame = page.locator("#file-viewer-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("sandbox", "");
    const isolatedSource = await frame.getAttribute("srcdoc");
    expect(isolatedSource).toContain("Content-Security-Policy");
    expect(isolatedSource).not.toContain("https://example.com");
    const previewFrame = page.frameLocator("#file-viewer-frame");
    await expect(previewFrame.locator("#preview-title")).toHaveText(
      "ModelHop live preview",
    );
    await expect(previewFrame.locator("html")).not.toHaveAttribute(
      "data-script-ready",
      "true",
    );

    await page.locator("#file-viewer-interactions").click();
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const interactiveSource = await frame.getAttribute("srcdoc");
    expect(interactiveSource).toContain("script-src 'nonce-");
    expect(interactiveSource).not.toContain("script-src 'unsafe-inline'");
    expect(interactiveSource).toMatch(/<script nonce="[^"]+">/u);
    await expect(previewFrame.locator("html")).toHaveAttribute(
      "data-script-ready",
      "true",
    );
    await expect(previewFrame.locator("html")).toHaveAttribute(
      "data-parent-access",
      "blocked",
    );
    await expect(previewFrame.locator("html")).toHaveAttribute(
      "data-popup-blocked",
      "true",
    );
    await expect(previewFrame.locator("html")).toHaveAttribute(
      "data-network-blocked",
      "true",
    );
    expect(externalPreviewRequests).toEqual([]);
    await previewFrame.locator("#preview-action").click();
    await expect(previewFrame.locator("#preview-title")).toHaveText(
      "Interaction works",
    );
    await expectNoViewportOverflow(page);
    await page.locator("#close-file-viewer").click();
    await expect(dialog).toBeHidden();
    await expect(frame).toHaveAttribute("srcdoc", "");

    await page.locator("#open-file-viewer").click();
    await expect(dialog).toBeVisible();
    await page.evaluate(async () => {
      await (
        window as unknown as {
          modelHopFixture: {
            dispatch(action: string): Promise<void>;
          };
        }
      ).modelHopFixture.dispatch("handback-complete");
    });
    await expect(dialog).toBeHidden();
    await expect(frame).toHaveAttribute("srcdoc", "");
    await expect(
      page.locator('[data-testid="session-ended"]'),
    ).toBeVisible();
  });

  test("loads every directory page and can enter the second workspace root", async ({
    page,
  }) => {
    await loadScenario(page, "multi-root-files");
    await page
      .getByRole("button", { name: /^Folder ModelHop(?:,|$)/i })
      .click();
    const persistedState = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: {
            state(): {
              activePanel?: string;
              currentFolderPath?: string;
            } | undefined;
          };
        }
      ).modelHopFixture.state(),
    );
    expect(persistedState).toMatchObject({
      activePanel: "files-panel",
      currentFolderPath: "@primary",
    });
    await expect(
      page.getByRole("button", { name: /More \d+/i }),
    ).toBeVisible();
    const overflowGeometry = await page
      .locator(".constellation-more")
      .evaluate((button) => {
        const element = button as HTMLElement;
        const bounds = element.getBoundingClientRect();
        const label = element.querySelector<HTMLElement>(".more-label");
        const badge = element.querySelector<HTMLElement>(".more-count");
        const labelBounds = label?.getBoundingClientRect();
        const badgeBounds = badge?.getBoundingClientRect();
        const card = element.closest<HTMLElement>("#constellation-view");
        const cardBounds = card?.getBoundingClientRect();
        return {
          anchoredToCard: Boolean(
            cardBounds &&
              element.offsetParent &&
              card?.contains(element.offsetParent),
          ),
          cardTop: cardBounds?.top,
          badgeContained: Boolean(
            badgeBounds &&
              badgeBounds.left >= bounds.left &&
              badgeBounds.right <= bounds.right &&
              badgeBounds.top >= bounds.top &&
              badgeBounds.bottom <= bounds.bottom,
          ),
          badgeText: badge?.textContent,
          contentCenterOffsetX:
            labelBounds && badgeBounds
              ? Math.abs(
                  (labelBounds.left + badgeBounds.right) / 2 -
                    (bounds.left + bounds.right) / 2,
                )
              : Number.POSITIVE_INFINITY,
          contentCenterOffsetY:
            labelBounds && badgeBounds
              ? Math.abs(
                  (Math.min(labelBounds.top, badgeBounds.top) +
                      Math.max(labelBounds.bottom, badgeBounds.bottom)) /
                    2 -
                    (bounds.top + bounds.bottom) / 2,
                )
              : Number.POSITIVE_INFINITY,
          position: getComputedStyle(button).position,
          top: bounds.top,
        };
      });
    expect(overflowGeometry.anchoredToCard).toBe(true);
    expect(overflowGeometry.badgeContained).toBe(true);
    expect(overflowGeometry.badgeText).toMatch(/^\+\d+$/u);
    expect(overflowGeometry.contentCenterOffsetX).toBeLessThanOrEqual(1);
    expect(overflowGeometry.contentCenterOffsetY).toBeLessThanOrEqual(1);
    expect(overflowGeometry.position).toBe("absolute");
    expect(
      overflowGeometry.top - (overflowGeometry.cardTop ?? 0),
    ).toBeCloseTo(12, 0);
    const commands = await page.evaluate(() =>
      (
        window as unknown as {
          modelHopFixture: {
            commands(): Array<{
              type: string;
              rootId?: string;
              cursor?: string;
            }>;
          };
        }
      ).modelHopFixture.commands(),
    );
    expect(
      commands.some(
        (command) =>
          command.type === "files.list" &&
          command.rootId === "primary" &&
          command.cursor === "3",
      ),
    ).toBe(true);

    await page.getByRole("button", { name: /More \d+/i }).click();
    await expect(
      page
        .locator("#file-tree")
        .getByRole("treeitem", { name: /LICENSE$/i }),
    ).toBeVisible();
    await expect(
      page
        .locator("#file-tree")
        .getByRole("treeitem", { name: /tsconfig\.json$/i }),
    ).toBeVisible();
    await page
      .locator("#file-tree")
      .getByRole("treeitem", { name: /ModelHopDocs$/i })
      .click();
    await page.locator("#tree-view-button").click();
    await expect(
      page
        .locator("#file-tree")
        .getByRole("treeitem", { name: /remote-security\.md/i }),
    ).toBeVisible();
  });

  test("centres the radar and keeps long-name bubbles separate and readable", async ({
    page,
  }) => {
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

    const geometry = await page
      .locator("#constellation-view")
      .evaluate((card) => {
        const cardBounds = card.getBoundingClientRect();
        const nodes = [
          ...card.querySelectorAll<HTMLElement>(
            ".constellation-node:not(.constellation-more)",
          ),
        ].map((element) => {
          const bounds = element.getBoundingClientRect();
          const label =
            element.querySelector<HTMLElement>(".node-label");
          return {
            name: element.getAttribute("aria-label") ?? "node",
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
            radius: Math.min(bounds.width, bounds.height) / 2,
            labelClipped: Boolean(
              label &&
                (label.scrollWidth > label.clientWidth + 1 ||
                  label.scrollHeight > label.clientHeight + 1),
            ),
            relation: element.dataset.relation,
          };
        });
        const overlaps: string[] = [];
        nodes.forEach((node, index) => {
          nodes.slice(index + 1).forEach((other) => {
            const distance = Math.hypot(
              node.x - other.x,
              node.y - other.y,
            );
            if (distance + 0.5 < node.radius + other.radius) {
              overlaps.push(`${node.name} / ${other.name}`);
            }
          });
        });
        const current = nodes.find(
          (node) => node.relation === "current",
        );
        return {
          clippedLabels: nodes
            .filter((node) => node.labelClipped)
            .map((node) => node.name),
          centreDelta: current
            ? {
                x:
                  current.x -
                  (cardBounds.left + cardBounds.width / 2),
                y:
                  current.y -
                  (cardBounds.top + cardBounds.height / 2),
              }
            : undefined,
          overlaps,
        };
      });

    expect(geometry.overlaps).toEqual([]);
    expect(geometry.clippedLabels).toEqual([]);
    expect(Math.abs(geometry.centreDelta?.x ?? 999)).toBeLessThan(1);
    expect(Math.abs(geometry.centreDelta?.y ?? 999)).toBeLessThan(1);
  });

  test("offers every mobile attachment source", async ({ page }) => {
    await loadScenario(page, "attachments");
    const dialog = page.locator("#attachment-dialog");
    await expect(dialog).toBeVisible();
    for (const label of [
      "Repository file",
      "Device document",
      "Photo library",
      "Camera",
    ]) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("keeps a failed exact-session hand-back recoverable", async ({
    page,
  }) => {
    await loadScenario(page, "handback-failed");
    const recovery = page.locator(
      '[data-testid="handback-recovery"]',
    );
    const retry = page.locator('[data-testid="handback-retry"]');
    await expect(recovery).toContainText(
      /conversation is still available|remote access remains active/i,
    );
    await expect(retry).toBeVisible();
    await page.locator("#tab-activity").click();
    await expect(page.locator("#activity-timeline-full")).toContainText(
      "Hand-back: Failed",
    );
    await expect(page.locator("#activity-timeline-full")).not.toContainText(
      "Provider switch: Failed",
    );
    await page.locator("#tab-chat").click();
    await retry.click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as {
              modelHopFixture: {
                commands(): Array<{
                  type: string;
                  strategy?: string;
                  cancelActive?: boolean;
                }>;
              };
            }
          ).modelHopFixture
            .commands()
            .some(
              (command) =>
                command.type === "session.handback" &&
                command.strategy === "finish" &&
                command.cancelActive === false,
            ),
        ),
      )
      .toBe(true);
    await expect(page.locator("#app")).not.toContainText(
      /opened a new conversation|open last/i,
    );
  });

  test("shows successful recovery and ended-link terminal states", async ({
    page,
  }) => {
    await loadScenario(page, "recovery-success");
    await page.locator("#tab-activity").click();
    await expect(
      page
        .locator("#activity-timeline-full")
        .getByText(/Conversation recovery succeeded/i),
    ).toBeVisible();

    await loadScenario(page, "handback-success");
    const ended = page.locator('[data-testid="session-ended"]');
    await expect(ended).toBeVisible();
    await expect(ended).toContainText("Conversation returned to laptop");
    await expect(ended).toContainText("phone link has ended");
    await expect(page.locator("#prompt-input")).toBeDisabled();
    await expect(page.locator("#main-content")).toBeHidden();
    await expect(page.locator(".bottom-tabs")).toBeHidden();
  });

  test("finishes hand-back authoritatively and ignores a late handing-back state", async ({
    page,
  }) => {
    await loadScenario(page, "handback-delayed");
    await expect(page.locator("#app")).toHaveAttribute(
      "data-session-state",
      "active",
    );
    await expect(page.locator("#task-summary")).toHaveAttribute(
      "data-phase",
      "busy",
    );
    await expect(page.locator("#prompt-input")).toBeDisabled();
    await expect(
      page.locator('[data-testid="session-ended"]'),
    ).toBeHidden();

    await page.evaluate(async () => {
      await (
        window as unknown as {
          modelHopFixture: {
            dispatch(action: string): Promise<void>;
          };
        }
      ).modelHopFixture.dispatch("handback-complete");
    });

    const ended = page.locator('[data-testid="session-ended"]');
    await expect(ended).toBeVisible();
    await expect(page.locator("#app")).toHaveAttribute(
      "data-session-state",
      "ended",
    );
    await expect(ended).toContainText("Conversation returned to laptop");
    await expect(ended).toContainText("phone link has ended");
    await expect(page.locator("#main-content")).toBeHidden();
    await expect(page.locator("#task-header")).toBeHidden();
    await expect(
      page.locator(
        "#app button:visible:enabled, #app input:visible:enabled, #app textarea:visible:enabled, #app select:visible:enabled",
      ),
    ).toHaveCount(0);

    await page.evaluate(async () => {
      await (
        window as unknown as {
          modelHopFixture: {
            dispatch(action: string): Promise<void>;
          };
        }
      ).modelHopFixture.dispatch("late-handback-state");
    });

    await expect(ended).toBeVisible();
    await expect(page.locator("#app")).toHaveAttribute(
      "data-session-state",
      "ended",
    );
    await expect(ended).toContainText("Conversation returned to laptop");
    await expect(ended).toContainText("phone link has ended");
    await expect(page.locator("#main-content")).toBeHidden();
    await expect(page.locator("#task-header")).toBeHidden();
    await expect(page.locator("#prompt-input")).toBeDisabled();
    await expect(
      page.locator(
        "#app button:visible:enabled, #app input:visible:enabled, #app textarea:visible:enabled, #app select:visible:enabled",
      ),
    ).toHaveCount(0);
  });
});
