import { expect, test as setup } from "@playwright/test";
import { PASSPHRASE, STORAGE_STATE } from "../fixtures/auth.ts";

/**
 * Signs in once and saves the session cookie for the whole suite. Runs as
 * the `setup` project; `chromium` depends on it and starts every test from
 * the saved state, so the existing specs never see the login page.
 */
setup("sign in and save the session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.context().storageState({ path: STORAGE_STATE });
});
