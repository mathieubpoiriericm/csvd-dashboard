import type { ComponentChildren } from "preact";
import { useId, useRef, useState } from "preact/hooks";

import { Icon } from "../Icon.tsx";
import type { Offence } from "../../lib/adapt/characters.ts";
import {
  type FieldView,
  fieldView,
  IDLE_VIEW,
  isSeen,
  ownIssues,
  valueAt,
} from "../../lib/adapt/feedback.ts";
import { useWizard } from "./wizard_context.ts";

/**
 * What a control shows. Inside the wizard a control naming its path reads
 * the timing rules (lib/adapt/feedback.ts); outside it, or with no path, an
 * explicit `error` is the whole story -- which is how the unit tests render
 * one on its own.
 */
function useView(
  field: string | undefined,
  text: string,
  required: boolean,
  error: string | undefined,
): FieldView {
  const wizard = useWizard();
  if (field === undefined || wizard === null) {
    return error === undefined
      ? IDLE_VIEW
      : { ...IDLE_VIEW, state: "error", message: error };
  }
  const own = ownIssues(wizard.issues, wizard.step, field);
  return fieldView({
    field,
    text,
    own,
    seen: isSeen(wizard.seen, wizard.step, field, own),
    required,
    valueOf: (path) => valueAt(wizard.answers, wizard.step, path),
  });
}

/**
 * An offence as the echo draws it: a space, a non-breaking space and a line
 * break made visible, and any other invisible character -- a control or
 * format character, a separator -- written as its code point, since it
 * would otherwise draw a mark with nothing in it.
 *
 * Every pattern and every replacement glyph is written as a `\u` escape, on
 * purpose: the first fix round found this written as `/ /g` twice, a plain
 * U+0020 space both times, so the second replace -- meant for U+00A0 --
 * silently matched nothing (the first replace had already consumed every
 * U+0020), and a non-breaking space, an offence the message names, was
 * drawn invisibly in the echo. A literal space and a literal non-breaking
 * space are one pixel apart in source and indistinguishable once pasted
 * into a terminal or a diff; `\u0020` and `\u00a0` cannot be confused for
 * each other again.
 */
const visible = (s: string) =>
  s.replace(/\u0020/g, "\u2423").replace(/\u00a0/g, "\u237d").replace(
    /\n/g,
    "\u21b5",
  ).replace(
    /[\p{Cc}\p{Cf}\p{Z}]/gu,
    (c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );

/** The characters of context the echo keeps either side of an offence. */
const CONTEXT = 20;

/**
 * The stretches of the value the echo draws: the whole of a short value,
 * else a window of context round each offence, overlapping windows merged.
 */
function windows(value: string, offences: Offence[]): Array<[number, number]> {
  if (value.length <= 3 * CONTEXT) return [[0, value.length]];
  const out: Array<[number, number]> = [];
  for (const o of offences) {
    const from = Math.max(0, o.start - CONTEXT);
    const to = Math.min(value.length, o.end + CONTEXT);
    const last = out[out.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/**
 * The value again with each offence marked. An <input> cannot style part
 * of its text, so the marks are drawn here; the message names every
 * character in words, which is why this copy is hidden from a screen reader.
 * The echo is one clipped line, so a long value is drawn as a window of
 * context round each offence, the rest elided: an offence two hundred
 * characters into a section would otherwise sit past the clip, unseen.
 */
function Echo({ value, offences }: { value: string; offences: Offence[] }) {
  const parts: ComponentChildren[] = [];
  let drawn = 0;
  for (const [from, to] of windows(value, offences)) {
    if (from > drawn) parts.push("\u2026");
    let at = from;
    for (const o of offences) {
      if (o.start < at || o.end > to) continue;
      if (o.start > at) parts.push(value.slice(at, o.start));
      parts.push(<mark key={o.start}>{visible(o.char)}</mark>);
      at = o.end;
    }
    parts.push(value.slice(at, to));
    drawn = to;
  }
  if (drawn < value.length) parts.push("\u2026");
  return <span class="adapt-echo" aria-hidden="true">{parts}</span>;
}

function Mark({ view }: { view: FieldView }) {
  if (view.state === "required") {
    return <span class="adapt-field-mark" aria-hidden="true">Required</span>;
  }
  if (view.state === "valid" || view.state === "error") {
    return (
      <span class="adapt-field-mark" aria-hidden="true">
        <Icon
          name={view.state === "valid" ? "checkCircle" : "exclamationTriangle"}
        />
      </span>
    );
  }
  return null;
}

interface FieldProps {
  label: string;
  hint?: string;
  view: FieldView;
  /** The id the hint and the message are rendered under; see `described`. */
  id: string;
  value: string;
  onFix?: (fix: string) => void;
  children: ComponentChildren;
}

/** One control with its label, mark, message and hint, labelled by containment. */
export function Field(
  { label, hint, view, id, value, onFix, children }: FieldProps,
) {
  // Everything but the label text sits outside the <label>, so the control's
  // accessible name is the label alone; the e2e spec addresses every field
  // by that exact name. The control points at the message and the hint.
  return (
    <div class={`adapt-field is-${view.state}`}>
      <label>
        <span class="adapt-field-label">{label}</span>
        {children}
      </label>
      <Mark view={view} />
      {view.message !== null && (
        <div class="adapt-field-message" id={`${id}-message`}>
          <Icon
            name={view.state === "error" ? "exclamationTriangle" : "info"}
          />
          <div class="adapt-field-message-body">
            <span>{view.message}</span>
            {view.more.map((line) => <span key={line}>{line}</span>)}
            {view.note !== null && (
              <span class="adapt-field-note">{view.note}</span>
            )}
            {(view.offences.length > 0 || (view.fix !== null && onFix)) && (
              <span class="adapt-field-fixrow">
                {view.offences.length > 0 && (
                  <Echo value={value} offences={view.offences} />
                )}
                {view.fix !== null && onFix && (
                  <button
                    type="button"
                    class="adapt-fix"
                    // The input keeps focus while the button is pressed, so
                    // the field does not re-render under the pointer and
                    // swallow the click.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      onFix(view.fix!)}
                  >
                    Use <code>{view.fix}</code>
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
      )}
      {hint && <span class="adapt-field-hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  );
}

/**
 * The attributes that tie a control to the message and the hint Field
 * renders under `id`: a screen reader reads both when the control takes
 * focus, and hears that it is required or in error. No live region: a
 * message spoken on every keystroke would drown what is typed.
 */
function described(
  id: string,
  hint: string | undefined,
  view: FieldView,
  required: boolean,
) {
  const ids = [
    view.message !== null && `${id}-message`,
    hint && `${id}-hint`,
  ].filter(Boolean);
  return {
    "aria-describedby": ids.length === 0 ? undefined : ids.join(" "),
    "aria-invalid": view.state === "error" ? "true" as const : undefined,
    "aria-required": required ? "true" as const : undefined,
  };
}

interface TextFieldProps {
  label: string;
  value: string;
  onInput: (value: string) => void;
  hint?: string;
  /** An explicit message, for a control outside the wizard. */
  error?: string;
  /** The issue path this control answers, as validate() writes it. */
  field?: string;
  /** Not required: no Required mark, no aria-required. */
  optional?: boolean;
  multiline?: boolean;
  inputMode?: "decimal" | "email" | "url";
  autoComplete?: string;
  /** False for a value no spelling service should see: a key, an address. */
  spellCheck?: boolean;
  autoCapitalize?: "off" | "none";
}

export function TextField(
  {
    label,
    value,
    onInput,
    hint,
    error,
    field,
    optional = false,
    multiline = false,
    inputMode,
    autoComplete,
    spellCheck,
    autoCapitalize,
  }: TextFieldProps,
) {
  const id = useId();
  const control = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const view = useView(field, value, !optional, error);
  const onFix = (fix: string) => {
    onInput(fix);
    // The button goes once the value passes; the caret returns to the end
    // of the input, ready for the next key.
    setTimeout(() => {
      control.current?.focus();
      control.current?.setSelectionRange(fix.length, fix.length);
    });
  };
  const shared = {
    value,
    "data-field": field,
    spellcheck: spellCheck,
    autoCapitalize,
    ...described(id, hint, view, !optional),
  };
  return (
    <Field
      label={label}
      hint={hint}
      view={view}
      id={id}
      value={value}
      onFix={onFix}
    >
      {multiline
        ? (
          <textarea
            ref={control}
            class="adapt-textarea"
            onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
            {...shared}
          />
        )
        : (
          // Always type="text": an email or url input runs the browser's own
          // validity check, which knows nothing of these rules and their
          // timing. inputMode keeps the right keyboard.
          <input
            ref={control}
            class="adapt-input"
            type="text"
            inputMode={inputMode}
            autoComplete={autoComplete}
            onInput={(e) => onInput((e.target as HTMLInputElement).value)}
            {...shared}
          />
        )}
    </Field>
  );
}

interface ParsedTextFieldProps extends TextFieldProps {
  /** The text as the answers would store it and `value` renders it. */
  canonical: (text: string) => string;
}

/**
 * A field whose answer is stored parsed -- a list split on commas, a
 * number -- rather than as the text typed.
 *
 * Rendering the parsed value back would rewrite the field under the
 * cursor: "a," splits to ["a"], renders as "a", and the comma is gone
 * before the next item can be typed. So the field shows what was typed
 * while that still parses to the stored value, and the stored value once
 * it has changed some other way (an import, a reset, a removed row). A fix
 * goes through the same `onInput`, so the typed text follows it.
 */
export function ParsedTextField(
  { canonical, value, onInput, ...rest }: ParsedTextFieldProps,
) {
  const [text, setText] = useState(value);
  return (
    <TextField
      {...rest}
      value={canonical(text) === value ? text : value}
      onInput={(v) => {
        setText(v);
        onInput(v);
      }}
    />
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  field?: string;
  optional?: boolean;
}

export function SelectField(
  { label, value, options, onChange, hint, error, field, optional = false }:
    SelectFieldProps,
) {
  const id = useId();
  const view = useView(field, value, !optional, error);
  return (
    <Field label={label} hint={hint} view={view} id={id} value={value}>
      <select
        class="adapt-select"
        data-field={field}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        {...described(id, hint, view, !optional)}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            selected={option.value === value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
