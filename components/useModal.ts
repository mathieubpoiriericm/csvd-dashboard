import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

/**
 * Opens and closes a native <dialog> from a prop. The server renders it
 * closed; showModal() needs the element, so it runs in a layout effect, and
 * a dialog already in the wanted state is left alone because showModal()
 * on an open one throws. It runs after every render, not only when `open`
 * changes, so an element closed while the prop held (see below) is opened
 * again by the next render that still says it is open.
 *
 * `leave` is the callback Escape reports to. The browser can also close the
 * element itself -- Chrome closes on a second Escape without firing
 * `cancel` -- and then the `close` event reports the same leave while the
 * prop still says open, so the prop and the element cannot drift apart.
 */
export function useModal(open: boolean, leave: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const wanted = useRef(open);
  wanted.current = open;
  const onLeave = useRef(leave);
  onLeave.current = leave;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Our own close() runs once the prop is false, so this does nothing then.
    const closed = () => {
      if (wanted.current) onLeave.current();
    };
    dialog.addEventListener("close", closed);
    return () => dialog.removeEventListener("close", closed);
  }, []);
  return ref;
}
