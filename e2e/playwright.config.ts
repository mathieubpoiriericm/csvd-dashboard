import { defineConfig, devices } from "@playwright/test";
import { PASSPHRASE, SESSION_SECRET, STORAGE_STATE } from "./fixtures/auth.ts";

/**
 * The suite drives the *production* build, not the Vite dev server: the
 * islands import `data/*.json` at build time, so only the bundled output
 * proves that hydration and the data import actually work.
 *
 * `deno task start` pins no port, so the webServer calls `deno serve`
 * directly to keep the port deterministic.
 *
 * The app is gated. The server below is started with the suite's own
 * passphrase and session secret, the `setup` project signs in once and saves
 * the cookie, and `chromium` starts every test from it. A spec that wants
 * the logged-out state opts out with `test.use({ storageState: ... })`, as
 * `login.spec.ts` does. With `reuseExistingServer`, a server already
 * listening on the port must have been started with the same two values or
 * the setup project cannot sign in.
 */
// Separate worktrees must not reuse or replace one another's test server.
const PORT = Number(process.env.E2E_PORT ?? 8000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("E2E_PORT must be an integer between 1 and 65535");
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["html"], ["github"]]
    : [["html", { open: "never" }]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      testMatch: /\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
    },
    // Leaflet and the tooltip popovers are the only engine-sensitive surfaces
    // here, and the popovers lean on native top-layer and focus-order
    // behaviour, so they are worth a cross-engine run if they ever look off.
    // Enable these if either starts misbehaving off-Chromium; they triple the
    // run, and need `npx playwright install firefox webkit` first.
    // { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],

  webServer: {
    command: `deno task build && deno serve -A --port ${PORT} _fresh/server.js`,
    cwd: "..",
    // The gate answers 303 for `/`; Playwright treats any non-error status
    // as "up", so the health check needs no login.
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DASHBOARD_PASSPHRASE: PASSPHRASE,
      DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    },
  },
});
