import path from "node:path";

/**
 * The login the suite runs under.
 *
 * `playwright.config.ts` passes these two values to the server it starts, and
 * `tests/auth.setup.ts` signs in with the passphrase once and saves the
 * resulting cookie to STORAGE_STATE, which every `chromium` test then starts
 * from. Neither value is a real secret; they exist so the production build
 * under test is gated exactly as the deployed one is.
 *
 * Playwright loads the config as CommonJS, so this is `__dirname` rather
 * than `import.meta.url`, which is a syntax error there.
 */
export const PASSPHRASE = "e2e passphrase: correct horse battery staple";
export const SESSION_SECRET = "e2e-session-secret-not-for-production";

/** Gitignored; written by the setup project, read by the chromium project. */
export const STORAGE_STATE = path.join(__dirname, "..", ".auth", "user.json");
