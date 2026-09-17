/**
 * Shapes of the JSON emitted by `pipeline/export/`. Keys are camelCase; the
 * human-readable column labels live in the islands' column definitions.
 *
 * The four array fields on `Gene` were R list-columns. They are still always
 * arrays, never bare strings: `pipeline/export/tables.py` builds them as
 * Python lists and a Python list serialises as a JSON array unconditionally,
 * so nothing on the Python side needs R's `I()` wrapping to stop a
 * one-element vector unboxing into a bare string. When a gene has no value
 * the array holds a single sentinel string such as `"(none found)"`, which
 * the filter UI matches on literally.
 */

/** One row of Table 1 — a putative causal gene. */
export interface Gene {
  gene: string;
  protein: string;
  chromosomalLocation: string;
  gwasTrait: string[];
  mendelianRandomization: string;
  evidenceFromOtherOmicsStudies: string[];
  linkToMonogenicDisease: string[];
  brainCellTypes: string;
  affectedPathway: string;
  references: string[];
  /** Verbatim sentence from the paper supporting this row's first-occurrence
   * extraction. Never blank -- a gene curated before the provenance prompt
   * (migration 004) publishes the "(not yet extracted)" sentinel instead. */
  sourceQuote: string;
  /** The model's own [0.0, 1.0] score for the same first-occurrence
   * extraction, or null for a gene with no machine-extracted entry at all. */
  confidence: number | null;
}

/** One row of Table 2 — a drug in a registered clinical trial. */
export interface Trial {
  drug: string;
  mechanismOfAction: string;
  geneticTarget: string;
  geneticEvidence: string;
  trialName: string;
  registryId: string;
  clinicalTrialPhase: string;
  svdPopulation: string;
  svdPopulationDetails: string;
  /** Stored as a string: the source column is nullable and mixes formats. */
  targetSampleSize: string;
  estimatedCompletionDate: string;
  primaryOutcome: string;
  sponsorType: string;
  /** ClinicalTrials.gov overall status token, or "(unknown)" when no registry record answers. */
  overallStatus: string;
}

/** NCBI Gene cache entry. */
export interface GeneInfo {
  name: string;
  uid: string | null;
  description: string | null;
  otheraliases: string | null;
}

/** UniProt cache entry. */
export interface ProteinInfo {
  gene: string;
  accession: string | null;
  url: string | null;
}

/**
 * A PubMed citation, keyed by PMID.
 *
 * `formattedRef` is the pre-rendered HTML fragment the export has always
 * written. The five fields beside it are the same citation as data, published
 * since the table cell needs an author and a year on their own. Every one of
 * them is nullable: `read_pubmed_refs` completes a PMID it cannot resolve with
 * the `formattedRef` sentinel and nulls, and `lib/citations.ts` falls back to
 * the bare PMID when it sees that.
 */
export interface Reference {
  pmid: string;
  authors: string | null;
  title: string | null;
  journal: string | null;
  publicationDate: string | null;
  doi: string | null;
  formattedRef: string;
}

/** OMIM phenotype entry. `omimNum` is numeric in the source CSV. */
export interface OmimEntry {
  omimNum: number;
  omimLink: string;
  phenotype: string;
  inheritance: string;
  geneOrLocus: string;
  geneOrLocusMimNumber: string;
}

/**
 * A cross-reference to a concept related to, but not the same as, the disease
 * on the row.
 *
 * `relation` is whatever the source reported, verbatim — Orphanet's `E`
 * (exact), `BTNT` (the ORPHAcode is broader than this code), `NTBT` (narrower),
 * `ND` (not yet decided), `W` (wrong mapping), or a compound like `BTNT/E`.
 * `null` means the source stated none, which is not evidence of anything.
 */
export interface RelatedXref {
  id: string;
  relation: string | null;
}

/**
 * One gene's association with one disease, as ClinVar and Orphadata report it.
 *
 * The four identifier fields name *this* disease: ClinVar attests them for this
 * gene, or Orphanet maps them exactly and ClinVar was silent. Every other
 * cross-reference is in `relatedXrefs`, because it names a different concept —
 * Orphanet:1885 ("Ectopia lentis") maps to three distinct OMIM subtypes, and
 * only one of them is the disease on the row.
 */
export interface GeneAnnotation {
  geneSymbol: string;
  groupKey: string;
  diseaseName: string;
  omimId: string | null;
  mondoId: string | null;
  orphacode: string | null;
  medgenId: string | null;
  /**
   * OMIM phenotypic series this disease belongs to. A series names a *group*
   * of phenotypes, so it is not the disease's own MIM number and
   * `omimByNumber` cannot resolve one.
   */
  omimSeries: string[];
  classification: string | null;
  recordCount: number | null;
  relatedXrefs: RelatedXref[];
  /**
   * One version per source that contributed to this row, keyed by the
   * source id the pipeline writes (`clinvar`, `orphadata`). A row is
   * assembled from both, and they are versioned separately, so a single
   * `sourceVersion` could only ever name one of them — it named
   * Orphadata's, because that is the source the export reads last. A key
   * present with a `null` value means the source contributed rows and
   * publishes no version of its own, which is ClinVar today.
   */
  sourceVersions: Record<string, string | null>;
}

/** One geocoded trial facility. */
export interface TrialLocation {
  nctId: string;
  facilityName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  trialTitle: string | null;
  status: string | null;
  lat: number;
  lon: number;
}

/** Latest pipeline run summary; null until a run has been recorded. */
export interface PipelineStatus {
  runTimestamp: string;
  papersProcessed: number;
  fulltextRetrieved: number;
  genesExtracted: number;
  genesValidated: number;
}

/**
 * The full report of one pipeline run, mirroring
 * `pipeline/run_report.py`'s `PipelineRunReport`. Null until a run has
 * recorded one; the About page falls back to `PipelineStatus`.
 */
export interface PipelineRun {
  runTimestamp: string;
  status: RunStatus;
  runMode: string;
  durationSeconds: number;
  computeSeconds: number;
  config: RunConfig;
  papers: PaperCounts;
  genes: GeneCounts;
  tokens: TokenCounts;
  database: DatabaseCounts | null;
  steps: RunStep[];
  apis: ApiService[];
  papersDetail: CappedList<RunPaper>;
  acceptedGenes: CappedList<RunGene>;
  rejectedGenes: CappedList<RejectedGene>;
}

export type RunStatus = "completed" | "completed_with_warnings" | "failed";

export type StepStatus = "ok" | "warning" | "failed" | "skipped";

/** An enumeration that may be shorter than the count it reports. */
export interface CappedList<T> {
  shown: number;
  total: number;
  items: T[];
}

export interface RunConfig {
  model: string | null;
  effort: string | null;
  promptVersion: string | null;
  mode: string | null;
  skipValidation: boolean;
  dryRun: boolean;
  confidenceThresholdUpdate: number | null;
  confidenceThresholdInsert: number | null;
}

/** One trial population of the radar and the population filter. */
export interface Population {
  key: string;
  label: string;
}

export interface CitationStandard {
  name: string;
  label: string;
  doi: string;
  linkLabel: string;
}

export interface AboutCitation {
  authors: string;
  title: string;
  journal: string;
  year: number;
  doi: string;
}

export interface AdditionalSource {
  name: string;
  href: string;
  licence: { label: string; href: string | null };
  provides: string;
}

/** `disease/manifest.json`, normalized. See docs/superpowers/specs/2026-09-17-disease-reuse-design.md §3.1. */
export interface DiseaseManifest {
  schemaVersion: 1;
  disease: {
    key: string;
    name: string;
    short: string;
    abbreviation: string;
    adjective: string;
  };
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
    url: string | null;
    copyright: string;
    logo: { src: string; srcOnDark: string | null; alt: string };
  };
  contact: { maintainer: { name: string; email: string } };
  about: {
    citation: AboutCitation | null;
    board: string | null;
    contactUs: string | null;
    acknowledgements: string | null;
    additionalSources: AdditionalSource[];
  };
  hosting: { url: string | null };
  populations: Population[];
  populationField: { label: string; detailsLabel: string };
  cellTypes: { label: string; glossary: Record<string, string> };
  citationStandard: CitationStandard | null;
}

export interface PaperCounts {
  found: number | null;
  newlySeen: number | null;
  alreadySeen: number | null;
  processed: number;
  fulltext: number;
  abstractOnly: number;
  noTextAvailable: number;
  failed: number;
}

export interface GeneCounts {
  extracted: number;
  validated: number;
  rejected: number;
  rejectedAtInsertFloor: number;
  /** Quotes checked. The two below are different claims — see the widget. */
  quotesChecked: number;
  quotesVerbatim: number;
  quotesCited: number;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  truncatedResponses: number;
  estimatedCostUsd: number;
}

export interface DatabaseCounts {
  inserted: number;
  updated: number;
}

export interface RunStep {
  key: string;
  label: string;
  ordinal: number;
  status: StepStatus;
  startedAt: string | null;
  durationSeconds: number | null;
  actions: string[];
  warnings: RunWarning[];
  error: RunError | null;
}

/** A non-fatal finding; `count` is things, not rows. */
export interface RunWarning {
  kind: string;
  title: string;
  count: number;
  detail: string | null;
  subjects: string[];
}

/** A failure, already phrased for a reader. */
export interface RunError {
  kind: string;
  title: string;
  detail: string | null;
  subject: string | null;
}

/** One external service and endpoint, aggregated over the run. */
export interface ApiService {
  service: string;
  label: string;
  endpoint: string;
  method: string;
  calls: number;
  ok: number;
  notFound: number;
  errors: number;
  retries: number;
  totalMs: number;
  bytes: number;
}

/** One upstream a reference-data refresh consulted. */
export interface SyncSource {
  key: string;
  label: string;
  fetched: number;
  cached: number;
  failed: number;
}

/**
 * One reference-data refresh: `--clinical-trials`,
 * `--sync-external-data` or `--sync-annotations`.
 *
 * Deliberately not a `PipelineRun`. A refresh has no papers, genes or
 * steps, and it is stored in its own table for the same reason -- so that
 * no query feeding the run widget or the About page's date badge can
 * mistake one for a run that processed nothing.
 */
export interface SyncRun {
  runTimestamp: string;
  mode: string;
  status: RunStatus;
  durationSeconds: number;
  sources: SyncSource[];
  apis: ApiService[];
  errors: CappedList<string>;
}

export interface RunPaper {
  pmid: string;
  source: string;
  fulltext: boolean;
  geneCount: number;
  rejectedCount: number;
  processingSeconds: number | null;
  error: string | null;
}

export interface RunGene {
  symbol: string;
  pmid: string | null;
  confidence: number | null;
  gwasTraits: string[];
  proteinName: string | null;
  mendelianRandomization: boolean | null;
  omicsEvidence: string[];
  causalEvidenceSummary: string | null;
  sourceQuote: string | null;
}

export interface RejectedGene {
  symbol: string;
  pmid: string | null;
  confidence: number | null;
  reasons: string[];
}

/** A single checkbox option in a sidebar filter group. */
export interface FilterChoice {
  label: string;
  value: string;
  description?: string;
}
