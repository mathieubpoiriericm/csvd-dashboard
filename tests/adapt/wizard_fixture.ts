import type { Answers } from "../../lib/adapt/answers.ts";
import { cardStates } from "../../lib/adapt/cards.ts";
import { progressOf, stepRequired } from "../../lib/adapt/feedback.ts";
import { type StepId, validate } from "../../lib/adapt/validate.ts";
import type { Wizard } from "../../components/adapt/wizard_context.ts";

const noop = () => {};

/** The context the island provides, for one step, with inert callbacks. */
export function wizardFor(
  answers: Answers,
  step: StepId,
  options: { seen?: ReadonlySet<string>; openCard?: string | null } = {},
): Wizard {
  const issues = validate(answers);
  const required = stepRequired(answers, step);
  return {
    step,
    answers,
    issues,
    seen: options.seen ?? new Set(),
    progress: progressOf(issues, step, required),
    cards: cardStates(answers, issues, step, required),
    openCard: options.openCard ?? null,
    toggleCard: noop,
    continueCard: noop,
    showLeft: noop,
  };
}
