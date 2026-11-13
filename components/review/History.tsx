import { ANSWER_LABELS, FIELD_LABELS } from "../../lib/review/display.ts";
import type {
  Account,
  Answer,
  Edit,
  ReviewEvent,
} from "../../lib/review/events.ts";
import { PIPELINE_ACTOR } from "../../lib/review/events.ts";
import type { GeneReview } from "../../lib/review/rules.ts";
import { simulatedTime } from "../../lib/review/time.ts";
import { Moved } from "./GeneDiff.tsx";

/** A first answer, as the history says it. */
const ANSWER_VERBS: Record<Answer, string> = {
  accept: "accepted",
  accept_with_edits: "accepted with edits",
  reject: "rejected",
  abstain: "abstained",
};

/** The values one side of an edit holds and the other does not. */
const without = (a: Edit["before"], b: Edit["before"]): string[] =>
  Array.isArray(a) && Array.isArray(b) ? a.filter((v) => !b.includes(v)) : [];

/**
 * What an event did, in words. An answer by a voter who answered this gene
 * before (`older` holds the events after it in the newest-first history) is
 * a change of mind and names both answers; a repeat of the same answer, made
 * again against a new version, reads as the plain answer.
 */
function happened(event: ReviewEvent, older: readonly ReviewEvent[]): string {
  if (event.type === "proposal") return "proposed the change";
  if (event.type === "ruling") return `ruled: ${event.outcome}`;
  const previous = older.find((e) =>
    e.type === "answer" && e.actor === event.actor
  );
  if (
    previous?.type === "answer" && previous.answer !== event.answer
  ) {
    return `changed answer: ${ANSWER_LABELS[previous.answer]} to ${
      ANSWER_LABELS[event.answer]
    }`;
  }
  return ANSWER_VERBS[event.answer];
}

/** Each field an edit changes, with what it strikes and what it adds. */
function Edits({ edits }: { edits: readonly Edit[] }) {
  return (
    <ul class="review-edits">
      {edits.map((edit) => (
        <li key={edit.field}>
          <span class="review-edit-field">{FIELD_LABELS[edit.field]}:</span>
          <Moved
            field={edit.field}
            before={edit.before}
            after={edit.after}
            added={without(edit.after, edit.before)}
            removed={without(edit.before, edit.after)}
            keep={false}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything that happened to the gene, newest first, stale events
 * included: an answer made against an earlier version of the change no
 * longer counts, and says so, but it stays where it happened, since the log
 * is the record and nothing in it is rewritten.
 */
export function History(
  { review, accounts, runTimestamp }: {
    review: GeneReview;
    accounts: readonly Account[];
    runTimestamp: string;
  },
) {
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return (
    <section class="card">
      <div class="card-body">
        <h2 class="card-title">History</h2>
        <ol class="review-history">
          {review.history.map((event, i) => {
            const stale = event.version !== review.version;
            return (
              <li
                key={event.id}
                class={stale
                  ? "review-event review-event-stale"
                  : "review-event"}
              >
                <p class="review-event-head">
                  {/* Not a `<time>`: a simulated time is never a date. */}
                  <span class="review-history-time">
                    {simulatedTime(event.at, runTimestamp)}
                  </span>{" "}
                  <b>
                    {event.actor === PIPELINE_ACTOR
                      ? "Pipeline run"
                      : names.get(event.actor) ?? event.actor}
                  </b>{" "}
                  {happened(event, review.history.slice(i + 1))}
                  {stale && (
                    <>
                      {" "}
                      <span class="review-badge review-superseded">
                        superseded
                      </span>
                    </>
                  )}
                </p>
                {event.type !== "proposal" && event.edits.length > 0 && (
                  <Edits edits={event.edits} />
                )}
                {event.type !== "proposal" && event.reason && (
                  <p class="review-reason">{event.reason}</p>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
