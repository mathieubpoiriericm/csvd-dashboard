import type { StepState } from "../../lib/adapt/feedback.ts";

export interface StepperStep {
  id: string;
  label: string;
  state: StepState;
  /**
   * What the state says, shown under the segment: "Done", "1 to fix", or
   * for a step in progress how much of it is answered, "3/24".
   */
  detail: string;
  /** How much of the step is answered, 0 to 100. */
  fill: number;
}

interface StepperProps {
  steps: StepperStep[];
  current: string;
  onSelect: (id: string) => void;
}

/**
 * Below 900px the segments are a row that scrolls sideways, and Next walks
 * the current one off its right edge. The segment that becomes current, or
 * takes focus, is brought to the middle of the row, so the steps either
 * side of it show too: the browser's own scroll on focus left a segment
 * that was partly in view where it was, its ring cut off. Only the row
 * moves: scrollIntoView would scroll the page as well, away from the step
 * heading that takes focus as the step opens. A no-op above 900px, where
 * the row does not scroll.
 */
export function keepInView(segment: HTMLLIElement | null) {
  const row = segment?.parentElement;
  if (!segment || !row) return;
  const box = row.getBoundingClientRect();
  const at = segment.getBoundingClientRect();
  row.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
}

/**
 * One segment per step, every step reachable in any order. The button's
 * name is the step's name alone -- the e2e spec finds steps by it -- and
 * the detail underneath is its description, so a screen reader hears
 * both. The detail says the state in words ("Not started", "Done", "1 to
 * fix", Review's "Ready"), so colour is never the only channel; the one
 * exception is a step in progress, whose count reads as a fraction or a
 * date aloud and is spelt out instead. Amber only when something typed is
 * wrong: an empty draft is not a fault, and seven amber steps on a first
 * visit read as one.
 */
export function Stepper({ steps, current, onSelect }: StepperProps) {
  return (
    <ol class="adapt-stepper" aria-label="Steps">
      {steps.map((step) => {
        const classes = ["adapt-stepper-item", `is-${step.state}`];
        if (step.id === current) classes.push("is-current");
        const described = `adapt-stepper-${step.id}`;
        const spoken = step.state === "progress"
          ? `${step.detail.replace("/", " of ")} answered, in progress`
          : null;
        return (
          <li
            key={step.id}
            ref={step.id === current ? keepInView : undefined}
          >
            <button
              type="button"
              class={classes.join(" ")}
              aria-current={step.id === current ? "step" : undefined}
              aria-describedby={described}
              onFocus={(e) =>
                keepInView(e.currentTarget.parentElement as HTMLLIElement)}
              onClick={() => onSelect(step.id)}
            >
              <span class="adapt-stepper-bar" aria-hidden="true">
                <span
                  class="adapt-stepper-fill"
                  style={{ width: `${step.fill}%` }}
                />
              </span>
              {step.label}
            </button>
            <span class="adapt-stepper-detail" id={described}>
              {spoken === null ? step.detail : (
                <>
                  <span aria-hidden="true">{step.detail}</span>
                  <span class="visually-hidden">{spoken}</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
