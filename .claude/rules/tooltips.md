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
