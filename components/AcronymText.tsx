import { Fragment } from "preact";
import type { ComponentChildren } from "preact";

import {
  acronymTooltip,
  CLARIFICATION_MARK,
  clarificationTooltip,
  type Segment,
  splitAcronyms,
} from "../lib/acronyms.ts";
import { Tooltip } from "./Tooltip.tsx";

/** Punctuation that belongs to the word before it, never to a new line. */
const TRAILING = /^[,;:.)]+/;

/**
 * One run of text between clarification marks: each acronym boxed, and the
 * punctuation straight after it kept on its line (`.acronym-glue`), so a list
 * of acronyms never wraps a comma onto a line of its own.
 */
function Segments(
  { segments, colocalizedIn }: {
    segments: Segment[];
    colocalizedIn?: string;
  },
) {
  const out: ComponentChildren[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment.acronym) {
      out.push(<Fragment key={index}>{segment.text}</Fragment>);
      continue;
    }
    const chip = (
      <Tooltip content={acronymTooltip(segment.text, colocalizedIn)}>
        {segment.text}
      </Tooltip>
    );
    const next = segments[index + 1];
    const glued = next && !next.acronym ? TRAILING.exec(next.text)?.[0] : null;
    if (!glued) {
      out.push(<Fragment key={index}>{chip}</Fragment>);
      continue;
    }
    out.push(
      <span key={index} class="acronym-glue">{chip}{glued}</span>,
    );
    segments[index + 1] = {
      text: next.text.slice(glued.length),
      acronym: false,
    };
  }
  return <>{out}</>;
}

/**
 * Free text with every glossary acronym boxed and explained, and the words
 * around them plain. `colocalizedIn` names the tissue the text belongs to when
 * that tissue colocalized significantly, so each acronym in it says so too.
 * A `[?]` prints as a boxed `?` that says the term before it awaits
 * clarification.
 *
 * Each plain segment is a keyed Fragment, not a bare string: under
 * `jsx: "precompile"` a string in a mixed array is escaped as it is built and
 * again by the renderer, so `a & b` reached the server-rendered page as
 * `a &amp;amp; b` until the island hydrated.
 */
export function AcronymText(
  { text, colocalizedIn }: { text: string; colocalizedIn?: string },
) {
  return (
    <span class="acronym-text">
      {text.split(CLARIFICATION_MARK).map((part, p) => (
        <span key={p}>
          {p > 0 && (
            <Tooltip
              content={clarificationTooltip()}
              label="Needs clarification"
            >
              ?
            </Tooltip>
          )}
          <Segments
            segments={splitAcronyms(part)}
            colocalizedIn={colocalizedIn}
          />
        </span>
      ))}
    </span>
  );
}
