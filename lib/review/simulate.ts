/**
 * The simulated committee. No real committee exists yet, so the site shows
 * twelve fictional accounts and a generated log of their review activity over a
 * round. The log is a pure function of the round and a seed: the same inputs
 * give the same history, so tests and screenshots are repeatable.
 */

import type { ReviewChange, ReviewRound } from "../types.ts";
import type { Account, Answer, Edit, ReviewEvent } from "./events.ts";
import { PIPELINE_ACTOR } from "./events.ts";

export const SEED = 20261112;

const NAMES = "ABCDEFGHIJKL";

/** `r01` the chair, `r02`…`r11` members, `r12` the observer. */
export const ACCOUNTS: readonly Account[] = Array.from(
  { length: 12 },
  (_, i) => ({
    id: `r${String(i + 1).padStart(2, "0")}`,
    name: `Reviewer ${NAMES[i]}`,
    role: i === 0 ? "chair" : i === 11 ? "observer" : "member",
  }),
);

/** The eleven who vote, chair first. */
const VOTERS = ACCOUNTS.slice(0, 11);

/** The chance that voter `k` answers a change that is not planted. */
const ANSWER_ODDS = [1, .95, .9, .8, .7, .65, .55, .45, .3, .15, .6];

const REASONS = [
  "The evidence is consistent with the cited source.",
  "The source does not support the claim as written.",
  "The wording overstates what the paper reports.",
  "A closer reading of the paper is needed first.",
  "The cited paper reports this result clearly.",
  "The change is outside my area of expertise.",
  "The effect size is too small to be convincing.",
  "The evidence fits what the field already holds.",
];

const DAY_MS = 86_400_000;

/** Small seeded generator: every random number of a history comes from one. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The one-edit list that removes the last value of the first field with something
 * added, or an empty list when the change has no such field.
 */
function editFor(change: ReviewChange): Edit[] {
  const field = change.fields.find((f) => f.added.length > 0);
  if (!field) return [];
  const last = field.added[field.added.length - 1];
  const after = field.after as string[];
  const idx = after.lastIndexOf(last);
  return [{
    field: field.field,
    before: after,
    after: after.filter((_, i) => i !== idx),
  }];
}

export function simulate(
  round: ReviewRound,
  seed: number = SEED,
): ReviewEvent[] {
  const rand = mulberry32(seed);
  const run = Date.parse(round.runTimestamp);
  const midnight = run - (((run % DAY_MS) + DAY_MS) % DAY_MS);
  const events: ReviewEvent[] = [];

  /** A time on `day` after the run's date, between 08:00 and 18:00 UTC. */
  const timeOn = (day: number): string =>
    new Date(
      midnight + day * DAY_MS + (480 + Math.floor(rand() * 601)) * 60_000,
    )
      .toISOString();
  const answerDay = (from: number, to: number): number =>
    from + Math.floor(rand() * (to - from + 1));
  const reason = (): string => REASONS[Math.floor(rand() * REASONS.length)];

  round.changes.forEach((change, index) => {
    const base = {
      roundId: round.id,
      gene: change.gene,
      version: change.version,
    };
    events.push({
      ...base,
      id: "",
      at: round.runTimestamp,
      actor: PIPELINE_ACTOR,
      type: "proposal",
    });

    const answer = (
      k: number,
      kind: Answer,
      day = answerDay(1, 6),
    ): void => {
      // An edit needs something to remove; without it the voter just accepts.
      const edits = kind === "accept_with_edits" ? editFor(change) : [];
      const effective: Answer = kind === "accept_with_edits" && !edits.length
        ? "accept"
        : kind;
      events.push({
        ...base,
        id: "",
        at: timeOn(day),
        actor: VOTERS[k].id,
        type: "answer",
        answer: effective,
        edits,
        reason: effective === "accept" ? null : reason(),
      });
    };
    const each = (ks: number[], kind: Answer) =>
      ks.forEach((k) => answer(k, kind));
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);

    if (index > 7) {
      VOTERS.forEach((_, k) => {
        if (rand() >= ANSWER_ODDS[k]) return;
        const u = rand();
        answer(
          k,
          u < .82
            ? "accept"
            : u < .87
            ? "accept_with_edits"
            : u < .95
            ? "reject"
            : "abstain",
        );
      });
      return;
    }
    switch (index) {
      case 0:
        each(range(0, 10), "accept");
        break;
      case 1:
        answer(1, "accept", answerDay(1, 3));
        answer(1, "reject", answerDay(4, 6));
        each([0, ...range(2, 7)], "reject");
        answer(8, "accept");
        each([9, 10], "abstain");
        break;
      case 2:
      case 3:
        each(range(0, 4), "accept");
        each(range(5, 9), "reject");
        answer(10, "abstain");
        if (index === 3) {
          events.push({
            ...base,
            id: "",
            at: timeOn(7),
            actor: VOTERS[0].id,
            type: "ruling",
            outcome: "accepted",
            edits: [],
            reason: reason(),
          });
        }
        break;
      case 4:
        each([0, ...range(3, 10)], "accept");
        answer(1, "accept");
        answer(2, "accept_with_edits");
        break;
      case 5:
        each(range(0, 10), "abstain");
        break;
      case 6:
        each(range(0, 4), "accept");
        answer(5, "reject");
        break;
      default:
        break; // 7: not started
    }
  });

  // Oldest first; the sort is stable, so ties keep the order they were made in.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events.map((e, i) => ({
    ...e,
    id: `e${String(i + 1).padStart(4, "0")}`,
  }));
}
