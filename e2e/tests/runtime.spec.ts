import { expect, test } from "@playwright/test";

const ROUTES = [
  "/",
  "/genes",
  "/phenogram",
  "/trials",
  "/timeline",
  "/map",
  "/adapt",
];

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
    { name: "narrow mobile", width: 320, height: 740 },
  ]
) {
  test(`${viewport.name} routes load without runtime or layout failures`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    const failedResources: string[] = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.origin === new URL(baseURL!).origin && response.status() >= 400
      ) {
        failedResources.push(`${response.status()} ${url.pathname}`);
      }
    });

    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator("main")).toBeVisible();
      const layout = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        overflowing: [...document.querySelectorAll("body *")]
          .filter((element) =>
            element.getBoundingClientRect().right > innerWidth + 1 &&
            element.getBoundingClientRect().right < innerWidth + 100
          )
          .slice(0, 20)
          .map((element) => ({
            element: `${element.tagName.toLowerCase()}${
              element.className
                ? `.${String(element.className).split(" ").join(".")}`
                : ""
            }`,
            right: Math.round(element.getBoundingClientRect().right),
            width: Math.round(element.getBoundingClientRect().width),
            scrollWidth: element.scrollWidth,
            position: getComputedStyle(element).position,
            overflowX: getComputedStyle(element).overflowX,
          })),
      }));
      expect(layout.documentWidth, `${route}: ${JSON.stringify(layout)}`)
        .toBeLessThanOrEqual(layout.viewportWidth);
    }

    expect(pageErrors).toEqual([]);
    expect(failedResources).toEqual([]);
  });
}
