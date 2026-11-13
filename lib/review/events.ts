/**
 * The shape of a review event. The committee's state is an append-only log of
 * these: nothing is edited in place, so the history of a gene is the log
 * filtered to it, and a standing is always derived, never stored.
 */

import type { Gene, ReviewFieldValue } from "../types.ts";

/** An observer reads; a member answers; a chair answers and may also rule. */
export type Role = "member" | "chair" | "observer";

export interface Account {
  id: string;
  name: string;
  role: Role;
}

export type Answer = "accept" | "accept_with_edits" | "reject" | "abstain";
export type Outcome = "accepted" | "rejected";

/** One field a voter would change before accepting. */
export interface Edit {
  field: keyof Gene;
  before: ReviewFieldValue;
  after: ReviewFieldValue;
}

interface EventBase {
  id: string;
  at: string;
  roundId: string;
  gene: string;
  /** The change version the event was made against; a mismatch is stale. */
  version: string;
  actor: string;
}

export type ProposalEvent = EventBase & { type: "proposal" };
export type AnswerEvent = EventBase & {
  type: "answer";
  answer: Answer;
  edits: Edit[];
  reason: string | null;
};
export type RulingEvent = EventBase & {
  type: "ruling";
  outcome: Outcome;
  edits: Edit[];
  reason: string;
};
export type ReviewEvent = ProposalEvent | AnswerEvent | RulingEvent;

/** The actor of events the pipeline writes. */
export const PIPELINE_ACTOR = "pipeline";

/** Whether the account's answers count toward a tally. */
export const votes = (account: Account): boolean => account.role !== "observer";
