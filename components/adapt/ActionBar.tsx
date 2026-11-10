import { useEffect, useId, useRef } from "preact/hooks";
import { autoUpdate, computePosition, offset, shift } from "@floating-ui/dom";

import { BUNDLE_NAME } from "../../lib/adapt/bundle.ts";

export interface ActionBarSession {
  onSave: () => void;
  /** Opens the resume dialog. */
  onResume: () => void;
  saving: boolean;
  indicator: { tone: "ok" | "danger"; text: string } | null;
  /** Formatted, for display and copy. */
  code: string | null;
  /** "kept until 24 Nov 2026". */
  keptUntil: string | null;
}

export interface ActionBarProps {
  /** issues.length === 0 */
  canDownload: boolean;
  onDownload: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  /** Called after the confirm. */
  onReset: () => void;
  /** The confirm() text. */
  resetConfirm: string;
  /** Null when sessions are off. */
  session: ActionBarSession | null;
}

/**
 * The wizard's buttons, pinned above the stepper so they are on every step.
 * The primary group is always on screen; the rest sit in a `[popover]` that
 * a More button opens on a narrow screen and that the stylesheet lays out
 * inline in the bar on a wide one.
 */
export function ActionBar(
  {
    canDownload,
    onDownload,
    onExport,
    onImport,
    onReset,
    resetConfirm,
    session,
  }: ActionBarProps,
) {
  // The file input is the control the browser needs and the button above it
  // is the one people reach: a <label> wrapped round a hidden input is in no
  // tab order and in no accessibility tree. The input itself is taken out of
  // the tab order, because .visually-hidden clips rather than hides and
  // focus would otherwise land on a control nobody can see.
  const importInput = useRef<HTMLInputElement>(null);
  const moreId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLDivElement>(null);
  // Below 900px the panel is a popover in the top layer, placed under its
  // More button by Floating UI as the tooltips are (see
  // .claude/rules/tooltips.md), so it follows the button at any bar height
  // rather than at a height the stylesheet guessed. Wide, the panel is
  // static in the bar and never opens, so this never runs.
  useEffect(() => {
    const button = toggle.current;
    const pop = more.current;
    if (!button || !pop) return;
    let stop: (() => void) | null = null;
    const onToggle = (e: Event) => {
      stop?.();
      stop = null;
      pop.classList.remove("is-placed");
      if ((e as ToggleEvent).newState !== "open") return;
      stop = autoUpdate(button, pop, async () => {
        const { x, y } = await computePosition(button, pop, {
          strategy: "fixed",
          placement: "bottom-end",
          middleware: [offset(8), shift({ padding: 8 })],
        });
        if (!pop.matches(":popover-open")) return;
        pop.style.left = `${x}px`;
        pop.style.top = `${y}px`;
        pop.classList.add("is-placed");
      });
    };
    pop.addEventListener("toggle", onToggle);
    return () => {
      pop.removeEventListener("toggle", onToggle);
      stop?.();
    };
  }, []);
  return (
    <div class="adapt-bar">
      {session !== null && (
        <div class="adapt-bar-primary">
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            disabled={session.saving}
            onClick={session.onSave}
          >
            Save session
          </button>
          {session.indicator !== null && (
            <span class={`adapt-bar-indicator is-${session.indicator.tone}`}>
              {session.indicator.text}
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        class="adapt-button adapt-bar-toggle"
        ref={toggle}
        popovertarget={moreId}
      >
        More
      </button>
      <div class="adapt-bar-more" popover id={moreId} ref={more}>
        {session !== null && session.code !== null && (
          <div class="adapt-bar-code">
            <code>{session.code}</code>
            <button
              type="button"
              class="adapt-button"
              onClick={() => navigator.clipboard?.writeText(session.code ?? "")}
            >
              Copy code
            </button>
            {session.keptUntil !== null && (
              <span class="adapt-bar-kept">{session.keptUntil}</span>
            )}
          </div>
        )}
        {session !== null && (
          <button type="button" class="adapt-button" onClick={session.onResume}>
            I have a resume code
          </button>
        )}
        <button type="button" class="adapt-button" onClick={onExport}>
          Export answers
        </button>
        <button
          type="button"
          class="adapt-button"
          onClick={() => importInput.current?.click()}
        >
          Import answers
        </button>
        <input
          ref={importInput}
          class="visually-hidden"
          tabIndex={-1}
          type="file"
          accept="application/json,.json"
          aria-label="Import answers file"
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            // Cleared so that choosing the same file again -- after
            // fixing it, or after a Start over -- still fires a change.
            input.value = "";
            if (f) onImport(f);
          }}
        />
        <button
          type="button"
          class="adapt-button"
          onClick={() => {
            // Every answer and the saved draft go at once, and the only
            // copy of them is the export beside this button.
            if (!globalThis.confirm(resetConfirm)) return;
            onReset();
          }}
        >
          Start over
        </button>
        <button
          type="button"
          class="adapt-button adapt-button-primary"
          disabled={!canDownload}
          onClick={onDownload}
        >
          Download {BUNDLE_NAME}
        </button>
      </div>
    </div>
  );
}
