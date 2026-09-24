import type { Answers } from "../../../lib/adapt/answers.ts";
import type { Issue } from "../../../lib/adapt/validate.ts";
import type { Fetch } from "../../../lib/adapt/lookups.ts";

export interface StepProps {
  answers: Answers;
  /** Replace one step's slice; the island re-validates and re-saves. */
  update: (change: (draft: Answers) => void) => void;
  issues: Issue[];
  /** The fetch to look things up with; the island passes globalThis.fetch. */
  fetch: Fetch;
  /** Set a status line under the step while a lookup runs or after it fails. */
  setStatus: (text: string) => void;
  /** Whether a lookup is running; every lookup button is disabled while one is. */
  busy: boolean;
  /** Run a lookup unless one already is, holding `busy` until it settles. */
  lookup: (task: () => Promise<void>) => void;
}
