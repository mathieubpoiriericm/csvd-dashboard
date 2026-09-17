import { define } from "../utils.ts";
import TrialsMap from "../islands/TrialsMap.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";
import { PAGE_DESCRIPTIONS } from "../lib/disease/site.ts";

export default define.page(function Map() {
  return (
    <Page
      title="Trials Map"
      description={PAGE_DESCRIPTIONS.map}
    >
      <div class="tip-row">
        {
          /*
          Load-bearing, not decoration: the facility feed is ClinicalTrials.gov
          only, so it covers just the NCT-registered trials -- 69 of the 77 --
          and only those with a geocoded site. Without this the map-stats line
          reads "for 69 registered trials" against a table of 102 rows with no
          explanation.
        */
        }
        <TipBox label="Note:">
          This map shows research sites from trials registered on{" "}
          <strong>ClinicalTrials.gov (NCT IDs only)</strong>. Trials from other
          registries (ISRCTN, ACTRN, ChiCTR) are not displayed.
        </TipBox>
        <TipBox>
          Click a cluster to zoom in and reveal the individual sites. Click a
          site marker for facility details and a link to ClinicalTrials.gov.
        </TipBox>
      </div>

      <TrialsMap />
    </Page>
  );
});
