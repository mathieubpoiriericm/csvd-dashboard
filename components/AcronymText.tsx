import { acronymTooltip, splitAcronyms } from "../lib/acronyms.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Free text with every glossary acronym boxed and explained, and the words
 * around them plain. `colocalizedIn` names the tissue the text belongs to when
 * that tissue colocalized significantly, so each acronym in it says so too.
 */
export function AcronymText(
  { text, colocalizedIn }: { text: string; colocalizedIn?: string },
) {
  return (
    <>
      {splitAcronyms(text).map((segment, index) =>
        segment.acronym
          ? (
            <Tooltip
              key={index}
              content={acronymTooltip(segment.text, colocalizedIn)}
            >
              {segment.text}
            </Tooltip>
          )
          : segment.text
      )}
    </>
  );
}
