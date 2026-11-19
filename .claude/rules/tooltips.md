---
paths:
  - "components/Tooltip.tsx"
  - "lib/tooltips.ts"
  - "tests/tooltips_test.ts"
  - "tests/csvd/tooltips_test.ts"
  - "e2e/tests/csvd/tooltips.spec.ts"
---

# Tooltips

`lib/tooltips.ts` builds structured `TooltipContent` from the lookup Maps in
`lib/data.ts`; `components/Tooltip.tsx` renders it as ordinary JSX, which is why
there is no HTML escaping anywhere.

Tooltips are native `[popover]` panels positioned by `@floating-ui/dom`. This
replaced Tippy 6.3.7, whose repo is archived and whose Popper v2 engine is
frozen. Three things about the arrangement are load-bearing:

- **The trigger is a `<button popovertarget>`, not a span.** Activating it
  establishes the popover's _invoker relationship_, which is what puts the panel
  in the keyboard focus order — Tab from the trigger reaches the link inside,
  and Escape closes the panel and returns focus. `showPopover()` alone does not
  establish that relationship, and `showPopover({source})` needs Safari 26, so
  the hover path (imperative) and the keyboard path (native activation) are
  deliberately different routes into the same panel.
- **The panel sits next to its trigger, inside the cell.** Popovers render in
  the top layer, so `.table-scroll`'s `overflow` cannot clip them and no portal
  is needed. The cost is that a closed panel is still in the cell's
  `textContent` — see the e2e note below.
- **`display` is only ever set under `:popover-open`.** Setting it on
  `.tooltip-pop` outright would beat the UA's `[popover]:not(:popover-open)`
  rule on origin and every panel on the page would render at once.

Positioning is the only part left to JavaScript; CSS anchor positioning would do
it declaratively but sits at ~84% support.

**A trigger's own panel is not a hover.** The controller opens a panel only when
the pointer enters its tooltip from outside, judged by the tooltip the pointer
last entered rather than by `relatedTarget` (WebKit gives none when a panel
leaves from under the pointer), so a panel that Escape closes from under the
resting pointer, as at 320px where the fitted panel covers its trigger, stays
closed until the pointer leaves and comes back, and Enter opens it by the
keyboard route. A panel's departure is never a hover, whichever trigger it
uncovers: another tooltip's trigger left under the resting pointer opens on
hover only once the pointer has moved, which the controller judges by the
pointer's position, since `relatedTarget` names the departing panel just as it
names a panel the pointer really left.

**A panel never scrolls and never cuts content off.** `fitToViewport()` in
`components/Tooltip.tsx` widens a panel too tall for the viewport, sets short
rows in columns, and as a last resort scales the body down with `zoom`, before
Floating UI places it anywhere in the viewport (`flip` to four sides, `shift`
with `crossAxis`). Hiding a scrollbar is not a fix: content behind it is still
cut off. `zoom` sits on `.tooltip-pop-body`, never on the panel, which carries
the `left`/`top` Floating UI writes. The fit runs only on a shown panel: on
native activation (a click, a tap, Enter or Space) the panel can be rendered
before it is shown (in Chromium and WebKit always, in Firefox on a click), so
`position()` measures nothing while it is hidden (a hidden panel is 0×0, and
recording that as fitted left the shown one cut off) and runs again on the
panel's `toggle` event.
