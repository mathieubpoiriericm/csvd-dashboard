import { Icon } from "../Icon.tsx";
import { seenKey } from "../../lib/adapt/feedback.ts";
import type { StepId } from "../../lib/adapt/validate.ts";
import { useWizard } from "./wizard_context.ts";

/**
 * The id a note is rendered under, for the control it describes to point
 * at. One step renders at a time, and every character of the path but a
 * letter, a digit or a hyphen is escaped, so no two paths share one.
 */
export const noteId = (step: StepId, field: string): string =>
  `adapt-note-${step}-${
    field.replace(
      /[^A-Za-z0-9-]/g,
      (c) => `_${c.codePointAt(0)!.toString(16)}_`,
    )
  }`;

/** Whether the note on `field` has something to say in the step on screen. */
export function useNoted(field: string | undefined): string | undefined {
  const wizard = useWizard();
  if (wizard === null || field === undefined) return undefined;
  return wizard.issues.some((i) => i.step === wizard.step && i.field === field)
    ? noteId(wizard.step, field)
    : undefined;
}

/**
 * The messages on a path no control owns: a list's count, a logo, a MeSH
 * row. Muted guidance until the path is seen, red after, the way a field's
 * own message is. The control the note is about points at it by its id
 * (useNoted), so the message is read with the control. Not
 * `.adapt-lookup-result`: the e2e spec expects exactly one of those per
 * lookup.
 */
export function FieldNote({ field }: { field: string }) {
  const wizard = useWizard();
  if (wizard === null) return null;
  const own = wizard.issues.filter((i) =>
    i.step === wizard.step && i.field === field
  );
  if (own.length === 0) return null;
  const seen = wizard.seen.has(seenKey(wizard.step, field));
  return (
    <div
      class={`adapt-field-message ${seen ? "is-error" : "is-note"}`}
      id={noteId(wizard.step, field)}
      data-field={field}
      tabIndex={-1}
    >
      <Icon name={seen ? "exclamationTriangle" : "info"} />
      <div class="adapt-field-message-body">
        {own.map((issue) => <span key={issue.message}>{issue.message}</span>)}
      </div>
    </div>
  );
}

/** The ARIA a control carries for the note that holds its messages. */
function useNoteAria(field: string, required: boolean) {
  const wizard = useWizard();
  const described = useNoted(field);
  const seen = wizard !== null && described !== undefined &&
    wizard.seen.has(seenKey(wizard.step, field));
  return {
    "data-field": field,
    "aria-describedby": described,
    "aria-invalid": seen ? "true" as const : undefined,
    "aria-required": required ? "true" as const : undefined,
  };
}

/**
 * A logo's file input. Its messages are a FieldNote rather than a field's
 * own, so it points at that note, is invalid once the note is red, and is
 * required when it is the one logo the manifest needs.
 */
export function LogoInput(
  { field, required, onFile }: {
    field: "logoLight" | "logoDark";
    required: boolean;
    onFile: (file: File | undefined) => void;
  },
) {
  const aria = useNoteAria(field, required);
  return (
    <input
      class="adapt-input"
      type="file"
      accept=".svg,.png,image/svg+xml,image/png"
      {...aria}
      onChange={(e) => {
        const input = e.currentTarget;
        const file = input.files?.[0];
        // Cleared, as the import control is, so that the same file can be
        // chosen again after Remove: an input still holding it fires no
        // change.
        input.value = "";
        onFile(file);
      }}
    />
  );
}

/** A checkbox whose messages are a FieldNote, wired to it as LogoInput is. */
export function NotedCheckbox(
  { field, checked, onToggle }: {
    field: string;
    checked: boolean;
    onToggle: (checked: boolean) => void;
  },
) {
  const aria = useNoteAria(field, false);
  return (
    <input
      type="checkbox"
      checked={checked}
      {...aria}
      onChange={(e) => onToggle(e.currentTarget.checked)}
    />
  );
}
