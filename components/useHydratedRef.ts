import { useLayoutEffect, useRef } from "preact/hooks";

/** Marks committed island controls for diagnostics without another render. */
export function useHydratedRef<T extends Element>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    ref.current?.setAttribute("data-hydrated", "true");
  }, []);
  return ref;
}
