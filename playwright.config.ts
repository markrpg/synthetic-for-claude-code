import { defineConfig } from "@playwright/test";

const requestedFixturePort = process.env.MODELHOP_REMOTE_FIXTURE_PORT;
const fixturePort =
  requestedFixturePort && /^\d+$/u.test(requestedFixturePort)
    ? requestedFixturePort
    : "4179";
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

const baseUse = {
  baseURL: fixtureOrigin,
  colorScheme: "dark" as const,
  hasTouch: true,
  isMobile: true,
  locale: "en-GB",
  reducedMotion: "reduce" as const,
  serviceWorkers: "block" as const,
  timezoneId: "Europe/London",
};

const desktopUse = {
  ...baseUse,
  browserName: "chromium" as const,
  deviceScaleFactor: 1,
  hasTouch: false,
  isMobile: false,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
};

const responsiveTestMatch = /responsive\.spec\.ts/;

export default defineConfig({
  testDir: "./test/mobile",
  outputDir: "./test-results/mobile",
  snapshotPathTemplate:
    "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: "playwright-report/mobile",
      },
    ],
  ],
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.015,
    },
  },
  timeout: 30_000,
  use: {
    ...baseUse,
    actionTimeout: 5_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command:
      `node ./scripts/serve-remote-fixture.mjs --build --port ${fixturePort}`,
    url: `${fixtureOrigin}/__health`,
    // A manually running fixture may contain an older CSP nonce contract or
    // stale assets. The acceptance suite must always own a fresh server.
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "android-compact-360x640",
      testIgnore: responsiveTestMatch,
      use: {
        ...baseUse,
        deviceScaleFactor: 2,
        viewport: { width: 360, height: 640 },
      },
    },
    {
      name: "iphone-se-375x667",
      testIgnore: responsiveTestMatch,
      use: {
        ...baseUse,
        browserName: "chromium",
        deviceScaleFactor: 2,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        viewport: { width: 375, height: 667 },
      },
    },
    {
      name: "iphone-modern-393x852",
      testIgnore: responsiveTestMatch,
      use: {
        ...baseUse,
        browserName: "chromium",
        deviceScaleFactor: 3,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        viewport: { width: 393, height: 852 },
      },
    },
    {
      name: "pixel-412x915",
      testIgnore: responsiveTestMatch,
      use: {
        ...baseUse,
        deviceScaleFactor: 2.625,
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
        viewport: { width: 412, height: 915 },
      },
    },
    {
      name: "landscape-852x393",
      testIgnore: responsiveTestMatch,
      use: {
        ...baseUse,
        deviceScaleFactor: 3,
        viewport: { width: 852, height: 393 },
      },
    },
    {
      name: "keyboard-393x520",
      testIgnore: responsiveTestMatch,
      use: {
        ...baseUse,
        deviceScaleFactor: 3,
        viewport: { width: 393, height: 520 },
      },
    },
    {
      name: "tablet-portrait-768x1024",
      testMatch: responsiveTestMatch,
      use: {
        ...baseUse,
        browserName: "chromium",
        deviceScaleFactor: 2,
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "tablet-landscape-1024x768",
      testMatch: responsiveTestMatch,
      use: {
        ...baseUse,
        browserName: "chromium",
        deviceScaleFactor: 2,
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        viewport: { width: 1024, height: 768 },
      },
    },
    {
      name: "desktop-1440x900",
      testMatch: responsiveTestMatch,
      use: {
        ...desktopUse,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "desktop-hd-1920x1080",
      testMatch: responsiveTestMatch,
      use: {
        ...desktopUse,
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: "ultrawide-2560x1440",
      testMatch: responsiveTestMatch,
      use: {
        ...desktopUse,
        viewport: { width: 2560, height: 1440 },
      },
    },
  ],
});
