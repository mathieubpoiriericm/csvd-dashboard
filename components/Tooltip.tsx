import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  arrow,
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
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
  dispose: () => void;
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
    const handle = (event: Event) => {
      const element = locate(event.target);
      const registered = element && entries.get(element);
      if (!registered) return;
      const { button, pop, setOpen } = registered;
      if (event.type === "beforetoggle" || event.type === "toggle") {
        // The queued toggle event can arrive after focus has already left.
        // Only the synchronous transition may cancel a pending close.
        if (event.type === "beforetoggle") clearTimeout(registered.timer);
        const open = (event as ToggleLike).newState === "open";
        if (!open) pop.classList.remove("is-placed");
        // Closing must leave the focused link attached until the native
        // popover algorithm restores focus to its invoker. `toggle` runs
        // after that algorithm; beforetoggle is only early enough for opening.
        if (open || event.type === "toggle") setOpen(open);
        return;
      }
      const related = locate((event as MouseEvent).relatedTarget);
      if (related === element) return;
      clearTimeout(registered.timer);
      if (event.type === "pointerover" && element === button) {
        registered.timer = setTimeout(() => {
          if (pop.isConnected && !pop.matches(":popover-open")) {
            pop.showPopover();
          }
        }, OPEN_DELAY_MS);
      } else if (event.type === "pointerout" || event.type === "focusout") {
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
      "focusin",
      "focusout",
      "beforetoggle",
      "toggle",
    ];
    for (const type of types) doc.addEventListener(type, handle, true);
    controller = {
      entries,
      dispose: () => {
        for (const type of types) doc.removeEventListener(type, handle, true);
      },
    };
    controllers.set(doc, controller);
  }
  controller.entries.set(entry.button, entry);
  controller.entries.set(entry.pop, entry);
  return () => {
    clearTimeout(entry.timer);
    controller.entries.delete(entry.button);
    controller.entries.delete(entry.pop);
    if (controller.entries.size === 0) {
      controller.dispose();
      controllers.delete(doc);
    }
  };
}

interface TooltipProps {
  content: TooltipContent | null;
  italic?: boolean;
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
export function Tooltip({ content, italic, children }: TooltipProps) {
  const popoverId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const pointer = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const button = trigger.current;
    const pop = panel.current;
    if (!button || !pop) return;
    return registerTooltip({ button, pop, setOpen });
  }, [content === null]);

  // Content has committed before Floating UI measures the open panel.
  useLayoutEffect(() => {
    const button = trigger.current;
    const pop = panel.current;
    const tip = pointer.current;
    if (!open || !button || !pop || !tip) return;
    let active = true;
    const position = async () => {
      const { x, y, placement, middlewareData } = await computePosition(
        button,
        pop,
        {
          strategy: "fixed",
          placement: "top",
          middleware: [
            offset(ARROW_SIZE_PX + 2),
            flip(),
            shift({ padding: VIEWPORT_PADDING_PX }),
            size({
              padding: VIEWPORT_PADDING_PX,
              apply({ availableHeight, elements }) {
                const scrollport = elements.floating.querySelector<HTMLElement>(
                  ".tooltip-pop-scroll",
                );
                if (scrollport) {
                  scrollport.style.maxHeight = `${
                    Math.max(
                      0,
                      availableHeight,
                    )
                  }px`;
                }
              },
            }),
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

      // Revealed only once placed, so it never paints at the UA default
      // position for a frame while computePosition resolves.
      pop.classList.add("is-placed");
    };

    const stop = autoUpdate(button, pop, position);
    return () => {
      active = false;
      stop();
      pop.classList.remove("is-placed");
    };
  }, [open, content]);

  if (!content) return <>{children}</>;

  return (
    <>
      <button
        type="button"
        ref={trigger}
        class={`tooltip-box${italic ? " tooltip-box-italic" : ""}`}
        popovertarget={popoverId}
        popovertargetaction="show"
        aria-expanded={open}
        aria-controls={popoverId}
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

/** Detail markup is shared by the deferred popover and server-render tests. */
export function TooltipDetails({ content }: { content: TooltipContent }) {
  return (
    <span class="tooltip-pop-scroll">
      {content.rows.map((row) => (
        <span key={row.label} class="tooltip-row">
          <strong>{row.label}</strong> {row.value}
        </span>
      ))}
      {content.link && (
        <a
          class="tooltip-link-btn"
          href={content.link.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {content.link.label}
        </a>
      )}
    </span>
  );
}
