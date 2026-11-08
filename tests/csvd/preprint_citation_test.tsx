/**
 * The Research Square preprint gold cites by DOI renders as a citation.
 *
 * It has no PubMed record, so until its citation was read from Europe PMC the
 * Genes table showed the bare DOI where every other reference showed
 * `Author, X., et al. (year)`.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import GenesView from "../../islands/GenesView.tsx";
import { genes } from "../../lib/data/genes.ts";

const DOI = "10.21203/rs.3.rs-5926137/v1";

Deno.test("the preprint cited by DOI renders as a citation, not a bare DOI", () => {
  const rows = genes.filter((row) => row.references.includes(DOI));
  assert(rows.length > 0, `no gene cites ${DOI}`);
  const html = renderToString(<GenesView rows={rows} />);
  assertStringIncludes(html, "Debette, S.");
  assert(!html.includes(`>${DOI}</a>`), "the bare DOI link is still shown");
});
