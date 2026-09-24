import { define } from "../utils.ts";
import Phenogram from "../islands/Phenogram.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";

/**
 * The karyogram, drawn in-app from data/table1.json and the hg38 cytobands.
 * It replaced a sandboxed iframe around a PhenoGram raster with pixel-colour
 * hit-testing; the print version of the same figure is
 * scripts/phenogram_figure.py.
 */
export default define.page(function PhenogramPage() {
  return (
    <Page
      title="Phenogram"
      description="Chromosomal positions of the putative causal genes, with their GWAS phenotypes and supporting evidence."
    >
      <div class="tip-row">
        <TipBox>
          Hover over or activate a gene to see its location, phenotypes and
          evidence; hover over or activate a phenotype in the key for its
          definition. With a keyboard, focus the item and press Enter.
        </TipBox>
      </div>

      <Phenogram />
    </Page>
  );
});
