import { assertEquals } from "@std/assert";

import {
  currentTheme,
  observeStoredTheme,
  observeSystemTheme,
  observeThemeChanges,
  stampedTheme,
  storedTheme,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
} from "../lib/theme.ts";

function replaceGlobal(
  name: "document" | "localStorage" | "matchMedia",
  value: unknown,
): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  };
}

Deno.test("stampedTheme and currentTheme accept only explicit theme values", () => {
  const restoreDocument = replaceGlobal("document", {
    documentElement: { dataset: { theme: "dark" } },
  });
  const restoreMedia = replaceGlobal("matchMedia", () => ({ matches: false }));
  try {
    assertEquals(stampedTheme(), "dark");
    assertEquals(currentTheme(), "dark");

    document.documentElement.dataset.theme = "contrast";
    assertEquals(stampedTheme(), null);
    assertEquals(currentTheme(), "light");
  } finally {
    restoreMedia();
    restoreDocument();
  }
});

Deno.test("currentTheme follows the system and defaults to light without matchMedia", () => {
  const restoreDocument = replaceGlobal("document", {
    documentElement: { dataset: {} },
  });
  const restoreDarkMedia = replaceGlobal(
    "matchMedia",
    () => ({ matches: true }),
  );
  try {
    assertEquals(currentTheme(), "dark");
  } finally {
    restoreDarkMedia();
  }

  const restoreNoMedia = replaceGlobal("matchMedia", undefined);
  try {
    assertEquals(currentTheme(), "light");
  } finally {
    restoreNoMedia();
    restoreDocument();
  }
});

Deno.test("storedTheme handles valid, invalid, and blocked storage", () => {
  const restoreValid = replaceGlobal("localStorage", {
    getItem: (key: string) => key === THEME_STORAGE_KEY ? "light" : null,
  });
  try {
    assertEquals(storedTheme(), "light");
  } finally {
    restoreValid();
  }

  const restoreInvalid = replaceGlobal("localStorage", {
    getItem: () => "contrast",
  });
  try {
    assertEquals(storedTheme(), null);
  } finally {
    restoreInvalid();
  }

  const restoreBlocked = replaceGlobal("localStorage", {
    getItem: () => {
      throw new DOMException("blocked");
    },
  });
  try {
    assertEquals(storedTheme(), null);
  } finally {
    restoreBlocked();
  }
});

Deno.test("observeSystemTheme reports changes and removes its listener", () => {
  let systemCallback: (() => void) | undefined;
  let removed: (() => void) | undefined;
  const query = {
    matches: false,
    addEventListener: (_name: string, callback: () => void) => {
      systemCallback = callback;
    },
    removeEventListener: (_name: string, callback: () => void) => {
      removed = callback;
    },
  };
  const restoreMedia = replaceGlobal("matchMedia", () => query);
  const observed: string[] = [];
  try {
    const stop = observeSystemTheme((theme) => observed.push(theme));
    systemCallback?.();
    query.matches = true;
    systemCallback?.();
    stop();
    assertEquals(observed, ["light", "dark"]);
    assertEquals(removed, systemCallback);
  } finally {
    restoreMedia();
  }
});

Deno.test("observeSystemTheme is a no-op when matchMedia is unavailable", () => {
  const restoreMedia = replaceGlobal("matchMedia", undefined);
  try {
    observeSystemTheme(() => {
      throw new Error("listener must not be called");
    })();
  } finally {
    restoreMedia();
  }
});

Deno.test("observeStoredTheme reports cross-document choices and cleans up", () => {
  const observed: Array<string | null> = [];
  const dispatchStorage = (key: string | null, newValue: string | null) => {
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      newValue: { value: newValue },
    });
    globalThis.dispatchEvent(event);
  };

  const stop = observeStoredTheme((theme) => observed.push(theme));
  dispatchStorage("another-app", "dark");
  dispatchStorage(THEME_STORAGE_KEY, "dark");
  dispatchStorage(THEME_STORAGE_KEY, "contrast");
  dispatchStorage(null, null);
  stop();
  dispatchStorage(THEME_STORAGE_KEY, "light");

  assertEquals(observed, ["dark", null, null]);
});

Deno.test("observeThemeChanges combines explicit and system events", () => {
  let systemCallback: (() => void) | undefined;
  const query = {
    matches: false,
    addEventListener: (_name: string, callback: () => void) => {
      systemCallback = callback;
    },
    removeEventListener: () => {
      systemCallback = undefined;
    },
  };
  const restoreMedia = replaceGlobal("matchMedia", () => query);
  let calls = 0;
  try {
    const stop = observeThemeChanges(() => calls++);
    globalThis.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    systemCallback?.();
    assertEquals(calls, 2);

    stop();
    globalThis.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
    systemCallback?.();
    assertEquals(calls, 2);
  } finally {
    restoreMedia();
  }
});
