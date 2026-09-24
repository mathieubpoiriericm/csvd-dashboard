import { createContext } from "preact";
import { useContext } from "preact/hooks";

import type { Answers } from "../../lib/adapt/answers.ts";
import type { CardState } from "../../lib/adapt/cards.ts";
import type { Progress } from "../../lib/adapt/feedback.ts";
import type { Issue, StepId } from "../../lib/adapt/validate.ts";

/**
 * What the island tells the fields, the notes and the cards about the step
 * on screen. It rides in a context rather than in props so that no step
 * renders a new function prop: tests/adapt/steps_test.tsx hands every
 * function prop a string and expects it to write an answer.
 */
export interface Wizard {
  step: StepId;
  /** The answers, so a list control can tell which of its items offends. */
  answers: Answers;
  /** validate() over every answer. */
  issues: Issue[];
  /** "step:path" keys left after an edit, or revealed. */
  seen: ReadonlySet<string>;
  progress: Progress;
  cards: Record<string, CardState>;
  openCard: string | null;
  toggleCard: (id: string) => void;
  continueCard: (id: string) => void;
  showLeft: () => void;
}

export const WizardContext = createContext<Wizard | null>(null);

export const useWizard = (): Wizard | null => useContext(WizardContext);
