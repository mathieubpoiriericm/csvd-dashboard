/**
 * Text as preact-render-to-string writes it into HTML, in text and in
 * attributes alike: `&`, `"` and `<` become entities, and `'` and `>` stay.
 * A test that looks for a manifest string in rendered HTML goes through
 * this, or a fork whose institute is "UCL & UCLH" fails on a correct page.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll(
    "<",
    "&lt;",
  );
}
