import { Fragment } from "preact";

import {
  acronymTooltip,
  CLARIFICATION_MARK,
  clarificationTooltip,
  splitAcronyms,
} from "../lib/acronyms.ts";
import { Tooltip } from "./Tooltip.tsx";

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
    <>
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
          {splitAcronyms(part).map((segment, index) =>
            segment.acronym
              ? (
                <Tooltip
                  key={index}
                  content={acronymTooltip(segment.text, colocalizedIn)}
                >
                  {segment.text}
                </Tooltip>
              )
              : <Fragment key={index}>{segment.text}</Fragment>
          )}
        </span>
      ))}
    </>
  );
}
