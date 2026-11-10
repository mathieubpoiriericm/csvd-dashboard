/**
 * The phenogram's SVG export: colours the live figure takes from CSS tokens,
 * written out as literals because an exported file has no stylesheet.
 *
 * These are the light-theme values; `tests/phenogram_svg_test.ts` reads
 * `assets/app.css` and fails when a token is retuned without this table.
 */
export const SVG_PALETTE = {
  /** `--svd-figure-ink` / `--svd-ink` (slate-950). */
  ink: "#1d1f20",
  /** `--svd-ink-muted` (slate-700). */
  inkMuted: "#5d5d60",
  /** `--svd-line-strong` (slate-400). */
  lineStrong: "#b7b7ba",
  /** `--svd-figure-plate` (white). */
  plate: "#ffffff",
} as const;
