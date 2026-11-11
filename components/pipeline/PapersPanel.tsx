/**
 * The run details' Papers tab: every paper the run took up, and what became
 * of it, as a table.
 *
 * It was a list of records, and on the run this was drawn for thirty-four
 * of its thirty-eight carried the same two pills: "Extracted by" the
 * fallback model and "Declined by" the same classifier. The run's own notes
 * about its fallback and its unread papers now stand above the table, once,
 * and a row says only who read it. Nothing in the table is a pill.
 *
 * The table's roles are spelled out. Below 600px its rows fold into lines,
 * which changes its `display`, and some engines drop a table's implicit
 * roles when that happens.
 */

import encoding from "../../lib/pipeline_encoding.json" with { type: "json" };
import { Icon } from "../Icon.tsx";
import {
  paperNotes,
  type PaperRow,
  paperRows,
} from "../../lib/pipeline_details.ts";
import {
  describeTruncation,
  field,
  isTruncated,
  paperSourceLabel,
} from "../../lib/pipeline_display.ts";
import type { PipelineRun } from "../../lib/types.ts";
import { WarningNote } from "./Note.tsx";
import { CountCell, Pmid, TableHead } from "./records.tsx";

const PAPERS = encoding.papers;

/**
 * Who read the paper. The fallback names its model for a pointer and for a
 * screen reader; in the column it would be the same word on most rows. A
 * paper nobody read says so with a glyph as well as in words, since it is
 * the row that needs a look.
 */
function ReadBy(
  { row, fallbackModel }: { row: PaperRow; fallbackModel: string },
) {
  if (row.readBy === "unread") {
    return (
      <span class="pipeline-table-flag">
        <Icon name={field("toReview").icon} />
        {PAPERS.unread}
      </span>
    );
  }
  if (row.readBy === "fallback") {
    return <span title={fallbackModel}>{PAPERS.fallback}</span>;
  }
  return <>{PAPERS.primary}</>;
}

function Paper(
  { row, declinedColumn, columns, accepted }: {
    row: PaperRow;
    declinedColumn: boolean;
    columns: number;
    accepted: string;
  },
) {
  const { paper } = row;
  return (
    <>
      <tr role="row">
        <td role="cell" class="is-lead">
          <Pmid pmid={paper.pmid} />
        </td>
        <td role="cell">{paperSourceLabel(paper.source)}</td>
        <td role="cell">
          <ReadBy
            row={row}
            fallbackModel={paper.extractionModel ?? PAPERS.fallback}
          />
        </td>
        {declinedColumn && <td role="cell">{row.declinedBy}</td>}
        <td role="cell" class="is-numeric is-time">{row.time}</td>
        <CountCell value={paper.geneCount} label={accepted} />
        <CountCell
          value={paper.rejectedCount}
          label={field("genesRejected").label}
        />
      </tr>
      {paper.error !== null && (
        <tr role="row" class="pipeline-table-note">
          <td role="cell" colSpan={columns}>
            <span class="pipeline-table-note-label">
              {field("reason").label}
            </span>{" "}
            {paper.error}
          </td>
        </tr>
      )}
    </>
  );
}

export function PapersPanel({ run }: { run: PipelineRun }) {
  const { rows, declinedColumn, written } = paperRows(run);
  const list = run.papersDetail;
  // Accepted means what reached the database, so a run that failed before
  // its merge heads the column with what its findings are: validated.
  const accepted = field(written ? "genesAccepted" : "genesValidated").label;
  const columns = declinedColumn ? 7 : 6;
  const notes = paperNotes(run);
  return (
    <>
      {notes.length > 0 && (
        <div class="pipeline-panel-notes">
          {notes.map((warning, index) => (
            <WarningNote key={index} warning={warning} />
          ))}
        </div>
      )}
      {isTruncated(list.shown, list.total) && (
        <p class="pipeline-truncation">
          {describeTruncation(list.shown, list.total)}
        </p>
      )}
      <table class="pipeline-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <TableHead label={PAPERS.paper} />
            <TableHead label={PAPERS.text} />
            <TableHead label={PAPERS.readBy} />
            {declinedColumn && <TableHead label={field("refusal").label} />}
            <TableHead label={PAPERS.time} numeric />
            <TableHead label={accepted} numeric />
            <TableHead label={field("genesRejected").label} numeric />
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row, index) => (
            <Paper
              key={index}
              row={row}
              declinedColumn={declinedColumn}
              columns={columns}
              accepted={accepted}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}
