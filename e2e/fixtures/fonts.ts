import type { Page } from "@playwright/test";

/**
 * Every font the shell preloads, with the state of the @font-face it feeds.
 *
 * A preload that no rule consumes is a wasted round trip and a browser
 * console warning, so the specs assert every entry ends up `loaded`. The
 * face is found from the file name, which the build keeps as
 * `<Family>-<weight>-latin-<hash>.woff2`; the family is spelled without its
 * space there ("BarlowCondensed"), and the @font-face declares it with one.
 */
export async function preloadedFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return await page.evaluate(() => {
    const links = document.querySelectorAll<HTMLLinkElement>(
      'link[rel="preload"][as="font"]',
    );
    return Array.from(links, (link) => {
      const file = new URL(link.href).pathname.split("/").pop() ?? "";
      const match = /^([A-Za-z]+)-(\d{3})-/.exec(file);
      const family = match?.[1].replace(/([a-z])([A-Z])/g, "$1 $2") ?? "";
      const weight = match?.[2] ?? "";
      const face = Array.from(document.fonts).find((candidate) =>
        candidate.family.replace(/^"|"$/g, "") === family &&
        candidate.weight === weight
      );
      return { href: link.href, family, weight, status: face?.status ?? null };
    });
  });
}
