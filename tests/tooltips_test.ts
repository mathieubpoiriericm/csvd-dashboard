import { assert, assertEquals, assertNotMatch } from "@std/assert";

import {
  cellTypeTooltip,
  citationRows,
  geneTooltip,
  omicsTooltip,
  omimTooltip,
  proteinTooltip,
  referenceRows,
  referenceTooltip,
  splitCellTypes,
} from "../lib/tooltips.ts";
import { CELL_TYPE_NAMES } from "../lib/disease/cell_types.ts";
import {
  geneInfoTooltip,
  omimEntryTooltip,
  proteinInfoTooltip,
  safeHttpsUrl,
} from "../lib/tooltip_content.ts";
import {
  phenogramTooltip,
  phenotypeTooltip,
} from "../lib/phenogram_tooltips.ts";
import { registryTooltip, trialGeneTooltip } from "../lib/trial_tooltips.ts";
import type { Reference } from "../lib/types.ts";
import { geneInfoByName, omimByNumber, referenceByPmid } from "../lib/data.ts";
import { citationLink, definitionLabel } from "../lib/disease.ts";
import { encoding } from "../lib/phenogram.ts";
import { sampleGene } from "./fixtures/rows.ts";

// -----------------------------------------------------------------------------
// referenceTooltip
// -----------------------------------------------------------------------------

/**
 * `refs.json` carries `formattedRef` as a pre-rendered HTML fragment, straight
 * from the `pubmed_citations.formatted_ref` database column. `TooltipBody`
 * renders every `TooltipRow.value` as a JSX text child, so any markup that
 * survives this far is displayed literally instead of being parsed.
 */
Deno.test("referenceTooltip leaves no markup in any row value", () => {
  for (const pmid of referenceByPmid.keys()) {
    const content = referenceTooltip(pmid);
    assertEquals(content !== null, true, `no tooltip for ${pmid}`);
    for (const row of content!.rows) {
      assertNotMatch(row.value, /<[^>]+>/, `markup in ${pmid} / ${row.label}`);
      assertNotMatch(row.value, /&[a-z]+;|&#\d+;/i, `entity in ${pmid}`);
    }
  }
});

function bareReference(fields: Partial<Reference>): Reference {
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

Deno.test("referenceRows falls back to the fragment when no field is set", () => {
  // What a PMID the export could not resolve looks like, and what a database
  // predating the widened query would produce for every row.
  assertEquals(referenceRows(bareReference({})), [{
    label: "Reference",
    value: "PMID: 12345678 (citation not available)",
  }]);
});

Deno.test("referenceRows shows only the fields a row actually carries", () => {
  // A citation with no DOI shows no DOI row rather than an empty one, and one
  // field present is enough to keep it off the fragment path.
  assertEquals(referenceRows(bareReference({ journal: "Nature" })), [
    { label: "Journal", value: "Nature" },
  ]);
  assertEquals(
    referenceRows(bareReference({ authors: "Mishra A", title: "A title" })),
    [
      { label: "Authors", value: "Mishra A" },
      { label: "Title", value: "A title" },
    ],
  );
  assertEquals(
    referenceRows(
      bareReference({ publicationDate: "Nov 2022", doi: "10.1/x" }),
    ),
    [
      { label: "Year", value: "2022" },
      { label: "DOI", value: "10.1/x" },
    ],
  );
});

Deno.test("referenceRows treats a whitespace-only field as absent", () => {
  assertEquals(referenceRows(bareReference({ authors: "  ", title: " " })), [{
    label: "Reference",
    value: "PMID: 12345678 (citation not available)",
  }]);
});

Deno.test("referenceTooltip tolerates surrounding whitespace on the PMID", () => {
  assertEquals(referenceTooltip(" 37063705 "), referenceTooltip("37063705"));
});

Deno.test("referenceTooltip returns null for an unknown PMID", () => {
  assertEquals(referenceTooltip("00000000"), null);
});

Deno.test("referenceTooltip builds rows and the PubMed link from a lookup row", () => {
  const lookup = new Map([[
    "12345678",
    bareReference({ authors: "Author A", title: "A title", doi: "10.1/x" }),
  ]]);
  assertEquals(referenceTooltip(" 12345678 ", lookup), {
    rows: [
      { label: "Authors", value: "Author A" },
      { label: "Title", value: "A title" },
      { label: "DOI", value: "10.1/x" },
    ],
    link: {
      href: "https://pubmed.ncbi.nlm.nih.gov/12345678",
      label: "View on PubMed",
    },
  });
});

Deno.test("citationRows safely decodes supported entities and fallback citations", () => {
  assertEquals(
    citationRows(
      "<b>A&amp; B</b><br/>Title &lt;x&gt;<br>Journal&nbsp;x<br>DOI: 10.1/test",
    ),
    [
      { label: "Authors", value: "A& B" },
      { label: "Title", value: "Title <x>" },
      { label: "Journal", value: "Journal x" },
      { label: "DOI", value: "10.1/test" },
    ],
  );
  assertEquals(citationRows("<i>PMID: 1</i> (citation not available)"), [{
    label: "Reference",
    value: "PMID: 1 (citation not available)",
  }]);
});

Deno.test("unknown cell-type values do not get invented expansions", () => {
  // The glossary is the fork's own; its first entry stands in for any.
  const [abbreviation, name] = Object.entries(CELL_TYPE_NAMES)[0] ?? [];
  if (abbreviation !== undefined) {
    assertEquals(cellTypeTooltip(abbreviation), {
      rows: [{ label: abbreviation, value: name }],
    });
  }
  for (const value of ["all", "40", "(unknown)"]) {
    assert(
      !Object.hasOwn(CELL_TYPE_NAMES, value),
      `${value} is in the glossary`,
    );
    assertEquals(cellTypeTooltip(value), null);
  }
});

Deno.test("omicsTooltip reads detail after the actual semicolon", () => {
  assertEquals(omicsTooltip("  TWAS; whole blood  "), {
    rows: [
      { label: "TWAS", value: "Transcriptome-Wide Association Study" },
      { label: "Tissue", value: "whole blood" },
    ],
  });
});

Deno.test("omicsTooltip handles a known type without tissue and rejects unknown types", () => {
  assertEquals(omicsTooltip("EWAS"), {
    rows: [{ label: "EWAS", value: "Epigenome-Wide Association Study" }],
  });
  assertEquals(omicsTooltip("metabolomics; plasma"), null);
});

Deno.test("splitCellTypes preserves directional separators and ignores blanks", () => {
  assertEquals(splitCellTypes(" FB > PC < SMC "), {
    parts: ["FB", "PC", "SMC"],
    separators: [">", "<"],
  });
  assertEquals(splitCellTypes(" <> "), { parts: [], separators: ["<", ">"] });
});

Deno.test("registry links use resolvable public URL forms", () => {
  assertEquals(
    registryTooltip("ACTRN12624001477516")?.link,
    {
      href:
        "https://www.anzctr.org.au/Trial/Registration/TrialReview.aspx?ACTRN=ACTRN12624001477516",
      label: "View on ANZCTR",
    },
  );
  assertEquals(
    registryTooltip("ChiCTR2500109773")?.link,
    {
      href: "https://www.chictr.org.cn/searchprojEN.html",
      label: "Search ChiCTR",
    },
  );
  assertEquals(registryTooltip("unsupported-1"), null);
});

// -----------------------------------------------------------------------------
// geneTooltip
// -----------------------------------------------------------------------------

/**
 * `proteinTooltip` already withholds a panel when the lookup carries no
 * accession, and the trigger renders as plain text. The NCBI side must follow
 * the same rule: a lookup row whose uid, description and aliases are all null
 * has nothing to say, and wrapping the cell anyway advertises a tooltip that
 * opens onto three "Not available" lines and no link.
 */
Deno.test("a lookup row with no usable field gets no gene tooltip", () => {
  const lookup = new Map([
    ["GENE1", {
      name: "GENE1",
      uid: null,
      description: null,
      otheraliases: null,
    }],
  ]);
  assertEquals(geneTooltip("GENE1", lookup), null);
  // The same rule for the protein cell.
  const proteins = new Map([
    ["GENE1", { gene: "GENE1", accession: null, url: null }],
  ]);
  assertEquals(proteinTooltip("GENE1", proteins), null);
});

Deno.test("a lookup row with any usable field still gets a tooltip", () => {
  const partial = [
    { name: "A", uid: "1", description: null, otheraliases: null },
    { name: "B", uid: null, description: "a description", otheraliases: null },
    { name: "C", uid: null, description: null, otheraliases: "X, Y" },
  ];
  const lookup = new Map(partial.map((info) => [info.name, info]));
  for (const info of partial) {
    const content = geneTooltip(info.name, lookup);
    assertEquals(content !== null, true, `${info.name} must keep its tooltip`);
    assertEquals(content!.rows.length, 3);
  }
});

Deno.test("the committed lookup rows follow the same two rules", () => {
  // Vacuous on an empty cache; on the committed one it is the check the two
  // synthetic cases above stand in for.
  for (const info of geneInfoByName.values()) {
    const usable = Boolean(info.uid || info.description || info.otheraliases);
    assertEquals(geneTooltip(info.name) !== null, usable, info.name);
  }
});

Deno.test("gene tooltip builders cover missing, partial, trial, and encoded UID records", () => {
  assertEquals(geneInfoTooltip(undefined), null);
  assertEquals(
    geneInfoTooltip({
      name: "PARTIAL",
      uid: null,
      description: " Description ",
      otheraliases: null,
    }),
    {
      rows: [
        { label: "UID", value: "Not available" },
        { label: "Description", value: "Description" },
        { label: "Other Aliases", value: "Not available" },
      ],
      link: undefined,
    },
  );
  assertEquals(
    geneInfoTooltip({
      name: "ENCODED",
      uid: "id/with space",
      description: null,
      otheraliases: "Alias",
    })?.link,
    {
      href: "https://www.ncbi.nlm.nih.gov/gene/id%2Fwith%20space",
      label: "View on NCBI Gene",
    },
  );
  assertEquals(geneTooltip("NOSUCHGENE"), null);
  assertEquals(trialGeneTooltip("NOSUCHGENE"), null);
});

Deno.test("protein and OMIM tooltips return records and reject unknown keys", () => {
  assertEquals(proteinTooltip("NOSUCHGENE"), null);
  const proteins = new Map([
    ["GENE1", {
      gene: "GENE1",
      accession: "P00001",
      url: "https://www.uniprot.org/uniprotkb/P00001/entry",
    }],
  ]);
  assertEquals(proteinTooltip("GENE1", proteins)?.link, {
    href: "https://www.uniprot.org/uniprotkb/P00001/entry",
    label: "View on UniProt",
  });
  assertEquals(omimTooltip("not-a-number"), null);
  // Every committed OMIM entry resolves, and a number the table lacks does not.
  for (const [number, entry] of omimByNumber) {
    assertEquals(omimTooltip(` ${number} `)?.rows[0], {
      label: "Phenotype",
      value: entry.phenotype.trim() || "Not available",
    });
  }
  assertEquals(omimTooltip("999999999"), null);

  assertEquals(
    proteinInfoTooltip({ gene: "EMPTY", accession: " ", url: null }),
    null,
  );
  assertEquals(
    proteinInfoTooltip({
      gene: "HTTP",
      accession: " P1 ",
      url: "http://example.com/P1",
    }),
    {
      rows: [{ label: "UniProt Accession Number", value: "P1" }],
      link: undefined,
    },
  );
  assertEquals(omimEntryTooltip(undefined), null);
  // A well-formed https link is offered; anything else is dropped below.
  assertEquals(
    omimEntryTooltip({
      omimNum: 1,
      omimLink: "https://www.omim.org/entry/1",
      phenotype: "A phenotype",
      inheritance: "AD",
      geneOrLocus: "GENE",
      geneOrLocusMimNumber: "2",
    })?.link,
    { href: "https://www.omim.org/entry/1", label: "View on OMIM" },
  );
  assertEquals(
    omimEntryTooltip({
      omimNum: 1,
      omimLink: "not a URL",
      phenotype: " ",
      inheritance: "",
      geneOrLocus: "GENE",
      geneOrLocusMimNumber: " ",
    }),
    {
      rows: [
        { label: "Phenotype", value: "Not available" },
        { label: "Inheritance", value: "Not available" },
        { label: "Gene or Locus", value: "GENE" },
        { label: "Gene or Locus MIM Number", value: "Not available" },
      ],
      link: undefined,
    },
  );
});

Deno.test("safeHttpsUrl accepts only normalized HTTPS URLs", () => {
  assertEquals(safeHttpsUrl(null), undefined);
  assertEquals(safeHttpsUrl(" "), undefined);
  assertEquals(safeHttpsUrl("not a URL"), undefined);
  assertEquals(safeHttpsUrl("http://example.com"), undefined);
  assertEquals(
    safeHttpsUrl(" https://example.com/path "),
    "https://example.com/path",
  );
});

// -----------------------------------------------------------------------------
// phenogramTooltip / phenotypeTooltip
// -----------------------------------------------------------------------------

// The committed cSVD panels -- JAK1, LAMB1, CENPF, WMH and PSMD -- are pinned
// in tests/csvd/tooltips_test.ts; these build their rows from the encoding.

Deno.test("phenogramTooltip names the location, the evidence and the display labels", () => {
  const first = encoding.traits[0];
  const rich = sampleGene({
    gene: "GENE1",
    chromosomalLocation: "1p31.3",
    gwasTrait: [first.key],
    evidenceFromOtherOmicsStudies: ["TWAS;brain frontal cortex"],
    linkToMonogenicDisease: ["999999"],
    mendelianRandomization: "No",
  });
  assertEquals(phenogramTooltip(rich).rows, [
    { label: "Location", value: "1p31.3" },
    { label: "GWAS phenotypes", value: first.label },
    { label: "Other omics", value: "TWAS;brain frontal cortex" },
    { label: "Monogenic disease", value: "999999" },
    { label: "Mendelian randomization", value: "No" },
  ]);
});

Deno.test("phenogramTooltip says None found rather than the sentinel", () => {
  const bare = phenogramTooltip(sampleGene({ chromosomalLocation: "7q31.1" }));
  assertEquals(bare.rows.map((r) => r.value), [
    "7q31.1",
    "None found",
    "None found",
    "None found",
    "No",
  ]);
});

Deno.test("phenogramTooltip links an NCBI record and omits the link without one", () => {
  for (const [symbol, info] of geneInfoByName) {
    if (!info.uid) continue;
    assertEquals(
      phenogramTooltip(sampleGene({ gene: symbol })).link?.href,
      `https://www.ncbi.nlm.nih.gov/gene/${info.uid}`,
    );
  }
  assertEquals(
    phenogramTooltip(sampleGene({ gene: "NOSUCHGENE" })).link,
    undefined,
  );
});

Deno.test("phenogramTooltip resolves OMIM numbers it knows and keeps the ones it does not", () => {
  for (const [number, entry] of omimByNumber) {
    const known = sampleGene({ linkToMonogenicDisease: [String(number)] });
    // A row with no phenotype text falls back to the number itself.
    assertEquals(
      phenogramTooltip(known).rows[3].value,
      entry.phenotype.trim() || String(number),
    );
  }
  const future = sampleGene({
    gwasTrait: ["FUTURE-TRAIT"],
    linkToMonogenicDisease: ["999999"],
  });
  const content = phenogramTooltip(future);
  assertEquals(content.rows[1].value, "FUTURE-TRAIT");
  assertEquals(content.rows[3].value, "999999");
});

Deno.test("phenogramTooltip resolves against the lookups it is handed", () => {
  const omim = new Map([[
    "100000",
    {
      omimNum: 100000,
      omimLink: "https://omim.org/entry/100000",
      phenotype: "A phenotype",
      inheritance: "AD",
      geneOrLocus: "GENE1",
      geneOrLocusMimNumber: "100001",
    },
  ]]);
  const geneInfo = new Map([[
    "GENE1",
    { name: "GENE1", uid: "42", description: null, otheraliases: null },
  ]]);
  const content = phenogramTooltip(
    sampleGene({ gene: "GENE1", linkToMonogenicDisease: ["100000", "200000"] }),
    { omim, geneInfo },
  );
  assertEquals(content.rows[3].value, "A phenotype; 200000");
  assertEquals(content.link, {
    href: "https://www.ncbi.nlm.nih.gov/gene/42",
    label: "View on NCBI Gene",
  });
});

Deno.test("phenotypeTooltip carries the long name, the standard's definition and its DOI", () => {
  const defined = {
    key: "T1",
    label: "T1",
    family: "f",
    name: "Trait one",
    definition: "Signal abnormality of a kind.",
    standard: true,
  };
  const content = phenotypeTooltip(defined);
  assertEquals(content.rows[0], { label: "T1", value: "Trait one" });
  assertEquals(content.rows[1].label, definitionLabel());
  assertEquals(content.rows[1].value, "Signal abnormality of a kind.");
  assertEquals(content.link, citationLink());

  const plain = { key: "T2", label: "T2", family: "f", name: "Trait two" };
  assertEquals(phenotypeTooltip(plain), {
    rows: [{ label: "T2", value: "Trait two" }],
    link: undefined,
  });
});
