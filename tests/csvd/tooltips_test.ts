/**
 * Tooltip content over the committed cSVD lookups: one PubMed citation, one
 * UniProt accession, one OMIM entry, three genes' phenogram panels and two
 * traits' STRIVE-2 definitions.
 *
 * The rules are tested on synthetic rows in tests/tooltips_test.ts; this is
 * the record of what the committed cSVD data renders, and a fork deletes
 * the whole tests/csvd/ tree.
 */
import { assertEquals } from "@std/assert";

import { genes } from "../../lib/data.ts";
import { encoding } from "../../lib/phenogram.ts";
import {
  phenogramTooltip,
  phenotypeTooltip,
} from "../../lib/phenogram_tooltips.ts";
import {
  cellTypeTooltip,
  geneTooltip,
  omimTooltip,
  proteinTooltip,
  referenceTooltip,
} from "../../lib/tooltips.ts";
import { trialGeneTooltip } from "../../lib/trial_tooltips.ts";

const gene = (symbol: string) => genes.find((g) => g.gene === symbol)!;

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
    links: [{
      href: "https://pubmed.ncbi.nlm.nih.gov/37063705",
      label: "View on PubMed",
    }],
  });
});

Deno.test("a trial's genetic target resolves to its NCBI record", () => {
  assertEquals(trialGeneTooltip("FGA")?.rows.length, 3);
});

/**
 * COL4A1/2 is the curators' label for the collagen IV pair, which no NCBI or
 * UniProt record carries. Both lookups now name each gene with its own record,
 * where they used to publish nothing for the row at all.
 */
Deno.test("COL4A1/2's tooltips name both collagen genes", () => {
  assertEquals(geneTooltip("COL4A1/2")?.links, [
    {
      href: "https://www.ncbi.nlm.nih.gov/gene/1282",
      label: "View COL4A1 on NCBI Gene",
    },
    {
      href: "https://www.ncbi.nlm.nih.gov/gene/1284",
      label: "View COL4A2 on NCBI Gene",
    },
  ]);
  assertEquals(
    proteinTooltip("COL4A1/2")?.rows.map((row) => row.value),
    ["COL4A1", "P02462", "COL4A2", "P08572"],
  );
  assertEquals(
    phenogramTooltip(gene("COL4A1/2")).links?.map((link) => link.label),
    ["View COL4A1 on NCBI Gene", "View COL4A2 on NCBI Gene"],
  );
});

Deno.test("protein and OMIM tooltips return the committed records", () => {
  assertEquals(proteinTooltip("LAMB1")?.links, [{
    href: "https://www.uniprot.org/uniprotkb/P07942/entry",
    label: "View on UniProt",
  }]);
  assertEquals(omimTooltip(" 617168 ")?.rows, [
    { label: "Phenotype", value: "Aortic aneurysm, familial thoracic 10" },
    { label: "Inheritance", value: "AD" },
    { label: "Gene or Locus", value: "LOX" },
    { label: "Gene or Locus MIM Number", value: "153455" },
  ]);
});

// The OMIM rows gold's monogenic prose adds carry the phenotype, the number,
// the inheritance and the gold gene; gold gives no gene MIM number, which the
// tooltip says rather than leaving a blank row.
Deno.test("an OMIM entry built from gold prose renders what gold gives", () => {
  assertEquals(omimTooltip("621424"), {
    rows: [
      {
        label: "Phenotype",
        value: "Hippocampal Memory Defect and a Leukoencephalopathy",
      },
      { label: "Inheritance", value: "AD" },
      { label: "Gene or Locus", value: "LAMB1" },
      { label: "Gene or Locus MIM Number", value: "Not available" },
    ],
    links: [{
      href: "https://www.omim.org/entry/621424?search=621424&highlight=621424",
      label: "View on OMIM",
    }],
  });
});

Deno.test("phenogramTooltip names the location, the evidence and the NCBI link", () => {
  assertEquals(phenogramTooltip(gene("JAK1")), {
    rows: [
      { label: "Location", value: "1p31.3" },
      { label: "GWAS phenotypes", value: "PSMD" },
      {
        label: "Other omics",
        value: "TWAS (Brain cerebellum, brain frontal cortex BA9)",
      },
      {
        label: "Monogenic disease",
        value: "Autoinflammation, immune dysregulation, and eosinophilia",
      },
      { label: "Mendelian randomization", value: "No" },
    ],
    links: [{
      href: "https://www.ncbi.nlm.nih.gov/gene/3716",
      label: "View on NCBI Gene",
    }],
  });
});

// LAMB1's monogenic link is the gold table's OMIM 621424, named by its
// phenotype; its GWAS and other-omics cells are empty, so they carry the
// None found rows.
Deno.test("phenogramTooltip says None found rather than the sentinel, and uses display labels", () => {
  const lamb1 = phenogramTooltip(gene("LAMB1"));
  assertEquals(lamb1.rows.map((r) => r.value), [
    "7q31.1",
    "None found",
    "None found",
    "Hippocampal Memory Defect and a Leukoencephalopathy",
    "No",
  ]);
  assertEquals(
    lamb1.links?.[0]?.href,
    "https://www.ncbi.nlm.nih.gov/gene/3912",
  );

  const cenpf = phenogramTooltip(gene("CENPF"));
  assertEquals(cenpf.rows[1].value, "WM-PVS; HIP-PVS; PSMD");
  assertEquals(cenpf.rows[3].value, "Stromme syndrome");
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
  assertEquals(content.links, [{
    href: "https://doi.org/10.1016/S1474-4422(23)00131-X",
    label: "View STRIVE-2 (Lancet Neurol 2023)",
  }]);

  const psmd = encoding.traits.find((t) => t.key === "PSMD")!;
  assertEquals(phenotypeTooltip(psmd), {
    rows: [{
      label: "PSMD",
      value: "Peak width of skeletonized mean diffusivity",
    }],
    links: [],
  });
});

Deno.test("a cSVD cell type expands to its glossary name", () => {
  assertEquals(cellTypeTooltip("EC"), {
    rows: [{ label: "EC", value: "Endothelial Cells" }],
  });
});

Deno.test("a cSVD cell subtype names the subtype, and a source note is kept", () => {
  assertEquals(cellTypeTooltip("Matrix, PC"), {
    rows: [{ label: "Matrix PC", value: "Matrix Pericytes" }],
  });
  assertEquals(cellTypeTooltip("Parenchymal, pvFB"), {
    rows: [{
      label: "Parenchymal pvFB",
      value: "Parenchymal Perivascular Fibroblasts",
    }],
  });
  assertEquals(cellTypeTooltip("Exc Neu (allen brain atlas)"), {
    rows: [{
      label: "Exc Neu",
      value: "Excitatory Neurons (allen brain atlas)",
    }],
  });
  assertEquals(cellTypeTooltip("Matrix, ZZ"), null);
});
