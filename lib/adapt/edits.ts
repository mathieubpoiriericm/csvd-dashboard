/**
 * Edits the steps make that reach past the one field typed into.
 *
 * A step's handlers cannot be reached from a test (see islands/CLAUDE.md),
 * so an edit with a consequence elsewhere in the answers lives here.
 */
import {
  alignMeshTerms,
  type Answers,
  type MeshChoice,
  type Search,
  type Trait,
} from "./answers.ts";
import type { Fetch } from "./lookups.ts";
import { clean } from "./generate/json.ts";
import { PMID } from "./validate.ts";

/**
 * The values a lookup asks about: each one once, as the files write it, in
 * list order, with the blanks left out. Rows holding the same value ask one
 * question, and its answer lands on every row still holding it.
 */
export function lookupValues(values: string[]): string[] {
  return [...new Set(values.map(clean).filter((value) => value !== ""))];
}

/**
 * The MeSH rows kept one per phrase (alignMeshTerms()) from the moment a
 * phrase exists, so removing a phrase shortens both lists at its index:
 * its row goes with it, checked or not, and the touched state under
 * `meshTerms` shifts the way the phrases' does (forgetRemoved()).
 */
function alignPhrases(search: Search) {
  search.meshTerms = alignMeshTerms(search.diseaseTerms, search.meshTerms);
}

/** Add a blank phrase, and the stand-in row beside it. */
export function addDiseaseTerm(draft: Answers) {
  draft.search.diseaseTerms.push("");
  alignPhrases(draft.search);
}

/**
 * The count query for one marker term, as the pipeline's marker branch
 * reads it: the term with any disease phrase, since pipeline/pubmed_search.py
 * joins every phrase with OR. A blank phrase is no anchor.
 */
export function markerCountQuery(phrases: string[], term: string): string {
  const anchors = lookupValues(phrases).map((p) => `"${p}"[Title/Abstract]`);
  return `(${anchors.join(" OR ")}) AND "${clean(term)}"[Title/Abstract]`;
}

/** Every marker count is anchored on every phrase, so a phrase change voids them. */
function voidMarkerCounts(search: Search) {
  for (const marker of search.markerTerms) marker.count = null;
}

/** Retype disease phrase `i`; the marker counts described the old phrases. */
export function setDiseaseTerm(draft: Answers, i: number, value: string) {
  draft.search.diseaseTerms[i] = value;
  alignPhrases(draft.search);
  voidMarkerCounts(draft.search);
}

/** Remove disease phrase `i` and the MeSH row beside it. */
export function removeDiseaseTerm(draft: Answers, i: number) {
  alignPhrases(draft.search);
  draft.search.diseaseTerms.splice(i, 1);
  draft.search.meshTerms.splice(i, 1);
  voidMarkerCounts(draft.search);
}

/**
 * Write a marker count onto every row still holding its term, provided the
 * phrases it was anchored on are still the phrases: a count taken against
 * other phrases describes another query. Returns whether one was written.
 */
export function applyMarkerCount(
  draft: Answers,
  phrases: string[],
  term: string,
  count: number,
): boolean {
  const anchors = lookupValues(draft.search.diseaseTerms).join("\n");
  if (anchors !== lookupValues(phrases).join("\n")) return false;
  const rows = draft.search.markerTerms.filter((m) =>
    clean(m.term) === clean(term)
  );
  for (const row of rows) row.count = count;
  return rows.length > 0;
}

/**
 * Whether phrase `i` still needs its MeSH lookup: no row answers it yet --
 * the one beside it names other words, or is not there -- or the one that
 * does has a heading whose count never came back. A row naming the phrase
 * with no heading is an answer, whether MeSH has none or the researcher
 * dropped it, and asking again would bring a dropped heading back.
 */
function meshPending(search: Search, i: number): boolean {
  const phrase = clean(search.diseaseTerms[i]);
  const row = search.meshTerms[i];
  if (phrase === "") return false;
  if (row === undefined || clean(row.phrase) !== phrase) return true;
  return row.heading !== null && row.count === null;
}

/** The phrases "Check MeSH headings" looks up: those still pending, once each. */
export function phrasesToCheck(search: Search): string[] {
  return lookupValues(
    search.diseaseTerms.filter((_, i) => meshPending(search, i)),
  );
}

/**
 * Write the row a MeSH lookup returned onto the phrases that asked: every
 * one still holding its words and still pending, found as the answer lands
 * rather than by the index it had when the lookup began, since a phrase
 * above can be removed meanwhile. The rows are aligned first, so a phrase
 * behind a blank or an unchecked one leaves no hole. Returns whether the
 * answer found a phrase; one removed, retyped or dropped meanwhile gets
 * nothing.
 */
export function writeMeshRow(
  draft: Answers,
  phrase: string,
  row: MeshChoice,
): boolean {
  const search = draft.search;
  const asked = [...search.diseaseTerms.keys()].filter((i) =>
    clean(search.diseaseTerms[i]) === clean(phrase) && meshPending(search, i)
  );
  if (asked.length === 0) return false;
  alignPhrases(search);
  for (const i of asked) search.meshTerms[i] = { ...row };
  return true;
}

/**
 * Write a study count and its samples onto every search term row still
 * holding the term, found as the answer lands: one removed or retyped
 * meanwhile gets nothing, and nothing lands on another row. Returns whether
 * one was written.
 */
export function applyTrialCount(
  draft: Answers,
  term: string,
  count: number,
  sample: { conditions: string[]; interventions: string[] },
): boolean {
  const rows = draft.trials.searchTerms.filter((s) =>
    clean(s.term) === clean(term)
  );
  for (const row of rows) {
    row.count = count;
    row.sampleConditions = sample.conditions;
    row.sampleInterventions = sample.interventions;
  }
  return rows.length > 0;
}

/** Retype search term `i`; its count and samples answered the old words. */
export function setTrialTerm(draft: Answers, i: number, value: string) {
  const row = draft.trials.searchTerms[i];
  row.term = value;
  row.count = null;
  row.sampleConditions = [];
  row.sampleInterventions = [];
}

/**
 * Carry a gene's new spelling to the answers that name it: the OMIM rows
 * and the alias members holding the old one, so "xyz1" checked as "XYZ1"
 * leaves no OMIM row naming a gene the list no longer holds. Compared
 * trimmed and case-sensitive, as validate() compares them: HGNC case
 * matters ("C9orf72").
 */
export function renameGene(draft: Answers, from: string, to: string) {
  const old = clean(from);
  if (old === "" || old === clean(to)) return;
  for (const row of draft.monogenic.omimRows) {
    if (clean(row.geneOrLocus) === old) row.geneOrLocus = to;
  }
  for (const alias of draft.monogenic.aliases) {
    alias.symbols = alias.symbols.map((s) => clean(s) === old ? to : s);
  }
}

/**
 * Write a gene check onto the row that asked: the first still holding the
 * symbol as typed and still unchecked, found as the answer lands, since a
 * row above can be removed meanwhile. The official spelling replaces the
 * typed one there and wherever else the answers name it. Returns whether a
 * row was found.
 */
export function applyGeneCheck(
  draft: Answers,
  typed: string,
  official: string | null,
  traits: Array<{ name: string; omim: string | null }>,
): boolean {
  const row = draft.monogenic.genes.find((g) =>
    g.verified === null && clean(g.symbol) === clean(typed)
  );
  if (row === undefined) return false;
  row.verified = official !== null;
  row.clinvarTraits = traits;
  if (official !== null && official !== row.symbol) {
    renameGene(draft, row.symbol, official);
    row.symbol = official;
  }
  return true;
}

/** Whether the OMIM entries already hold this gene's row for a ClinVar trait. */
export function hasOmimRow(
  answers: Answers,
  gene: string,
  trait: { name: string; omim: string | null },
): boolean {
  return answers.monogenic.omimRows.some((row) =>
    clean(row.geneOrLocus) === clean(gene) &&
    (trait.omim === null
      ? clean(row.phenotype) === clean(trait.name)
      : clean(row.omimNum) === trait.omim)
  );
}

/** The notes a term search writes, which a researcher's own are not. */
const TOP_HIT_NOTE = /^OLS4 top hit: /;
const NO_TERM_NOTE = /^no term in EFO, HP or MONDO for /;

/**
 * The term and note an ontology search writes: its top hit with the
 * alternatives listed, or none, noted as such.
 */
export function xrefAnswer(
  name: string,
  hits: Array<{ id: string; label: string }>,
): { xref: string | null; xrefNote: string } {
  if (hits.length === 0) {
    return {
      xref: null,
      xrefNote: `no term in EFO, HP or MONDO for "${name}"`,
    };
  }
  return {
    xref: hits[0].id,
    xrefNote: `OLS4 top hit: ${hits[0].label}; alternatives: ${
      hits.slice(1).map((h) => `${h.id} ${h.label}`).join("; ") || "none"
    }`,
  };
}

/**
 * Whether writing a search's answer would replace one the researcher chose:
 * a term other than the top hit, or a note of their own. The step asks
 * before it does.
 */
export function replacesChoice(
  trait: Trait,
  answer: { xref: string | null },
): boolean {
  const note = clean(trait.xrefNote);
  return (trait.xref !== null && trait.xref !== answer.xref) ||
    (note !== "" && !TOP_HIT_NOTE.test(note) && !NO_TERM_NOTE.test(note));
}

/**
 * Set a trait's ontology term by hand. Cleared, a note the search wrote
 * about its top hit goes with it: that note answered for the term, and a
 * trait with no term owes one saying why nothing fits.
 */
export function setXref(trait: Trait, value: string) {
  trait.xref = clean(value) === "" ? null : value;
  if (trait.xref === null && TOP_HIT_NOTE.test(clean(trait.xrefNote))) {
    trait.xrefNote = "";
  }
}

/**
 * Write a fetched abstract onto every example still citing its PMID; one
 * removed or retyped meanwhile gets nothing. A null abstract -- no such
 * record -- is written too, which keeps the example unconfirmed. Returns
 * whether one was written.
 */
export function applyAbstract(
  draft: Answers,
  pmid: string,
  abstract: string | null,
): boolean {
  const rows = draft.prompt.examples.filter((e) =>
    clean(e.pmid) === clean(pmid)
  );
  for (const row of rows) row.abstract = abstract;
  return rows.length > 0;
}

const plural = (n: number, noun: string, nouns = `${noun}s`) =>
  `${n} ${n === 1 ? noun : nouns}`;

/** What each lookup asks about, and what its negative answer is. */
const LOOKUPS = {
  mesh: ["Checked", "phrase", "with no MeSH heading"],
  markers: ["Counted", "marker term", ""],
  trials: ["Counted", "search term", ""],
  genes: ["Checked", "symbol", "not the official symbol of a human gene"],
  gold: ["Checked", "PMID", "not found in PubMed"],
} as const;

/**
 * The line a lookup leaves once it has run. An empty status after a
 * success read as nothing having happened -- and to a keyboard user, whose
 * focus stays on the button, it was silence. A result that found its row
 * gone or retyped says so rather than vanishing.
 */
export function lookupSummary(
  kind: keyof typeof LOOKUPS,
  asked: number,
  negative: number,
  missed: number,
): string {
  if (asked === 0) return "Nothing to check: every row is checked or blank.";
  const [verb, noun, negatives] = LOOKUPS[kind];
  const parts = [`${verb} ${plural(asked, noun)}`];
  if (negative > 0 && negatives !== "") parts.push(`${negative} ${negatives}`);
  const line = `${parts.join("; ")}.`;
  return missed === 0
    ? line
    : `${line} ${plural(missed, "row")} changed while checking; check again.`;
}

/**
 * Keep phrase `i` as a title and abstract phrase with no MeSH heading.
 *
 * The heading a lookup found is a suggestion: MeSH can offer a parent too
 * broad to search, or a heading the researcher does not recognise in the
 * scope note. Dropping it keeps the row checked -- it still names its
 * phrase -- so the phrase stays an answer and only the heading goes.
 */
export function dropMeshHeading(draft: Answers, i: number) {
  const row = draft.search.meshTerms[i];
  if (row === undefined) return;
  draft.search.meshTerms[i] = {
    phrase: row.phrase,
    heading: null,
    scopeNote: null,
    count: null,
  };
}

/**
 * The prefix of a parked member's family (see renameFamily): a control
 * character, which no key typed into a field holds, so a parked member
 * matches no family and its select reads "pick a family" until its key is
 * one again. The row's index follows it.
 */
const PARKED = "\u0000";

const parkedOn = (row: number): string => `${PARKED}${row}`;

/** The row a member is parked on, or -1 for one that names a key. */
const parkedRow = (family: string): number =>
  family.startsWith(PARKED) ? Number(family.slice(PARKED.length)) : -1;

/** The rows other than `row` holding `key`, compared as the files write it. */
function holders(
  families: Array<{ key: string }>,
  key: string,
  row: number,
): number[] {
  if (key === "") return [];
  return families.flatMap((f, j) =>
    j !== row && clean(f.key) === key ? [j] : []
  );
}

/**
 * Hand each parked member back to its row once the row's key is its own
 * again: not blank, and held by no other family. A key shared with another
 * family becomes one row's own when the other leaves it, by a rename or a
 * removal, so this runs after both.
 */
function settle(
  families: Array<{ key: string }>,
  members: Array<{ family: string }>,
) {
  for (const member of members) {
    const row = parkedRow(member.family);
    const key = clean(families[row]?.key ?? "");
    if (key !== "" && holders(families, key, row).length === 0) {
      member.family = families[row].key;
    }
  }
}

/**
 * Retype the key of family `i`, and carry its members with it.
 *
 * A trait or a mechanism names its family by key, so renaming a family
 * would otherwise leave every member pointing at a key that no longer
 * exists: the select shows "pick a family" and each one has to be
 * reassigned by hand.
 *
 * A key is retyped a keystroke at a time, so it passes through states
 * that name no family of its own: blank, when it is backspaced away
 * before the new one is typed, or another family's key, on the way from
 * "mri_b" to "mri_c". Members carried into either would be lost among
 * the unassigned traits, or given to that other family, and the next
 * keystroke could not tell them apart again. So while the key is in such
 * a state its members are parked on a value no key can take, tied to the
 * row, and they follow the key out of it.
 *
 * Entering the key of one other family parks that family's members too:
 * while two families hold a key it names neither, and whichever of the two
 * leaves it first must take its own members with it, not the other's. A
 * member of a family whose key is not in play, or of none, is never moved.
 */
export function renameFamily(
  families: Array<{ key: string }>,
  members: Array<{ family: string }>,
  i: number,
  value: string,
) {
  const own = (key: string) =>
    key !== "" && holders(families, key, i).length === 0;
  const old = clean(families[i].key);
  const next = clean(value);
  const from = own(old) ? old : parkedOn(i);
  const to = own(next) ? value : parkedOn(i);
  const owner = next === old ? [] : holders(families, next, i);
  for (const member of members) {
    const family = clean(member.family);
    if (family === from) member.family = to;
    else if (owner.length === 1 && family === next) {
      member.family = parkedOn(owner[0]);
    }
  }
  families[i].key = value;
  settle(families, members);
}

/**
 * Remove family `i`. Its parked members go back to no family, so "pick a
 * family" shows and validate() asks for one, rather than waiting on the
 * row for whichever family next takes its place; a park below it moves up
 * with its row. A member naming a key is left alone.
 */
export function removeFamily(
  families: Array<{ key: string }>,
  members: Array<{ family: string }>,
  i: number,
) {
  for (const member of members) {
    const row = parkedRow(member.family);
    if (row === i) member.family = "";
    else if (row > i) member.family = parkedOn(row - 1);
  }
  families.splice(i, 1);
  settle(families, members);
}

/**
 * Add each example paper to the gold list once, noted as a prompt
 * example. A PMID is compared as the files write it, trimmed, so a padded
 * example does not become a second row, and two examples citing one paper
 * add it once.
 */
export function addExamplePapers(draft: Answers) {
  const present = new Set(draft.gold.rows.map((row) => clean(row.pmid)));
  for (const example of draft.prompt.examples) {
    const pmid = clean(example.pmid);
    if (!PMID.test(pmid) || present.has(pmid)) continue;
    present.add(pmid);
    draft.gold.rows.push({
      pmid,
      note: "prompt example",
      title: null,
      exists: null,
    });
  }
}

/**
 * Write the titles a summary lookup returned onto the gold rows they
 * answer, matched by trimmed PMID rather than by index: a row removed or
 * retyped while the request was out simply goes unanswered. Returns how
 * many answers found no row.
 */
export function applyTitles(
  draft: Answers,
  titles: Record<string, string | null>,
): number {
  const answered = new Set<string>();
  for (const row of draft.gold.rows) {
    const pmid = clean(row.pmid);
    if (!Object.hasOwn(titles, pmid)) continue;
    row.title = titles[pmid];
    row.exists = titles[pmid] !== null;
    answered.add(pmid);
  }
  return Object.keys(titles).filter((pmid) => !answered.has(pmid)).length;
}

/** A confidence as typed: an empty field is no answer, not zero. */
export function parseConfidence(text: string): number {
  return text.trim() === "" ? NaN : Number(text);
}

const pause = (delay: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delay));

/**
 * `f`, with the requests to `host` started at least `gap()` milliseconds
 * apart and every other request passed straight through.
 *
 * NCBI allows three requests a second without an API key and ten with
 * one, and answers a burst over it with 429. A lookup costs several
 * requests per row (four for a gene: its symbol and its ClinVar traits),
 * so the spacing is held here -- across the requests of one lookup's loop,
 * its retries, and lookups started back to back -- rather than in each
 * loop. The clock is monotonic, and the next start is
 * never further off than one gap, so a clock set back cannot hold every
 * request until it catches up.
 */
export function spaced(
  f: Fetch,
  host: string,
  gap: () => number,
  wait: (delay: number) => Promise<void> = pause,
  now: () => number = () => performance.now(),
): Fetch {
  let next = 0;
  // The gap the next start was set with, which bounds how far off it is.
  let held = 0;
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).host !== host) return f(input, init);
    const at = now();
    const start = Math.max(at, Math.min(next, at + held));
    held = gap();
    next = start + held;
    const delay = start - at;
    return (delay > 0 ? wait(delay) : Promise.resolve()).then(() =>
      f(input, init)
    );
  };
}
