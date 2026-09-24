/**
 * The `.pipeline-api` request log, shared by the run widget's drawer and
 * the reference-data refreshes below it.
 *
 * Both callers consult the same class of thing -- external services the
 * pipeline or a refresh called -- and render it with the same
 * `.pipeline-apis > ul > .pipeline-api` shape (see `assets/app.css`), so it
 * is one component with one set of styles rather than a copy that drifts.
 * Each caller keeps its own wrapper element and heading: the run widget
 * wraps this in a `<section>` with an `<h3>`, the refresh block in a bare
 * `<div>` with none, and this renders only the `<ul>` itself.
 */

import { Icon } from "./Icon.tsx";
import { describeApi } from "../lib/pipeline_display.ts";
import type { ApiService } from "../lib/types.ts";

export function ApiList({ apis }: { apis: ApiService[] }) {
  return (
    <ul>
      {apis.map((api) => (
        <li
          key={`${api.service}-${api.method}-${api.endpoint}`}
          class="pipeline-api"
        >
          <span class="pipeline-api-name">
            <Icon name="arrowsRightLeft" />
            {api.label}
          </span>
          {
            /* One line of code, the verb first: as two flex items the
              method stayed at the end of the service's line on a phone
              while its path wrapped below it. */
          }
          <code class="pipeline-api-endpoint">
            <span class="pipeline-method">{api.method}</span> {api.endpoint}
          </code>
          <span class="pipeline-api-detail">{describeApi(api)}</span>
        </li>
      ))}
    </ul>
  );
}
