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
