import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { autoUpdate, computePosition, flip, shift } from "@floating-ui/dom";

import { manifest } from "../lib/disease/manifest.ts";
import { phenogramFileName } from "../lib/phenogram_svg.ts";
import { saveDownload } from "./download.ts";

interface PhenogramDownloadProps {
  /** Builds the SVG document; called from click handlers only, never in SSR. */
  build: (withKey: boolean) => Promise<string>;
}

/** `toggle` carries `newState`, which Deno's DOM lib does not model yet. */
type ToggleLike = Event & { newState?: "open" | "closed" };

/**
 * The "Download SVG" menu: a native popover opened by its invoker button, so
 * Escape, light-dismiss and focus return come from the platform.
 */
export function PhenogramDownload({ build }: PhenogramDownloadProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Under the button, kept there through scrolling and resizing.
  useLayoutEffect(() => {
    const button = toggle.current;
    const pop = panel.current;
    if (!open || !button || !pop) return;
    return autoUpdate(button, pop, async () => {
      const { x, y } = await computePosition(button, pop, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [flip({ padding: 8 }), shift({ padding: 8 })],
      });
      pop.style.left = `${x}px`;
      pop.style.top = `${y}px`;
    });
  }, [open]);

  const choose = async (withKey: boolean) => {
    panel.current?.hidePopover();
    try {
      const svg = await build(withKey);
      saveDownload(
        phenogramFileName(withKey, new Date(), manifest.disease.key),
        svg,
        "image/svg+xml",
      );
    } catch (error) {
      console.error("The phenogram SVG could not be saved.", error);
    }
  };

  return (
    <div class="phenogram-download">
      <button
        ref={toggle}
        type="button"
        class="phenogram-download-toggle"
        popovertarget={id}
        // A string, not a boolean: the server drops a boolean-false aria-*.
        aria-expanded={open ? "true" : "false"}
      >
        Download SVG <span aria-hidden="true">▾</span>
      </button>
      <div
        ref={panel}
        popover="auto"
        id={id}
        class="phenogram-download-pop"
        onToggle={(event) => setOpen((event as ToggleLike).newState === "open")}
      >
        <button
          type="button"
          class="phenogram-download-item"
          onClick={() => choose(false)}
        >
          Figure only
        </button>
        <button
          type="button"
          class="phenogram-download-item"
          onClick={() => choose(true)}
        >
          Figure with key
        </button>
        <p class="phenogram-download-note">
          Text uses the Barlow and Barlow Condensed fonts, free from Google
          Fonts. Install them before editing in Inkscape.
        </p>
      </div>
    </div>
  );
}
