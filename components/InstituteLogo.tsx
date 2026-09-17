/**
 * The institute's mark, from the manifest.
 *
 * Two static files rather than one inline SVG recoloured through
 * currentColor: a fork replaces two files under static/institute/ and
 * touches nothing under components/. The navbar is dark in both themes, so
 * it asks for the dark file; the login card sits on a light surface.
 */
import { INSTITUTE } from "../lib/disease/site.ts";

export function InstituteLogo(
  { dark = false, decorative = false }: {
    dark?: boolean;
    decorative?: boolean;
  },
) {
  const src = dark
    ? INSTITUTE.logo.srcOnDark ?? INSTITUTE.logo.src
    : INSTITUTE.logo.src;
  return (
    <img
      class="institute-logo"
      src={src}
      alt={decorative ? "" : INSTITUTE.logo.alt}
      aria-hidden={decorative ? "true" : undefined}
    />
  );
}
