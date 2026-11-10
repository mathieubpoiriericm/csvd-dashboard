import { assert, assertEquals, assertNotMatch } from "@std/assert";

import {
  cellTypeText,
  cellTypeTooltip,
  citationRows,
  geneTooltip,
  omimTooltip,
  proteinTooltip,
  referenceRows,
  referenceTooltip,
  splitCellTypes,
  splitSubtype,
  studyTypeTooltip,
} from "../lib/tooltips.ts";
import { parseOmicsEntry } from "../lib/omics.ts";
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
import type { GeneInfo, Reference } from "../lib/types.ts";
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
    links: [{
      href: "https://pubmed.ncbi.nlm.nih.gov/12345678",
      label: "View on PubMed",
    }],
  });
});

Deno.test("referenceTooltip links a preprint cited by DOI to the resolver", () => {
  const doi = "10.1000/50%-é";
  const lookup = new Map([[
    doi,
    bareReference({ pmid: doi, authors: "Author A", doi }),
  ]]);
  assertEquals(referenceTooltip(doi, lookup)?.links, [{
    href: "https://doi.org/10.1000/50%25-%C3%A9",
    label: "View on doi.org",
  }]);
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

Deno.test("a cell subtype names its subtype, and a source note is kept", () => {
  // The glossary is the fork's own; its first entry stands in for any.
  const [abbreviation, name] = Object.entries(CELL_TYPE_NAMES)[0] ?? [];
  if (abbreviation === undefined) return;
  assertEquals(cellTypeTooltip(`Venous, ${abbreviation}`), {
    rows: [{ label: `Venous ${abbreviation}`, value: `Venous ${name}` }],
  });
  assertEquals(cellTypeTooltip(`${abbreviation} (some atlas)`), {
    rows: [{ label: abbreviation, value: `${name} (some atlas)` }],
  });
  // Neither form invents a name for an abbreviation the glossary lacks.
  assert(!Object.hasOwn(CELL_TYPE_NAMES, "ZZQQ"));
  assertEquals(cellTypeTooltip("Venous, ZZQQ"), null);
  assertEquals(cellTypeTooltip("ZZQQ (some atlas)"), null);
});

Deno.test("a cell subtype splits from its abbreviation, and prints without the comma", () => {
  // The glossary is the fork's own; its first entry stands in for any.
  const [abbreviation] = Object.keys(CELL_TYPE_NAMES);
  if (abbreviation === undefined) return;
  assertEquals(splitSubtype(`Inner Arachnoid, ${abbreviation}`), {
    subtype: "Inner Arachnoid",
    abbreviation,
  });
  assertEquals(
    cellTypeText(`Inner Arachnoid, ${abbreviation}`),
    `Inner Arachnoid ${abbreviation}`,
  );
  // A bare abbreviation, and a comma before something the glossary lacks,
  // are left as written.
  assertEquals(splitSubtype(abbreviation), { subtype: null, abbreviation });
  assert(!Object.hasOwn(CELL_TYPE_NAMES, "ZZQQ"));
  assertEquals(splitSubtype("Venous, ZZQQ"), {
    subtype: null,
    abbreviation: "Venous, ZZQQ",
  });
  assertEquals(cellTypeText("Venous, ZZQQ"), "Venous, ZZQQ");
});

Deno.test("every glossary abbreviation takes a subtype, whatever it holds", () => {
  // Not only the first: the split used to stop at whitespace, so a subtype
  // of an abbreviation holding a space came back whole, with no tooltip.
  for (const [abbreviation, name] of Object.entries(CELL_TYPE_NAMES)) {
    assertEquals(splitSubtype(`Venous, ${abbreviation}`), {
      subtype: "Venous",
      abbreviation,
    }, abbreviation);
    assertEquals(cellTypeTooltip(`Venous, ${abbreviation}`), {
      rows: [{ label: `Venous ${abbreviation}`, value: `Venous ${name}` }],
    }, abbreviation);
  }
});

Deno.test("the glossary decides where a subtype ends, not the abbreviation's spelling", () => {
  // A glossary of the test's own: a disease's may hold no such abbreviation.
  const glossary = {
    "T cells": "T lymphocytes",
    "NK": "Natural killer cells",
    "T, NK": "T and natural killer cells",
  };
  assertEquals(splitSubtype("Venous, T cells", glossary), {
    subtype: "Venous",
    abbreviation: "T cells",
  });
  assertEquals(cellTypeText("Venous, T cells", glossary), "Venous T cells");
  assertEquals(cellTypeTooltip("Venous, T cells", glossary), {
    rows: [{ label: "Venous T cells", value: "Venous T lymphocytes" }],
  });
  // The subtype is everything before the abbreviation, commas included, and
  // the longest abbreviation the glossary defines wins.
  assertEquals(splitSubtype("Inner, outer,NK", glossary), {
    subtype: "Inner, outer",
    abbreviation: "NK",
  });
  assertEquals(splitSubtype("Venous, T, NK", glossary), {
    subtype: "Venous",
    abbreviation: "T, NK",
  });
  // An abbreviation is not a subtype of its own last word.
  assertEquals(splitSubtype("T, NK", glossary), {
    subtype: null,
    abbreviation: "T, NK",
  });
  assertEquals(cellTypeTooltip("T, NK", glossary), {
    rows: [{ label: "T, NK", value: "T and natural killer cells" }],
  });
  // Free text holding a comma, and a comma with nothing before it, stay whole.
  for (const whole of ["Venous, ZZ QQ", "Venous, T", ", NK"]) {
    assertEquals(splitSubtype(whole, glossary), {
      subtype: null,
      abbreviation: whole,
    });
    assertEquals(cellTypeText(whole, glossary), whole);
    assertEquals(cellTypeTooltip(whole, glossary), null);
  }
  assertEquals(cellTypeTooltip("T cells (some atlas)", glossary), {
    rows: [{ label: "T cells", value: "T lymphocytes (some atlas)" }],
  });
});

const OMICS_GLOSSARY = new Map([
  ["TWAS", {
    name: "Transcriptome-Wide Association Study",
    kind: "omics methodology",
  }],
]);

Deno.test("studyTypeTooltip names the method and lists every colocalized item", () => {
  assertEquals(
    studyTypeTooltip(parseOmicsEntry("TWAS;Q: a*, b, c*"), OMICS_GLOSSARY),
    {
      rows: [
        {
          label: "TWAS",
          value: "Transcriptome-Wide Association Study · omics methodology",
        },
        { label: "Significant colocalization", value: "a, c" },
      ],
    },
  );
});

Deno.test("studyTypeTooltip keeps colocalization for a type the glossary lacks, and is null with nothing to say", () => {
  assertEquals(
    studyTypeTooltip(parseOmicsEntry("Other;Q: a*"), OMICS_GLOSSARY),
    { rows: [{ label: "Significant colocalization", value: "a" }] },
  );
  assertEquals(
    studyTypeTooltip(parseOmicsEntry("TWAS;artery aorta*"), OMICS_GLOSSARY)
      ?.rows[1],
    { label: "Significant colocalization", value: "artery aorta" },
  );
  assertEquals(
    studyTypeTooltip(parseOmicsEntry("Other;Q: a"), OMICS_GLOSSARY),
    null,
  );
  assertEquals(studyTypeTooltip(parseOmicsEntry("TWAS"))?.rows.length, 1);
});

Deno.test("splitCellTypes preserves directional separators and ignores blanks", () => {
  assertEquals(splitCellTypes(" FB > PC < SMC "), {
    parts: ["FB", "PC", "SMC"],
    chains: [{
      label: null,
      parts: ["FB", "PC", "SMC"],
      separators: [">", "<"],
    }],
  });
  assertEquals(splitCellTypes(" <> "), {
    parts: [],
    chains: [{ label: null, parts: [], separators: ["<", ">"] }],
  });
});

Deno.test("registry links use resolvable public URL forms", () => {
  assertEquals(
    registryTooltip("ACTRN12624001477516")?.links,
    [{
      href:
        "https://www.anzctr.org.au/Trial/Registration/TrialReview.aspx?ACTRN=ACTRN12624001477516",
      label: "View on ANZCTR",
    }],
  );
  assertEquals(
    registryTooltip("ChiCTR2500109773")?.links,
    [{
      href: "https://www.chictr.org.cn/searchprojEN.html",
      label: "Search ChiCTR",
    }],
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
    ["GENE1", [{
      name: "GENE1",
      symbol: "GENE1",
      uid: null,
      description: null,
      otheraliases: null,
    }]],
  ]);
  assertEquals(geneTooltip("GENE1", lookup), null);
  // The same rule for the protein cell.
  const proteins = new Map([
    ["GENE1", [{ gene: "GENE1", symbol: "GENE1", accession: null, url: null }]],
  ]);
  assertEquals(proteinTooltip("GENE1", proteins), null);
});

Deno.test("a lookup row with any usable field still gets a tooltip", () => {
  const partial: GeneInfo[] = [
    { name: "A", symbol: "A", uid: "1", description: null, otheraliases: null },
    {
      name: "B",
      symbol: "B",
      uid: null,
      description: "a description",
      otheraliases: null,
    },
    {
      name: "C",
      symbol: "C",
      uid: null,
      description: null,
      otheraliases: "X, Y",
    },
  ];
  const lookup = new Map(partial.map((info) => [info.name, [info]]));
  for (const info of partial) {
    const content = geneTooltip(info.name, lookup);
    assertEquals(content !== null, true, `${info.name} must keep its tooltip`);
    assertEquals(content!.rows.length, 3);
  }
});

Deno.test("the committed lookup rows follow the same two rules", () => {
  // Vacuous on an empty cache; on the committed one it is the check the two
  // synthetic cases above stand in for.
  for (const [name, infos] of geneInfoByName) {
    const usable = infos.some((info) =>
      Boolean(info.uid || info.description || info.otheraliases)
    );
    assertEquals(geneTooltip(name) !== null, usable, name);
  }
});

Deno.test("gene tooltip builders cover missing, partial, trial, and encoded UID records", () => {
  assertEquals(geneInfoTooltip(undefined), null);
  assertEquals(geneInfoTooltip([]), null);
  assertEquals(
    geneInfoTooltip([{
      name: "PARTIAL",
      symbol: "PARTIAL",
      uid: null,
      description: " Description ",
      otheraliases: null,
    }]),
    {
      rows: [
        { label: "UID", value: "Not available" },
        { label: "Description", value: "Description" },
        { label: "Other Aliases", value: "Not available" },
      ],
      links: [],
    },
  );
  assertEquals(
    geneInfoTooltip([{
      name: "ENCODED",
      symbol: "ENCODED",
      uid: "id/with space",
      description: null,
      otheraliases: "Alias",
    }])?.links,
    [{
      href: "https://www.ncbi.nlm.nih.gov/gene/id%2Fwith%20space",
      label: "View on NCBI Gene",
    }],
  );
  assertEquals(geneTooltip("NOSUCHGENE"), null);
  assertEquals(trialGeneTooltip("NOSUCHGENE"), null);
});

// An alias key is published as one lookup row per member gene, and the
// tooltip has to say which record belongs to which member.
const PAIR: GeneInfo[] = [
  {
    name: "PAIR",
    symbol: "GENEA",
    uid: "1",
    description: "a",
    otheraliases: null,
  },
  {
    name: "PAIR",
    symbol: "GENEB",
    uid: "2",
    description: "b",
    otheraliases: "X",
  },
];

Deno.test("a key with several lookup rows shows one block and one link per member", () => {
  assertEquals(geneInfoTooltip(PAIR), {
    rows: [
      { label: "Gene", value: "GENEA" },
      { label: "UID", value: "1" },
      { label: "Description", value: "a" },
      { label: "Other Aliases", value: "Not available" },
      { label: "Gene", value: "GENEB" },
      { label: "UID", value: "2" },
      { label: "Description", value: "b" },
      { label: "Other Aliases", value: "X" },
    ],
    links: [
      {
        href: "https://www.ncbi.nlm.nih.gov/gene/1",
        label: "View GENEA on NCBI Gene",
      },
      {
        href: "https://www.ncbi.nlm.nih.gov/gene/2",
        label: "View GENEB on NCBI Gene",
      },
    ],
  });
});

Deno.test("a member with nothing to show is dropped but the survivor keeps its Gene row", () => {
  const empty = { uid: null, description: null, otheraliases: null };
  assertEquals(
    geneInfoTooltip([
      { name: "PAIR", symbol: "GENEA", ...empty },
      { name: "PAIR", symbol: "GENEB", ...empty, uid: "2" },
    ]),
    {
      rows: [
        { label: "Gene", value: "GENEB" },
        { label: "UID", value: "2" },
        { label: "Description", value: "Not available" },
        { label: "Other Aliases", value: "Not available" },
      ],
      links: [{
        href: "https://www.ncbi.nlm.nih.gov/gene/2",
        label: "View GENEB on NCBI Gene",
      }],
    },
  );
});

Deno.test("a key whose members all lack content gets no tooltip", () => {
  const empty = { uid: null, description: null, otheraliases: null };
  assertEquals(
    geneInfoTooltip([
      { name: "PAIR", symbol: "GENEA", ...empty },
      { name: "PAIR", symbol: "GENEB", ...empty },
    ]),
    null,
  );
  assertEquals(
    proteinInfoTooltip([
      { gene: "PAIR", symbol: "GENEA", accession: null, url: null },
      { gene: "PAIR", symbol: "GENEB", accession: " ", url: null },
    ]),
    null,
  );
});

Deno.test("a single row keeps today's output even when its symbol differs from its key", () => {
  assertEquals(
    geneInfoTooltip([{
      name: "OLDSYM",
      symbol: "NEWSYM",
      uid: "3",
      description: "d",
      otheraliases: null,
    }]),
    {
      rows: [
        { label: "UID", value: "3" },
        { label: "Description", value: "d" },
        { label: "Other Aliases", value: "Not available" },
      ],
      links: [{
        href: "https://www.ncbi.nlm.nih.gov/gene/3",
        label: "View on NCBI Gene",
      }],
    },
  );
});

Deno.test("protein and OMIM tooltips return records and reject unknown keys", () => {
  assertEquals(proteinTooltip("NOSUCHGENE"), null);
  const proteins = new Map([
    ["GENE1", [{
      gene: "GENE1",
      symbol: "GENE1",
      accession: "P00001",
      url: "https://www.uniprot.org/uniprotkb/P00001/entry",
    }]],
  ]);
  assertEquals(proteinTooltip("GENE1", proteins)?.links, [{
    href: "https://www.uniprot.org/uniprotkb/P00001/entry",
    label: "View on UniProt",
  }]);
  assertEquals(omimTooltip("not-a-number"), null);
  // Every committed OMIM entry resolves, and a number the table lacks does not.
  for (const [number, entry] of omimByNumber) {
    assertEquals(omimTooltip(` ${number} `)?.rows[0], {
      label: "Phenotype",
      value: entry.phenotype.trim() || "Not available",
    });
  }
  assertEquals(omimTooltip("999999999"), null);

  assertEquals(proteinInfoTooltip(undefined), null);
  assertEquals(
    proteinInfoTooltip([{
      gene: "EMPTY",
      symbol: "EMPTY",
      accession: " ",
      url: null,
    }]),
    null,
  );
  assertEquals(
    proteinInfoTooltip([{
      gene: "HTTP",
      symbol: "HTTP",
      accession: " P1 ",
      url: "http://example.com/P1",
    }]),
    {
      rows: [{ label: "UniProt Accession Number", value: "P1" }],
      links: [],
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
    })?.links,
    [{ href: "https://www.omim.org/entry/1", label: "View on OMIM" }],
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
      links: [],
    },
  );
});

Deno.test("a protein key with several rows lists each accession and drops only an unsafe link", () => {
  assertEquals(
    proteinInfoTooltip([
      { gene: "PAIR", symbol: "GENEA", accession: "P1", url: "https://u/P1" },
      { gene: "PAIR", symbol: "GENEB", accession: "P2", url: "http://u/P2" },
    ]),
    {
      rows: [
        { label: "Gene", value: "GENEA" },
        { label: "UniProt Accession Number", value: "P1" },
        { label: "Gene", value: "GENEB" },
        { label: "UniProt Accession Number", value: "P2" },
      ],
      links: [{ href: "https://u/P1", label: "View GENEA on UniProt" }],
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
    { label: "Other omics", value: "TWAS (brain frontal cortex)" },
    { label: "Monogenic disease", value: "999999" },
    { label: "Mendelian randomization", value: "No" },
  ]);
});

Deno.test("phenogramTooltip states significant colocalization in words, without the stars", () => {
  const gene = sampleGene({
    chromosomalLocation: "1p31.3",
    evidenceFromOtherOmicsStudies: [
      "TWAS;Q: a*, b",
      "Proteomics",
      "PWAS;c*",
    ],
  });
  const rows = phenogramTooltip(gene).rows;
  const omics = rows.findIndex((r) => r.label === "Other omics");
  assertEquals(rows[omics].value, "TWAS (Q: a, b); Proteomics; PWAS (c)");
  assertEquals(rows[omics + 1], {
    label: "Significant colocalization",
    value: "TWAS (Q): a; PWAS: c",
  });
});

Deno.test("phenogramTooltip prints a clarification mark in the colocalization row as ?", () => {
  const gene = sampleGene({
    evidenceFromOtherOmicsStudies: ["TWAS;[?]: a*"],
  });
  const row = phenogramTooltip(gene).rows.find((r) =>
    r.label === "Significant colocalization"
  );
  assertEquals(row?.value, "TWAS (?): a");
});

Deno.test("phenogramTooltip adds no colocalization row when nothing colocalized", () => {
  const gene = sampleGene({ evidenceFromOtherOmicsStudies: ["TWAS;Q: a, b"] });
  assertEquals(
    phenogramTooltip(gene).rows.some((r) =>
      r.label === "Significant colocalization"
    ),
    false,
  );
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
  for (const [name, infos] of geneInfoByName) {
    assertEquals(
      phenogramTooltip(sampleGene({ gene: name })).links?.map((l) => l.href),
      infos.filter((info) => info.uid).map((info) =>
        `https://www.ncbi.nlm.nih.gov/gene/${info.uid}`
      ),
    );
  }
  assertEquals(
    phenogramTooltip(sampleGene({ gene: "NOSUCHGENE" })).links,
    [],
  );
});

Deno.test("phenogramTooltip links each member's NCBI record", () => {
  const omim = new Map();
  assertEquals(
    phenogramTooltip(sampleGene({ gene: "PAIR" }), {
      omim,
      geneInfo: new Map([["PAIR", PAIR]]),
    }).links,
    [
      {
        href: "https://www.ncbi.nlm.nih.gov/gene/1",
        label: "View GENEA on NCBI Gene",
      },
      {
        href: "https://www.ncbi.nlm.nih.gov/gene/2",
        label: "View GENEB on NCBI Gene",
      },
    ],
  );
  assertEquals(
    phenogramTooltip(sampleGene({ gene: "PAIR" }), {
      omim,
      geneInfo: new Map([["PAIR", PAIR.slice(0, 1)]]),
    }).links,
    [{
      href: "https://www.ncbi.nlm.nih.gov/gene/1",
      label: "View on NCBI Gene",
    }],
  );
  // A member NCBI gave no uid gets no link, and the others keep their names.
  assertEquals(
    phenogramTooltip(sampleGene({ gene: "PAIR" }), {
      omim,
      geneInfo: new Map([["PAIR", [PAIR[0], { ...PAIR[1], uid: null }]]]),
    }).links,
    [{
      href: "https://www.ncbi.nlm.nih.gov/gene/1",
      label: "View GENEA on NCBI Gene",
    }],
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
    [{
      name: "GENE1",
      symbol: "GENE1",
      uid: "42",
      description: null,
      otheraliases: null,
    }],
  ]]);
  const content = phenogramTooltip(
    sampleGene({ gene: "GENE1", linkToMonogenicDisease: ["100000", "200000"] }),
    { omim, geneInfo },
  );
  assertEquals(content.rows[3].value, "A phenotype; 200000");
  assertEquals(content.links, [{
    href: "https://www.ncbi.nlm.nih.gov/gene/42",
    label: "View on NCBI Gene",
  }]);
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
  // A fork the wizard starts may name no standard, and then has no link.
  const citation = citationLink();
  assertEquals(content.links, citation ? [citation] : []);

  const plain = { key: "T2", label: "T2", family: "f", name: "Trait two" };
  assertEquals(phenotypeTooltip(plain), {
    rows: [{ label: "T2", value: "Trait two" }],
    links: [],
  });
});
