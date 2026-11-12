/**
 * What the suite expects of the committed data, derived rather than restated.
 *
 * `expected.deno.ts` computes every count under Deno from the app's own
 * `lib/` over `data/*.json` and `disease/`; this module runs it once per
 * Playwright process and exposes the result. Regenerating the data or
 * changing the disease therefore changes these expectations with it, and on
 * the empty export a fork starts from every count is zero -- which is why
 * the specs that click a first row or hover a first marker guard on these
 * counts rather than assume one.
 *
 * Playwright loads this file as CommonJS, so `__dirname` rather than
 * `import.meta.url` (see e2e/CLAUDE.md), and the derivation runs through a
 * child `deno run` because Node cannot import the app's JSON-attributed
 * modules.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Expected } from "./expected.deno.ts";

const ROOT = join(__dirname, "..", "..");

export const EXPECTED: Expected = JSON.parse(
  execFileSync("deno", ["run", "-A", join(__dirname, "expected.deno.ts")], {
    cwd: ROOT,
    encoding: "utf8",
  }),
);

export const SITE_TITLE = EXPECTED.siteTitle;
export const ABOUT_HEADING = EXPECTED.aboutHeading;
export const POPULATION_LABEL = EXPECTED.populationLabel;
export const TRAIT_COUNT = EXPECTED.traitCount;
export const INSTITUTE_ALT = EXPECTED.instituteAlt;
export const INSTITUTE_COPYRIGHT = EXPECTED.instituteCopyright;
export const MAINTAINER_EMAIL = EXPECTED.maintainerEmail;

/**
 * Rows the two tables show on first paint: genes are unfiltered, and trials
 * start from the default status selection -- every status but Completed,
 * Suspended and Unknown, or all of them under gold-only.
 */
export const GENE_TOTAL = EXPECTED.geneRows;
export const TRIAL_TOTAL = EXPECTED.trialRows;
export const TRIAL_SHOWN = EXPECTED.trialRowsShown;
/** The status group's banner fragment on first paint; null when it starts at Show All (`GOLD_ONLY`). */
export const STATUS_SUMMARY: string | null = EXPECTED.statusSummary;
/** The banner summary on first paint: the status fragment, or "None". */
export const DEFAULT_SUMMARY = STATUS_SUMMARY ?? "None";
/** `summary` with the status default's fragment after it, when there is one. */
export const withStatusSummary = (summary: string): string =>
  STATUS_SUMMARY === null ? summary : `${summary} | ${STATUS_SUMMARY}`;

/** Pages a table of `rows` needs at the default page size of ten. */
export const pagesFor = (rows: number): number => Math.ceil(rows / 10);

/**
 * The review area's figures and copy, or null when there is no review round
 * (none committed, or gold-only off): the area then does not exist at all.
 */
export const REVIEW: Expected["review"] = EXPECTED.review;
