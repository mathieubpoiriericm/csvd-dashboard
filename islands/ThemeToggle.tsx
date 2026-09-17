import { useEffect, useState } from "preact/hooks";

import { Icon } from "../components/Icon.tsx";
import {
  currentTheme,
  observeStoredTheme,
  observeSystemTheme,
  stampedTheme,
  storedTheme,
  type Theme,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
} from "../lib/theme.ts";

function updateBrowserThemeColor() {
  const bar = getComputedStyle(document.documentElement)
    .getPropertyValue("--svd-nav").trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", bar);
  }
}

/**
 * Switches the theme and remembers the choice.
 *
 * The button renders on the server too, so it must not read localStorage or
 * matchMedia during the first render — it starts on the light label and
 * corrects itself in an effect once mounted. The stamp on <html> is applied
 * before first paint by the inline script in routes/_app.tsx, so the page
 * itself never flashes; only this control's icon settles a frame later.
 */
export default function ThemeToggle() {
  // null is the server-rendered state. It keeps hydration deterministic and
  // doubles as the only mounted flag the icon needs.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    const stopSystemObserver = observeSystemTheme((next) => {
      // While no explicit choice is stored or stamped the OS keeps control.
      // The stamp matters when storage access is blocked after a click.
      if (stampedTheme() || storedTheme()) return;
      setTheme(next);
      updateBrowserThemeColor();
    });

    const stopStorageObserver = observeStoredTheme((stored) => {
      if (stored === null) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = stored;

      setTheme(currentTheme());
      updateBrowserThemeColor();
      globalThis.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    });

    return () => {
      stopSystemObserver();
      stopStorageObserver();
    };
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse writes; the stamp keeps this page coherent.
    }
    updateBrowserThemeColor();
    globalThis.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  }

  const next: Theme = theme === "dark" ? "light" : "dark";
  const hint = theme === null ? "Switch theme" : `Switch to ${next} theme`;

  return (
    <button
      type="button"
      class="theme-toggle"
      onClick={() => choose(next)}
      aria-label={hint}
      title={hint}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
