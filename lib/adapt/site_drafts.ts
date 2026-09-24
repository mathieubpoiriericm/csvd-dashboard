import type { Identity } from "./answers.ts";
import { clean } from "./generate/json.ts";

/**
 * Each word's first letter in capitals, for a heading. A word starts after
 * a space, a hyphen, a slash or an opening bracket -- not after `\b`, which
 * counts only ASCII letters as a word even under /u, so it wrote
 * "Alzheimer'S" and "MéNièRe'S". Only a lower-case Latin letter is raised,
 * and only in a word with no capital of its own: a Greek letter keeps its
 * case ("β-thalassemia" read as "B-Thalassemia" with a capital beta), as do
 * "mTOR" and "tRNA".
 */
export function titleCase(name: string): string {
  return name.replace(
    /(^|[\s(/\u2010-\u2014-])(\p{Script=Latin})([^\s(/\u2010-\u2014-]*)/gu,
    (word: string, before: string, letter: string, rest: string) =>
      /\p{Ll}/u.test(letter) && !/\p{Lu}/u.test(rest)
        ? before + letter.toUpperCase() + rest
        : word,
  );
}

/**
 * The site strings drafted from the identity answers by the interview's
 * templates. The researcher edits prose more readily than they compose it,
 * so every string is shown as an editable field.
 *
 * The names are read as the generated files write them, trimmed. A line
 * whose names are not all typed yet is drafted blank, so it stays a
 * question rather than reading "  Dashboard" and counting as answered.
 */
export function draftSite(
  disease: Identity["disease"],
  institute: Identity["institute"],
): Identity["site"] {
  const name = clean(disease.name);
  const abbreviation = clean(disease.abbreviation);
  const adjective = clean(disease.adjective);
  const instituteName = clean(institute.name);
  const short = clean(institute.short);
  const line = (needs: string[], text: () => string) =>
    needs.every((part) => part !== "") ? text() : "";
  const named = `${name} (${abbreviation})`;
  const namedBy = [name, abbreviation];
  // "The Francis Crick Institute" brings its own article.
  const the = /^the\s/i.test(instituteName) ? "" : "the ";
  return {
    title: line([short, adjective], () => `${short} ${adjective} Dashboard`),
    heading: line(
      [name],
      () =>
        `Putative Causal Genes and Clinical Trial Drugs for ${titleCase(name)}`,
    ),
    metaDescription: line(
      [name, instituteName, short],
      () =>
        `Interactive dashboard of putative causal genes and clinical trial drugs for ${name}, from ${the}${instituteName} (${short}).`,
    ),
    aboutTitle: line(
      [instituteName, adjective],
      () => `Welcome to ${the}${instituteName}'s ${adjective} Dashboard`,
    ),
    aboutLede: line(
      [...namedBy, adjective],
      () =>
        `This dashboard provides up-to-date and standardized information on putative ${named} causal genes and drugs tested in planned or ongoing ${adjective} clinical trials.`,
    ),
    loginLede: line(
      namedBy,
      () => `Putative causal genes and clinical trial drugs for ${named}.`,
    ),
    pages: {
      genes: line(
        namedBy,
        () =>
          `Genes implicated in ${named}, with the GWAS, omics and monogenic evidence supporting each one.`,
      ),
      trials: line(
        namedBy,
        () =>
          `Drugs tested in planned or ongoing ${named} trials, grouped by drug.`,
      ),
      timeline: line(
        namedBy,
        () =>
          `Planned and ongoing ${named} trials, arranged by target population and trial phase.`,
      ),
      map: line(
        namedBy,
        () => `Facility locations for the registered ${named} trials.`,
      ),
    },
  };
}

const SITE_KEYS = [
  "title",
  "heading",
  "metaDescription",
  "aboutTitle",
  "aboutLede",
  "loginLede",
] as const;
const PAGE_KEYS = ["genes", "trials", "timeline", "map"] as const;

/**
 * Apply `edit` to the names the site strings are drafted from, then
 * redraft every string still on its draft: blank, or exactly what the old
 * names drafted. A string the researcher has written is left alone, so
 * editing one line stops that line -- and only that line -- following the
 * names.
 */
export function redraftSite(
  identity: Identity,
  edit: (identity: Identity) => void,
): void {
  const before = draftSite(identity.disease, identity.institute);
  edit(identity);
  const after = draftSite(identity.disease, identity.institute);
  const next = (current: string, was: string, now: string) =>
    current.trim() === "" || current === was ? now : current;
  const { site } = identity;
  for (const key of SITE_KEYS) {
    site[key] = next(site[key], before[key], after[key]);
  }
  for (const key of PAGE_KEYS) {
    site.pages[key] = next(
      site.pages[key],
      before.pages[key],
      after.pages[key],
    );
  }
}
