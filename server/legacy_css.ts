/**
 * Strips Leaflet's Internet Explorer 8 declarations from leaflet.css.
 *
 * leaflet@1.9.4 still ships two declarations only IE < 9 understands: the
 * `behavior: url(#default#VML)` on `.lvml` (VML shapes, used when a browser
 * has no SVG) and a `filter: progid:DXImageTransform…` rotating the popup
 * tip under `.leaflet-oldie`, a class Leaflet sets only for IE < 9. Neither
 * can apply here -- this app's client is ES modules, which no IE runs -- but
 * every other browser still parses them, and Firefox logs each as a CSS
 * error in the console on every page load.
 *
 * Exactly these two go. The sibling `-ms-filter` and `-ms-zoom` lines are
 * just as dead but parse silently (an unknown vendor-prefixed property is not
 * reported), and `.leaflet-safari`'s `image-rendering:
 * -webkit-optimize-contrast` is live: Leaflet sets that class on Safari, which
 * sharpens the OpenStreetMap tiles with it. Firefox's warning on that one is
 * Firefox correctly ignoring a WebKit value, and stays.
 */

import type { Plugin } from "vite";

/** Matches the leaflet.css module however the resolver spells its path. */
const LEAFLET_CSS = /[\\/]leaflet[\\/]dist[\\/]leaflet\.css(?:\?|$)/;

const IE_DECLARATIONS = [
  /^[ \t]*behavior:\s*url\(#default#VML\);[ \t]*\r?\n/m,
  /^[ \t]*filter:\s*progid:DXImageTransform\.Microsoft\.Matrix\([^)]*\);[ \t]*\r?\n/m,
] as const;

/**
 * Removes each declaration in `IE_DECLARATIONS` from `css`. Throws if one is
 * missing, so a Leaflet upgrade that moves or drops them is noticed rather
 * than left to a stale pattern that silently matches nothing.
 */
export function stripLeafletIeDeclarations(css: string): string {
  return IE_DECLARATIONS.reduce((text, pattern) => {
    if (!pattern.test(text)) {
      throw new Error(
        `leaflet.css no longer contains ${pattern}; update server/legacy_css.ts`,
      );
    }
    return text.replace(pattern, "");
  }, css);
}

/** Vite plugin applying `stripLeafletIeDeclarations` to leaflet.css. */
export function leafletLegacyCss(): Plugin {
  return {
    name: "leaflet-legacy-css",
    enforce: "pre",
    transform(code, id) {
      return LEAFLET_CSS.test(id) ? stripLeafletIeDeclarations(code) : null;
    },
  };
}
