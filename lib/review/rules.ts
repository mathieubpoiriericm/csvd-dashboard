/**
 * The committee's rules: how answers on one gene become a tally and a
 * standing. Pure functions of their arguments; the accounts and the event log
 * arrive as data, so nothing here reads the dataset.
 */

import type { ReviewChange } from "../types.ts";
import type {
  Account,
  AnswerEvent,
  Edit,
  ReviewEvent,
  RulingEvent,
} from "./events.ts";
import { votes } from "./events.ts";

export type Standing =
  | "not_started"
  | "in_review"
  | "conflict"
  | "accepted"
  | "rejected"
  | "no_quorum";

export interface Tally {
  accept: number;
  reject: number;
  abstain: number;
  outstanding: number;
}

/** The spec's table, first match wins; two thirds settles a gene. */
export function standingOf(tally: Tally): Standing {
  const { accept: acc, reject: rej, abstain: abs, outstanding: out } = tally;
  if (acc + rej + abs === 0) return "not_started";
  if (acc > 0 && acc >= 2 * (rej + out)) return "accepted";
  if (rej > 0 && rej >= 2 * (acc + out)) return "rejected";
  if (out === 0 && acc + rej === 0) return "no_quorum";
  if (acc + out < 2 * rej && rej + out < 2 * acc) return "conflict";
  return "in_review";
}

/** Two thirds of those not abstaining: `needed` votes of `of`. */
export function settlesAt(tally: Tally): { needed: number; of: number } {
  const of = tally.accept + tally.reject + tally.outstanding;
  return { needed: Math.ceil(2 * of / 3), of };
}

export interface GeneReview {
  gene: string;
  version: string;
  tally: Tally;
  /** From the answers alone. */
  voted: Standing;
  /** The ruling's outcome when there is one, else `voted`. */
  standing: Standing;
  editsToReconcile: boolean;
  resolvedByChair: boolean;
  ruling: RulingEvent | null;
  /** Voter id to current answer. */
  answers: ReadonlyMap<string, AnswerEvent>;
  /** This gene's events, newest first, stale ones included. */
  history: ReviewEvent[];
}

/** Edit lists are equal as values, whatever order the edits were listed in. */
function editsKey(edits: readonly Edit[]): string {
  return JSON.stringify(
    edits
      .map((e) => [e.field, e.before, e.after])
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
  );
}

export function reviewGene(
  change: ReviewChange,
  accounts: readonly Account[],
  events: readonly ReviewEvent[],
): GeneReview {
  // Oldest first, ties by position (Array.sort is stable).
  const ordered = events
    .filter((e) => e.gene === change.gene)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const history = [...ordered].reverse();

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const answers = new Map<string, AnswerEvent>();
  let ruling: RulingEvent | null = null;
  for (const event of ordered) {
    if (event.version !== change.version) continue;
    const account = byId.get(event.actor);
    if (event.type === "answer" && account && votes(account)) {
      answers.set(account.id, event);
    } else if (event.type === "ruling" && account?.role === "chair") {
      ruling = event;
    }
  }

  const tally: Tally = { accept: 0, reject: 0, abstain: 0, outstanding: 0 };
  const accepted: AnswerEvent[] = [];
  for (const voter of accounts.filter(votes)) {
    const current = answers.get(voter.id);
    if (!current) tally.outstanding++;
    else if (current.answer === "reject") tally.reject++;
    else if (current.answer === "abstain") tally.abstain++;
    else {
      tally.accept++;
      accepted.push(current);
    }
  }

  const voted = standingOf(tally);
  const keys = new Set(
    accepted.map((a) => editsKey(a.answer === "accept" ? [] : a.edits)),
  );
  return {
    gene: change.gene,
    version: change.version,
    tally,
    voted,
    standing: ruling ? ruling.outcome : voted,
    editsToReconcile: voted === "accepted" && ruling === null && keys.size > 1,
    resolvedByChair: ruling !== null,
    ruling,
    answers,
    history,
  };
}
