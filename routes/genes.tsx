import { define } from "../utils.ts";
import GenesView from "../islands/GenesView.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";

export default define.page(function Genes() {
  return (
    <Page
      title="Putative Causal Genes"
      description="Genes implicated in cerebral small vessel disease (SVD), with the GWAS, omics and monogenic evidence supporting each one."
    >
      <div class="tip-row">
        <TipBox>
          Elements with a grey background have tooltips. Hover over or activate
          them to see additional information.
        </TipBox>
        <TipBox>
          Activate a highlighted element to see details and reach external links
          via the link button in the tooltip.
        </TipBox>
      </div>

      <GenesView />
    </Page>
  );
});
