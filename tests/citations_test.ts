/**
 * Composing a citation out of the fields the export publishes.
 *
 * The cases that matter are the ragged ones. Every row in the committed data
 * has all five fields today, so the fallbacks here are exercised against
 * hand-built rows -- which is the point: they exist for a PMID the pipeline
 * could not resolve, and that row would otherwise reach the table as
 * `undefined (undefined)`.
 */

import { assert, assertEquals } from "@std/assert";

import { doiHref, isDoi, shortCitation, toCitation } from "../lib/citations.ts";
import { referenceByPmid } from "../lib/data.ts";
import type { Reference } from "../lib/types.ts";
import doiCases from "./fixtures/doi_cases.json" with { type: "json" };

function reference(fields: Partial<Reference>): Reference {
  return {
    pmid: "12345678",
    authors: null,
    title: null,
    journal: null,
    publicationDate: null,
    doi: null,
    formattedRef: "PMID: 12345678 (citation not available)",
    ...fields,
  };
}

Deno.test("a full row reads as surname, initial, et al. and a year", () => {
  const row = reference({
    authors: "Mishra A, Malik R, Hachiya T, et al.",
    journal: "Nature",
    publicationDate: "Nov 2022",
    doi: "10.1038/s41586-022-05165-3",
  });
  assertEquals(shortCitation(row), "Mishra, A., et al. (2022)");
  assertEquals(toCitation(row), {
    author: "Mishra, A.",
    year: "2022",
    journal: "Nature",
    doi: "10.1038/s41586-022-05165-3",
    etAl: true,
  });
});

Deno.test("a sole author gets no et al.", () => {
  const row = reference({ authors: "Mishra A", publicationDate: "2022" });
  assertEquals(shortCitation(row), "Mishra, A. (2022)");
  assertEquals(toCitation(row).etAl, false);
});

Deno.test("a compound surname keeps every word but the initial", () => {
  const row = reference({ authors: "van der Berg J, Smith A" });
  assertEquals(toCitation(row).author, "van der Berg, J.");
});

Deno.test("a one-token author is used as it stands", () => {
  // A consortium byline rather than a person. Splitting it would invent an
  // initial out of the last letter of the name.
  const row = reference({ authors: "MEGASTROKE" });
  assertEquals(toCitation(row).author, "MEGASTROKE");
  assertEquals(shortCitation(row), "MEGASTROKE");
});

Deno.test("a name that does not end in initials is used whole", () => {
  // Europe PMC hands a collective name over verbatim, and a PubMed surname
  // with no initials is stored bare: neither ends in an initial to take.
  const consortium = reference({
    authors: "MEGASTROKE Consortium, Smith A",
    publicationDate: "2024",
  });
  assertEquals(
    shortCitation(consortium),
    "MEGASTROKE Consortium, et al. (2024)",
  );
  const bare = reference({ authors: "De Silva", publicationDate: "2024" });
  assertEquals(shortCitation(bare), "De Silva (2024)");

  // Initials still read as initials, dotted, hyphenated or non-ASCII.
  assertEquals(
    toCitation(reference({ authors: "Le Grand Q" })).author,
    "Le Grand, Q.",
  );
  assertEquals(
    toCitation(reference({ authors: "Dupont J-P" })).author,
    "Dupont, J.",
  );
  assertEquals(
    toCitation(reference({ authors: "Smith J.A." })).author,
    "Smith, J.",
  );
  assertEquals(
    toCitation(reference({ authors: "Ångström Å" })).author,
    "Ångström, Å.",
  );
});

Deno.test("a missing year drops the parenthesis rather than emptying it", () => {
  const row = reference({ authors: "Mishra A, Malik R" });
  assertEquals(shortCitation(row), "Mishra, A., et al.");
  assertEquals(toCitation(row).year, "");
});

Deno.test("an unparseable publication date yields no year", () => {
  const row = reference({ authors: "Mishra A", publicationDate: "in press" });
  assertEquals(toCitation(row).year, "");
});

Deno.test("a year is found wherever it sits in the date string", () => {
  assertEquals(toCitation(reference({ publicationDate: "1998" })).year, "1998");
  assertEquals(
    toCitation(reference({ publicationDate: "2019 Jan-Feb" })).year,
    "2019",
  );
});

Deno.test("a row with no citation falls back to its PMID", () => {
  const row = reference({});
  assertEquals(shortCitation(row), "PMID 12345678");
  assertEquals(toCitation(row).author, "");
});

Deno.test("an empty authors string is treated as absent", () => {
  const row = reference({ authors: "   ", journal: "Nature" });
  assertEquals(toCitation(row).author, "");
  assertEquals(shortCitation(row), "PMID 12345678");
  assertEquals(toCitation(row).etAl, false);
});

Deno.test("every committed reference composes a real citation", () => {
  // The fallback exists for a row the pipeline could not resolve. No committed
  // row is one, and this fails if a regeneration makes one so; it is vacuous
  // on the empty export a fork starts from.
  for (const [pmid, row] of referenceByPmid) {
    assert(toCitation(row).author !== "", `${pmid} has no author to cite`);
    const short = shortCitation(row);
    assert(!short.startsWith("PMID "), `${pmid} fell back to its PMID`);
    assert(/\(\d{4}\)$/.test(short), `${pmid} has no year: ${short}`);
  }
});

Deno.test("a DOI is told apart from a PMID, by the rule the pipeline uses", () => {
  // The same cases tests/pipeline/test_doi_references.py runs is_doi over.
  for (const value of doiCases.doi) assert(isDoi(value), value);
  for (const value of doiCases.notDoi) assert(!isDoi(value), value);
});

Deno.test("a DOI link keeps every character of the suffix in the path", () => {
  // `encodeURI` would leave `#` and `?` bare, cutting the suffix into a
  // fragment or a query string that doi.org never sees.
  const sici = "10.1002/(SICI)1097-4636(199601)30:1<1::AID-JBM1>3.0.CO;2-#";
  assert(isDoi(sici));
  const href = doiHref(sici);
  assertEquals(new URL(href).hash, "");
  assertEquals(decodeURIComponent(new URL(href).pathname.slice(1)), sici);

  const query = "10.1000/what?is=this&x";
  const url = new URL(doiHref(query));
  assertEquals(url.search, "");
  assertEquals(decodeURIComponent(url.pathname.slice(1)), query);

  // The separators stay, and `%` and non-ASCII are encoded as before.
  assertEquals(
    doiHref("10.1000/50%-é"),
    "https://doi.org/10.1000/50%25-%C3%A9",
  );
  assertEquals(
    doiHref("10.21203/rs.3.rs-5926137/v1"),
    "https://doi.org/10.21203/rs.3.rs-5926137/v1",
  );
});
