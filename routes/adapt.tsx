import { define } from "../utils.ts";
import { Page } from "../components/Page.tsx";
import { TipBox } from "../components/TipBox.tsx";
import AdaptWizard from "../islands/AdaptWizard.tsx";

const NEEDS: ReadonlyArray<[string, string]> = [
  [
    "A researcher who knows the disease",
    "The nine questions are scientific judgements; the wizard checks shape and looks things up, it does not decide.",
  ],
  [
    "A GitHub account and a terminal",
    "The archive is unpacked into a fork of the repository; the checklist it carries lists what remains: commands, a few hand edits and the deploy settings.",
  ],
  [
    "Deno, uv, Node and PostgreSQL",
    "Installed on the machine that runs the pipeline; the guide names the versions.",
  ],
  [
    "An Anthropic API key",
    "The only paid step: about 0.09 USD per paper, so a query retrieving 800 papers a year costs about 70 USD a year.",
  ],
  [
    "A free NCBI API key",
    "Optional here and for the pipeline; without one NCBI allows three requests a second.",
  ],
];

/**
 * The adaptation guide as a page: the interview from the new-disease skill,
 * with the same lookups, ending in a download of the disease/ folder and
 * the checklist of what is left. It reads no data and embeds none.
 */
export default define.page(function AdaptPage() {
  return (
    <Page
      contained
      title="Adapt this dashboard to another disease"
      description="Answer the interview below and download a ready disease/ folder for your fork. Every word that names the disease lives in that folder; the code, the pipeline and the tests hold for any disease of this class."
    >
      <div class="tip-row">
        <TipBox>
          Your answers are saved in this browser as you go. Nothing is sent
          anywhere except the lookups to NCBI, the EBI Ontology Lookup Service
          and ClinicalTrials.gov.
        </TipBox>
      </div>
      <div class="card">
        <div class="card-body">
          <h2 class="card-title">Before you start</h2>
          {NEEDS.map(([need, why]) => (
            <div class="about-row" key={need}>
              <span class="about-info-label">{need}</span>
              <div class="about-row-value">{why}</div>
            </div>
          ))}
          <p class="about-sources-note">
            The full guide is docs/adapting-to-your-disease.md in the
            repository; the checklist the wizard produces points into it.
          </p>
        </div>
      </div>
      <noscript>
        <p class="about-sources-note">
          The wizard needs JavaScript. Without it, the guide
          docs/adapting-to-your-disease.md in the repository walks the same
          interview by hand.
        </p>
      </noscript>
      <AdaptWizard />
    </Page>
  );
});
