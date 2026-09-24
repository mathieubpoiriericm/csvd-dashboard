import { define } from "../utils.ts";
import TrialsView from "../islands/TrialsView.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";
import { PAGE_DESCRIPTIONS } from "../lib/disease/site.ts";

export default define.page(function Trials() {
  return (
    <Page
      title="Clinical Trials"
      description={PAGE_DESCRIPTIONS.trials}
    >
      <div class="tip-row">
        <TipBox>
          Rows are merged by drug. Sorting by another column ungroups them.
        </TipBox>
        <TipBox>
          Registry IDs and genetic targets carry tooltips with links to the
          source record.
        </TipBox>
      </div>

      <TrialsView />
    </Page>
  );
});
