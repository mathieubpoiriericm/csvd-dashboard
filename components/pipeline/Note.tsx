/**
 * A note in the run widget: something a step, or the run, has to say.
 *
 * A rail and a wash, a member of the note family beside `.tip-box` and
 * `.notice`, and not a framed surface. It used to be one: a box with four
 * registration marks, inside the opened step's box with four more, inside
 * the card's -- three nested frames round a sentence.
 *
 * The tint says whether it needs a look. `ember` is for what does, `danger`
 * for a failure, and `muted` for the routine: the fallback model serving a
 * paper or a finding under a floor is the run working as designed, and in
 * amber it read as trouble on every card.
 *
 * The tint is never the only thing saying so. A note that needs a look, and
 * a failure, carries `mark`: a glyph before its title, and the same words
 * for a screen reader, which is told nothing by a rail's colour.
 */

import type { ComponentChildren } from "preact";

import { Icon, type IconName } from "../Icon.tsx";
import { field, formatCount } from "../../lib/pipeline_display.ts";
import {
  isPmid,
  isReview,
  SHOW_ALL,
  splitSubjects,
} from "../../lib/pipeline_ledger.ts";
import type { RunWarning } from "../../lib/types.ts";

export type NoteTint = "ember" | "muted" | "danger";

export function Note(
  { tint, mark, title, children }: {
    tint: NoteTint;
    mark?: { icon: IconName; label: string };
    title: ComponentChildren;
    children?: ComponentChildren;
  },
) {
  return (
    <div class={`pipeline-note pipeline-tint-${tint}`}>
      <strong class="pipeline-note-title">
        {mark && <Icon name={mark.icon} />}
        <span>
          {mark && <span class="visually-hidden">{mark.label}:</span>}
          {title}
        </span>
      </strong>
      {children}
    </div>
  );
}

/**
 * A warning's subject, after the comma that separates it from the one
 * before: a paper is a link to it, anything else its name.
 */
function Subject({ subject, first }: { subject: string; first: boolean }) {
  return (
    <>
      {!first && ", "}
      {isPmid(subject)
        ? (
          <a
            class="pipeline-pmid"
            href={`https://pubmed.ncbi.nlm.nih.gov/${subject}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {subject}
          </a>
        )
        : subject}
    </>
  );
}

function SubjectList({ subjects }: { subjects: string[] }) {
  return (
    <>
      {subjects.map((subject, index) => (
        <Subject key={index} subject={subject} first={index === 0} />
      ))}
    </>
  );
}

/**
 * What a warning names. The first few are in the note; the rest wait
 * behind a native disclosure, in the page, rather than becoming "and 26
 * more" -- a count of things the reader was then given no way to see.
 */
function Subjects({ subjects }: { subjects: string[] }) {
  if (subjects.length === 0) return null;
  const { shown, rest } = splitSubjects(subjects);
  return (
    <div class="pipeline-note-subjects">
      <SubjectList subjects={shown} />
      {rest.length > 0 && (
        <details class="pipeline-note-more">
          <summary>{SHOW_ALL} {formatCount(subjects.length)}</summary>
          <SubjectList subjects={rest} />
        </details>
      )}
    </div>
  );
}

/**
 * One of the run's warnings, as a note: its sentence, what explains it, and
 * what it names. It reads the same on a step's row of the card and at the
 * head of the Papers tab, which repeats the two warnings that are about
 * papers.
 */
export function WarningNote({ warning }: { warning: RunWarning }) {
  const review = isReview(warning.kind);
  return (
    <Note
      tint={review ? "ember" : "muted"}
      mark={review ? field("toReview") : undefined}
      title={warning.title}
    >
      {warning.detail && <p class="pipeline-note-detail">{warning.detail}</p>}
      <Subjects subjects={warning.subjects} />
    </Note>
  );
}
