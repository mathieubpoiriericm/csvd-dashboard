import os from "node:os";
import path from "node:path";
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

// How many workers CI runs, when it says. An empty value counts as unset:
// ci.yml passes `${{ vars.CI_RUNNER && '4' || '' }}`, which is the empty
// string on GitHub's runners, and there the suite keeps its 2 workers.
const WORKERS_ENV = process.env.E2E_WORKERS ?? "";
const WORKERS = WORKERS_ENV === "" ? undefined : Number(WORKERS_ENV);
if (WORKERS !== undefined && (!Number.isInteger(WORKERS) || WORKERS < 1)) {
  throw new Error("E2E_WORKERS must be a positive integer");
}

// Saved sessions are on for the suite, kept here. Derived from the port, not
// made with mkdtemp: Playwright evaluates this config once per worker, and
// every runner already has its own E2E_PORT.
const SESSIONS_DIR = path.join(os.tmpdir(), `adapt-sessions-e2e-${PORT}`);

// The web server's command empties SESSIONS_DIR before the server starts, and
// so once per run in Playwright's main process, never per worker. Each run
// leaves about ten sessions behind and the server's sweep removes only those
// 14 days old, so on a runner with a fixed port and a lasting /tmp the
// directory would reach the server's cap of 500 sessions within weeks, and
// every create would then answer "full". `rm -rf` is given this one path,
// quoted, and succeeds when it does not exist yet.
const quotedSessionsDir = `'${SESSIONS_DIR.replaceAll("'", `'\\''`)}'`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: WORKERS ?? (process.env.CI ? 2 : undefined),
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
    command: `rm -rf -- ${quotedSessionsDir} && deno task build && ` +
      `deno serve -A --port ${PORT} _fresh/server.js`,
    cwd: "..",
    // The gate answers 303 for `/`; Playwright treats any non-error status
    // as "up", so the health check needs no login.
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DASHBOARD_PASSPHRASE: PASSPHRASE,
      DASHBOARD_SESSION_SECRET: SESSION_SECRET,
      // Emptied when this server starts, but a reused local server keeps
      // what earlier runs left, so no spec may rely on it being empty.
      ADAPT_SESSIONS_DIR: SESSIONS_DIR,
      // Every worker shares one client address, and a run creates more
      // sessions in a minute than the production limit of ten per client.
      ADAPT_SESSION_PER_CLIENT_LIMIT: "1000",
    },
  },
});
