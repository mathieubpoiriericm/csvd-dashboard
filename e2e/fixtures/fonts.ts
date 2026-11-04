import type { Page } from "@playwright/test";

/**
 * Every font the shell preloads, with the state of the @font-face it feeds.
 *
 * A preload that no rule consumes is a wasted round trip and a browser
 * console warning, so the specs assert every entry ends up `loaded`. The
 * face is found from the file name, which the build keeps as
 * `<Family>-<weight>-<subset>-<hash>.woff2`; the family is spelled without its
 * space there ("BarlowCondensed"), and the @font-face declares it with one.
 *
 * Each family and weight has two faces, latin and latin-ext, told apart only
 * by unicode-range (a FontFace exposes no source URL). So the face is the one
 * whose range covers a character of the file's own subset: "A" for latin, "Ā"
 * for latin-ext. Matching on family and weight alone would find whichever
 * pair member is declared first -- latin-ext, which a page with no such
 * character never loads.
 */
export async function preloadedFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return await page.evaluate(() => {
    const covers = (range: string, code: number) =>
      range.split(",").some((part) => {
        const [start, end] = part.trim().replace(/^U\+/i, "").split("-");
        const low = parseInt(start, 16);
        return code >= low && code <= parseInt(end ?? start, 16);
      });
    const links = document.querySelectorAll<HTMLLinkElement>(
      'link[rel="preload"][as="font"]',
    );
    return Array.from(links, (link) => {
      const file = new URL(link.href).pathname.split("/").pop() ?? "";
      const match = /^([A-Za-z]+)-(\d{3})-(latin(?:-ext)?)-/.exec(file);
      const family = match?.[1].replace(/([a-z])([A-Z])/g, "$1 $2") ?? "";
      const weight = match?.[2] ?? "";
      const probe = match?.[3] === "latin-ext" ? 0x100 : 0x41;
      const face = Array.from(document.fonts).find((candidate) =>
        candidate.family.replace(/^"|"$/g, "") === family &&
        candidate.weight === weight &&
        covers(candidate.unicodeRange, probe)
      );
      return { href: link.href, family, weight, status: face?.status ?? null };
    });
  });
}
