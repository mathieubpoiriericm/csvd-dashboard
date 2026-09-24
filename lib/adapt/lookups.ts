/**
 * The interview's pre-fill lookups, callable from the browser.
 *
 * Every function takes the fetch to use, so nothing here touches the
 * network in a test, and returns a Result rather than throwing, so the
 * island can put the failure in the step's status line. NCBI, OLS4 and
 * ClinicalTrials.gov all answer cross-origin requests.
 */

import type { MeshChoice } from "./answers.ts";

export type Fetch = typeof fetch;
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface NcbiAuth {
  email: string;
  apiKey: string;
}

/**
 * How long a request may take, its body included, before it is abandoned,
 * and how a retry waits. The island uses the real clock; a test passes its
 * own so that nothing waits.
 */
export interface Timing {
  deadline: number;
  pause: (delay: number) => Promise<void>;
}

const REAL: Timing = {
  deadline: 30_000,
  pause: (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
};

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
const OLS = "https://www.ebi.ac.uk/ols4/api/search";
const CTGOV = "https://clinicaltrials.gov/api/v2/studies";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

function ncbiUrl(
  endpoint: string,
  params: Record<string, string>,
  auth: NcbiAuth,
): string {
  // A key pasted with a trailing newline is refused by NCBI outright.
  const email = auth.email.trim();
  const apiKey = auth.apiKey.trim();
  const query = new URLSearchParams(params);
  if (email !== "") query.set("email", email);
  if (apiKey !== "") query.set("api_key", apiKey);
  return `${EUTILS}${endpoint}?${query}`;
}

/** One request's outcome, with what a retry needs to know of a failure. */
type Attempt = { ok: true; value: string } | {
  ok: false;
  error: string;
  /** The status of an answer that was not OK. */
  status?: number;
  /** The seconds a refusal asked to be left alone for, when it said. */
  retryAfter?: number;
  /** The fetch itself failed: offline, or a refusal with no CORS header. */
  rejected?: boolean;
};

/**
 * NCBI writes an error with a + for every space ("ID+list+is+empty!"); a
 * text with no space in it is read back that way.
 */
function words(text: string): string {
  const trimmed = text.trim();
  return /\s/.test(trimmed) ? trimmed : trimmed.replaceAll("+", " ");
}

/**
 * A refusal's reason, when its body gives one in words: a page or a JSON
 * document is not read out, and a long reason is cut at 200 characters.
 */
async function reasonOf(response: Response): Promise<string> {
  let text: string;
  try {
    text = words(await response.text());
  } catch {
    return "";
  }
  if (text === "" || /^[<{[]/.test(text)) return "";
  const reason = text.split(/\s*[\r\n]+\s*/).join("; ");
  return `: ${reason.length > 200 ? `${reason.slice(0, 199)}…` : reason}`;
}

/**
 * One request, abandoned at the deadline. The timer aborts the signal the
 * fetch was given, which stops a body that never ends as well as an answer
 * that never starts.
 */
async function attempt(
  f: Fetch,
  url: string,
  timing: Timing,
): Promise<Attempt> {
  const host = new URL(url).host;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timing.deadline);
  try {
    const response = await f(url, { signal: abort.signal });
    if (!response.ok) {
      const after = (response.headers.get("retry-after") ?? "").trim();
      return {
        ok: false,
        error: `${response.status} from ${host}${await reasonOf(response)}`,
        status: response.status,
        retryAfter: /^\d+$/.test(after) ? Number(after) : undefined,
      };
    }
    return { ok: true, value: await response.text() };
  } catch (error) {
    if (abort.signal.aborted) {
      return {
        ok: false,
        error: `${host} did not answer within ${
          timing.deadline / 1000
        } s; try again`,
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rejected: error instanceof TypeError,
    };
  } finally {
    clearTimeout(timer);
  }
}

const REFUSED =
  "NCBI refused the API key; correct it or clear it in NCBI access";
const LIMITED = "rate-limiting this browser; wait a moment and try again";
const ADD_KEY = ", or add an API key";

/**
 * An E-utilities request, retried the way NCBI's gateway needs.
 *
 * The gateway refuses a key it does not know, and a request over the rate
 * limit, with no CORS header, so the browser sees only "Failed to fetch". A
 * keyed request failing like that, or with a readable 400, is sent once
 * without the key: if that one is answered, the keyed one is sent again a
 * second later -- a key over its own limit is refused the same way for a
 * moment -- and a second refusal is put down to the key. A 429, and a keyless
 * request that fails to fetch, is retried twice after a widening pause
 * (Retry-After when it is given, up to ten seconds). A timeout is final.
 * Every retry goes through the same fetch, so the island's spacing holds.
 */
async function ncbiText(
  f: Fetch,
  url: string,
  timing: Timing,
): Promise<Result<string>> {
  const keyed = new URL(url).searchParams.has("api_key");
  const first = await attempt(f, url, timing);
  if (first.ok) return first;
  if (keyed && (first.rejected || first.status === 400)) {
    const bare = new URL(url);
    bare.searchParams.delete("api_key");
    if (!(await attempt(f, String(bare), timing)).ok) return fail(first.error);
    await timing.pause(1000);
    const again = await attempt(f, url, timing);
    return again.ok ? again : fail(REFUSED);
  }
  let last = first;
  for (let tries = 1; tries < 3; tries++) {
    if (last.status !== 429 && (keyed || !last.rejected)) break;
    await timing.pause(
      last.retryAfter === undefined
        ? 1000 * tries
        : Math.min(last.retryAfter * 1000, 10_000),
    );
    const next = await attempt(f, url, timing);
    if (next.ok) return next;
    last = next;
  }
  if (last.status === 429) {
    return fail(`NCBI is ${LIMITED}${keyed ? "" : ADD_KEY}`);
  }
  return last.rejected && !keyed
    ? fail(`${last.error} (NCBI may be ${LIMITED}${ADD_KEY})`)
    : fail(last.error);
}

async function getText(
  f: Fetch,
  url: string,
  timing: Timing,
): Promise<Result<string>> {
  if (url.startsWith(EUTILS)) return ncbiText(f, url, timing);
  const got = await attempt(f, url, timing);
  return got.ok ? got : fail(got.error);
}

async function getJson(
  f: Fetch,
  url: string,
  timing: Timing,
): Promise<Result<Record<string, unknown>>> {
  const text = await getText(f, url, timing);
  if (!text.ok) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.value);
  } catch {
    return fail(`unreadable response from ${new URL(url).host}`);
  }
  return parsed !== null && typeof parsed === "object"
    ? ok(parsed as Record<string, unknown>)
    : fail(`unreadable response from ${new URL(url).host}`);
}

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/**
 * esearch's result. A search NCBI could not run is answered with a 200 all
 * the same, naming the fault in ERROR: read as an empty idlist it said "no
 * hit", and a re-check erased the heading a row already had.
 */
function searched(
  body: Record<string, unknown>,
): Result<Record<string, unknown>> {
  const found = rec(body.esearchresult);
  const error = found.ERROR;
  return typeof error === "string" && error.trim() !== ""
    ? fail(`NCBI reported "${error.trim()}"`)
    : ok(found);
}

/** An esearch's ids; a reply with no idlist at all is a broken one. */
async function esearch(
  f: Fetch,
  params: Record<string, string>,
  auth: NcbiAuth,
  timing: Timing,
): Promise<Result<{ ids: string[]; found: Record<string, unknown> }>> {
  const body = await getJson(f, ncbiUrl("esearch.fcgi", params, auth), timing);
  if (!body.ok) return body;
  const found = searched(body.value);
  if (!found.ok) return found;
  const idlist = found.value.idlist;
  return Array.isArray(idlist)
    ? ok({ ids: idlist.map(String), found: found.value })
    : fail("no idlist in the response");
}

function countOf(body: Record<string, unknown>): Result<number> {
  const found = searched(body);
  if (!found.ok) return found;
  // Number() reads "", " ", "0x10" and "1e3" as numbers too.
  const raw = found.value.count;
  return typeof raw === "string" && /^\d+$/.test(raw)
    ? ok(Number(raw))
    : fail("no count in the response");
}

const GREEK: Record<string, string> = {
  "α": "alpha",
  "β": "beta",
  "γ": "gamma",
  "δ": "delta",
  "ε": "epsilon",
  "ζ": "zeta",
  "η": "eta",
  "θ": "theta",
  "ι": "iota",
  "κ": "kappa",
  "λ": "lambda",
  "μ": "mu",
  "ν": "nu",
  "ξ": "xi",
  "ο": "omicron",
  "π": "pi",
  "ρ": "rho",
  "σ": "sigma",
  "ς": "sigma",
  "τ": "tau",
  "υ": "upsilon",
  "φ": "phi",
  "χ": "chi",
  "ψ": "psi",
  "ω": "omega",
};

/**
 * A phrase or term compared as PubMed does. NCBI folds a query before it
 * translates it -- "Sjögren" comes back as "Sjogren" -- and MeSH spells its
 * terms in ASCII ("beta-Thalassemia"), so accents go, Greek letters take
 * their names, typographic quotes and dashes their ASCII forms, and case
 * and spacing are ignored.
 */
const norm = (text: string): string =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[α-ω]/g, (letter) => GREEK[letter])
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(
      /[\u201c\u201d\u201e\u201f\u2033]/g,
      '"',
    )
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .trim().replace(/\s+/g, " ");

interface Descriptor {
  terms: string[];
  scopeNote: string;
}

/**
 * The descriptors among `ids`, in their order. Hits that are all of another
 * record type are an answer -- MeSH has no heading for the phrase -- and
 * come back empty; hits with nothing to read are a broken reply.
 */
async function descriptorsOf(
  f: Fetch,
  ids: string[],
  auth: NcbiAuth,
  timing: Timing,
): Promise<Result<Descriptor[]>> {
  if (ids.length === 0) return ok([]);
  const summary = await getJson(
    f,
    ncbiUrl("esummary.fcgi", {
      db: "mesh",
      id: ids.join(","),
      retmode: "json",
    }, auth),
    timing,
  );
  if (!summary.ok) return summary;
  const entries = rec(summary.value.result);
  const descriptors = ids.flatMap((id) => {
    const entry = rec(entries[id]);
    const terms = arr(entry.ds_meshterms).filter((t): t is string =>
      typeof t === "string"
    );
    const type = entry.ds_recordtype;
    if (terms.length === 0) return [];
    if (typeof type === "string" && type !== "descriptor") return [];
    const scopeNote = typeof entry.ds_scopenote === "string"
      ? entry.ds_scopenote
      : "";
    return [{ terms, scopeNote }];
  });
  const typed = ids.some((id) =>
    typeof rec(entries[id]).ds_recordtype === "string"
  );
  return descriptors.length === 0 && !typed
    ? fail("no heading in the response")
    : ok(descriptors);
}

/**
 * The MeSH heading a phrase names, with its scope note, or null when MeSH
 * has none for it.
 *
 * esearch's hits are not the answer: they come newest record first, twenty
 * to a page, so a broad phrase's own heading -- an old, low-numbered record
 * -- is often not among them while its subtypes are. The heading PubMed
 * maps the whole phrase to (its translationset's `"…"[MeSH Terms]`) is
 * therefore looked up directly, one more search per mapped term. Without a
 * mapping, a page of 200 hits is summarised, and among its descriptors the
 * answer is the one with the phrase as an entry term, else the one whose
 * shortest entry term containing the phrase is shortest; with none of
 * those, MeSH has no heading for it. Only a descriptor can be the answer: a
 * supplementary concept is no heading `[MeSH Terms]` can search, and a
 * query built on one retrieves nothing.
 */
export async function meshLookup(
  f: Fetch,
  phrase: string,
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<{ heading: string; scopeNote: string } | null>> {
  const search = await esearch(
    f,
    { db: "mesh", term: phrase.trim(), retmode: "json", retmax: "200" },
    auth,
    timing,
  );
  if (!search.ok) return search;
  const answer = (pick: Descriptor | undefined) =>
    ok(
      pick === undefined
        ? null
        : { heading: pick.terms[0], scopeNote: pick.scopeNote },
    );
  const wanted = norm(phrase);
  const mapped = arr(search.value.found.translationset).flatMap((entry) => {
    const { from, to } = rec(entry);
    if (typeof from !== "string" || typeof to !== "string") return [];
    if (norm(from) !== wanted) return [];
    return [...to.matchAll(/"([^"]+)"\[MeSH Terms\]/g)].map((m) => m[1]);
  });
  if (mapped.length > 0) {
    const ids: string[] = [];
    for (const term of mapped) {
      const hit = await esearch(
        f,
        { db: "mesh", term: `"${term}"[MeSH Terms]`, retmode: "json" },
        auth,
        timing,
      );
      if (!hit.ok) return hit;
      ids.push(...hit.value.ids);
    }
    const named = await descriptorsOf(f, [...new Set(ids)], auth, timing);
    if (!named.ok) return named;
    const terms = mapped.map(norm);
    const pick = named.value.find((d) => terms.includes(norm(d.terms[0]))) ??
      named.value.find((d) => d.terms.some((t) => terms.includes(norm(t))));
    if (pick !== undefined) return answer(pick);
  }
  const hits = await descriptorsOf(f, search.value.ids, auth, timing);
  if (!hits.ok) return hits;
  const containing = (terms: string[]) =>
    Math.min(
      ...terms.filter((t) => norm(t).includes(wanted)).map((t) => t.length),
    );
  return answer(
    hits.value.find((d) => d.terms.some((t) => norm(t) === wanted)) ??
      hits.value
        .filter((d) => Number.isFinite(containing(d.terms)))
        .sort((a, b) => containing(a.terms) - containing(b.terms))[0],
  );
}

export const meshCountTerm = (heading: string): string => `"${heading}"[MeSH]`;

export async function pubmedCount(
  f: Fetch,
  term: string,
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<number>> {
  const body = await getJson(
    f,
    ncbiUrl("esearch.fcgi", {
      db: "pubmed",
      term,
      rettype: "count",
      retmode: "json",
    }, auth),
    timing,
  );
  return body.ok ? countOf(body.value) : body;
}

/**
 * One phrase's row: the heading it resolves to, that heading's scope note
 * and its all-time paper count.
 *
 * A phrase that resolves to nothing is a row with a null heading, which is
 * an answer the step shows; only a failed lookup is a failure. The count
 * is best-effort -- a heading with an unavailable count is still the right
 * heading -- so it never fails the row.
 */
export async function meshRow(
  f: Fetch,
  phrase: string,
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<MeshChoice>> {
  const hit = await meshLookup(f, phrase, auth, timing);
  if (!hit.ok) return fail(hit.error);
  const heading = hit.value === null ? null : hit.value.heading;
  let count: number | null = null;
  if (heading !== null) {
    const counted = await pubmedCount(f, meshCountTerm(heading), auth, timing);
    count = counted.ok ? counted.value : null;
  }
  return ok({
    phrase,
    heading,
    scopeNote: hit.value === null ? null : hit.value.scopeNote,
    count,
  });
}

export async function olsSearch(
  f: Fetch,
  name: string,
  timing: Timing = REAL,
): Promise<Result<Array<{ id: string; label: string }>>> {
  const query = new URLSearchParams({
    q: name.trim(),
    ontology: "efo,hp,mondo",
    rows: "5",
  });
  const body = await getJson(f, `${OLS}?${query}`, timing);
  if (!body.ok) return body;
  const docs = rec(body.value.response).docs;
  if (!Array.isArray(docs)) return fail("no docs in the response");
  return ok(docs.flatMap((doc) => {
    const { obo_id, label } = rec(doc);
    return typeof obo_id === "string" && typeof label === "string"
      ? [{ id: obo_id, label }]
      : [];
  }));
}

export async function ctgovCount(
  f: Fetch,
  term: string,
  timing: Timing = REAL,
): Promise<Result<number>> {
  const query = new URLSearchParams({
    "query.cond": term.trim(),
    countTotal: "true",
    pageSize: "1",
  });
  const body = await getJson(f, `${CTGOV}?${query}`, timing);
  if (!body.ok) return body;
  return typeof body.value.totalCount === "number"
    ? ok(body.value.totalCount)
    : fail("no totalCount in the response");
}

export async function ctgovSample(
  f: Fetch,
  term: string,
  timing: Timing = REAL,
): Promise<Result<{ conditions: string[]; interventions: string[] }>> {
  const query = new URLSearchParams({
    "query.cond": term.trim(),
    pageSize: "20",
    fields: "NCTId,Condition,InterventionName",
  });
  const body = await getJson(f, `${CTGOV}?${query}`, timing);
  if (!body.ok) return body;
  if (!Array.isArray(body.value.studies)) {
    return fail("no studies in the response");
  }
  const conditions = new Set<string>();
  const interventions = new Set<string>();
  for (const study of body.value.studies) {
    const section = rec(rec(study).protocolSection);
    for (const c of arr(rec(section.conditionsModule).conditions)) {
      if (typeof c === "string") conditions.add(c);
    }
    for (const i of arr(rec(section.armsInterventionsModule).interventions)) {
      const name = rec(i).name;
      if (typeof name === "string") interventions.add(name);
    }
  }
  return ok({ conditions: [...conditions], interventions: [...interventions] });
}

/**
 * A record NCBI Gene still keeps. A replaced (status 1) or discontinued (2)
 * one keeps its old symbol as its name, pointing at its successor through
 * currentid.
 */
const current = (entry: Record<string, unknown>): boolean =>
  ["", "0"].includes(String(entry.status ?? "").trim()) &&
  ["", "0"].includes(String(entry.currentid ?? "").trim());

/**
 * The official spelling of `symbol` as NCBI Gene's human record names it,
 * or null when no current human gene carries it as its own symbol.
 *
 * `[sym]` matches aliases and former symbols too -- an alias finds the gene
 * it stands for, a withdrawn symbol the gene that replaced it and the dead
 * record that still bears it -- so only live records are searched and a
 * hit is not the answer: each record's `name` is read back and compared.
 * That also returns the case HGNC writes, which is not always upper case
 * (the open-reading-frame symbols keep a lower-case "orf"), where the
 * search itself ignores case. A record esummary could not read might have
 * been the answer, so with no answer found it fails the lookup.
 */
export async function officialSymbol(
  f: Fetch,
  symbol: string,
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<string | null>> {
  const wanted = symbol.trim();
  const search = await esearch(
    f,
    {
      db: "gene",
      term: `${wanted}[sym] AND human[orgn] AND alive[prop]`,
      retmode: "json",
    },
    auth,
    timing,
  );
  if (!search.ok) return search;
  const { ids } = search.value;
  if (ids.length === 0) return ok(null);
  const summary = await getJson(
    f,
    ncbiUrl("esummary.fcgi", {
      db: "gene",
      id: ids.join(","),
      retmode: "json",
    }, auth),
    timing,
  );
  if (!summary.ok) return summary;
  if (summary.value.result === undefined) {
    return fail("no result in the response");
  }
  const result = rec(summary.value.result);
  let unread: string | undefined;
  for (const id of ids) {
    const entry = rec(result[id]);
    if (entry.error !== undefined) {
      unread ??= id;
      continue;
    }
    const { name } = entry;
    if (
      current(entry) && typeof name === "string" &&
      name.toLowerCase() === wanted.toLowerCase()
    ) return ok(name);
  }
  return unread === undefined
    ? ok(null)
    : fail(`NCBI Gene could not summarise record ${unread}`);
}

// The record and trait rules of pipeline/clinvar_fetch.py, whose docstrings
// give the measurements behind each: _CNV_VARIANT_TYPES, _MAX_RECORD_GENES,
// _MAX_OVERLAP_SPAN and _DISEASE_PREFIXES.
const CNV_VARIANT_TYPES = new Set(["copy number gain", "copy number loss"]);
const MAX_RECORD_GENES = 5;
const MAX_OVERLAP_SPAN = 1_000;
const DISEASE_SOURCES = new Set(["omim", "mondo", "orphanet"]);

/** The widest interval a record's variants cover, in bases; 0 unplaced. */
function recordSpan(variations: Array<Record<string, unknown>>): number {
  let widest = 0;
  for (const variation of variations) {
    for (const loc of arr(variation.variation_loc).map(rec)) {
      const start = Number(loc.start);
      const stop = Number(loc.stop);
      if (Number.isInteger(start) && Number.isInteger(stop) && start && stop) {
        widest = Math.max(widest, Math.abs(stop - start));
      }
    }
  }
  return widest;
}

/**
 * Whether a record's traits are the gene's own rather than a region's, as
 * _describes_gene decides it: one named gene is that gene's whatever the
 * variant; beyond one, the searched symbol must be among at most five, the
 * record no copy-number event, and its variants no wider than an overlap.
 */
function describesGene(
  record: Record<string, unknown>,
  symbol: string,
): boolean {
  const symbols = arr(record.genes).map((gene) =>
    String(rec(gene).symbol ?? "")
  );
  if (symbols.length === 0) return false;
  if (symbols.length === 1) return true;
  if (symbols.length > MAX_RECORD_GENES) return false;
  const wanted = symbol.toUpperCase();
  if (!symbols.some((s) => s.toUpperCase() === wanted)) return false;
  const variations = arr(record.variation_set).map(rec);
  const types = [record.obj_type, ...variations.map((v) => v.variant_type)]
    .map((type) => String(type ?? "").toLowerCase());
  if (types.some((type) => CNV_VARIANT_TYPES.has(type))) return false;
  return recordSpan(variations) <= MAX_OVERLAP_SPAN;
}

/** An xref's id, when it has one: blank and absent ids are none. */
function xrefId(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value.trim();
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : null;
}

/**
 * The diseases ClinVar attests for a gene, each with its OMIM number when
 * one is given, for the step to offer as that gene's phenotypes.
 *
 * Only pathogenic records are searched, and a record is read only when it
 * describes the gene rather than a region spanning it (describesGene); a
 * trait counts only when it carries an OMIM, MONDO or Orphanet identifier,
 * which is what drops "not provided", "not specified" and "See cases" with
 * no list of placeholder names. The rules are the pipeline's, so the
 * wizard offers what --sync-annotations would publish.
 */
export async function clinvarTraits(
  f: Fetch,
  symbol: string,
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<Array<{ name: string; omim: string | null }>>> {
  const wanted = symbol.trim();
  const search = await esearch(
    f,
    {
      db: "clinvar",
      term: `${wanted}[gene] AND "clinsig pathogenic"[Properties]`,
      retmode: "json",
      retmax: "200",
    },
    auth,
    timing,
  );
  if (!search.ok) return search;
  const { ids } = search.value;
  if (ids.length === 0) return ok([]);
  const summary = await getJson(
    f,
    ncbiUrl("esummary.fcgi", {
      db: "clinvar",
      id: ids.join(","),
      retmode: "json",
    }, auth),
    timing,
  );
  if (!summary.ok) return summary;
  if (summary.value.result === undefined) {
    return fail("no result in the response");
  }
  const result = rec(summary.value.result);
  const traits = new Map<string, string | null>();
  for (const id of ids) {
    const record = rec(result[id]);
    if (!describesGene(record, wanted)) continue;
    // ClinVar files a record's traits under each of its classifications;
    // the germline one names the inherited conditions. A top-level
    // trait_set is what the API returned before 2024 and is gone.
    // pipeline/clinvar_fetch.py reads the same place.
    const classification = rec(record.germline_classification);
    for (const trait of arr(classification.trait_set)) {
      const { trait_name, trait_xrefs } = rec(trait);
      if (typeof trait_name !== "string") continue;
      const xrefs = arr(trait_xrefs).map(rec).flatMap((xref) => {
        const id = xrefId(xref.db_id);
        const source = typeof xref.db_source === "string"
          ? xref.db_source.trim().toLowerCase()
          : "";
        return id === null ? [] : [{ source, id }];
      });
      if (!xrefs.some((xref) => DISEASE_SOURCES.has(xref.source))) continue;
      const omim = xrefs.find((xref) => xref.source === "omim")?.id ?? null;
      const existing = traits.get(trait_name);
      if (existing === undefined || existing === null) {
        traits.set(trait_name, omim);
      }
    }
  }
  return ok([...traits].map(([name, omim]) => ({ name, omim })));
}

/**
 * efetch prints an abstract for an 80-column terminal: a line break inside
 * a paragraph is only its layout, and copied from the page it would carry
 * into a field. Paragraphs, which a blank line separates, are kept.
 */
const unwrap = (text: string): string =>
  text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph.split("\n").map((line) => line.trim()).filter(Boolean).join(
        " ",
      )
    )
    .filter(Boolean).join("\n\n");

export async function pubmedAbstract(
  f: Fetch,
  pmid: string,
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<string | null>> {
  const url = ncbiUrl("efetch.fcgi", {
    db: "pubmed",
    id: pmid.trim(),
    rettype: "abstract",
    retmode: "text",
  }, auth);
  const text = await getText(f, url, timing);
  if (!text.ok) return text;
  const trimmed = text.value.trim();
  // A PMID with no record is answered with a 200 holding only its list
  // number ("1."), not with an empty body.
  if (trimmed === "" || /^\d+\.$/.test(trimmed)) return ok(null);
  // So is a request efetch could not run, in its own words; and a gateway's
  // page is no abstract either.
  if (trimmed.startsWith("<")) {
    return fail(`unreadable response from ${new URL(url).host}`);
  }
  if (!/\s/.test(trimmed) && trimmed.includes("+")) {
    return fail(`NCBI reported "${words(trimmed)}"`);
  }
  return ok(unwrap(trimmed));
}

export async function pubmedSummaries(
  f: Fetch,
  pmids: string[],
  auth: NcbiAuth,
  timing: Timing = REAL,
): Promise<Result<Record<string, string | null>>> {
  if (pmids.length === 0) return ok({});
  const body = await getJson(
    f,
    ncbiUrl("esummary.fcgi", {
      db: "pubmed",
      id: pmids.join(","),
      retmode: "json",
    }, auth),
    timing,
  );
  if (!body.ok) return body;
  if (body.value.result === undefined) {
    return fail("no result in the response");
  }
  const result = rec(body.value.result);
  const out: Record<string, string | null> = {};
  for (const pmid of pmids) {
    const entry = rec(result[pmid]);
    out[pmid] = typeof entry.title === "string" ? entry.title : null;
  }
  return ok(out);
}
