import { assertEquals, assertNotMatch } from "@std/assert";

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
import { geneInfoByName, genes, referenceByPmid } from "../lib/data.ts";
import { encoding } from "../lib/phenogram.ts";

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

Deno.test("referenceTooltip builds its rows from the discrete fields", () => {
  // The journal and the year are separate rows now: they are separate columns
  // in `pubmed_citations`, and the table cell shows the year on its own, so
  // reading them back out of "Neurology. Genetics (Jun 2023)" would make the
  // two panels able to disagree.
  assertEquals(referenceTooltip("37063705"), {
    rows: [
      { label: "Authors", value: "Morel H, Bailly L, Urbanczyk C, et al." },
      {
        label: "Title",
        value:
          "Extension of the Clinicoradiologic Spectrum of Newly Described End-Truncating",
      },
      { label: "Journal", value: "Neurology. Genetics" },
      { label: "Year", value: "2023" },
      { label: "DOI", value: "10.1212/NXG.0000000000200069" },
    ],
    link: {
      href: "https://pubmed.ncbi.nlm.nih.gov/37063705",
      label: "View on PubMed",
    },
  });
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

Deno.test("unknown brain-cell values do not get invented expansions", () => {
  assertEquals(cellTypeTooltip("EC"), {
    rows: [{ label: "EC", value: "Endothelial Cells" }],
  });
  assertEquals(cellTypeTooltip("all"), null);
  assertEquals(cellTypeTooltip("40"), null);
  assertEquals(cellTypeTooltip("(unknown)"), null);
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
  const empty = [...geneInfoByName.values()].filter((info) =>
    !info.uid && !info.description && !info.otheraliases
  );
  assertEquals(
    empty.length > 0,
    true,
    "fixture expects at least one all-null NCBI lookup row",
  );

  for (const info of empty) {
    assertEquals(geneTooltip(info.name), null, `${info.name} must not wrap`);
    // The same row is why its protein cell renders unwrapped today.
    assertEquals(proteinTooltip(info.name), null);
  }
});

Deno.test("a lookup row with any usable field still gets a tooltip", () => {
  const partial = [...geneInfoByName.values()].filter((info) =>
    (info.uid || info.description || info.otheraliases) &&
    !(info.uid && info.description && info.otheraliases)
  );
  assertEquals(
    partial.length > 0,
    true,
    "fixture expects at least one partially populated NCBI lookup row",
  );

  for (const info of partial) {
    const content = geneTooltip(info.name);
    assertEquals(content !== null, true, `${info.name} must keep its tooltip`);
    assertEquals(content!.rows.length, 3);
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
  assertEquals(trialGeneTooltip("FGA")?.rows.length, 3);
});

Deno.test("protein and OMIM tooltips return records and reject unknown keys", () => {
  assertEquals(proteinTooltip("NOSUCHGENE"), null);
  assertEquals(proteinTooltip("LAMB1")?.link, {
    href: "https://www.uniprot.org/uniprotkb/P07942/entry",
    label: "View on UniProt",
  });
  assertEquals(omimTooltip("not-a-number"), null);
  assertEquals(omimTooltip(" 617168 ")?.rows, [
    { label: "Phenotype", value: "Aortic aneurysm, familial thoracic 10" },
    { label: "Inheritance", value: "AD" },
    { label: "Gene or Locus", value: "LOX" },
    { label: "Gene or Locus MIM Number", value: "153455" },
  ]);

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

const gene = (symbol: string) => genes.find((g) => g.gene === symbol)!;

Deno.test("phenogramTooltip names the location, the evidence and the NCBI link", () => {
  assertEquals(phenogramTooltip(gene("JAK1")), {
    rows: [
      { label: "Location", value: "1p31.3" },
      { label: "GWAS phenotypes", value: "PSMD" },
      { label: "Other omics", value: "TWAS;brain frontal cortex" },
      {
        label: "Monogenic disease",
        value: "Autoinflammation, immune dysregulation, and eosinophilia",
      },
      { label: "Mendelian randomization", value: "No" },
    ],
    link: {
      href: "https://www.ncbi.nlm.nih.gov/gene/3716",
      label: "View on NCBI Gene",
    },
  });
});

Deno.test("phenogramTooltip says None found rather than the sentinel, and uses display labels", () => {
  const lamb1 = phenogramTooltip(gene("LAMB1"));
  assertEquals(lamb1.rows.map((r) => r.value), [
    "7q31.1",
    "None found",
    "None found",
    "None found",
    "No",
  ]);
  assertEquals(lamb1.link?.href, "https://www.ncbi.nlm.nih.gov/gene/3912");

  const cenpf = phenogramTooltip(gene("CENPF"));
  assertEquals(cenpf.rows[1].value, "WM-PVS; HIP-PVS; PSMD");
  assertEquals(cenpf.rows[3].value, "Stromme syndrome");
});

Deno.test("phenogramTooltip has no link for a gene without an NCBI record", () => {
  const unknown = { ...gene("LAMB1"), gene: "NOSUCHGENE" };
  assertEquals(phenogramTooltip(unknown).link, undefined);
});

Deno.test("phenogramTooltip preserves future traits and unresolved OMIM numbers", () => {
  const future = {
    ...gene("LAMB1"),
    gwasTrait: ["FUTURE-TRAIT"],
    linkToMonogenicDisease: ["999999"],
  };
  const content = phenogramTooltip(future);
  assertEquals(content.rows[1].value, "FUTURE-TRAIT");
  assertEquals(content.rows[3].value, "999999");
});

Deno.test("phenotypeTooltip carries the long name, the STRIVE-2 definition and its DOI", () => {
  const wmh = encoding.traits.find((t) => t.key === "WMH")!;
  const content = phenotypeTooltip(wmh);
  assertEquals(content.rows[0], {
    label: "WMH",
    value: "White matter hyperintensities (of presumed vascular origin)",
  });
  assertEquals(content.rows[1].label, "STRIVE-2 definition");
  assertEquals(content.rows[1].value.startsWith("Signal abnormality"), true);
  assertEquals(content.link, {
    href: "https://doi.org/10.1016/S1474-4422(23)00131-X",
    label: "View STRIVE-2 (Lancet Neurol 2023)",
  });

  const psmd = encoding.traits.find((t) => t.key === "PSMD")!;
  assertEquals(phenotypeTooltip(psmd), {
    rows: [{
      label: "PSMD",
      value: "Peak width of skeletonized mean diffusivity",
    }],
    link: undefined,
  });
});
