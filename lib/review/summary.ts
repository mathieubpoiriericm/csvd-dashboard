/**
 * The summary behind every KPI of the review pages: one pass over the round's
 * genes and the event log, with nothing stored.
 */

import type { ReviewKind, ReviewRound } from "../types.ts";
import type { Account, ReviewEvent } from "./events.ts";
import { votes } from "./events.ts";
import { reviewGene } from "./rules.ts";
import type { GeneReview, Standing } from "./rules.ts";

export interface MemberProgress {
  account: Account;
  answered: number;
  owed: number;
  accept: number;
  withEdits: number;
  reject: number;
  abstain: number;
  /** The `at` of their newest event. */
  lastActive: string | null;
}

export interface ReviewSummary {
  total: number;
  settled: number;
  accepted: number;
  rejected: number;
  conflict: number;
  inReview: number;
  notStarted: number;
  noQuorum: number;
  editsToReconcile: number;
  resolvedByChair: number;
  answersIn: number;
  /** Owed is voters times total. */
  answersOwed: number;
  byKind: Record<ReviewKind, Record<Standing, number>>;
  /** In the accounts' order; an observer owes 0. */
  members: MemberProgress[];
}

export interface ReviewState {
  round: ReviewRound;
  accounts: readonly Account[];
  events: readonly ReviewEvent[];
  /** In the round's change order. */
  reviews: GeneReview[];
  summary: ReviewSummary;
}

const STANDINGS: Standing[] = [
  "not_started",
  "in_review",
  "conflict",
  "accepted",
  "rejected",
  "no_quorum",
];

const emptyRow = (): Record<Standing, number> =>
  Object.fromEntries(STANDINGS.map((s) => [s, 0])) as Record<Standing, number>;

function memberProgress(
  account: Account,
  total: number,
  reviews: readonly GeneReview[],
  events: readonly ReviewEvent[],
): MemberProgress {
  const progress: MemberProgress = {
    account,
    answered: 0,
    owed: votes(account) ? total : 0,
    accept: 0,
    withEdits: 0,
    reject: 0,
    abstain: 0,
    lastActive: null,
  };
  for (const review of reviews) {
    const current = review.answers.get(account.id);
    if (!current) continue;
    progress.answered++;
    if (current.answer === "accept") progress.accept++;
    else if (current.answer === "accept_with_edits") progress.withEdits++;
    else if (current.answer === "reject") progress.reject++;
    else progress.abstain++;
  }
  let newest = -Infinity;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.actor === account.id && at > newest) {
      newest = at;
      progress.lastActive = event.at;
    }
  }
  return progress;
}

/**
 * The state of one round. Answers belong to the round they were given in: a
 * log that outlives a round holds the same gene and version in the next, so
 * the events are filtered to this round before anything counts them, and
 * `reviewGene`, which matches on gene and version, only ever sees this
 * round's.
 */
export function reviewState(
  round: ReviewRound,
  accounts: readonly Account[],
  log: readonly ReviewEvent[],
): ReviewState {
  const events = log.filter((e) => e.roundId === round.id);
  const reviews = round.changes.map((c) => reviewGene(c, accounts, events));
  const total = reviews.length;
  const count = (standing: Standing) =>
    reviews.filter((r) => r.standing === standing).length;
  const byKind = {
    new: emptyRow(),
    claims: emptyRow(),
    citation_protein: emptyRow(),
    citation: emptyRow(),
  };
  round.changes.forEach((c, i) => byKind[c.kind][reviews[i].standing]++);

  const members = accounts.map((a) =>
    memberProgress(a, total, reviews, events)
  );
  const accepted = count("accepted");
  const rejected = count("rejected");
  return {
    round,
    accounts,
    events,
    reviews,
    summary: {
      total,
      settled: accepted + rejected,
      accepted,
      rejected,
      conflict: count("conflict"),
      inReview: count("in_review"),
      notStarted: count("not_started"),
      noQuorum: count("no_quorum"),
      editsToReconcile: reviews.filter((r) => r.editsToReconcile).length,
      resolvedByChair: reviews.filter((r) => r.resolvedByChair).length,
      answersIn: members.reduce((n, m) => n + m.answered, 0),
      answersOwed: members.reduce((n, m) => n + m.owed, 0),
      byKind,
      members,
    },
  };
}
