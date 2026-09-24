import { expect, test } from "@playwright/test";

/**
 * Every SVG the origin serves runs under `server/svg_policy.ts`: opened as a
 * page, a script inside one would run with the viewer's session. The logos
 * are served before login, and the login page draws both of them.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("the SVGs the login page draws are sandboxed and still render", async ({ page, request }) => {
  await page.goto("/login");
  const images = page.locator('img[src$=".svg"]');
  const sources = [
    ...await images.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("src")!)
    ),
    ...await page.locator('link[rel="icon"][type="image/svg+xml"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")!)),
  ];
  expect(sources.length).toBeGreaterThan(0);

  for (const source of sources) {
    const response = await request.get(source);
    expect(response.ok(), source).toBe(true);
    const policy = response.headers()["content-security-policy"];
    expect(policy, source).toContain("default-src 'none'");
    expect(policy, source).toContain("sandbox");
    expect(policy, source).toContain("frame-ancestors 'none'");
  }

  // The policy governs the file as a document; as an image it still decodes.
  for (const image of await images.all()) {
    await expect.poll(() =>
      image.evaluate((node: HTMLImageElement) =>
        node.complete ? node.naturalWidth : 0
      )
    ).toBeGreaterThan(0);
  }
});
