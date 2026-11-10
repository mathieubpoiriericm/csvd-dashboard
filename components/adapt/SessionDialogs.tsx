import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";

import {
  type Overview,
  type Remaining,
  SESSION_COPY,
} from "../../lib/adapt/session.ts";
import { formatCode } from "../../lib/adapt/session_code.ts";
import { STEP_ORDER, type StepId } from "../../lib/adapt/validate.ts";

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
function useModal(open: boolean, leave: () => void) {
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

/**
 * Escape is reported, not obeyed: the browser's own close would leave
 * `open` true in the island, so the callback is the one thing that closes
 * the dialog, by flipping the prop. There is no light-dismiss: a click
 * outside does nothing.
 */
const onEscape = (leave: () => void) => (e: Event) => {
  e.preventDefault();
  leave();
};

export function GreetingDialog(
  { open, onNew, onResume }: {
    open: boolean;
    onNew: () => void;
    onResume: () => void;
  },
) {
  const ref = useModal(open, onNew);
  const titleId = useId();
  return (
    <dialog
      class="adapt-dialog"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onEscape(onNew)}
    >
      <h2 class="adapt-dialog-title" id={titleId}>
        {SESSION_COPY.greetingTitle}
      </h2>
      <p>{SESSION_COPY.greetingBody}</p>
      <div class="adapt-dialog-actions">
        <button type="button" class="adapt-button" onClick={onResume}>
          {SESSION_COPY.greetingResume}
        </button>
        <button
          type="button"
          class="adapt-button adapt-button-primary"
          onClick={onNew}
        >
          {SESSION_COPY.greetingNew}
        </button>
      </div>
    </dialog>
  );
}

export function CodeDialog(
  { open, code, keptUntil, onDone }: {
    open: boolean;
    code: string;
    keptUntil: string;
    onDone: () => void;
  },
) {
  const ref = useModal(open, onDone);
  const titleId = useId();
  const shown = formatCode(code);
  return (
    <dialog
      class="adapt-dialog"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onEscape(onDone)}
    >
      <h2 class="adapt-dialog-title" id={titleId}>{SESSION_COPY.codeTitle}</h2>
      <p>{SESSION_COPY.codeBody}</p>
      {
        /* Selectable as a whole, so a browser that refuses the clipboard
          still leaves a way to copy it. */
      }
      <p class="adapt-dialog-code">
        <code>{shown}</code>
      </p>
      <p class="adapt-dialog-kept">{keptUntil}</p>
      <div class="adapt-dialog-actions">
        <button
          type="button"
          class="adapt-button"
          onClick={() => {
            navigator.clipboard?.writeText(shown)?.catch(() => {});
          }}
        >
          Copy code
        </button>
        <button
          type="button"
          class="adapt-button adapt-button-primary"
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </dialog>
  );
}

export function ResumeDialog(
  { open, busy, error, onResume, onCancel }: {
    open: boolean;
    busy: boolean;
    error: string;
    onResume: (code: string) => void;
    onCancel: () => void;
  },
) {
  // While the request runs, Cancel and Escape do nothing: it settles first,
  // into the answers replaced or a reason shown here, and a window closed
  // under it would replace the answers with nothing on screen to say so.
  const cancel = () => {
    if (!busy) onCancel();
  };
  const ref = useModal(open, cancel);
  const titleId = useId();
  const inputId = useId();
  const [value, setValue] = useState("");
  // Each opening starts empty: a code typed for an earlier attempt, or a
  // wrong one, is not offered again.
  useLayoutEffect(() => {
    if (open) setValue("");
  }, [open]);
  return (
    <dialog
      class="adapt-dialog"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onEscape(cancel)}
    >
      <h2 class="adapt-dialog-title" id={titleId}>
        {SESSION_COPY.resumeTitle}
      </h2>
      <form
        class="adapt-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          onResume(value);
        }}
      >
        <label class="adapt-field-label" for={inputId}>Resume code</label>
        <input
          id={inputId}
          class="adapt-input adapt-dialog-input"
          type="text"
          value={value}
          autocomplete="off"
          {
            // Spread, because a literal false is dropped by the precompiled
            // JSX and the attribute must read "false".
            ...{ spellcheck: false }
          }
          autocapitalize="characters"
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        {error !== "" && <p class="adapt-dialog-error" role="alert">{error}</p>}
        <div class="adapt-dialog-actions">
          <button type="button" class="adapt-button" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            class="adapt-button adapt-button-primary"
            disabled={busy}
          >
            {SESSION_COPY.resumeAction}
          </button>
        </div>
      </form>
    </dialog>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const stepNumber = (step: StepId) => STEP_ORDER.indexOf(step) + 1;

function RemainingRow({ r }: { r: Remaining }) {
  return (
    <li class="adapt-welcome-row">
      <span class="adapt-welcome-glyph" aria-hidden="true">●</span>
      <div class="adapt-welcome-what">
        <p class="adapt-welcome-step">
          <span>{stepNumber(r.step)}. {r.label}</span>
          <span class="adapt-welcome-count">{r.count} to answer or fix</span>
        </p>
        {r.started
          ? (
            <ul class="adapt-welcome-items">
              {r.items.map((item) => (
                <li key={`${item.label}:${item.message}`}>
                  {item.label === null
                    ? item.message
                    : `${item.label}: ${item.message}`}
                </li>
              ))}
            </ul>
          )
          : <p class="adapt-welcome-items">Not started</p>}
      </div>
    </li>
  );
}

/**
 * What a returning visitor sees before the guide: the steps the saved
 * answers finish beside the ones that still ask something. Each panel names
 * its state in words as well as a colour and a glyph.
 */
export function WelcomeBack(
  { overview, lastSaved, keptUntil, onContinue, onReview }: {
    overview: Overview;
    lastSaved: string;
    keptUntil: string;
    onContinue: (step: StepId | "review") => void;
    onReview: () => void;
  },
) {
  const { completed, remaining, first } = overview;
  const items = remaining.reduce((n, r) => n + r.count, 0);
  const doneId = useId();
  const leftId = useId();
  // The screen replaces the step the researcher was on, so its heading takes
  // focus as a new step's does: it scrolls into view and is announced. Not
  // in a layout effect, as a step heading's is: the resume window closes in
  // the same commit, in a layout effect of its own that runs after this
  // one, and until then the page is inert under it and focus cannot land;
  // its close() then hands focus back to the button that opened it. The
  // passive effect runs after both, and the screen has no field a click
  // could have reached first.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section class="adapt-welcome">
      <header>
        <h2 class="adapt-welcome-title" ref={heading} tabIndex={-1}>
          Welcome back
        </h2>
        <p class="adapt-welcome-saved">
          last saved {lastSaved} · {keptUntil}
        </p>
      </header>
      <div class="adapt-welcome-panels">
        <section
          class="adapt-welcome-panel adapt-welcome-done"
          aria-labelledby={doneId}
        >
          <header class="adapt-welcome-head">
            <h2 id={doneId}>Completed</h2>
            <span>{completed.length} of {STEP_ORDER.length} steps</span>
          </header>
          <ul class="adapt-welcome-list">
            {completed.map((c) => (
              <li class="adapt-welcome-row" key={c.step}>
                <span class="adapt-welcome-glyph" aria-hidden="true">✓</span>
                <span>{stepNumber(c.step)}. {c.label}</span>
              </li>
            ))}
          </ul>
        </section>
        <section
          class={`adapt-welcome-panel adapt-welcome-left${
            remaining.length === 0 ? " is-empty" : ""
          }`}
          aria-labelledby={leftId}
        >
          <header class="adapt-welcome-head">
            <h2 id={leftId}>Remaining</h2>
            {remaining.length > 0 && (
              <span>
                {plural(remaining.length, "step")} · {plural(items, "item")}
              </span>
            )}
          </header>
          {remaining.length === 0
            ? <p class="adapt-welcome-nothing">Nothing left</p>
            : (
              <ul class="adapt-welcome-list">
                {remaining.map((r) => <RemainingRow key={r.step} r={r} />)}
              </ul>
            )}
        </section>
      </div>
      <div class="adapt-dialog-actions">
        <button type="button" class="adapt-button" onClick={onReview}>
          Review all steps
        </button>
        <button
          type="button"
          class="adapt-button adapt-button-primary"
          onClick={() => onContinue(first ?? "review")}
        >
          Continue at {remaining[0]?.label ?? "Review and download"}
        </button>
      </div>
    </section>
  );
}
