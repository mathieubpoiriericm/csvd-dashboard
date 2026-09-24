import type { ComponentChildren } from "preact";

import { define } from "../utils.ts";
import { Page } from "../components/Page.tsx";
import { ValueBox } from "../components/ValueBox.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { formatLongDate } from "../lib/constants.ts";
import {
  drugCount,
  geneCount,
  publicationCount,
  trialCount,
} from "../lib/data/summary.ts";
import { pipelineStatus } from "../lib/data/pipeline.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import PipelineRunView from "../islands/PipelineRun.tsx";
import { PipelineSyncs } from "../components/PipelineSyncs.tsx";
import { pipelineSyncs } from "../lib/data/pipeline_syncs.ts";
import {
  ABOUT,
  ABOUT_LEDE,
  ABOUT_TITLE,
  MAINTAINER,
} from "../lib/disease/site.ts";
import type { PipelineRun, PipelineStatus, SyncRun } from "../lib/types.ts";

const INFO_ROWS: ReadonlyArray<{
  icon: IconName;
  label: string;
  value: ComponentChildren;
  /** Rendered muted and italic: a placeholder, not a value. */
  pending?: boolean;
}> = [
  ABOUT.citation === null
    ? {
      icon: "chatQuote",
      label: "How to Cite:",
      value: (
        <>
          Last Name, Initial. <i>et al.</i> Publication Title. <i>Journal.</i>
          {" "}
          (Publication Year) DOI
        </>
      ),
      pending: true,
    }
    : {
      icon: "chatQuote",
      label: "How to Cite:",
      value: (
        <>
          {ABOUT.citation.authors} {ABOUT.citation.title}.{" "}
          <i>{ABOUT.citation.journal}.</i> ({ABOUT.citation.year}){" "}
          <a href={`https://doi.org/${ABOUT.citation.doi}`}>
            {ABOUT.citation.doi}
          </a>
        </>
      ),
    },
  {
    icon: "userGroup",
    label: "Scientific Board:",
    value: ABOUT.board ?? "To be confirmed",
    pending: ABOUT.board === null,
  },
  {
    icon: "identification",
    label: "Contact Us:",
    value: ABOUT.contactUs ?? "To be confirmed",
    pending: ABOUT.contactUs === null,
  },
  {
    icon: "arrowPath",
    label: "Maintenance:",
    value: (
      <a
        class="about-contact"
        href={`mailto:${MAINTAINER.email}`}
        aria-label={`Email ${MAINTAINER.name} at ${MAINTAINER.email}`}
      >
        <Icon name="envelope" />
        {MAINTAINER.name}
      </a>
    ),
  },
  {
    icon: "checkBadge",
    label: "Acknowledgements:",
    value: ABOUT.acknowledgements ?? "To be confirmed",
    pending: ABOUT.acknowledgements === null,
  },
];

/**
 * The machine-fetched annotation sources.
 *
 * Attribution here is a licence obligation, not a courtesy: Orphadata is
 * CC-BY-4.0 and asserts that in every payload, and the pipeline logs an error
 * if the asserted licence ever changes. ClinVar and Open Targets ask to be
 * cited rather than requiring it, and are listed on the same footing so a
 * reader can see every source the disease annotations came from in one place.
 */
const DATA_SOURCES: ReadonlyArray<{
  name: string;
  href: string;
  licence: ComponentChildren;
  provides: string;
}> = [
  {
    name: "ClinVar",
    href: "https://www.ncbi.nlm.nih.gov/clinvar/",
    licence: "NCBI, public domain",
    provides:
      "Monogenic disease associations and their clinical significance, " +
      "from pathogenic variant records.",
  },
  {
    name: "Orphanet / Orphadata",
    href: "https://www.orphadata.com/",
    licence: (
      <a
        href="https://creativecommons.org/licenses/by/4.0"
        target="_blank"
        rel="noopener noreferrer"
      >
        CC BY 4.0
      </a>
    ),
    provides:
      "Cross-references between disease vocabularies, with the mapping " +
      "relation that says when a code is broader or narrower rather than " +
      "equivalent, and HPO phenotype frequencies.",
  },
  {
    name: "Open Targets Platform",
    href: "https://platform.opentargets.org/",
    licence: (
      <a
        href="https://creativecommons.org/publicdomain/zero/1.0/"
        target="_blank"
        rel="noopener noreferrer"
      >
        CC0 1.0
      </a>
    ),
    provides:
      "Gene identity anchors, ranked disease associations, Gene Ontology " +
      "terms, and the ChEMBL mechanisms the trial drugs are checked against.",
  },
];

const ALL_SOURCES = [
  ...DATA_SOURCES,
  ...ABOUT.additionalSources.map((s) => ({
    name: s.name,
    href: s.href,
    licence: s.licence.href
      ? (
        <a href={s.licence.href} target="_blank" rel="noopener noreferrer">
          {s.licence.label}
        </a>
      )
      : s.licence.label,
    provides: s.provides,
  })),
];

/** The four headline totals, in the order they read across the hero. */
const KPIS: ReadonlyArray<{ icon: IconName; label: string; value: number }> = [
  { icon: "dna", label: "Putative Causal Genes", value: geneCount },
  { icon: "molecule", label: "Drugs Tested", value: drugCount },
  { icon: "beaker", label: "Clinical Trials", value: trialCount },
  {
    icon: "documentText",
    label: "Publications",
    value: publicationCount,
  },
];

interface AboutContentProps {
  status?: PipelineStatus | null;
  run?: PipelineRun | null;
  syncs?: SyncRun[];
}

type PipelineCount = Exclude<keyof PipelineStatus, "runTimestamp">;

const PIPELINE_COUNTS: ReadonlyArray<[PipelineCount, string]> = [
  ["papersProcessed", "Papers Processed"],
  ["fulltextRetrieved", "Full-Text Retrieved"],
  ["genesExtracted", "Genes Extracted"],
  ["genesValidated", "Genes Validated"],
];

export function AboutContent(
  {
    status = pipelineStatus,
    run = pipelineRun,
    syncs = pipelineSyncs,
  }: AboutContentProps,
) {
  const runDateLabel = formatLongDate(status?.runTimestamp);

  return (
    <Page
      contained
      header={
        <>
          <p class="notice notice-warning about-warning">
            <strong>
              This is a preview of a dashboard that is still a work in progress.
            </strong>
          </p>

          <div class="card about-hero">
            <div class="card-body">
              {
                /* Groups the badge and heading into one grid item: at >=900px
                `.about-hero .card-body` becomes a two-column grid, and
                without this wrapper the badge and <h1> would auto-place into
                separate columns instead of sitting together in the first one
                beside .about-lede. */
              }
              <div class="about-hero-head">
                {runDateLabel
                  ? (
                    <span class="date-badge">
                      <Icon name="calendar" />
                      Up to date as of {runDateLabel}
                    </span>
                  )
                  : (
                    <span class="date-unavailable">
                      Data update date unavailable
                    </span>
                  )}

                <h1>{ABOUT_TITLE}</h1>
              </div>
              <p class="about-lede">{ABOUT_LEDE}</p>

              {
                /* A <section> rather than a <div>: the accessible name only
                promotes this to a landmark on a sectioning element, and the
                e2e finds it by that role. */
              }
              <section class="about-kpis" aria-label="Dashboard totals">
                {KPIS.map(({ icon, label, value }) => (
                  <div class="about-kpi" key={label}>
                    <span class="about-kpi-badge">
                      <Icon name={icon} />
                    </span>
                    <div class="about-kpi-text">
                      <div class="about-kpi-value">
                        {value.toLocaleString("en-US")}
                      </div>
                      <span class="about-kpi-label">{label}</span>
                    </div>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </>
      }
    >
      {
        /* The widget when a run has recorded a full report; the summary
          card otherwise. data/pipeline_run.json is `null` until the first
          run writes one, and a database that has not taken migration 009
          (the run report column) keeps it that way, so the fallback is a
          real state rather than a defensive branch. */
      }
      {run ? <PipelineRunView /> : status && (
        <div class="card">
          <div class="card-body">
            <h2 class="card-title">Last Pipeline Run</h2>
            <p class="pipeline-status-timestamp">
              {runDateLabel ?? "Date unavailable"}
            </p>
            <div class="value-box-row">
              {PIPELINE_COUNTS.map(([key, label]) => (
                <ValueBox key={key} label={label} value={status[key]} />
              ))}
            </div>
          </div>
        </div>
      )}

      {
        /* The reference-data refreshes, beside whichever of the two above
          rendered rather than instead of one: a refresh is a different
          event from a run, not a second account of the same one. It sits
          above the two-column grid whose right column is Data Sources, the
          panel whose names it echoes. */
      }
      <PipelineSyncs runs={syncs} />

      <div class="about-grid">
        <div class="card">
          <div class="card-body">
            <h2 class="card-title">
              <Icon name="identification" />
              Citation &amp; Contact
            </h2>
            {INFO_ROWS.map((row) => (
              <div class="about-row" key={row.label}>
                <Icon name={row.icon} />
                <span class="about-info-label">{row.label}</span>
                <div
                  class={`about-row-value${row.pending ? " is-pending" : ""}`}
                >
                  {row.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div class="card">
          <div class="card-body">
            <h2 class="card-title">
              <Icon name="circleStack" />
              Data Sources
            </h2>
            <p class="about-sources-note">
              The curated gene and trial tables are maintained by hand. The
              disease annotations beside them are fetched from these reference
              databases and stored separately, so a curated value is never
              overwritten by a machine-fetched one.
            </p>
            {ALL_SOURCES.map((source) => (
              <div class="about-source-card" key={source.name}>
                <div class="about-source-head">
                  <Icon name="circleStack" />
                  <span class="about-source-label">
                    <a
                      href={source.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.name}
                    </a>
                  </span>
                  <span class="about-chip">{source.licence}</span>
                </div>
                <p class="about-source-text">{source.provides}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h2 class="card-title">
            <Icon name="arrowsRightLeft" />
            Reuse this dashboard for another disease
          </h2>
          <p class="about-sources-note">
            The code is disease-neutral; everything that names this disease
            lives in one folder. A step-by-step page collects the answers,
            checks them against PubMed, the ontology services and
            ClinicalTrials.gov, and downloads that folder for a fork.
          </p>
          <a class="about-contact" href="/adapt">
            <Icon name="documentText" />
            Open the adaptation guide
          </a>
        </div>
      </div>
    </Page>
  );
}

export default define.page(function About() {
  return <AboutContent />;
});
