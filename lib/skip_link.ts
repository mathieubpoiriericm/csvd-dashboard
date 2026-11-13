/**
 * A skip link whose target is hidden until it is focused.
 *
 * The figures' "Skip the figure" link lands on a line that is clipped out of
 * flow until it holds focus (`.figure-end` in `assets/app.css`). Followed as
 * a plain fragment link, Chromium focuses the line and then scrolls to where
 * it now is; Firefox and WebKit scroll first, to the clipped box, and then
 * focus it, so the line appears a screen below and the reader who pressed
 * the link sees nothing arrive. Focusing the target from the click scrolls
 * to it as it is once focused, in all three.
 */

/** What `followSkipLink` needs of the click: the link and a way to stop it. */
interface SkipClick {
  preventDefault(): void;
  currentTarget: { hash: string };
}

/**
 * Focus the element a skip link's fragment names, in place of the browser's
 * own navigation. With no such element the click is left alone, so the link
 * still does whatever the browser makes of it.
 */
export function followSkipLink(
  event: SkipClick,
  page: { getElementById(id: string): { focus(): void } | null } = document,
): void {
  const target = page.getElementById(event.currentTarget.hash.slice(1));
  if (target === null) return;
  event.preventDefault();
  target.focus();
}
