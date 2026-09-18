/**
 * The institute's mark, from the manifest.
 *
 * Two static files rather than one inline SVG recoloured through
 * currentColor: a fork replaces two files under static/institute/ and
 * touches nothing under components/.
 *
 * `theme` says which surface the mark sits on. The navbar is dark in both
 * themes, so it asks for `"dark"` outright and renders one <img>. The login
 * card follows the theme, and there is no server-side way to know which one
 * a viewer will get -- the choice is `prefers-color-scheme` until the toggle
 * writes `data-theme`, both of which are resolved in the browser. So `"auto"`
 * renders both files and the stylesheet shows exactly one, under the same two
 * dark blocks the tokens are declared in.
 */
import { INSTITUTE } from "../lib/disease/site.ts";

export function InstituteLogo(
  { theme = "auto", decorative = false }: {
    theme?: "dark" | "light" | "auto";
    decorative?: boolean;
  },
) {
  const alt = decorative ? "" : INSTITUTE.logo.alt;
  const hidden = decorative ? "true" : undefined;
  const onDark = INSTITUTE.logo.srcOnDark ?? INSTITUTE.logo.src;

  if (theme !== "auto") {
    return (
      <img
        class="institute-logo"
        src={theme === "dark" ? onDark : INSTITUTE.logo.src}
        alt={alt}
        aria-hidden={hidden}
      />
    );
  }

  return (
    <>
      <img
        class="institute-logo institute-logo-light"
        src={INSTITUTE.logo.src}
        alt={alt}
        aria-hidden={hidden}
      />
      <img
        class="institute-logo institute-logo-dark"
        src={onDark}
        alt={alt}
        aria-hidden={hidden}
      />
    </>
  );
}
