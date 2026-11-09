import { acronymTooltip, splitAcronyms } from "../lib/acronyms.ts";
import {
  colocalizedItems,
  colocalizedText,
  type OmicsEntry,
  parseOmicsEntry,
} from "../lib/omics.ts";
import { isAbsent } from "../lib/sentinels.ts";
import { studyTypeTooltip } from "../lib/tooltips.ts";
import { Absent } from "./Absent.tsx";
import { AcronymText } from "./AcronymText.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The study type, carrying the entry's colocalization list, and `suffix` --
 * the separator after the entry -- held to it when nothing follows inside
 * the entry.
 *
 * A type the glossary names is one hover target with both. A type that only
 * contains acronyms (`Proteogenomic MR`) keeps each of them boxed, and each
 * also lists the colocalized items, so `MR` never loses its own expansion. A
 * type with neither is boxed whole when there is a list to show, plain
 * otherwise.
 */
function StudyType({ entry, suffix }: { entry: OmicsEntry; suffix: string }) {
  const tip = acronymTooltip(entry.type) === null &&
      splitAcronyms(entry.type).some((segment) => segment.acronym)
    ? null
    : studyTypeTooltip(entry);
  if (!tip) {
    const colocalized = colocalizedItems(entry).join(", ");
    return (
      <AcronymText
        text={entry.type + suffix}
        colocalizedIn={colocalized || undefined}
      />
    );
  }
  const chip = <Tooltip content={tip}>{entry.type}</Tooltip>;
  return (
    <span class="acronym-text">
      {suffix
        ? (
          <span class="acronym-glue">
            {chip}
            {suffix}
          </span>
        )
        : chip}
    </span>
  );
}

/**
 * One omics evidence entry as the cell prints it,
 * `TWAS (<biomarker>: artery aorta, YFS: blood)`, with no `*`. An acronym
 * inside a colocalized item says that its tissue colocalized.
 *
 * Every piece of punctuation goes into the text of the piece it follows or
 * opens (`"(WMH:"`, `"brain,"`, `"RNA-Seq),"`), so `AcronymText` can hold
 * it to an acronym beside it; `suffix` is the list separator after the
 * whole entry, for the same reason.
 */
export function OmicsEntryView(
  { value, suffix = "" }: { value: string; suffix?: string },
) {
  if (isAbsent(value)) {
    return (
      <>
        <Absent />
        {suffix}
      </>
    );
  }

  const entry = parseOmicsEntry(value);
  if (!entry.biomarker && entry.items.length === 0) {
    return <StudyType entry={entry} suffix={suffix} />;
  }
  const close = `)${suffix}`;
  const last = entry.items.length - 1;
  return (
    <>
      <StudyType entry={entry} suffix="" />{" "}
      {entry.biomarker && (
        <AcronymText text={`(${entry.biomarker}${last < 0 ? close : ":"}`} />
      )}
      {entry.items.map((item, index) => (
        <span key={index}>
          {(index > 0 || entry.biomarker) && " "}
          <AcronymText
            text={(index === 0 && !entry.biomarker ? "(" : "") + item.text +
              (index === last ? close : ",")}
            colocalizedIn={colocalizedText(item)}
          />
        </span>
      ))}
    </>
  );
}
