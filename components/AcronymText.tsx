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

/** What belongs to the chip before it: closing punctuation, or `-based`. */
const TRAILING = /^(?:[,;:.)]+|-[A-Za-z]+[,;:.)]*)/;
/** What belongs to the chip after it. */
const OPENING = "(";

/** A segment, or the `?` that stands for a clarification mark. */
interface Piece extends Segment {
  mark?: true;
}

/** `text` cut into acronyms, `?` marks and the plain text between them. */
function piecesOf(text: string): Piece[] {
  return text.split(CLARIFICATION_MARK).flatMap((part, p): Piece[] => [
    ...(p > 0 ? [{ text: "?", acronym: true, mark: true } as const] : []),
    ...splitAcronyms(part),
  ]);
}

/**
 * Free text with every glossary acronym boxed and explained, and the words
 * around them plain. `colocalizedIn` names the tissue the text belongs to when
 * that tissue colocalized significantly, so each acronym in it says so too.
 * A `[?]` prints as a boxed `?` that says the term before it awaits
 * clarification.
 *
 * The punctuation around a chip stays on its line (`.acronym-glue`) -- an
 * opening parenthesis before it, a comma, colon, closing parenthesis or
 * `-word` after it -- so a wrapped cell never starts a line with "," or ends
 * one with "(". Callers put a list's separators inside the text for the same
 * reason (`"WMH,"`, then a space).
 *
 * Each plain segment is a keyed Fragment, not a bare string: under
 * `jsx: "precompile"` a string in a mixed array is escaped as it is built and
 * again by the renderer, so `a & b` reached the server-rendered page as
 * `a &amp;amp; b` until the island hydrated.
 */
export function AcronymText(
  { text, colocalizedIn }: { text: string; colocalizedIn?: string },
) {
  const pieces = piecesOf(text);
  const out: ComponentChildren[] = [];
  let taken = 0; // characters of this plain piece the chip before it took
  let opening = ""; // the "(" the chip after this plain piece will take
  pieces.forEach((piece, index) => {
    const next = pieces[index + 1];
    if (!piece.acronym) {
      let plain = piece.text.slice(taken);
      taken = 0;
      if (next && plain.endsWith(OPENING)) {
        opening = OPENING;
        plain = plain.slice(0, -OPENING.length);
      }
      if (plain) out.push(<Fragment key={index}>{plain}</Fragment>);
      return;
    }
    const trailing = next && !next.acronym
      ? TRAILING.exec(next.text)?.[0] ?? ""
      : "";
    taken = trailing.length;
    const chip = piece.mark
      ? (
        <Tooltip content={clarificationTooltip()} label="Needs clarification">
          ?
        </Tooltip>
      )
      : (
        <Tooltip content={acronymTooltip(piece.text, colocalizedIn)}>
          {piece.text}
        </Tooltip>
      );
    out.push(
      opening || trailing
        ? (
          <span key={index} class="acronym-glue">
            {opening}
            {chip}
            {trailing}
          </span>
        )
        : <Fragment key={index}>{chip}</Fragment>,
    );
    opening = "";
  });
  return <span class="acronym-text">{out}</span>;
}
