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

import { shortCitation, toCitation } from "../lib/citations.ts";
import { referenceByPmid } from "../lib/data.ts";
import type { Reference } from "../lib/types.ts";

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
  // The fallback exists for a row the pipeline could not resolve. None of the
  // 29 committed rows is one, and this fails if a regeneration makes one so.
  for (const [pmid, row] of referenceByPmid) {
    assert(toCitation(row).author !== "", `${pmid} has no author to cite`);
    const short = shortCitation(row);
    assert(!short.startsWith("PMID "), `${pmid} fell back to its PMID`);
    assert(/\(\d{4}\)$/.test(short), `${pmid} has no year: ${short}`);
  }
});
