import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  arrow,
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";

import type { TooltipContent } from "../lib/tooltip_content.ts";

/**
 * Carried over from the Tippy configuration this replaced. The close delay is
 * longer than Tippy's 80ms because it is now the only thing bridging the gap
 * between trigger and panel: the pointer leaves the button, and the panel's own
 * `mouseenter` has to land before the timer fires. Tippy did this with an
 * `interactiveBorder` hit-test instead.
 */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 140;

/** Keep in sync with `--svd-tooltip-arrow` in app.css. */
const ARROW_SIZE_PX = 8;
const VIEWPORT_PADDING_PX = 8;

const OPPOSITE_SIDE = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
} as const;

/**
 * The arrow's turn for each placement. It is a square with its top and left
 * borders drawn, so it is that corner that reads as the point: 45deg aims it
 * up, at a trigger below the panel. The default placement is `top`, where it
 * must aim down; drawn at 45deg there, the outline sat inside the panel as a
 * "^" and the part pointing at the trigger had none.
 */
const ARROW_ROTATION = { bottom: 45, left: 135, top: 225, right: 315 } as const;

/**
 * Makes a panel fit the viewport whole, so no content is ever cut off and the
 * panel never needs to scroll. The CSS width cap is right for a short panel;
 * a long one (a gene's full omics list, an alias key's member genes) is
 * fitted in three steps, each only when the one before it was not enough:
 *
 * 1. widen it, up to the viewport's width;
 * 2. if its rows are short and simply many, so nothing wraps wider, set them
 *    side by side in columns;
 * 3. scale the body down with `zoom` until it fits -- a phone, or a window
 *    too small for the content at any width.
 *
 * `zoom` goes on the body, not the panel: on the positioned panel it would
 * scale the `left`/`top` Floating UI writes as well. Every step is reset
 * first, because a panel fitted to a small window must grow back in a larger
 * one; the caller skips the whole pass while the viewport keeps its size.
 */
function fitToViewport(pop: HTMLElement): void {
  pop.style.maxWidth = "";
  pop.style.width = "";
  const body = pop.querySelector<HTMLElement>(".tooltip-pop-body");
  if (!body) return;
  body.style.columnCount = "";
  body.style.zoom = "";
  const root = pop.ownerDocument.documentElement;
  const maxHeight = root.clientHeight - 2 * VIEWPORT_PADDING_PX;
  const maxWidth = root.clientWidth - 2 * VIEWPORT_PADDING_PX;
  const measure = () => pop.getBoundingClientRect();

  // Text reflows non-linearly, so a few rounds.
  for (let round = 0; round < 4; round++) {
    const { width, height } = measure();
    if (height <= maxHeight || width >= maxWidth) break;
    const wider = Math.ceil((width * height / maxHeight) * 1.1);
    pop.style.maxWidth = `${Math.min(maxWidth, Math.max(wider, width + 40))}px`;
    if (measure().width > width + 1) continue;
    // Nothing wrapped wider. A multicol box's max-content width is one
    // column's, not the sum, so the panel is sized to hold every column.
    const gap = parseFloat(getComputedStyle(body).columnGap) || 0;
    const columns = Math.min(
      Math.ceil((height * 1.15) / maxHeight),
      Math.floor((maxWidth + gap) / (width + gap)),
    );
    if (columns >= 2) {
      const total = Math.ceil(columns * width + (columns - 1) * gap);
      body.style.columnCount = String(columns);
      pop.style.maxWidth = `${total}px`;
      pop.style.width = `${total}px`;
    }
    break;
  }

  // Wrapped text's height falls roughly with the square of the scale (fewer
  // lines, each shorter), hence the square root; the cap on each step keeps
  // a rounding miss from stalling the loop just above the fit.
  let scale = 1;
  for (let round = 0; round < 12; round++) {
    const { height } = measure();
    if (height <= maxHeight) return;
    scale *= Math.min(0.98, Math.sqrt(maxHeight / height));
    body.style.zoom = String(scale);
  }
}

/** `toggle` carries `newState`, which Deno's DOM lib does not model yet. */
type ToggleLike = Event & { newState?: "open" | "closed" };

interface Registration {
  button: HTMLButtonElement;
  pop: HTMLSpanElement;
  setOpen: (open: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// One controller per document; removing hundreds of rows performs map deletes,
// not thousands of AbortSignal removals. No DOM access occurs during SSR.
const controllers = new WeakMap<Document, {
  entries: Map<Element, Registration>;
  depart: (tooltip: Registration) => void;
  release: () => void;
}>();

function registerTooltip(entry: Registration): () => void {
  const doc = entry.button.ownerDocument;
  let controller = controllers.get(doc);
  if (!controller) {
    const entries = new Map<Element, Registration>();
    const locate = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest(".tooltip-box, .tooltip-pop")
        : null;
    const tooltipOf = (target: EventTarget | null) => {
      const element = locate(target);
      return element ? entries.get(element) : undefined;
    };
    // The tooltip the pointer last entered. A hover is the pointer entering a
    // tooltip from outside it, and this, not `relatedTarget`, says where it
    // came from: a panel closed from under a resting pointer (by Escape, at a
    // size where the fitted panel covers its trigger) is followed by a
    // `pointerover` on the trigger, whose `relatedTarget` is that panel in
    // Chromium and Firefox and nothing at all in WebKit.
    //
    // A panel over another tooltip's trigger uncovers that one in the same
    // way, and its `pointerover` looks like a hover off the panel: its
    // `relatedTarget` is the panel (or, in WebKit, can be nothing), just as
    // when the pointer moves off the panel's edge onto a trigger beside it.
    // Only the pointer's position tells the two apart. `rest` keeps where
    // it was when a panel closed from over it, and a `pointerover` there is
    // the panel leaving, not the pointer arriving: that tooltip's hover is
    // `held` until the pointer moves.
    let pointerIn: Registration | undefined;
    let last = { x: NaN, y: NaN };
    let rest: { x: number; y: number; closed: Registration } | undefined;
    let held: Registration | undefined;
    // A panel leaving the page: closed (its `beforetoggle`) or removed with
    // its row by a re-render (no event at all). Only from under the pointer
    // does it uncover anything.
    const depart = (tooltip: Registration) => {
      if (pointerIn !== tooltip) return;
      rest = { ...last, closed: tooltip };
      held = undefined;
    };
    const hover = (tooltip: Registration, element: Element | null) => {
      clearTimeout(tooltip.timer);
      if (element !== tooltip.button) return;
      const { pop } = tooltip;
      tooltip.timer = setTimeout(() => {
        if (pop.isConnected && !pop.matches(":popover-open")) {
          pop.showPopover();
        }
      }, OPEN_DELAY_MS);
    };
    const handle = (event: Event) => {
      if (event.type.startsWith("pointer")) {
        const { clientX: x, clientY: y } = event as PointerEvent;
        last = { x, y };
        if (rest && (x !== rest.x || y !== rest.y)) {
          rest = undefined;
          release();
        }
        if (event.type === "pointermove") {
          // The first move away from that point, still on the held
          // tooltip, enters it as its `pointerover` would have: a move
          // within one element fires no `pointerover` of its own.
          if (rest || !held) return;
          const tooltip = held;
          held = undefined;
          if (tooltipOf(event.target) === tooltip) {
            hover(tooltip, locate(event.target));
          }
          return;
        }
      }
      const element = locate(event.target);
      const registered = element ? entries.get(element) : undefined;
      if (event.type === "pointerover") {
        const from = pointerIn;
        pointerIn = registered;
        if (!registered || from === registered) return;
        // Uncovered, not entered. The closed panel's own trigger holds no
        // hover: it waits for the pointer to leave and come back.
        if (rest) {
          if (registered !== rest.closed) held = registered;
          return;
        }
        hover(registered, element);
        return;
      }
      // Out of the document altogether, so the next entry is a hover even
      // onto the same trigger.
      if (
        event.type === "pointerout" && !(event as MouseEvent).relatedTarget
      ) {
        pointerIn = undefined;
      }
      if (!registered) return;
      const { button, pop, setOpen } = registered;
      if (event.type === "beforetoggle" || event.type === "toggle") {
        // The queued toggle event can arrive after focus has already left.
        // Only the synchronous transition may cancel a pending close.
        if (event.type === "beforetoggle") clearTimeout(registered.timer);
        const open = (event as ToggleLike).newState === "open";
        // Only `beforetoggle` comes before the hit test that follows the
        // panel's departure; the queued `toggle` can come after it.
        if (event.type === "beforetoggle" && !open) depart(registered);
        if (!open) pop.classList.remove("is-placed");
        // Closing must leave the focused link attached until the native
        // popover algorithm restores focus to its invoker. `toggle` runs
        // after that algorithm; beforetoggle is only early enough for opening.
        if (open || event.type === "toggle") setOpen(open);
        return;
      }
      // Between a trigger and its own panel is movement within one tooltip.
      if (tooltipOf((event as FocusEvent).relatedTarget) === registered) return;
      clearTimeout(registered.timer);
      if (event.type === "pointerout" || event.type === "focusout") {
        registered.timer = setTimeout(() => {
          if (
            !button.matches(":focus-within, :hover") &&
            !pop.matches(":focus-within, :hover") &&
            pop.matches(":popover-open")
          ) {
            pop.hidePopover();
          }
        }, CLOSE_DELAY_MS);
      }
    };
    const types = [
      "pointerover",
      "pointerout",
      "pointermove",
      "focusin",
      "focusout",
      "beforetoggle",
      "toggle",
    ];
    for (const type of types) {
      doc.addEventListener(type, handle, { capture: true, passive: true });
    }
    // Listening ends with the last tooltip, but not while a departure's
    // record stands: a re-filter removes every row before it draws the new
    // ones, and a trigger drawn under the resting pointer must still meet
    // the record. The pointer's first move elsewhere clears it.
    const release = () => {
      if (entries.size > 0 || rest) return;
      for (const type of types) doc.removeEventListener(type, handle, true);
      controllers.delete(doc);
    };
    controller = { entries, depart, release };
    controllers.set(doc, controller);
  }
  controller.entries.set(entry.button, entry);
  controller.entries.set(entry.pop, entry);
  return () => {
    clearTimeout(entry.timer);
    // Preact runs this before it removes the row, so a panel going with it
    // is still connected and open here; removing it fires no `beforetoggle`.
    if (entry.pop.matches(":popover-open")) controller.depart(entry);
    controller.entries.delete(entry.button);
    controller.entries.delete(entry.pop);
    controller.release();
  };
}

interface TooltipProps {
  content: TooltipContent | null;
  italic?: boolean;
  /** The trigger's accessible name, for a trigger whose text alone is no name (`?`). */
  label?: string;
  children: preact.ComponentChildren;
}

/**
 * Wraps a table cell value in a popover.
 *
 * The trigger is a real `<button popovertarget>` and the panel is a native
 * `[popover]`, which is what buys the keyboard behaviour: activating the button
 * establishes the invoker relationship, so Tab moves *into* the panel to reach
 * the link, and Escape closes it and returns focus to the button. Showing the
 * panel imperatively — which is what the hover path does — does not establish
 * that relationship, so the pointer and keyboard paths are deliberately
 * different: hover calls `showPopover()`, the keyboard uses the native
 * `popovertarget` activation.
 *
 * The panel is rendered next to its trigger rather than portalled to
 * `document.body`. Popovers are promoted to the top layer, so `.table-scroll`'s
 * `overflow` cannot clip them — the reason the old implementation needed
 * `appendTo: () => document.body`, at the cost of that keyboard behaviour.
 *
 * Positioning is the only part left to JavaScript: CSS anchor positioning would
 * do it declaratively but is not supported widely enough yet.
 */
export function Tooltip({ content, italic, label, children }: TooltipProps) {
  const popoverId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const pointer = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const button = trigger.current;
    const pop = panel.current;
    if (!button || !pop) return;
    const unregister = registerTooltip({ button, pop, setOpen });
    // A tap before hydration opens the server-rendered panel natively, and its
    // toggle events fired before anything listened: adopt that open panel so
    // it gets its content and placement instead of staying invisible.
    if (pop.matches(":popover-open")) setOpen(true);
    return unregister;
  }, [content === null]);

  // Content has committed before Floating UI measures the open panel.
  useLayoutEffect(() => {
    const button = trigger.current;
    const pop = panel.current;
    const tip = pointer.current;
    if (!open || !button || !pop || !tip) return;
    let active = true;
    // autoUpdate calls this on every scroll frame and on every resize of the
    // panel, including the ones fitting it causes; only a new viewport size
    // can change the fit, so only that re-runs it.
    let fitted = "";
    const position = async () => {
      // A hidden panel measures 0×0: fitting it does nothing, and recording
      // its viewport as fitted would leave the shown panel unfitted.
      if (!pop.matches(":popover-open")) return;
      const root = pop.ownerDocument.documentElement;
      const viewport = `${root.clientWidth}x${root.clientHeight}`;
      if (viewport !== fitted) {
        fitted = viewport;
        fitToViewport(pop);
      }
      const { x, y, placement, middlewareData } = await computePosition(
        button,
        pop,
        {
          strategy: "fixed",
          placement: "top",
          middleware: [
            offset(ARROW_SIZE_PX + 2),
            // Below, then beside: a tall panel that fits neither above nor
            // below a table cell often fits next to it.
            flip({
              fallbackPlacements: ["bottom", "right", "left"],
              padding: VIEWPORT_PADDING_PX,
            }),
            // `crossAxis` lets a panel that fits on no side slide over its
            // own trigger rather than run off the viewport's edge. The panel
            // used to be capped to the space on one side of the trigger, not
            // to the viewport, and scrolled to show the rest.
            shift({ padding: VIEWPORT_PADDING_PX, crossAxis: true }),
            arrow({ element: tip }),
          ],
        },
      );

      // A close can win while Floating UI is measuring. Do not let that stale
      // result reveal or reposition a panel that is no longer open.
      if (!active || !pop.matches(":popover-open")) return;

      pop.style.left = `${x}px`;
      pop.style.top = `${y}px`;

      const side = placement.split("-")[0] as keyof typeof OPPOSITE_SIDE;
      const { x: arrowX, y: arrowY } = middlewareData.arrow ?? {};
      tip.style.left = arrowX == null ? "" : `${arrowX}px`;
      tip.style.top = arrowY == null ? "" : `${arrowY}px`;
      tip.style.right = "";
      tip.style.bottom = "";
      tip.style[OPPOSITE_SIDE[side]] = `${-ARROW_SIZE_PX / 2}px`;
      tip.style.transform = `rotate(${ARROW_ROTATION[side]}deg)`;
      // A panel slid over its trigger has nothing to point at: the arrow
      // would hang off its edge at some unrelated row.
      const slid = side === "top" || side === "bottom"
        ? middlewareData.shift?.y
        : middlewareData.shift?.x;
      tip.hidden = Math.abs(slid ?? 0) > 0.5;

      // Revealed only once placed, so it never paints at the UA default
      // position for a frame while computePosition resolves.
      pop.classList.add("is-placed");
    };

    const stop = autoUpdate(button, pop, position);
    // On native activation (a click, a tap, Enter or Space) the panel can be
    // rendered from its beforetoggle before it is shown: in Chromium and
    // WebKit always, in Firefox on a click. The call above then finds it
    // hidden; `toggle` follows once it is shown, whichever route opened it.
    pop.addEventListener("toggle", position);
    return () => {
      active = false;
      stop();
      pop.removeEventListener("toggle", position);
      pop.classList.remove("is-placed");
    };
  }, [open, content]);

  // A gene symbol is italic whether or not there is anything to say about
  // it: the only italics came from the trigger's class, so a symbol with no
  // lookup record (one NCBI does not know, say) stood upright beside every
  // other.
  if (!content) return italic ? <i>{children}</i> : <>{children}</>;

  return (
    <>
      <button
        type="button"
        ref={trigger}
        class={`tooltip-box${italic ? " tooltip-box-italic" : ""}`}
        popovertarget={popoverId}
        popovertargetaction="show"
        // A string, not `open`: the server drops a boolean-false aria-*
        // value, so a server-rendered trigger carried no collapsed state
        // until its island started.
        aria-expanded={open ? "true" : "false"}
        aria-controls={popoverId}
        aria-label={label}
      >
        {children}
      </button>
      <span ref={panel} id={popoverId} popover="auto" class="tooltip-pop">
        {open && <TooltipDetails content={content} />}
        <span ref={pointer} class="tooltip-arrow" />
      </span>
    </>
  );
}

/**
 * Detail markup is shared by the deferred popover and server-render tests.
 * Rows and links are keyed by position, not content: a key published as
 * several member genes repeats its labels ("UID" once per member), and two
 * members can resolve to one record and so carry the same link.
 */
export function TooltipDetails({ content }: { content: TooltipContent }) {
  return (
    <span class="tooltip-pop-body">
      {content.rows.map((row, index) => (
        <span key={index} class="tooltip-row">
          <strong>{row.label}</strong> {row.value}
        </span>
      ))}
      {content.links?.map((link, index) => (
        <a
          key={index}
          class="tooltip-link-btn"
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {link.label}
        </a>
      ))}
    </span>
  );
}
