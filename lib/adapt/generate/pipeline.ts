import type { Answers } from "../answers.ts";
import { clean, jsonText } from "./json.ts";

/**
 * A MeSH heading per phrase, in the phrases' order, once each: two phrases
 * often resolve to one heading, and a row that no longer names its phrase
 * -- one left from a phrase since removed or retyped -- is no longer an
 * answer.
 */
export function meshHeadings(
  answers: Answers,
): Array<{ heading: string; count: number | null }> {
  const { diseaseTerms, meshTerms } = answers.search;
  const seen = new Set<string>();
  const out: Array<{ heading: string; count: number | null }> = [];
  diseaseTerms.forEach((phrase, i) => {
    const m = meshTerms[i];
    if (
      m === undefined || m.heading === null || clean(m.phrase) !== clean(phrase)
    ) return;
    // Written, and told apart, as the file spells it.
    const heading = clean(m.heading);
    if (heading === "" || seen.has(heading)) return;
    seen.add(heading);
    out.push({ heading, count: m.count });
  });
  return out;
}

/**
 * A condition as clinical_trials_fetch.py compares one: it lower-cases the
 * trial's stated condition before looking for the substring, so a
 * substring written with a capital could never match.
 */
const condition = (value: string): string => clean(value).toLowerCase();

export function generatePipeline(answers: Answers): string {
  const { search, trials, monogenic } = answers;
  // Built from entries, so no spelling can set the object's prototype.
  const geneAliases = Object.fromEntries(
    monogenic.aliases.map((alias) => [
      clean(alias.alias),
      alias.symbols.map(clean),
    ]),
  );
  const mesh = meshHeadings(answers);
  return jsonText({
    schemaVersion: 1,
    $comment:
      "Read only by pipeline/disease.py. Gene symbols and search terms belong here, never in disease/manifest.json, because every island bundle embeds that file. Written by the adapt wizard; the counts in the comments below are the PubMed and ClinicalTrials.gov totals seen when the terms were chosen.",
    search: {
      pubmed: {
        $comment: mesh
          .map((m) => `${m.heading}: ${m.count ?? "?"} papers all-time`)
          .join("; "),
        diseaseTerms: search.diseaseTerms.map(clean),
        markerTerms: search.markerTerms.map((m) => clean(m.term)),
        meshTerms: mesh.map((m) => m.heading),
      },
      clinicalTrials: {
        $comment: trials.searchTerms
          .map((t) => `${clean(t.term)}: ${t.count ?? "?"} studies`)
          .join("; "),
        searchTerms: trials.searchTerms.map((t) => clean(t.term)),
        conditions: trials.conditions.map(condition),
        conditionPairs: trials.conditionPairs.map((
          [a, b],
        ) => [condition(a), condition(b)]),
      },
    },
    monogenicGenes: monogenic.genes.map((g) => clean(g.symbol)),
    geneAliases,
    pipeline: {
      runLabel: `${clean(answers.identity.disease.abbreviation)} Pipeline`,
      maxGenesPerPaper: 20,
    },
  });
}
