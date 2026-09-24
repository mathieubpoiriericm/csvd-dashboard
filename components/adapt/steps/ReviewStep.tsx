import { useRef } from "preact/hooks";

import { CodeBlock } from "../CodeBlock.tsx";
import { bundle, BUNDLE_NAME } from "../../../lib/adapt/bundle.ts";
import { issueLabel } from "../../../lib/adapt/cards.ts";
import { renderChecklist } from "../../../lib/adapt/checklist.ts";
import {
  type Issue,
  issuesFor,
  STEP_LABELS,
  STEP_ORDER,
  type StepId,
} from "../../../lib/adapt/validate.ts";
import type { StepProps } from "./types.ts";

interface ReviewProps extends StepProps {
  allIssues: Issue[];
  /** Go to a step, from the issues listed under its name. */
  onShow: (step: StepId) => void;
  onDownload: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onReset: () => void;
}

export function ReviewStep(
  {
    answers,
    allIssues,
    onShow,
    onDownload,
    onExport,
    onImport,
    onReset,
  }: ReviewProps,
) {
  // The file input is the control the browser needs and the button above it
  // is the one people reach: a <label> wrapped round a hidden input is in no
  // tab order and in no accessibility tree. The input itself is taken out of
  // the tab order, because .visually-hidden clips rather than hides and
  // focus would otherwise land on a control nobody can see.
  const importInput = useRef<HTMLInputElement>(null);
  const paths = bundle(answers).map((e) => e.path);
  const clean = allIssues.length === 0;
  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">8. Review and download</h2>
      <p class="adapt-status">
        {clean
          ? "Every step is complete. The archive holds these files:"
          : "The download opens once every step is complete. What is left is listed under the step that holds it."}
      </p>
      {STEP_ORDER.map((step) => {
        const own = issuesFor(allIssues, step);
        if (own.length === 0) return null;
        return (
          <section class="adapt-card is-open" key={step}>
            <h3 class="adapt-card-heading">
              <span class="adapt-card-head adapt-card-head-plain">
                <span class="adapt-card-text">
                  <span class="adapt-card-title">{STEP_LABELS[step]}</span>
                  <span class="adapt-card-summary">
                    {own.length} to answer or fix
                  </span>
                </span>
              </span>
            </h3>
            <div class="adapt-card-body">
              {
                /* Grouped by step, and each named by the row or section it
                   is about: a message such as "is listed twice" is written
                   by several steps, and "This section is required" by one
                   step fifteen times; read alone it does not say where to
                   look. */
              }
              <ul class="adapt-remaining">
                {own.map((issue) => {
                  const label = issueLabel(answers, issue);
                  return (
                    <li key={`${issue.field}:${issue.message}`}>
                      {label !== null && <strong>{label}:</strong>}{" "}
                      {issue.message}
                    </li>
                  );
                })}
              </ul>
              <div class="adapt-actions">
                <button
                  type="button"
                  class="adapt-button"
                  onClick={() => onShow(step)}
                >
                  Go to {STEP_LABELS[step]}
                </button>
              </div>
            </div>
          </section>
        );
      })}
      <CodeBlock>{paths.join("\n")}</CodeBlock>
      <div class="adapt-actions">
        <button
          type="button"
          class="adapt-button adapt-button-primary"
          disabled={!clean}
          onClick={onDownload}
        >
          Download {BUNDLE_NAME}
        </button>
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
            if (
              !globalThis.confirm("Discard every answer and the saved draft?")
            ) {
              return;
            }
            onReset();
          }}
        >
          Start over
        </button>
      </div>
      <h3 class="adapt-step-title">What comes next</h3>
      <p class="adapt-status">
        The same checklist is in the archive as ADAPT-CHECKLIST.md.
      </p>
      <CodeBlock>{renderChecklist(answers)}</CodeBlock>
    </section>
  );
}
