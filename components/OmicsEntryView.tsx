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
 * The study type, carrying the entry's colocalization list.
 *
 * A type the glossary names is one hover target with both. A type that only
 * contains acronyms (`Proteogenomic MR`) keeps each of them boxed, and each
 * also lists the colocalized items, so `MR` never loses its own expansion. A
 * type with neither is boxed whole when there is a list to show, plain
 * otherwise.
 */
function StudyType({ entry }: { entry: OmicsEntry }) {
  if (acronymTooltip(entry.type) === null) {
    if (splitAcronyms(entry.type).some((segment) => segment.acronym)) {
      const colocalized = colocalizedItems(entry).join(", ");
      return (
        <AcronymText
          text={entry.type}
          colocalizedIn={colocalized || undefined}
        />
      );
    }
  }
  const tip = studyTypeTooltip(entry);
  return tip
    ? <Tooltip content={tip}>{entry.type}</Tooltip>
    : <AcronymText text={entry.type} />;
}

/**
 * One omics evidence entry as the cell prints it,
 * `TWAS (<biomarker>: artery aorta, YFS: blood)`, with no `*`. An acronym
 * inside a colocalized item says that its tissue colocalized.
 */
export function OmicsEntryView({ value }: { value: string }) {
  if (isAbsent(value)) return <Absent />;

  const entry = parseOmicsEntry(value);
  const items = entry.items.map((item, index) => (
    <span key={index}>
      {index > 0 && ", "}
      <AcronymText text={item.text} colocalizedIn={colocalizedText(item)} />
    </span>
  ));

  return (
    <>
      <StudyType entry={entry} />
      {(entry.biomarker || items.length > 0) && " ("}
      {entry.biomarker && <AcronymText text={entry.biomarker} />}
      {entry.biomarker && items.length > 0 && ": "}
      {items}
      {(entry.biomarker || items.length > 0) && ")"}
    </>
  );
}
