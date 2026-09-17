import { define } from "../utils.ts";
import TrialsTimeline from "../islands/TrialsTimeline.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Page } from "../components/Page.tsx";
import { PAGE_DESCRIPTIONS } from "../lib/disease/site.ts";

/**
 * The trials radar, drawn in-app from data/table2.json. It replaced a
 * sandboxed iframe around a pre-rendered SVG that a Python script in the Shiny
 * pipeline used to generate; the print version of the same figure is
 * scripts/timeline_figure.py.
 */
export default define.page(function Timeline() {
  return (
    <Page
      title="Trials Radar"
      description={PAGE_DESCRIPTIONS.timeline}
    >
      <div class="tip-row">
        <TipBox>
          Hover over plot elements to display tooltips, or select a drug name or
          marker to open the trial details panel.
        </TipBox>
        <TipBox label="Visually-inspired by:">
          Fig. 1 in Cummings, J.{" "}
          <em>et al.</em>, Alzheimer's disease drug development pipeline: 2023,
          {" "}
          <em>Alzheimer's Dement.</em> (May 2023){" "}
          <a
            href="https://pubmed.ncbi.nlm.nih.gov/37251912/"
            target="_blank"
            rel="noopener noreferrer"
          >
            DOI: 10.1002/trc2.12385
          </a>
        </TipBox>
      </div>

      <TrialsTimeline />
    </Page>
  );
});
