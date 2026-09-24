/**
 * Everything the wizard collects, as one plain object.
 *
 * The island holds one of these in state, every step edits its own slice,
 * and the generators read the whole. Lookup results live beside the answer
 * they inform (the heading a phrase resolved to, the count a term
 * returned) so a reloaded draft shows what the researcher saw when they
 * decided.
 */

import type { CitationStandard } from "../types.ts";
import {
  aligned,
  bool,
  count,
  dict,
  file,
  isRecord,
  list,
  nullable,
  nullIfBlank,
  num,
  obj,
  pair,
  rebuild,
  str,
} from "./draft_shape.ts";
import type { StepId } from "./validate.ts";

export { isRecord };

export const DRAFT_VERSION = 1;
/**
 * localStorage key, in the `svd-` namespace the other storage keys share. The
 * literal scan matches a short form as written, so it does not flag it.
 */
export const DRAFT_STORAGE_KEY = "svd-adapt-draft";
/** The largest logo the Identity step takes, and a draft keeps, in bytes. */
export const LOGO_BYTE_LIMIT = 1_000_000;

export interface LogoFile {
  /** File name as uploaded, e.g. "logo-light.svg". */
  name: string;
  /** Base64 of the file's bytes. */
  base64: string;
}

export interface Identity {
  disease: {
    key: string;
    name: string;
    short: string;
    abbreviation: string;
    adjective: string;
  };
  /**
   * Drafted from the names above; a string still on its draft follows the
   * names, and one the researcher has edited stays theirs (redraftSite()).
   */
  site: {
    title: string;
    heading: string;
    metaDescription: string;
    aboutTitle: string;
    aboutLede: string;
    loginLede: string;
    pages: { genes: string; trials: string; timeline: string; map: string };
  };
  institute: {
    name: string;
    short: string;
    url: string;
    copyright: string;
    logoAlt: string;
  };
  logoLight: LogoFile | null;
  logoDark: LogoFile | null;
  maintainer: { name: string; email: string };
  cellTypes: {
    label: string;
    glossary: Array<{ abbrev: string; name: string }>;
  };
}

export interface MeshChoice {
  phrase: string;
  heading: string | null;
  scopeNote: string | null;
  count: number | null;
}

export interface Search {
  diseaseTerms: string[];
  meshTerms: MeshChoice[];
  markerTerms: Array<{ term: string; count: number | null }>;
  ncbi: { email: string; apiKey: string };
}

export interface Trait {
  key: string;
  label: string;
  name: string;
  family: string;
  definition: string;
  standard: boolean;
  xref: string | null;
  xrefNote: string;
}

export interface Vocabulary {
  traits: Trait[];
  families: Array<{ key: string; label: string }>;
  citationStandard: CitationStandard | null;
}

export interface PopulationAnswer {
  key: string;
  label: string;
  /** The radar's label lines; defaults to [label]. */
  lines: string[];
}

export interface Trials {
  populations: PopulationAnswer[];
  populationField: { label: string; detailsLabel: string };
  searchTerms: Array<{
    term: string;
    count: number | null;
    sampleConditions: string[];
    sampleInterventions: string[];
  }>;
  conditions: string[];
  conditionPairs: Array<[string, string]>;
  mechanismFamilies: Array<{ key: string; label: string }>;
  mechanisms: Array<{ name: string; family: string }>;
}

export interface OmimRow {
  omimNum: string;
  location: string;
  phenotype: string;
  phenotypeMimNumber: string;
  inheritance: string;
  phenotypeMappingKey: string;
  geneOrLocus: string;
  geneOrLocusMimNumber: string;
}

export interface Monogenic {
  genes: Array<{
    symbol: string;
    /** null until checked, then whether NCBI Gene knows the symbol. */
    verified: boolean | null;
    clinvarTraits: Array<{ name: string; omim: string | null }>;
  }>;
  aliases: Array<{ alias: string; symbols: string[] }>;
  omimRows: OmimRow[];
}

export interface ExampleAnswer {
  pmid: string;
  /** The <example type="…"> label, e.g. include_validated. */
  type: string;
  abstract: string | null;
  gene: string;
  traits: string[];
  sentence: string;
  confidence: number;
  reasoning: string;
}

export interface PromptAnswers {
  /** Typed section bodies, keyed by section id (see prompt_sections.ts). */
  sections: Record<string, string>;
  examples: ExampleAnswer[];
}

export interface Gold {
  rows: Array<{
    pmid: string;
    note: string;
    title: string | null;
    exists: boolean | null;
  }>;
}

export interface Answers {
  version: typeof DRAFT_VERSION;
  identity: Identity;
  search: Search;
  vocabulary: Vocabulary;
  trials: Trials;
  monogenic: Monogenic;
  prompt: PromptAnswers;
  gold: Gold;
}

/** Every object and array in `value` frozen, and `value` returned. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The answers a fresh draft starts from. Frozen: the island puts this very
 * object into state, and the server holds it for its lifetime, so one write
 * in place would come back at every Start over.
 */
export const EMPTY_ANSWERS: Answers = deepFreeze({
  version: DRAFT_VERSION,
  identity: {
    disease: { key: "", name: "", short: "", abbreviation: "", adjective: "" },
    site: {
      title: "",
      heading: "",
      metaDescription: "",
      aboutTitle: "",
      aboutLede: "",
      loginLede: "",
      pages: { genes: "", trials: "", timeline: "", map: "" },
    },
    institute: { name: "", short: "", url: "", copyright: "", logoAlt: "" },
    logoLight: null,
    logoDark: null,
    maintainer: { name: "", email: "" },
    cellTypes: { label: "", glossary: [] },
  },
  search: {
    diseaseTerms: [],
    meshTerms: [],
    markerTerms: [],
    ncbi: { email: "", apiKey: "" },
  },
  vocabulary: { traits: [], families: [], citationStandard: null },
  trials: {
    populations: [],
    populationField: { label: "", detailsLabel: "" },
    searchTerms: [],
    conditions: [],
    conditionPairs: [],
    mechanismFamilies: [],
    mechanisms: [],
  },
  monogenic: { genes: [], aliases: [], omimRows: [] },
  prompt: { sections: {}, examples: [] },
  gold: { rows: [] },
});

/**
 * One row per phrase, in the phrases' order.
 *
 * A lookup writes its row back by index, and the row for a phrase not
 * looked up yet has to be an object like every other: an array grown by
 * its `length` holds holes, `JSON.stringify` writes a hole as `null`, and
 * the next load reads `heading` off it and throws before anything renders.
 * That stand-in names no phrase, because a row answers the phrase it
 * names: one naming its phrase with no heading would read as "MeSH has no
 * heading for this", which nobody asked.
 */
export function alignMeshTerms(
  diseaseTerms: string[],
  meshTerms: MeshChoice[],
): MeshChoice[] {
  const rows: MeshChoice[] = [];
  for (const i of diseaseTerms.keys()) {
    const existing = meshTerms[i];
    rows.push(
      existing === undefined || existing === null
        ? { phrase: "", heading: null, scopeNote: null, count: null }
        : existing,
    );
  }
  return rows;
}

/**
 * The shape of a draft, as parseDraft reads one back (see draft_shape.ts).
 * A field added to Answers needs its line here, or a reload drops it;
 * tests/adapt/answers_test.ts round-trips a fixture with every field set.
 */
const STEPS_SHAPE = obj({
  identity: obj({
    disease: obj({
      key: str,
      name: str,
      short: str,
      abbreviation: str,
      adjective: str,
    }),
    site: obj({
      title: str,
      heading: str,
      metaDescription: str,
      aboutTitle: str,
      aboutLede: str,
      loginLede: str,
      pages: obj({ genes: str, trials: str, timeline: str, map: str }),
    }),
    institute: obj({
      name: str,
      short: str,
      url: str,
      copyright: str,
      logoAlt: str,
    }),
    logoLight: file(LOGO_BYTE_LIMIT),
    logoDark: file(LOGO_BYTE_LIMIT),
    maintainer: obj({ name: str, email: str }),
    cellTypes: obj({
      label: str,
      glossary: list(obj({ abbrev: str, name: str })),
    }),
  }),
  search: obj({
    // A MeSH row answers the phrase at its index, so the two lists keep
    // their places when one entry cannot be read.
    diseaseTerms: aligned(str),
    meshTerms: aligned(obj({
      phrase: str,
      heading: nullable(str),
      scopeNote: nullable(str),
      count,
    })),
    markerTerms: list(obj({ term: str, count })),
    ncbi: obj({ email: str, apiKey: str }),
  }),
  vocabulary: obj({
    traits: list(obj({
      key: str,
      label: str,
      name: str,
      family: str,
      definition: str,
      standard: bool,
      // A blank term is no term: kept, it would switch off the note a
      // trait without one owes.
      xref: nullIfBlank,
      xrefNote: str,
    })),
    families: list(obj({ key: str, label: str })),
    citationStandard: nullable(
      obj({ name: str, label: str, doi: str, linkLabel: str }),
    ),
  }),
  trials: obj({
    populations: list(obj({ key: str, label: str, lines: list(str) })),
    populationField: obj({ label: str, detailsLabel: str }),
    searchTerms: list(obj({
      term: str,
      count,
      sampleConditions: list(str),
      sampleInterventions: list(str),
    })),
    conditions: list(str),
    conditionPairs: list(pair),
    mechanismFamilies: list(obj({ key: str, label: str })),
    mechanisms: list(obj({ name: str, family: str })),
  }),
  monogenic: obj({
    genes: list(obj({
      symbol: str,
      verified: nullable(bool),
      clinvarTraits: list(obj({ name: str, omim: nullable(str) })),
    })),
    aliases: list(obj({ alias: str, symbols: list(str) })),
    omimRows: list(obj({
      omimNum: str,
      location: str,
      phenotype: str,
      phenotypeMimNumber: str,
      inheritance: str,
      phenotypeMappingKey: str,
      geneOrLocus: str,
      geneOrLocusMimNumber: str,
    })),
  }),
  prompt: obj({
    sections: dict,
    examples: list(obj({
      pmid: str,
      type: str,
      abstract: nullable(str),
      gene: str,
      traits: list(str),
      sentence: str,
      // An empty confidence is NaN, which JSON writes as null; it reads
      // back as NaN so that validate() still refuses it.
      confidence: num,
      reasoning: str,
    })),
  }),
  gold: obj({
    rows: list(obj({
      pmid: str,
      note: str,
      title: nullable(str),
      exists: nullable(bool),
    })),
  }),
});

export function serialiseDraft(answers: Answers): string {
  return JSON.stringify(answers);
}

/**
 * A draft of this version with every step present, and the path of every
 * answer in it that could not be read, or null. A missing step falls back
 * to its empty value so an older draft that predates a step still loads; a
 * different version does not, because its shapes are unknown.
 */
export function parseDraftReport(
  text: string,
): { answers: Answers; dropped: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== DRAFT_VERSION) return null;
  const { value, dropped } = rebuild(STEPS_SHAPE, raw);
  return {
    answers: {
      version: DRAFT_VERSION,
      ...value as Omit<Answers, "version">,
    },
    dropped,
  };
}

/** parseDraftReport's answers alone. */
export function parseDraft(text: string): Answers | null {
  return parseDraftReport(text)?.answers ?? null;
}

/**
 * Fields that are null until a lookup or an answer fills them, named by
 * their path from the step: the array's own field name (row index left out,
 * since every row shares one shape) joined to the leaf. Blanked, they go
 * back to null rather than to "", because validate() asks different things
 * of the two (a trait with no ontology term owes a note). A bare leaf name
 * would collide with `identity.site`'s `title` and `heading`, which are
 * ordinary required text, not a lookup result -- hence the full path rather
 * than the key alone.
 */
const NULLED = new Set([
  "meshTerms.heading",
  "meshTerms.scopeNote",
  "meshTerms.count",
  "markerTerms.count",
  "searchTerms.count",
  "traits.xref",
  "genes.verified",
  "genes.clinvarTraits.omim",
  "rows.title",
  "rows.exists",
  "examples.abstract",
]);

function blankValue(value: unknown, path = ""): unknown {
  if (NULLED.has(path)) return null;
  if (typeof value === "string") return "";
  if (typeof value === "number") return NaN;
  if (Array.isArray(value)) {
    return value.map((entry) => blankValue(entry, path));
  }
  if (isRecord(value)) {
    if (typeof value.base64 === "string") return null;
    return Object.fromEntries(
      Object.entries(value).map((
        [k, v],
      ) => [k, blankValue(v, path === "" ? k : `${path}.${k}`)]),
    );
  }
  return value;
}

/**
 * The answers with one step emptied: every string blank, every number
 * unset, every logo gone, every list its length. validate() on it lists the
 * questions the step asks as it stands, which is how the summary counts them
 * without a second, hand-kept list that could drift from the rules.
 */
export function blankStep(answers: Answers, step: StepId): Answers {
  return { ...answers, [step]: blankValue(answers[step]) } as Answers;
}
