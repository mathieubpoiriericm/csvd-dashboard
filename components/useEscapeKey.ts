/** Browser-only hook shared by the two islands with a dismissible drawer. */

import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

/**
 * Calls `onEscape` while `enabled`. The callback is read through a ref, so a
 * new closure per render does not resubscribe the listener -- the
 * subscription tracks `enabled` alone, as both call sites' `[active]` /
 * `[drawer]` dependency lists did. The ref is written in a layout effect
 * rather than during render, so a render that runs without committing -- and
 * is later thrown away -- cannot leave `handler.current` pointing at a
 * closure the committed render never produced.
 */
export function useEscapeKey(enabled: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape);
  useLayoutEffect(() => {
    handler.current = onEscape;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handler.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
