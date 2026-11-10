import { CodeBlock } from "../CodeBlock.tsx";
import { bundle } from "../../../lib/adapt/bundle.ts";
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
}

export function ReviewStep(
  { answers, allIssues, onShow }: ReviewProps,
) {
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
      <h3 class="adapt-step-title">What comes next</h3>
      <p class="adapt-status">
        The same checklist is in the archive as ADAPT-CHECKLIST.md.
      </p>
      <CodeBlock>{renderChecklist(answers)}</CodeBlock>
    </section>
  );
}
