/** Theme state shared by the toggle and theme-aware islands. */
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "svd-theme";
export const THEME_CHANGE_EVENT = "svd:themechange";

const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function systemTheme(): Theme {
  return globalThis.matchMedia?.(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

export function stampedTheme(): Theme | null {
  const stamped = document.documentElement.dataset.theme;
  return isTheme(stamped) ? stamped : null;
}

export function currentTheme(): Theme {
  return stampedTheme() ?? systemTheme();
}

/** Storage access can throw when site data is blocked. */
export function storedTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Observe operating-system theme changes when matchMedia is available. */
export function observeSystemTheme(
  listener: (theme: Theme) => void,
): () => void {
  const query = globalThis.matchMedia?.(THEME_MEDIA_QUERY);
  if (!query) return () => {};

  const onChange = () => listener(query.matches ? "dark" : "light");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Observe an explicit choice written or cleared by another document. */
export function observeStoredTheme(
  listener: (theme: Theme | null) => void,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    listener(isTheme(event.newValue) ? event.newValue : null);
  };
  globalThis.addEventListener("storage", onStorage);
  return () => globalThis.removeEventListener("storage", onStorage);
}

/** Observe both explicit toggle events and operating-system theme changes. */
export function observeThemeChanges(listener: () => void): () => void {
  globalThis.addEventListener(THEME_CHANGE_EVENT, listener);
  const stopSystemObserver = observeSystemTheme(listener);

  return () => {
    globalThis.removeEventListener(THEME_CHANGE_EVENT, listener);
    stopSystemObserver();
  };
}
