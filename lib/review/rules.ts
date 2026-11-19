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
import generated from "./standing.bend.mjs";

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

/**
 * The table itself is `standing.bend`, its laws proved in `/PROOF.bend`; these
 * functions run the module Bend generates from it (`deno task bend:build`).
 * The module refuses a count that is not a whole number from 0 up: it throws
 * rather than answer. `standingOf` passes the four counts, so each is refused
 * unless it is a whole number from 0 up; `settlesAt` passes only the sum of
 * accept, reject and outstanding, so only that sum is checked. The refusal is a
 * thrown string, not an `Error`, which is why the test uses try/catch and not
 * `assertThrows`.
 */
const bend = generated as unknown as {
  standing_of(
    acc: number,
    rej: number,
    abs: number,
    out: number,
  ): { $: string };
  needed(of: number): number;
};

const STANDINGS: Record<string, Standing> = {
  NotStarted: "not_started",
  InReview: "in_review",
  Conflict: "conflict",
  Accepted: "accepted",
  Rejected: "rejected",
  NoQuorum: "no_quorum",
};

/**
 * The spec's table, first match wins; two thirds settles a gene. The test "the
 * standing table's laws hold for every tally of up to 24 members" checks it
 * over every tally.
 */
export function standingOf(tally: Tally): Standing {
  const { accept, reject, abstain, outstanding } = tally;
  return STANDINGS[bend.standing_of(accept, reject, abstain, outstanding).$];
}

/** Two thirds of those not abstaining: `needed` votes of `of`. */
export function settlesAt(tally: Tally): { needed: number; of: number } {
  const of = tally.accept + tally.reject + tally.outstanding;
  return { needed: bend.needed(of), of };
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
