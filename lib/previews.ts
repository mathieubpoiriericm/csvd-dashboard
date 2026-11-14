/**
 * The features that work today and are still in preview. The hub page, the
 * navigation strip and the pages' own notes all render from this list, so a
 * feature's name, address and wording live here and nowhere else.
 */
import type { IconName } from "../components/Icon.tsx";
import { formatCount } from "./format.ts";

export type PreviewKey = "pipeline" | "adapt" | "review";

export interface PreviewSubpage {
  href: string;
  label: string;
}

export interface PreviewFeature {
  key: PreviewKey;
  href: string;
  /** The switcher's short name. */
  name: string;
  /** The card's heading. */
  title: string;
  /** The card's sentences. */
  summary: string;
  icon: IconName;
  /** Pages inside the feature that the switcher's second row links. */
  subpages: readonly PreviewSubpage[];
}

export const PREVIEWS_PATH = "/previews";
export const PIPELINE_PREVIEW_PATH = "/previews/pipeline";
export const PREVIEWS_LABEL = "New Feature Previews";
export const PREVIEWS_LEAD =
  "Features that work today and are still in preview. Pick one to open it.";
export const PREVIEWS_TIP =
  "New. Three features in preview: the pipeline run, the disease adaptation guide and the scientific review committee.";
export const PREVIEW_NOTE_LABEL = "Technical preview:";

const ADAPT_PATH = "/adapt";
const REVIEW_PATH = "/review";

const NOT_ELSEWHERE = "Its findings are not in the other pages.";

/** The run's window in words, or nothing when the report does not say. */
function windowPhrase(daysBack: number | null): string {
  if (daysBack === null || daysBack === 0) return "";
  return daysBack === 1
    ? " over the last day of publications"
    : ` over the last ${formatCount(daysBack)} days of publications`;
}

export function previewNote(daysBack: number | null): string {
  return `A real pipeline run${windowPhrase(daysBack)}. ${NOT_ELSEWHERE}`;
}

/**
 * The features on offer, in the order the switcher shows them. The guide needs
 * nothing committed; the run and the review exist only when their data does.
 */
export function previewFeatures(
  available: { pipeline: boolean; review: boolean },
  daysBack: number | null,
): PreviewFeature[] {
  const features: PreviewFeature[] = [];
  const window = windowPhrase(daysBack);
  if (available.pipeline) {
    features.push({
      key: "pipeline",
      href: PIPELINE_PREVIEW_PATH,
      name: "Pipeline run",
      title: "Pipeline run",
      summary: `A real run of the literature pipeline${window}: ` +
        `what it read, what it proposed and how each step went. ${NOT_ELSEWHERE}`,
      icon: "arrowPath",
      subpages: [],
    });
  }
  features.push({
    key: "adapt",
    href: ADAPT_PATH,
    name: "Adaptation guide",
    title: "Disease adaptation guide",
    summary:
      "Build this dashboard for another disease: answer nine questions, have them checked against PubMed, the ontology services and ClinicalTrials.gov, and download the folder for a fork.",
    icon: "arrowsRightLeft",
    subpages: [],
  });
  if (available.review) {
    features.push({
      key: "review",
      href: REVIEW_PATH,
      name: "Review committee",
      title: "Scientific review committee",
      summary:
        "How a committee would review what a pipeline run changed, gene by gene. The changes come from a real run; the committee and its verdicts are simulated. Member sign-in opens when the committee is formed; until then anyone can look around as an observer.",
      icon: "checkBadge",
      subpages: [
        { href: REVIEW_PATH, label: "Review queue" },
        { href: `${REVIEW_PATH}/progress`, label: "Committee progress" },
      ],
    });
  }
  return features;
}

/** Whether a path is a root or a page under one: `/reviewers` is neither. */
function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function isPreviewPath(pathname: string): boolean {
  return under(pathname, PREVIEWS_PATH) || under(pathname, ADAPT_PATH) ||
    under(pathname, REVIEW_PATH);
}

/** The feature a page belongs to; the hub itself belongs to none. */
export function currentPreview(pathname: string): PreviewKey | null {
  if (under(pathname, PIPELINE_PREVIEW_PATH)) return "pipeline";
  if (under(pathname, ADAPT_PATH)) return "adapt";
  if (under(pathname, REVIEW_PATH)) return "review";
  return null;
}
