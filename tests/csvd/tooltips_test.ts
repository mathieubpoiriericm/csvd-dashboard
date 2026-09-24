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
    link: {
      href: "https://pubmed.ncbi.nlm.nih.gov/37063705",
      label: "View on PubMed",
    },
  });
});

Deno.test("a trial's genetic target resolves to its NCBI record", () => {
  assertEquals(trialGeneTooltip("FGA")?.rows.length, 3);
});

Deno.test("protein and OMIM tooltips return the committed records", () => {
  assertEquals(proteinTooltip("LAMB1")?.link, {
    href: "https://www.uniprot.org/uniprotkb/P07942/entry",
    label: "View on UniProt",
  });
  assertEquals(omimTooltip(" 617168 ")?.rows, [
    { label: "Phenotype", value: "Aortic aneurysm, familial thoracic 10" },
    { label: "Inheritance", value: "AD" },
    { label: "Gene or Locus", value: "LOX" },
    { label: "Gene or Locus MIM Number", value: "153455" },
  ]);
});

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

Deno.test("a cSVD cell type expands to its glossary name", () => {
  assertEquals(cellTypeTooltip("EC"), {
    rows: [{ label: "EC", value: "Endothelial Cells" }],
  });
});
