/**
 * Every rule the interview states, as one pass over the answers.
 *
 * A rule here is one the generated files would fail a gate on (a schema
 * pattern, a test's invariant) or one the interview names under
 * "Validates". Messages are written for the researcher, not the developer.
 */
import {
  type Answers,
  LOGO_BYTE_LIMIT,
  type LogoFile,
  type OmimRow,
} from "./answers.ts";
import {
  FAMILY_PALETTE,
  MECHANISM_PALETTE,
  POPULATION_PALETTE,
} from "./palette.ts";
import { clean, trim } from "./generate/json.ts";
import { meshHeadings } from "./generate/pipeline.ts";
import { diseaseSteps, promptBodies } from "./generate/prompt.ts";
import { TYPED_SECTION_IDS } from "./prompt_sections.ts";
import { ABSENT_SENTINELS } from "../sentinels.ts";

export type StepId =
  | "identity"
  | "search"
  | "vocabulary"
  | "trials"
  | "monogenic"
  | "prompt"
  | "gold";

export const STEP_ORDER: readonly StepId[] = [
  "identity",
  "search",
  "vocabulary",
  "trials",
  "monogenic",
  "prompt",
  "gold",
];

/** Each step's name, as the stepper and the Review step's issue list print it. */
export const STEP_LABELS: Readonly<Record<StepId, string>> = {
  identity: "Identity",
  search: "Search terms",
  vocabulary: "Traits",
  trials: "Trials",
  monogenic: "Monogenic genes",
  prompt: "Prompt",
  gold: "Gold papers",
};

/**
 * What an issue says about the answer under it: that something is still
 * to be given (a blank field, a list too short), that a lookup has yet to
 * confirm what was typed, or that what was typed is wrong. Only the last is
 * a mistake to fix; the counts and colours read this rather than guessing
 * from the value's shape.
 */
export type IssueKind = "missing" | "pending" | "wrong";

export interface Issue {
  step: StepId;
  field: string;
  message: string;
  kind: IssueKind;
}

export const KEY = /^[a-z][a-z0-9_]*$/;
/**
 * A PubMed or OMIM number as written. A leading zero is refused: PubMed
 * answers "0123" as 123, so the lookups could never confirm it, and the
 * recall measurement compares PMIDs as strings.
 */
export const PMID = /^[1-9][0-9]*$/;
/**
 * What clinical_trials_fetch.py leaves of a stated condition before it
 * looks for a substring: lower case, and every run of anything but a
 * letter, a digit or a space turned into a space. A substring outside
 * this alphabet can therefore never match, and the fetch would quietly
 * keep no discovered trial at all; nor can one holding two spaces in a row,
 * which the fold never leaves.
 */
export const CONDITION = /^[a-z0-9 ]+$/;
export const conditionOk = (value: string): boolean =>
  CONDITION.test(value) && !/ {2}/.test(value);
/**
 * The `<example type="…">` label, which sits inside double quotes. Only an
 * inclusion can be written: the block always gives the gene and the traits
 * to extract, so an exclude_ example would teach the model to extract the
 * very gene it names as one to leave out.
 */
export const EXAMPLE_TYPE = /^include_[a-z0-9_]+$/;
/** The logo formats the archive publishes under static/institute/. */
const LOGO = /\.(svg|png)$/i;
/** An institute URL: an http or https scheme and no whitespace. */
export const WEB_URL = /^https?:\/\/\S+$/;
/** A DOI as the citation link appends it to https://doi.org/. */
export const DOI = /^10\.\d{4,9}\/\S+$/;
/**
 * pipeline/disease.py refuses any line that reads as a section heading; it
 * reads lines as Python's re.M does, broken at "\n" alone.
 */
export const HEADING_LINE = /(?:^|\n)## /;
/** pipeline/prompts.py refuses a prompt with a "{{" left in it. */
export const SLOT = "{{";
/**
 * A confidence the example block can carry. A field left empty is NaN, and
 * JSON writes NaN as null, so a reloaded draft has to fail here too -- null
 * passes >= 0 and <= 1.
 */
export const confidenceOk = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;
/**
 * Every value below is read as the generators write it, through `clean()`
 * (generate/json.ts): a padded key matches the row it names here as it
 * will in the generated files, and two spellings of one key are one key.
 */
const blank = (s: string) => trim(s) === "";
const lower = (s: string) => clean(s).toLowerCase();

/**
 * A character no field may hold: a control or format character (a
 * zero-width space, a soft hyphen, a bidirectional override) or a line or
 * paragraph separator. Each is invisible, and would travel into the files
 * unseen. A line break and a tab are a multi-line field's own.
 */
export const hiddenChar = (c: string): boolean =>
  c !== "\n" && c !== "\t" && /^[\p{Cc}\p{Cf}\u2028\u2029]$/u.test(c);
const hasHidden = (s: string) => [...trim(s)].some(hiddenChar);

/**
 * The names a JavaScript object keeps for itself. A mechanism, an alias or
 * a cell type becomes a key of a map in the generated files, and assigning
 * "__proto__" sets the map's prototype instead: the entry is silently lost.
 */
const OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const objectKey = (value: string): boolean =>
  OBJECT_KEYS.has(clean(value));

/** The PubMed search's own words, which a phrase would turn into a query. */
export const OPERATOR = /(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/;

/**
 * Whether ClinicalTrials.gov's query parser refuses a term: a square
 * bracket, a parenthesis or a double quote left open, or an operator with
 * nothing on one side. A refused term fails every sync that searches it.
 */
export function ctgovTermRefused(term: string): boolean {
  if (/[[\]]/.test(term)) return true;
  let depth = 0;
  for (const c of term) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return true;
  }
  if (depth !== 0 || (term.match(/"/g) ?? []).length % 2 !== 0) return true;
  return /^(?:AND|OR|NOT)(?:\s|$)|(?:^|\s)(?:AND|OR|NOT)$/.test(term);
}

/**
 * A maintainer's address: one "@", a local part and a domain of dotted
 * labels ending in one of two or more characters, none holding a space, an
 * angle bracket, a comma, a semicolon, a colon, a parenthesis, a square
 * bracket, a double quote or an invisible character. Checked by hand rather
 * than with one pattern, whose overlapping repeats backtracked on a long
 * value.
 */
export const EMAIL_REFUSED = /[\s@<>()[\],;:"\p{Cc}\p{Cf}]/u;
export function emailOk(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const labels = value.slice(at + 1).split(".");
  const parts = [value.slice(0, at), ...labels];
  return labels.length >= 2 && labels[labels.length - 1].length >= 2 &&
    parts.every((part) => part !== "" && !EMAIL_REFUSED.test(part));
}

/**
 * An institute URL a browser opens as written: http or https, no space, no
 * user name, and a host holding a dot. The pattern alone let "https://https//x.org" pass,
 * with "https" for its host.
 */
export function webUrlOk(value: string): boolean {
  if (!WEB_URL.test(value) || [...value].some(hiddenChar)) return false;
  try {
    const url = new URL(value);
    // A user name before the host is a phishing trick, not an address.
    return /^https?:$/.test(url.protocol) && /\.[^.]/.test(url.hostname) &&
      !url.hostname.startsWith(".") && url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

/** The ASCII the OMIM table holds: a printable character or a space. */
export const ASCII_TEXT = /^[\x20-\x7e]*$/;

/**
 * The typed sections that are blocks of lines of their own. Every other one
 * is spliced into one line of the template -- a step of the numbered
 * strategy, a rubric bullet, the middle of a sentence -- where a line break
 * would reach the model as an unnumbered line.
 */
export const BLOCK_SECTION_IDS: readonly string[] = [
  "criteria.phenotypes",
  "rubric.modifiers",
  "strategy.disease_steps",
];

/**
 * The two sections that name a monogenic gene. With none -- a legal answer
 * for a disease with no Mendelian form -- there is nothing to write in them.
 */
const MONOGENIC_SECTION_IDS = [
  "rubric.monogenic_examples",
  "strategy.background_example",
];

/** The longest trait label the karyogram's 128px label column draws whole. */
export const TRAIT_LABEL_MAX = 20;

/**
 * The required text fields named as the forms label them: a message is
 * read by the researcher, who never sees a key like `aboutLede`.
 */
const SITE_TEXT = [
  ["title", "The site title"],
  ["heading", "The navbar heading"],
  ["metaDescription", "The meta description"],
  ["aboutTitle", "The About page title"],
  ["aboutLede", "The About page lead"],
  ["loginLede", "The login page lead"],
] as const;
const PAGE_TEXT = [
  ["genes", "The Genes page description"],
  ["trials", "The Trials page description"],
  ["timeline", "The Trials radar page description"],
  ["map", "The Trials map page description"],
] as const;
const STANDARD_TEXT = [
  ["name", "The standard's name"],
  ["label", "The standard's citation"],
  ["linkLabel", "The standard's link label"],
] as const;
// Inheritance is not among them: OMIM states none for many phenotypes, and
// the upstream table carries rows with it blank.
const OMIM_TEXT = [
  ["location", "The OMIM row's cytogenetic location"],
  ["phenotype", "The OMIM row's phenotype"],
  ["phenotypeMimNumber", "The OMIM row's phenotype MIM number"],
  ["phenotypeMappingKey", "The OMIM row's phenotype mapping key"],
  ["geneOrLocusMimNumber", "The OMIM row's gene MIM number"],
] as const;

/**
 * Values no trait key, population key or mechanism name may take, compared
 * as the filters compare them, case and spacing aside: the filters' "Show
 * All" choice (`SHOW_ALL` in lib/constants.ts, written out here so the
 * island does not carry the vocabulary that module reads), the export's
 * absent-value sentinels, and the "NA" and "N/A" its fill_missing_text
 * folds into them. A key equal to one is a second filter choice with that
 * value, or is published as "(unknown)", and ticking it reads as "Show All"
 * or "nothing recorded".
 */
const RESERVED = new Set(
  ["all", "na", "n/a", ...ABSENT_SENTINELS].map((value) => value.toLowerCase()),
);
export const reserved = (value: string) => RESERVED.has(lower(value));

const HIDDEN_MESSAGE =
  "It holds an invisible character, which would reach the files unseen; delete it.";

class Collector {
  issues: Issue[] = [];
  constructor(private step: StepId) {}
  add(field: string, message: string, kind: IssueKind) {
    this.issues.push({ step: this.step, field, message, kind });
  }
  /** A required value. */
  text(field: string, value: string, what: string) {
    if (blank(value)) this.add(field, `${what} is required.`, "missing");
    else this.hidden(field, value);
  }
  /** A value holding an invisible character, blank or not. */
  hidden(field: string, value: string) {
    if (hasHidden(value)) this.add(field, HIDDEN_MESSAGE, "wrong");
  }
}

function duplicates(values: string[]): Set<number> {
  const seen = new Map<string, number>();
  const dup = new Set<number>();
  values.forEach((v, i) => {
    const k = lower(v);
    if (seen.has(k)) dup.add(i);
    else seen.set(k, i);
  });
  return dup;
}

/** Decode the character references an SVG may spell a URL scheme with. */
function decodeReferences(text: string): string {
  const named: Record<string, string> = {
    colon: ":",
    tab: "\t",
    newline: "\n",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    amp: "&",
  };
  const code = (value: number) =>
    value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => code(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, dec) => code(Number(dec)))
    .replace(
      /&([a-z]+);/gi,
      (entity, name) => named[name.toLowerCase()] ?? entity,
    );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SVG_ROOT =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*>\s*)*<svg\b([^>]*)>/i;
const SVG_NAMESPACE = /\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/;
const SVG_ACTIVE = [
  /<\s*(?:script|foreignObject|iframe|embed|object|handler|listener)\b/i,
  /\son[a-z]+\s*=/i,
  /<\s*(?:set|animate\w*)\b[^>]*attributeName\s*=\s*["']?\s*(?:on|href|xlink:href)/i,
];

function judgeLogo(logo: LogoFile): string | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(logo.base64), (c) => c.charCodeAt(0));
  } catch {
    return "The logo file could not be read; upload it again.";
  }
  if (bytes.length === 0) return "The logo file is empty; upload it again.";
  if (bytes.length > LOGO_BYTE_LIMIT) {
    return "The logo is larger than 1 MB; upload a smaller SVG or PNG.";
  }
  if (/\.png$/i.test(logo.name)) {
    return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)
      ? null
      : "This file is not a PNG, whatever its name says; upload the PNG itself, or an SVG named .svg.";
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch {
    return "This file is not an SVG, whatever its name says; a PNG must be named .png.";
  }
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) {
    return "This SVG declares entities, which can hide active content; export a plain SVG, or upload a PNG.";
  }
  const root = SVG_ROOT.exec(text);
  if (root === null || !SVG_NAMESPACE.test(root[1])) {
    return 'This SVG has no <svg xmlns="http://www.w3.org/2000/svg"> root, so a browser would not draw it as an image; export it again as a standalone SVG.';
  }
  const decoded = decodeReferences(text);
  if (
    SVG_ACTIVE.some((pattern) => pattern.test(decoded)) ||
    /javascript:|data:text\/html/i.test(decoded.replace(/\s+/g, ""))
  ) {
    return "This SVG carries a script or an event handler; export a plain SVG, or upload a PNG.";
  }
  return null;
}

/**
 * What is wrong with a logo's bytes, or null. The name's extension says
 * only what the archive calls the file: a PNG named .svg is rewritten by
 * the fork's `deno fmt`, an SVG without its namespace is not drawn as an
 * image, and an SVG carrying a script runs on the dashboard's origin when
 * its URL is opened. validate() runs on every render and a logo can be a
 * megabyte, so each verdict is kept for its bytes.
 */
const logoVerdicts = new Map<string, string | null>();
export function logoProblem(logo: LogoFile): string | null {
  const key = `${logo.name.toLowerCase().endsWith(".png")}:${logo.base64}`;
  if (logoVerdicts.has(key)) return logoVerdicts.get(key)!;
  const verdict = judgeLogo(logo);
  if (logoVerdicts.size >= 8) logoVerdicts.clear();
  logoVerdicts.set(key, verdict);
  return verdict;
}

/**
 * A whole-word, case-sensitive finder for the monogenic genes' symbols and
 * the aliases that stand for them, or null when there are none. A symbol is
 * a word of its own: "XYZ1" is not found in "XYZ12" or "aXYZ1".
 */
function symbolFinder(a: Answers): RegExp | null {
  const { genes, aliases } = a.monogenic;
  const symbols = [
    ...genes.map((g) => g.symbol),
    ...aliases.flatMap((al) => [al.alias, ...al.symbols]),
  ].map(clean).filter((s) => s !== "");
  if (symbols.length === 0) return null;
  const escaped = [...new Set(symbols)]
    .sort((x, y) => y.length - x.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`,
    "u",
  );
}

/**
 * Report a gene symbol in text that ships to every visitor before login:
 * the manifest, the radar's timeline and the karyogram's families. The
 * dataset is behind the login; its gene list must not be readable in front
 * of it.
 */
function publicText(
  c: Collector,
  finder: RegExp | null,
  field: string,
  value: string,
) {
  const found = finder?.exec(value);
  if (found) {
    c.add(
      field,
      `"${
        found[0]
      }" is a gene symbol, and this text is shown to every visitor before login; leave the gene out of it.`,
      "wrong",
    );
  }
}

function identityIssues(a: Answers): Issue[] {
  const c = new Collector("identity");
  const finder = symbolFinder(a);
  const {
    disease,
    site,
    institute,
    logoLight,
    logoDark,
    maintainer,
    cellTypes,
  } = a.identity;
  if (blank(disease.key)) {
    c.add("disease.key", "The key is required.", "missing");
  } else if (!KEY.test(clean(disease.key))) {
    c.add(
      "disease.key",
      "The key must be lower-case letters, digits and underscores, starting with a letter; it names the database and the deploy project.",
      "wrong",
    );
  }
  const named = [
    ["name", "The disease name"],
    ["short", "The short form"],
    ["abbreviation", "The abbreviation"],
    ["adjective", "The adjective form"],
  ] as const;
  for (const [key, what] of named) {
    c.text(`disease.${key}`, disease[key], what);
    publicText(c, finder, `disease.${key}`, disease[key]);
  }
  // The name and the abbreviation are spliced into the extraction prompt,
  // which pipeline/prompts.py refuses with a "{{" left in it.
  for (const key of ["name", "abbreviation"] as const) {
    if (disease[key].includes(SLOT)) {
      c.add(
        `disease.${key}`,
        'The text cannot contain "{{"; the prompt reads it as a slot.',
        "wrong",
      );
    }
  }
  for (const [key, what] of SITE_TEXT) {
    c.text(`site.${key}`, site[key], what);
    publicText(c, finder, `site.${key}`, site[key]);
  }
  for (const [key, what] of PAGE_TEXT) {
    c.text(`site.pages.${key}`, site.pages[key], what);
    publicText(c, finder, `site.pages.${key}`, site.pages[key]);
  }
  const instituteText = [
    ["name", "The institute name"],
    ["short", "The institute short name"],
    ["copyright", "The copyright line"],
    ["logoAlt", "The logo's alternative text"],
  ] as const;
  for (const [key, what] of instituteText) {
    c.text(`institute.${key}`, institute[key], what);
    publicText(c, finder, `institute.${key}`, institute[key]);
  }
  if (!blank(institute.url) && !webUrlOk(clean(institute.url))) {
    c.add(
      "institute.url",
      "The institute URL must be a web address starting with http:// or https://, or be left empty.",
      "wrong",
    );
  }
  for (
    const [path, logo, what] of [
      ["logoLight", logoLight, "The logo"],
      ["logoDark", logoDark, "The dark-theme logo"],
    ] as const
  ) {
    if (logo === null) {
      if (path === "logoLight") {
        c.add(path, "Upload a logo (SVG or PNG).", "missing");
      }
    } else if (!LOGO.test(logo.name)) {
      c.add(path, `${what} must be an .svg or a .png file.`, "wrong");
    } else {
      const problem = logoProblem(logo);
      if (problem !== null) c.add(path, problem, "wrong");
    }
  }
  c.text("maintainer.name", maintainer.name, "The maintainer's name");
  if (blank(maintainer.email)) {
    c.add(
      "maintainer.email",
      "Enter a valid email address for the maintainer.",
      "missing",
    );
  } else if (!emailOk(clean(maintainer.email))) {
    c.add(
      "maintainer.email",
      "Enter a valid email address for the maintainer.",
      "wrong",
    );
  }
  c.text("cellTypes.label", cellTypes.label, "The cell-type column label");
  publicText(c, finder, "cellTypes.label", cellTypes.label);
  if (cellTypes.glossary.length === 0) {
    c.add(
      "cellTypes.glossary",
      "Add at least one cell-type abbreviation.",
      "missing",
    );
  }
  // A row's fault is filed under the control that holds it: the
  // abbreviation's on the row, the name's on the row's name.
  const dup = duplicates(cellTypes.glossary.map((g) => g.abbrev));
  cellTypes.glossary.forEach((g, i) => {
    const row = `cellTypes.glossary[${i}]`;
    if (blank(g.abbrev)) {
      c.add(row, "Each cell type needs an abbreviation.", "missing");
    } else if (dup.has(i)) {
      c.add(row, `"${g.abbrev}" is listed twice.`, "wrong");
    } else if (objectKey(g.abbrev)) {
      c.add(
        row,
        `"${
          clean(g.abbrev)
        }" is a name JavaScript keeps for itself; use another abbreviation.`,
        "wrong",
      );
    } else c.hidden(row, g.abbrev);
    if (blank(g.name)) {
      c.add(`${row}.name`, "Each cell type needs a name.", "missing");
    } else c.hidden(`${row}.name`, g.name);
    publicText(c, finder, row, g.abbrev);
    publicText(c, finder, `${row}.name`, g.name);
  });
  return c.issues;
}

/**
 * A PubMed phrase or marker term, as pipeline/pubmed_search.py writes it:
 * quoted and tagged [Title/Abstract]. True when nothing is wrong with it.
 */
function searchPhrase(
  c: Collector,
  field: string,
  value: string,
  noun: string,
): boolean {
  if (blank(value)) {
    c.add(field, `${noun} cannot be empty.`, "missing");
  } else if (value.includes('"')) {
    c.add(field, `${noun} cannot contain a double quote.`, "wrong");
  } else if (/[[\]]/.test(value)) {
    c.add(
      field,
      "The search tags each phrase itself; remove the [tag].",
      "wrong",
    );
  } else if (OPERATOR.test(clean(value))) {
    c.add(
      field,
      "Put one phrase per row: AND, OR and NOT are the search's own words.",
      "wrong",
    );
  } else if (hasHidden(value)) {
    c.add(field, HIDDEN_MESSAGE, "wrong");
  } else return true;
  return false;
}

function searchIssues(a: Answers): Issue[] {
  const c = new Collector("search");
  const { diseaseTerms, meshTerms, markerTerms } = a.search;
  if (diseaseTerms.length === 0) {
    c.add("diseaseTerms", "Add at least one disease phrase.", "missing");
  }
  const dupPhrases = duplicates(diseaseTerms);
  diseaseTerms.forEach((t, i) => {
    if (
      searchPhrase(c, `diseaseTerms[${i}]`, t, "A phrase") &&
      dupPhrases.has(i)
    ) {
      c.add(`diseaseTerms[${i}]`, `"${t}" is listed twice.`, "wrong");
    }
  });
  // A row belongs to its phrase only while it still names it: a phrase
  // added or retyped since the last check has no row of its own yet, and
  // the one beside it was resolved for different words. A phrase MeSH has
  // no heading for is an answer, not a gap -- it still anchors the title
  // and abstract search -- so only a phrase never checked is flagged.
  diseaseTerms.forEach((phrase, i) => {
    if (blank(phrase)) return;
    const m = meshTerms[i];
    if (m === undefined || clean(m.phrase) !== clean(phrase)) {
      c.add(
        `meshTerms[${i}]`,
        `"${phrase}" has not been checked against MeSH yet.`,
        "pending",
      );
    } else if (m.heading !== null && m.count === 0) {
      c.add(
        `meshTerms[${i}]`,
        `"${m.heading}" finds no papers as a MeSH heading; drop it, or check a different phrase.`,
        "wrong",
      );
    }
  });
  // The headings the file will hold: pipeline/pubmed_search.py builds a
  // MeSH branch that is a syntax error when it has none.
  if (meshHeadings(a).length === 0) {
    c.add("meshTerms", "Resolve at least one MeSH heading.", "missing");
  }
  if (markerTerms.length === 0) {
    c.add(
      "markerTerms",
      "Use between one and fifteen marker terms.",
      "missing",
    );
  } else if (markerTerms.length > 15) {
    c.add("markerTerms", "Use between one and fifteen marker terms.", "wrong");
  }
  const phrases = new Set(diseaseTerms.map(lower));
  const dup = duplicates(markerTerms.map((m) => m.term));
  markerTerms.forEach((m, i) => {
    const field = `markerTerms[${i}]`;
    if (!searchPhrase(c, field, m.term, "A marker term")) {
      return;
    }
    if (phrases.has(lower(m.term))) {
      c.add(field, `"${m.term}" repeats a disease phrase.`, "wrong");
    } else if (dup.has(i)) {
      c.add(field, `"${m.term}" is listed twice.`, "wrong");
    }
  });
  return c.issues;
}

function vocabularyIssues(a: Answers): Issue[] {
  const c = new Collector("vocabulary");
  const finder = symbolFinder(a);
  const { traits, families, citationStandard } = a.vocabulary;
  if (traits.length < 4) {
    c.add("traits", "Define between four and sixteen traits.", "missing");
  } else if (traits.length > 16) {
    c.add("traits", "Define between four and sixteen traits.", "wrong");
  }
  if (families.length === 0) {
    c.add("families", "Add at least one family.", "missing");
  } else if (families.length > FAMILY_PALETTE.length) {
    c.add(
      "families",
      `At most ${FAMILY_PALETTE.length} families have a colour.`,
      "wrong",
    );
  }
  const familyKeys = new Set(families.map((f) => clean(f.key)));
  const dupFamilies = duplicates(families.map((f) => f.key));
  families.forEach((f, i) => {
    const row = `families[${i}]`;
    if (blank(f.key)) {
      c.add(row, "Each family needs a key.", "missing");
    } else if (dupFamilies.has(i)) {
      c.add(row, `Family "${f.key}" is listed twice.`, "wrong");
    } else if (!traits.some((t) => clean(t.family) === clean(f.key))) {
      c.add(row, `Family "${f.label}" has no trait.`, "missing");
    } else c.hidden(row, f.key);
    if (blank(f.label)) {
      c.add(`${row}.label`, "Each family needs a label.", "missing");
    } else c.hidden(`${row}.label`, f.label);
    publicText(c, finder, `${row}.label`, f.label);
  });
  const dup = duplicates(traits.map((t) => t.key));
  traits.forEach((t, i) => {
    const key = `traits[${i}].key`;
    if (blank(t.key)) c.add(key, "A trait needs a key.", "missing");
    else if (t.key.includes(",")) {
      c.add(key, "A trait key cannot contain a comma.", "wrong");
    } else if (clean(t.key).includes("\n")) {
      c.add(key, "A trait key is one line.", "wrong");
    } else if (t.key.includes(SLOT)) {
      // The keys are written into the prompt's traits.canonical section.
      c.add(
        key,
        'A trait key cannot contain "{{"; the prompt reads it as a slot.',
        "wrong",
      );
    } else if (reserved(t.key)) {
      c.add(
        key,
        `"${t.key}" is a value the filters keep for themselves; choose another key.`,
        "wrong",
      );
    } else if (hasHidden(t.key)) {
      c.add(key, HIDDEN_MESSAGE, "wrong");
    } else if (dup.has(i)) {
      c.add(key, `"${t.key}" is used twice.`, "wrong");
    }
    if (t.standard && citationStandard === null) {
      c.add(
        `traits[${i}].standard`,
        "Only a definition quoted from a named standard is marked as one; name the standard below, or untick this.",
        "wrong",
      );
    }
    c.text(`traits[${i}].label`, t.label, "The trait label");
    if ([...clean(t.label)].length > TRAIT_LABEL_MAX) {
      c.add(
        `traits[${i}].label`,
        `Keep the label to ${TRAIT_LABEL_MAX} characters: it is drawn in a 128px column on the karyogram.`,
        "wrong",
      );
    }
    c.text(`traits[${i}].name`, t.name, "The trait's long name");
    c.text(`traits[${i}].definition`, t.definition, "The trait definition");
    if (!familyKeys.has(clean(t.family))) {
      c.add(`traits[${i}].family`, "Pick a family for this trait.", "missing");
    }
    if (t.xref === null && blank(t.xrefNote)) {
      c.add(
        `traits[${i}].xrefNote`,
        "With no ontology term, note what was searched and why nothing matched.",
        "missing",
      );
    } else c.hidden(`traits[${i}].xrefNote`, t.xrefNote);
  });
  if (citationStandard !== null) {
    for (const [key, what] of STANDARD_TEXT) {
      c.text(`citationStandard.${key}`, citationStandard[key], what);
      publicText(c, finder, `citationStandard.${key}`, citationStandard[key]);
    }
    const doi = citationStandard.doi;
    if (blank(doi)) {
      c.add(
        "citationStandard.doi",
        "The standard's DOI is required.",
        "missing",
      );
    } else if (!DOI.test(clean(doi))) {
      c.add(
        "citationStandard.doi",
        "Write the DOI alone, starting with 10., e.g. 10.1000/xyz123: the link adds https://doi.org/ itself.",
        "wrong",
      );
    }
  }
  return c.issues;
}

/** A condition substring or pair word, as clinical_trials_fetch.py compares it. */
function conditionWord(
  c: Collector,
  field: string,
  word: string,
  empty: string,
  refused: (word: string) => string,
) {
  if (blank(word)) c.add(field, empty, "missing");
  else if (!conditionOk(lower(word))) c.add(field, refused(word), "wrong");
}

function trialsIssues(a: Answers): Issue[] {
  const c = new Collector("trials");
  const finder = symbolFinder(a);
  const t = a.trials;
  if (t.populations.length === 0) {
    c.add("populations", "Add at least one population.", "missing");
  }
  if (t.populations.length > POPULATION_PALETTE.length) {
    c.add(
      "populations",
      `At most ${POPULATION_PALETTE.length} populations have a colour.`,
      "wrong",
    );
  }
  const dupPop = duplicates(t.populations.map((p) => p.key));
  t.populations.forEach((p, i) => {
    const key = `populations[${i}].key`;
    if (blank(p.key)) {
      c.add(key, "A population needs a key.", "missing");
    } else if (reserved(p.key)) {
      c.add(
        key,
        `"${p.key}" is a value the filters keep for themselves; choose another key.`,
        "wrong",
      );
    } else if (objectKey(p.key)) {
      c.add(
        key,
        `"${
          clean(p.key)
        }" is a name JavaScript keeps for itself; choose another key.`,
        "wrong",
      );
    } else if (hasHidden(p.key)) {
      c.add(key, HIDDEN_MESSAGE, "wrong");
    } else if (dupPop.has(i)) {
      c.add(key, `"${p.key}" is used twice.`, "wrong");
    }
    publicText(c, finder, key, p.key);
    c.text(`populations[${i}].label`, p.label, "The population label");
    publicText(c, finder, `populations[${i}].label`, p.label);
    const lines = `populations[${i}].lines`;
    if (p.lines.length === 0 || p.lines.every(blank)) {
      c.add(
        lines,
        "Give the radar at least one non-empty label line.",
        "missing",
      );
    } else {
      const empty = p.lines.findIndex(blank);
      if (empty !== -1) {
        c.add(
          lines,
          `Line ${
            empty + 1
          } is empty; delete it: every line is drawn on the radar.`,
          "wrong",
        );
      } else c.hidden(lines, p.lines.join("\n"));
    }
    for (const line of p.lines) publicText(c, finder, lines, line);
  });
  for (
    const [key, what] of [
      ["label", "The population column label"],
      ["detailsLabel", "The population details label"],
    ] as const
  ) {
    c.text(`populationField.${key}`, t.populationField[key], what);
    publicText(c, finder, `populationField.${key}`, t.populationField[key]);
  }
  if (t.searchTerms.length === 0) {
    c.add(
      "searchTerms",
      "Add at least one ClinicalTrials.gov search term.",
      "missing",
    );
  }
  t.searchTerms.forEach((s, i) => {
    const field = `searchTerms[${i}]`;
    if (blank(s.term)) {
      c.add(field, "A search term cannot be empty.", "missing");
    } else if (ctgovTermRefused(clean(s.term))) {
      c.add(
        field,
        "ClinicalTrials.gov cannot parse this term: close every parenthesis and quote, leave out square brackets, and keep AND, OR and NOT between words.",
        "wrong",
      );
    } else c.hidden(field, s.term);
  });
  if (t.conditions.length === 0) {
    c.add("conditions", "Add at least one condition substring.", "missing");
  }
  t.conditions.forEach((s, i) => {
    conditionWord(
      c,
      `conditions[${i}]`,
      s,
      "A condition substring cannot be empty.",
      (word) =>
        `"${word}" can never match: conditions are compared as unaccented letters, digits and single spaces only.`,
    );
  });
  // Each word's fault is filed under its own control: the first word's on
  // the pair's row, the second's on the row's ".1".
  t.conditionPairs.forEach((pair, i) => {
    pair.forEach((word, w) => {
      conditionWord(
        c,
        w === 0 ? `conditionPairs[${i}]` : `conditionPairs[${i}].1`,
        word,
        "Both words of a pair are required.",
        () =>
          "A pair word can hold only unaccented letters, digits and single spaces, or it never matches.",
      );
    });
  });
  const familyKeys = new Set(t.mechanismFamilies.map((f) => clean(f.key)));
  const dupFam = duplicates(t.mechanismFamilies.map((f) => f.key));
  t.mechanismFamilies.forEach((f, i) => {
    const row = `mechanismFamilies[${i}]`;
    if (blank(f.key)) {
      c.add(row, "Each mechanism family needs a key.", "missing");
    } else if (dupFam.has(i)) {
      c.add(row, `Family "${f.key}" is listed twice.`, "wrong");
    } else if (!t.mechanisms.some((m) => clean(m.family) === clean(f.key))) {
      c.add(row, `Family "${f.label}" has no mechanism.`, "missing");
    } else c.hidden(row, f.key);
    if (blank(f.label)) {
      c.add(`${row}.label`, "Each mechanism family needs a label.", "missing");
    } else c.hidden(`${row}.label`, f.label);
    publicText(c, finder, `${row}.label`, f.label);
  });
  if (t.mechanisms.length === 0) {
    c.add(
      "mechanisms",
      "Name at least one mechanism of action with its family.",
      "missing",
    );
  }
  if (t.mechanisms.length > MECHANISM_PALETTE.length) {
    c.add(
      "mechanisms",
      `At most ${MECHANISM_PALETTE.length} mechanisms have a colour.`,
      "wrong",
    );
  }
  const dupMech = duplicates(t.mechanisms.map((m) => m.name));
  t.mechanisms.forEach((m, i) => {
    const name = `mechanisms[${i}].name`;
    if (blank(m.name)) {
      c.add(name, "A mechanism needs a name.", "missing");
    } else if (reserved(m.name)) {
      c.add(
        name,
        `"${m.name}" is the value a trial with no mechanism carries; name the mechanism.`,
        "wrong",
      );
    } else if (objectKey(m.name)) {
      c.add(
        name,
        `"${
          clean(m.name)
        }" is a name JavaScript keeps for itself; name the mechanism differently.`,
        "wrong",
      );
    } else if (hasHidden(m.name)) {
      c.add(name, HIDDEN_MESSAGE, "wrong");
    } else if (dupMech.has(i)) {
      c.add(name, `"${m.name}" is listed twice.`, "wrong");
    }
    publicText(c, finder, name, m.name);
    if (!familyKeys.has(clean(m.family))) {
      c.add(
        `mechanisms[${i}].family`,
        "Pick a family for this mechanism.",
        "missing",
      );
    }
  });
  return c.issues;
}

function monogenicIssues(a: Answers): Issue[] {
  const c = new Collector("monogenic");
  const { genes, aliases, omimRows } = a.monogenic;
  if (genes.length > 10) {
    c.add("genes", "List at most ten monogenic genes.", "wrong");
  }
  const dup = duplicates(genes.map((g) => g.symbol));
  genes.forEach((g, i) => {
    const field = `genes[${i}]`;
    if (blank(g.symbol)) {
      c.add(field, "A gene symbol cannot be empty.", "missing");
    } else if (g.symbol.includes(",")) {
      // The prompt lists the genes comma-separated, and a test splits the
      // list back on its commas to compare it with pipeline.json.
      c.add(field, "One gene per row: a symbol has no comma.", "wrong");
    } else if (/\s/.test(trim(g.symbol))) {
      c.add(field, "A gene symbol has no space.", "wrong");
    } else if (g.symbol.includes(SLOT)) {
      // Written as the symbol's own field says it: the row's value is an
      // object, so the field's words are the ones on the page.
      c.add(
        field,
        '"{{" can\'t be used: the prompt reads it as a slot.',
        "wrong",
      );
    } else if (hasHidden(g.symbol)) {
      c.add(field, HIDDEN_MESSAGE, "wrong");
    } else if (dup.has(i)) {
      c.add(field, `"${g.symbol}" is listed twice.`, "wrong");
    } else if (g.verified === null) {
      c.add(
        field,
        `"${g.symbol}" has not been checked against NCBI Gene yet.`,
        "pending",
      );
    } else if (g.verified === false) {
      c.add(
        field,
        `"${g.symbol}" is not the official symbol of a human gene in NCBI Gene; an alias or a former symbol does not count.`,
        "wrong",
      );
    }
  });
  // The aliases are written as one JSON object, so a repeated spelling
  // would keep only its last mapping. pipeline/data_merger.py stores every
  // extraction of a member under the alias, so an alias of a verified gene
  // renames that gene on every page that lists it.
  const monogenic = new Set(genes.map((g) => clean(g.symbol).toUpperCase()));
  const dupAliases = duplicates(aliases.map((al) => al.alias));
  aliases.forEach((al, i) => {
    const row = `aliases[${i}]`;
    const members = al.symbols.map(clean).filter((s) => s !== "");
    if (blank(al.alias)) {
      c.add(row, "An alias needs the literature spelling.", "missing");
    } else if (dupAliases.has(i)) {
      c.add(row, `"${al.alias}" is listed twice.`, "wrong");
    } else if (objectKey(al.alias)) {
      c.add(
        row,
        `"${
          clean(al.alias)
        }" is a name JavaScript keeps for itself; use another spelling.`,
        "wrong",
      );
    } else if (hasHidden(al.alias)) {
      c.add(row, HIDDEN_MESSAGE, "wrong");
    } else if (
      members.length === 1 && monogenic.has(members[0].toUpperCase()) &&
      clean(al.alias).toUpperCase() !== members[0].toUpperCase()
    ) {
      c.add(
        row,
        `This would publish ${members[0]} as "${
          clean(al.alias)
        }" on every page: a spelling NCBI Gene already resolves needs no alias.`,
        "wrong",
      );
    } else if (
      members.length > 1 &&
      members.every((m) => monogenic.has(m.toUpperCase()))
    ) {
      c.add(
        row,
        `This would publish ${members.join(" and ")} under the one name "${
          clean(al.alias)
        }"; list each monogenic gene as itself.`,
        "wrong",
      );
    }
    if (al.symbols.length === 0 || al.symbols.some(blank)) {
      c.add(
        `${row}.symbols`,
        "An alias needs at least one HGNC symbol, with no empty item.",
        "missing",
      );
    } else c.hidden(`${row}.symbols`, al.symbols.join(","));
  });
  const symbols = new Set(genes.map((g) => clean(g.symbol)));
  // tests/data_contract_test.ts keys data/omim_info.json on the number.
  const dupOmim = duplicates(omimRows.map((r) => r.omimNum));
  omimRows.forEach((r, i) => {
    const num = `omimRows[${i}].omimNum`;
    if (blank(r.omimNum)) {
      c.add(
        num,
        "The OMIM number must be digits, with no leading zero.",
        "missing",
      );
    } else if (!PMID.test(clean(r.omimNum))) {
      c.add(
        num,
        "The OMIM number must be digits, with no leading zero.",
        "wrong",
      );
    } else if (dupOmim.has(i)) {
      c.add(num, `OMIM ${clean(r.omimNum)} is listed twice.`, "wrong");
    }
    // tests/pipeline/export/test_omim.py holds the committed table to
    // ASCII, and a name copied from ClinVar or omim.org is often not.
    const ascii = (key: keyof OmimRow) => {
      if (!ASCII_TEXT.test(clean(r[key]))) {
        c.add(
          `omimRows[${i}].${key}`,
          "The OMIM table is plain ASCII: replace accented letters, curly quotes, long dashes and non-breaking spaces.",
          "wrong",
        );
      }
    };
    for (const [key, what] of OMIM_TEXT) {
      if (blank(r[key])) {
        c.add(`omimRows[${i}].${key}`, `${what} is required.`, "missing");
      } else ascii(key);
    }
    ascii("inheritance");
    const gene = `omimRows[${i}].geneOrLocus`;
    if (blank(r.geneOrLocus)) {
      c.add(
        gene,
        "The row's gene must be one of the monogenic genes.",
        "missing",
      );
    } else if (!symbols.has(clean(r.geneOrLocus))) {
      c.add(
        gene,
        "The row's gene must be one of the monogenic genes.",
        "wrong",
      );
    }
  });
  return c.issues;
}

function promptIssues(a: Answers): Issue[] {
  const c = new Collector("prompt");
  const optional = new Set(["strategy.disease_steps"]);
  if (a.monogenic.genes.length === 0) {
    for (const id of MONOGENIC_SECTION_IDS) optional.add(id);
  }
  // Checked on the bodies as the file will hold them.
  const bodies = promptBodies(a);
  for (const id of TYPED_SECTION_IDS) {
    const field = `sections.${id}`;
    const body = bodies[id];
    if (blank(body)) {
      // The disease steps may be empty, and the monogenic examples with no
      // monogenic gene; every other slot sits mid-sentence.
      if (!optional.has(id)) {
        c.add(
          field,
          "This section is required; it is spliced into the model's instructions.",
          "missing",
        );
      }
      continue;
    }
    if (HEADING_LINE.test(body)) {
      // pipeline/disease.py refuses any line that reads as a section heading.
      c.add(
        field,
        'A line starting with "## " would read as a new section heading; reword it.',
        "wrong",
      );
    }
    if (body.includes(SLOT)) {
      // pipeline/prompts.py refuses a prompt with a "{{" left in it.
      c.add(
        field,
        'The text cannot contain "{{"; the prompt reads it as a slot.',
        "wrong",
      );
    }
    if (!BLOCK_SECTION_IDS.includes(id) && body.includes("\n")) {
      c.add(
        field,
        "This text is spliced into one line of the model's instructions: join its lines.",
        "wrong",
      );
    }
    c.hidden(field, body);
  }
  // pipeline/prompts.py numbers each step and joins them one to a line, so
  // a line break inside a step would reach the model as an unnumbered line.
  const steps = diseaseSteps(a.prompt.sections["strategy.disease_steps"] ?? "");
  if (steps.some((step) => step.includes("\n"))) {
    c.add(
      "sections.strategy.disease_steps",
      "Each step is one paragraph: join the lines of a step, or leave a blank line between two steps.",
      "wrong",
    );
  }
  const examples = a.prompt.examples;
  if (examples.length === 1) {
    c.add("examples", "Give two to four example papers, or none.", "missing");
  } else if (examples.length > 4) {
    c.add("examples", "Give two to four example papers, or none.", "wrong");
  }
  const traitKeys = new Set(a.vocabulary.traits.map((t) => clean(t.key)));
  // The example blocks are written into the prompt, so a "{{" in any of
  // their typed text is reported on the field that holds it.
  const slotless = (field: string, value: string) => {
    if (value.includes(SLOT)) {
      c.add(
        field,
        'The text cannot contain "{{"; the prompt reads it as a slot.',
        "wrong",
      );
    } else c.hidden(field, value);
  };
  examples.forEach((e, i) => {
    const pmid = `examples[${i}].pmid`;
    if (blank(e.pmid)) {
      c.add(pmid, "The PMID must be digits, with no leading zero.", "missing");
    } else if (!PMID.test(clean(e.pmid))) {
      c.add(pmid, "The PMID must be digits, with no leading zero.", "wrong");
    } else if (e.abstract === null) {
      // The abstract is fetched only for a record that exists, and cleared
      // when the PMID is edited, so it is what confirms the paper.
      c.add(
        pmid,
        `Fetch the abstract to confirm PMID ${clean(e.pmid)} exists.`,
        "pending",
      );
    }
    const type = `examples[${i}].type`;
    if (blank(e.type)) {
      c.add(
        type,
        "The example type is required, e.g. include_validated.",
        "missing",
      );
    } else if (!EXAMPLE_TYPE.test(clean(e.type))) {
      c.add(
        type,
        "The example type starts with include_ and is lower-case letters, digits and underscores, e.g. include_validated: every example shows a gene to extract.",
        "wrong",
      );
    }
    c.text(`examples[${i}].gene`, e.gene, "The gene symbol");
    if (!blank(e.gene)) slotless(`examples[${i}].gene`, e.gene);
    const traits = `examples[${i}].traits`;
    if (e.traits.length === 0) {
      c.add(
        traits,
        "Pick at least one trait from the vocabulary step.",
        "missing",
      );
    } else if (e.traits.some((t) => !traitKeys.has(clean(t)))) {
      c.add(
        traits,
        "Pick at least one trait from the vocabulary step.",
        "wrong",
      );
    }
    c.text(`examples[${i}].sentence`, e.sentence, "The paper's own sentence");
    if (!blank(e.sentence)) slotless(`examples[${i}].sentence`, e.sentence);
    // A field left empty is NaN, and JSON writes NaN as null, so the
    // reloaded draft has to fail here too -- null passes >= 0 and <= 1.
    if (!confidenceOk(e.confidence)) {
      c.add(
        `examples[${i}].confidence`,
        "Confidence is a number between 0 and 1.",
        typeof e.confidence !== "number" || Number.isNaN(e.confidence)
          ? "missing"
          : "wrong",
      );
    }
    c.text(`examples[${i}].reasoning`, e.reasoning, "The reasoning line");
    if (!blank(e.reasoning)) slotless(`examples[${i}].reasoning`, e.reasoning);
  });
  return c.issues;
}

function goldIssues(a: Answers): Issue[] {
  const c = new Collector("gold");
  const rows = a.gold.rows;
  if (rows.length < 10) {
    c.add("rows", "List between ten and thirty gold PMIDs.", "missing");
  } else if (rows.length > 30) {
    c.add("rows", "List between ten and thirty gold PMIDs.", "wrong");
  }
  const dup = duplicates(rows.map((r) => r.pmid));
  rows.forEach((r, i) => {
    const field = `rows[${i}].pmid`;
    const pmid = clean(r.pmid);
    if (pmid === "") {
      c.add(field, "The PMID must be digits, with no leading zero.", "missing");
    } else if (!PMID.test(pmid)) {
      c.add(field, "The PMID must be digits, with no leading zero.", "wrong");
    } else if (dup.has(i)) {
      c.add(field, `${pmid} is listed twice.`, "wrong");
    } else if (r.exists === null) {
      c.add(field, `${pmid} has not been checked yet.`, "pending");
    } else if (r.exists === false) {
      c.add(field, `${pmid} does not exist in PubMed.`, "wrong");
    }
    c.text(
      `rows[${i}].note`,
      r.note,
      "The note saying why the paper is gold",
    );
  });
  return c.issues;
}

export function validate(answers: Answers): Issue[] {
  return [
    ...identityIssues(answers),
    ...searchIssues(answers),
    ...vocabularyIssues(answers),
    ...trialsIssues(answers),
    ...monogenicIssues(answers),
    ...promptIssues(answers),
    ...goldIssues(answers),
  ];
}

export function issuesFor(issues: Issue[], step: StepId): Issue[] {
  return issues.filter((i) => i.step === step);
}
