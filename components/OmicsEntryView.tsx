import { parseOmicsEntry } from "../lib/omics.ts";
import { isAbsent } from "../lib/sentinels.ts";
import { studyTypeTooltip } from "../lib/tooltips.ts";
import { Absent } from "./Absent.tsx";
import { AcronymText } from "./AcronymText.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * One omics evidence entry as the cell prints it,
 * `TWAS (<biomarker>: artery aorta, YFS: blood)`, with no `*`.
 *
 * The study type carries the entry's colocalization list, so it is one hover
 * target whenever it has that or a glossary entry to show; otherwise its
 * words are scanned for acronyms like the rest (`Proteogenomic MR`). An
 * acronym inside a colocalized item says that its tissue colocalized.
 */
export function OmicsEntryView({ value }: { value: string }) {
  if (isAbsent(value)) return <Absent />;

  const entry = parseOmicsEntry(value);
  const typeTip = studyTypeTooltip(entry);
  const items = entry.items.map((item, index) => (
    <span key={index}>
      {index > 0 && ", "}
      <AcronymText
        text={item.text}
        colocalizedIn={item.colocalized ? item.text : undefined}
      />
    </span>
  ));

  return (
    <>
      {typeTip
        ? <Tooltip content={typeTip}>{entry.type}</Tooltip>
        : <AcronymText text={entry.type} />}
      {(entry.biomarker || items.length > 0) && " ("}
      {entry.biomarker && <AcronymText text={entry.biomarker} />}
      {entry.biomarker && items.length > 0 && ": "}
      {items}
      {(entry.biomarker || items.length > 0) && ")"}
    </>
  );
}
