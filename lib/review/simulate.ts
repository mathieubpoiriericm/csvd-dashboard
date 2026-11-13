/**
 * The simulated committee. No real committee exists yet, so the site shows
 * twelve fictional accounts and a generated log of their review activity over a
 * round. The log is a pure function of the round and a seed: the same inputs
 * give the same history, so tests and screenshots are repeatable.
 *
 * Eight scripted cases are planted so every standing and flag shows. The four
 * benign ones go at the start of the round: "edits to reconcile" on the first
 * change that adds a list value, then "accepted", "in review" and "not
 * started" on the first changes still free. The four adverse ones go at the
 * end, counting back from the last change: "rejected" (with a change of
 * mind), "conflict", "resolved by chair", "no quorum". The round is ordered by
 * the gene table, so its first rows are the best-known curated genes and its
 * last the run's new proposals: a simulated rejection or conflict must never
 * read as a verdict on an established gene. A round too small for all eight
 * plants what fits, benign cases first, and never two cases on one change.
 * Every other change is answered at random by the odds below, and for the
 * same reason never ends at conflict, rejected or no quorum: an objection that
 * would tip it there is given as a plain accept instead.
 */

import type { ReviewChange, ReviewRound } from "../types.ts";
import type {
  Account,
  Answer,
  AnswerEvent,
  Edit,
  ReviewEvent,
} from "./events.ts";
import { PIPELINE_ACTOR } from "./events.ts";
import type { Standing } from "./rules.ts";
import { standingOf } from "./rules.ts";

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

/**
 * The chance that voter `k` answers a change that is not planted. The chair
 * answers everything; most members are well along and two lag far behind, so
 * about half the genes of a round are settled and the members are visibly at
 * different stages.
 */
const ANSWER_ODDS = [1, .96, .93, .9, .87, .85, .83, .6, .4, .25, .7];

/** The standings only a planted change may reach. */
const ADVERSE_STANDINGS: readonly Standing[] = [
  "conflict",
  "rejected",
  "no_quorum",
];

/** A scripted case, planted on one change. */
export type Planted =
  | "accepted"
  | "edits_to_reconcile"
  | "in_review"
  | "not_started"
  | "rejected"
  | "conflict"
  | "resolved_by_chair"
  | "no_quorum";

/** Planted at the start, in this order of priority. */
const BENIGN: readonly Planted[] = [
  "edits_to_reconcile",
  "accepted",
  "in_review",
  "not_started",
];

/** Planted at the end, the first of them on the last change. */
const ADVERSE: readonly Planted[] = [
  "rejected",
  "conflict",
  "resolved_by_chair",
  "no_quorum",
];

/**
 * Which change, by index, carries each planted case. "Edits to reconcile"
 * needs a change that adds a list value and is left out when none does.
 */
export function plantings(
  changes: readonly ReviewChange[],
): Map<number, Planted> {
  const planted = new Map<number, Planted>();
  const free = (i: number) => !planted.has(i);
  const adds = (i: number) => changes[i].fields.some((f) => f.added.length);
  const indices = changes.map((_, i) => i);
  for (const kind of BENIGN) {
    const at = indices.find((i) =>
      free(i) && (kind !== "edits_to_reconcile" || adds(i))
    );
    if (at !== undefined) planted.set(at, kind);
  }
  const fromEnd = [...indices].reverse();
  for (const kind of ADVERSE) {
    const at = fromEnd.find(free);
    if (at !== undefined) planted.set(at, kind);
  }
  return planted;
}

/**
 * A reason says why its answer was given, so each kind of answer draws from a
 * list of its own: a rejection never carries a supportive sentence, nor a
 * ruling a voter's disclaimer. A plain accept gives no reason. The lists share
 * no sentence, and none names a disease, gene or trait.
 */
export const REJECT_REASONS: readonly string[] = [
  "The source does not support the claim as written.",
  "The wording overstates what the paper reports.",
  "The effect size is too small to be convincing.",
  "The cited result does not concern this gene directly.",
];

export const ABSTAIN_REASONS: readonly string[] = [
  "The change is outside my area of expertise.",
  "A closer reading of the paper is needed first.",
  "I have a conflict of interest with the cited work.",
];

export const EDIT_REASONS: readonly string[] = [
  "The evidence holds, but one added value goes beyond the source.",
  "Sound overall; the last addition is not in the cited paper.",
  "I accept the change without its weakest addition.",
];

export const RULING_REASONS: readonly string[] = [
  "The cited paper reports this result clearly, which outweighs the objections.",
  "The objections concern wording, not the evidence itself.",
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
  const planted = plantings(round.changes);

  /** A time on `day` after the run's date, between 08:00 and 18:00 UTC. */
  const timeOn = (day: number): string =>
    new Date(
      midnight + day * DAY_MS + (480 + Math.floor(rand() * 601)) * 60_000,
    )
      .toISOString();
  const answerDay = (from: number, to: number): number =>
    from + Math.floor(rand() * (to - from + 1));
  /** One random draw per reason, whichever list it comes from. */
  const pick = (list: readonly string[]): string =>
    list[Math.floor(rand() * list.length)];
  const reasonFor = (answer: Answer): string | null =>
    answer === "accept" ? null : pick(
      answer === "reject"
        ? REJECT_REASONS
        : answer === "abstain"
        ? ABSTAIN_REASONS
        : EDIT_REASONS,
    );

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
        reason: reasonFor(effective),
      });
    };
    const each = (ks: number[], kind: Answer) =>
      ks.forEach((k) => answer(k, kind));
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);

    const kind = planted.get(index);
    if (kind === undefined) {
      const first = events.length;
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
      // Each voter answered at most once, so the answers are the tally. The
      // repair draws no random number: a history that needs none is unchanged.
      const given = events.slice(first) as AnswerEvent[];
      const count = (...kinds: Answer[]) =>
        given.filter((e) => kinds.includes(e.answer)).length;
      const adverse = () =>
        ADVERSE_STANDINGS.includes(standingOf({
          accept: count("accept", "accept_with_edits"),
          reject: count("reject"),
          abstain: count("abstain"),
          outstanding: VOTERS.length - given.length,
        }));
      while (adverse()) {
        const objection = given.findLast((e) => e.answer === "reject") ??
          given.findLast((e) => e.answer === "abstain");
        if (!objection) break;
        objection.answer = "accept";
        objection.edits = [];
        objection.reason = null;
      }
      return;
    }
    switch (kind) {
      case "accepted":
        each(range(0, 10), "accept");
        break;
      case "rejected":
        answer(1, "accept", answerDay(1, 3));
        answer(1, "reject", answerDay(4, 6));
        each([0, ...range(2, 7)], "reject");
        answer(8, "accept");
        each([9, 10], "abstain");
        break;
      case "conflict":
      case "resolved_by_chair":
        each(range(0, 4), "accept");
        each(range(5, 9), "reject");
        answer(10, "abstain");
        if (kind === "resolved_by_chair") {
          events.push({
            ...base,
            id: "",
            at: timeOn(7),
            actor: VOTERS[0].id,
            type: "ruling",
            outcome: "accepted",
            edits: [],
            reason: pick(RULING_REASONS),
          });
        }
        break;
      case "edits_to_reconcile":
        each([0, ...range(3, 10)], "accept");
        answer(1, "accept");
        answer(2, "accept_with_edits");
        break;
      case "no_quorum":
        each(range(0, 10), "abstain");
        break;
      case "in_review":
        each(range(0, 4), "accept");
        answer(5, "reject");
        break;
      default:
        break; // not started
    }
  });

  // Oldest first; the sort is stable, so ties keep the order they were made in.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events.map((e, i) => ({
    ...e,
    id: `e${String(i + 1).padStart(4, "0")}`,
  }));
}
