/**
 * The services a run called, as a table: a name, the request, how many
 * calls it took, and what they cost in time and data.
 *
 * One component, used by the run details' Services tab and by each refresh
 * of the Reference Data Refreshes block, so a service reads identically in
 * both places. The `.pipeline-api` row lives in this file alone.
 *
 * It was a list of flex rows with a name column 11rem wide, and a host name
 * longer than that pushed its request out of line with every other row's.
 * A table's columns cannot do that. Each row also carried the same
 * two-arrows glyph, which told thirteen services apart from nothing.
 *
 * A trouble column -- retries, not found, failed -- is drawn only when some
 * service had that trouble (`apiColumns`), so a clean inventory stays
 * narrow and a troubled one is visibly wider. "Not found" is its own
 * column, apart from "failed": it is the normal answer of the two
 * open-access lookups, not a fault.
 */

import encoding from "../lib/pipeline_encoding.json" with { type: "json" };
import { apiColumns } from "../lib/pipeline_details.ts";
import {
  field,
  formatBytes,
  formatMilliseconds,
} from "../lib/pipeline_display.ts";
import type { ApiService } from "../lib/types.ts";
import { CountCell, TableHead } from "./pipeline/records.tsx";

const SERVICES = encoding.services;

type Columns = ReturnType<typeof apiColumns>;

function ApiRow({ api, columns }: { api: ApiService; columns: Columns }) {
  return (
    <tr role="row" class="pipeline-api">
      <td role="cell" class="is-lead pipeline-api-name">{api.label}</td>
      {
        /* One line of code, the verb first: as two cells the method stayed
          at the end of the service's line on a phone while its path
          wrapped below it. */
      }
      <td role="cell" class="is-wide">
        <code class="pipeline-api-endpoint">
          <span class="pipeline-method">{api.method}</span> {api.endpoint}
        </code>
      </td>
      <CountCell value={api.calls} label={field("apiCalls").label} />
      {columns.retried && (
        <CountCell value={api.retries} label={field("apiRetries").label} />
      )}
      {columns.notFound && (
        <CountCell value={api.notFound} label={SERVICES.notFound} />
      )}
      {columns.failed && (
        <CountCell value={api.errors} label={SERVICES.failed} />
      )}
      {
        /* Empty, not "0 ms" and "0 B", when nothing was timed or counted:
          an older report recorded neither. */
      }
      <td role="cell" class="is-numeric is-time">
        {api.totalMs > 0 && formatMilliseconds(api.totalMs)}
      </td>
      <td role="cell" class="is-numeric">
        {api.bytes > 0 && formatBytes(api.bytes)}
      </td>
    </tr>
  );
}

export function ApiList({ apis }: { apis: ApiService[] }) {
  const columns = apiColumns(apis);
  return (
    <table class="pipeline-table" role="table">
      <thead role="rowgroup">
        <tr role="row">
          <TableHead label={field("apiService").label} />
          <TableHead label={SERVICES.request} />
          <TableHead label={field("apiCalls").label} numeric />
          {columns.retried && (
            <TableHead label={field("apiRetries").label} numeric />
          )}
          {columns.notFound && <TableHead label={SERVICES.notFound} numeric />}
          {columns.failed && <TableHead label={SERVICES.failed} numeric />}
          <TableHead label={SERVICES.time} numeric />
          <TableHead label={SERVICES.data} numeric />
        </tr>
      </thead>
      <tbody role="rowgroup">
        {apis.map((api) => (
          <ApiRow
            key={`${api.service}-${api.method}-${api.endpoint}`}
            api={api}
            columns={columns}
          />
        ))}
      </tbody>
    </table>
  );
}
