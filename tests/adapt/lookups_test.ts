import { assertEquals } from "@std/assert";

import {
  clinvarTraits,
  ctgovCount,
  ctgovSample,
  type Fetch,
  meshCountTerm,
  meshLookup,
  meshRow,
  officialSymbol,
  olsSearch,
  pubmedAbstract,
  pubmedCount,
  pubmedSummaries,
  type Timing,
} from "../../lib/adapt/lookups.ts";

const AUTH = { email: "", apiKey: "" };
const KEYED = { email: "ada@example.org", apiKey: "k1" };

/** A fetch that answers by URL substring, recording what was asked. */
function fake(
  routes: Array<[string, unknown]>,
  status = 200,
): Fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = ((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const hit = routes.find(([needle]) => url.includes(needle));
    const body = hit === undefined
      ? ""
      : typeof hit[1] === "string"
      ? hit[1]
      : JSON.stringify(hit[1]);
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as Fetch & { urls: string[] };
  f.urls = urls;
  return f;
}
const failing: Fetch = () => Promise.reject(new Error("offline"));
const throwingString: Fetch = () => Promise.reject("boom");

/** The timing, with no wait: every pause is recorded and none is waited. */
function instant(deadline = 30_000): Timing & { pauses: number[] } {
  const pauses: number[] = [];
  return {
    deadline,
    pause: (delay) => {
      pauses.push(delay);
      return Promise.resolve();
    },
    pauses,
  };
}

/**
 * A fetch that answers each request with the next reply -- a Response, or
 * an error to reject with -- and with the last one once they run out.
 */
function replies(
  ...answers: Array<Response | Error>
): Fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = ((input: string | URL | Request) => {
    urls.push(String(input));
    const answer = answers[Math.min(urls.length, answers.length) - 1];
    return answer instanceof Response
      ? Promise.resolve(answer.clone())
      : Promise.reject(answer);
  }) as unknown as Fetch & { urls: string[] };
  f.urls = urls;
  return f;
}

/**
 * `inner` behind NCBI's gateway refusing a key it does not know: a 400
 * with no CORS header, which the browser reports as a TypeError before
 * anything can read it.
 */
function refusingKey(inner: Fetch): Fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return new URL(url).searchParams.has("api_key")
      ? Promise.reject(new TypeError("Failed to fetch"))
      : inner(input, init);
  }) as unknown as Fetch & { urls: string[] };
  f.urls = urls;
  return f;
}

/**
 * The gateway's answer to a request over the rate limit. Not fetched live
 * for the stub, which would take going over the limit on purpose.
 */
const overLimit = () =>
  new Response(
    '{"error":"API rate limit exceeded","api-key":"192.0.2.1","count":"4","limit":"3"}',
    { status: 429, headers: { "content-type": "application/json" } },
  );
const count12 = () => Response.json({ esearchresult: { count: "12" } });
const REFUSED =
  "NCBI refused the API key; correct it or clear it in NCBI access";

Deno.test("meshLookup resolves a phrase through esearch then esummary", async () => {
  const f = fake([
    ["db=mesh&term=exampleitis", {
      esearchresult: { count: "1", idlist: ["68001"] },
    }],
    ["db=mesh&id=68001", {
      result: {
        "68001": {
          ds_meshterms: ["Exampleitis", "Example Disease"],
          ds_scopenote: "A made-up disease.",
        },
      },
    }],
  ]);
  assertEquals(await meshLookup(f, "exampleitis ", KEYED), {
    ok: true,
    value: { heading: "Exampleitis", scopeNote: "A made-up disease." },
  });
  assertEquals(
    f.urls[0],
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
      "?db=mesh&term=exampleitis&retmode=json&retmax=200" +
      "&email=ada%40example.org&api_key=k1",
  );
  assertEquals(
    f.urls[1],
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi" +
      "?db=mesh&id=68001&retmode=json&email=ada%40example.org&api_key=k1",
  );
});

Deno.test("meshLookup returns null for no hit and an error for a bad body", async () => {
  assertEquals(
    await meshLookup(
      fake([["db=mesh", { esearchresult: { count: "0", idlist: [] } }]]),
      "x",
      AUTH,
    ),
    { ok: true, value: null },
  );
  assertEquals(
    (await meshLookup(fake([["db=mesh", "not json"]]), "x", AUTH)).ok,
    false,
  );
  assertEquals(
    (await meshLookup(fake([["db=mesh", {}]], 500), "x", AUTH)).ok,
    false,
  );
  assertEquals(await meshLookup(failing, "x", AUTH), {
    ok: false,
    error: "offline",
  });
  assertEquals(await meshLookup(throwingString, "x", AUTH), {
    ok: false,
    error: "boom",
  });
});

Deno.test("an esearch ERROR fails every search in NCBI's words rather than reading as no hit", async () => {
  // E-utilities answers a search it could not run with a 200 all the same,
  // as it does live for an empty term. Read as an empty idlist it said
  // "MeSH has no heading", and a re-check erased the heading a row had.
  const f = fake([["esearch.fcgi", {
    header: { type: "esearch", version: "0.3" },
    esearchresult: { ERROR: "Empty term and query_key - nothing todo" },
  }]]);
  const failed = {
    ok: false as const,
    error: 'NCBI reported "Empty term and query_key - nothing todo"',
  };
  assertEquals(await meshLookup(f, "x", AUTH), failed);
  assertEquals(await meshRow(f, "x", AUTH), failed);
  assertEquals(await pubmedCount(f, "t", AUTH), failed);
  assertEquals(await officialSymbol(f, "X", AUTH), failed);
  assertEquals(await clinvarTraits(f, "G", AUTH), failed);
});

Deno.test("meshLookup fails on a reply with no idlist, and an empty one is no heading", async () => {
  assertEquals(
    await meshLookup(
      fake([["db=mesh", { esearchresult: { count: "0" } }]]),
      "x",
      AUTH,
    ),
    { ok: false, error: "no idlist in the response" },
  );
  // The live reply for a phrase MeSH does not know, which it names in the
  // errorlist beside an empty idlist.
  const unknown = fake([["db=mesh", {
    header: { type: "esearch", version: "0.3" },
    esearchresult: {
      count: "0",
      retmax: "0",
      retstart: "0",
      idlist: [],
      translationset: [],
      querytranslation: "(zzqqxxwv[All Fields])",
      errorlist: { phrasesnotfound: ["zzqqxxwv"], fieldsnotfound: [] },
      warninglist: {
        phrasesignored: [],
        quotedphrasesnotfound: [],
        outputmessages: ["No items found."],
      },
    },
  }]]);
  assertEquals(await meshLookup(unknown, "zzqqxxwv", AUTH), {
    ok: true,
    value: null,
  });
});

/** An esearch and esummary pair over MeSH records, as the live API writes them. */
function mesh(
  records: Array<{ id: string; type?: string; terms: unknown[] }>,
  translationset: unknown[] = [],
): Fetch {
  const result: Record<string, unknown> = {};
  for (const { id, type, terms } of records) {
    result[id] = {
      ...(type === undefined ? {} : { ds_recordtype: type }),
      ds_meshterms: terms,
      ds_scopenote: `Note ${id}.`,
    };
  }
  return fake([
    ["db=mesh&term=", {
      esearchresult: { idlist: records.map((r) => r.id), translationset },
    }],
    ["db=mesh&id=", { result }],
  ]);
}

const heading = async (f: Fetch, phrase: string) => {
  const found = await meshLookup(f, phrase, AUTH);
  return found.ok ? found.value?.heading ?? null : `failed: ${found.error}`;
};

Deno.test("meshLookup takes the heading PubMed maps the whole phrase to, not the first hit", async () => {
  // The live order for "multiple sclerosis": two subtypes, then the heading.
  const f = mesh([
    { id: "1", type: "descriptor", terms: ["Example Disease, Relapsing"] },
    { id: "2", type: "descriptor", terms: ["Example Disease, Progressive"] },
    { id: "3", type: "descriptor", terms: ["Example Disease", "Disease, Ex"] },
  ], [
    { from: "example", to: '"example"[MeSH Terms]' },
    7,
    { from: "Example  disease", to: '"example disease"[MeSH Terms] OR x' },
  ]);
  assertEquals(await heading(f, "example disease"), "Example Disease");
  // The mapped heading is searched for by name, and those hits summarised.
  const { urls } = f as Fetch & { urls: string[] };
  assertEquals(
    urls[1].includes("term=%22example+disease%22%5BMeSH+Terms%5D"),
    true,
  );
  assertEquals(urls[2].includes("id=1%2C2%2C3"), true);
});

Deno.test("meshLookup finds the mapped heading when the first page of hits holds only its subtypes", async () => {
  // esearch lists the newest records first, twenty to a page: a broad
  // phrase's own heading is an old record and falls outside it, so read
  // from the page the phrase resolved to its newest subtype.
  const subtypes = Array.from({ length: 20 }, (_, i) => ({
    id: String(68_090_000 + i),
    terms: [`Example Disease, Type ${i + 1}`, "Example Disease"],
  }));
  const f = fake([
    ["term=%22example+disease%22%5BMeSH+Terms%5D", {
      esearchresult: { count: "1", idlist: ["68000001"] },
    }],
    ["db=mesh&term=Example+disease&", {
      esearchresult: {
        count: "107",
        idlist: subtypes.map((s) => s.id),
        translationset: [{
          from: "example disease",
          to: '"example disease"[MeSH Terms] OR "example disease"[All Fields]',
        }],
      },
    }],
    ["db=mesh&id=68000001&", {
      result: {
        "68000001": {
          ds_recordtype: "descriptor",
          ds_meshterms: ["Example Disease", "Disease, Example"],
          ds_scopenote: "The heading.",
        },
      },
    }],
  ]);
  assertEquals(await meshLookup(f, "Example disease", AUTH, instant()), {
    ok: true,
    value: { heading: "Example Disease", scopeNote: "The heading." },
  });
  assertEquals(f.urls.length, 3);
  assertEquals(f.urls[0].includes("&retmax=200"), true);
  assertEquals(f.urls[2].includes("db=mesh&id=68000001&"), true);
});

Deno.test("meshLookup folds accents, Greek letters and typographic quotes as NCBI does", async () => {
  // NCBI folds the query before translating it, so the translationset
  // names the phrase in ASCII, as MeSH spells every term.
  const mapped = (from: string, heading: string) =>
    fake([
      ["%5BMeSH+Terms%5D", { esearchresult: { idlist: ["2"] } }],
      ["db=mesh&term=", {
        esearchresult: {
          idlist: ["1"],
          translationset: [{
            from,
            to: `"${heading.toLowerCase()}"[MeSH Terms] OR x`,
          }],
        },
      }],
      ["db=mesh&id=2&", {
        result: { "2": { ds_meshterms: [heading], ds_scopenote: "" } },
      }],
    ]);
  for (
    const [phrase, from, expected] of [
      ["Sjögren example", "Sjogren example", "Sjogren's Example"],
      ["β-example", "beta-example", "beta-Example"],
      ["Crohn’s example", "crohn's example", "Crohn Example"],
      ["long–example", "long-example", "Long-Example"],
    ]
  ) {
    assertEquals(
      await heading(mapped(from, expected), phrase),
      expected,
      phrase,
    );
  }
  // Without a mapping the entry terms are compared folded too.
  const entry = mesh([
    { id: "1", terms: ["Other Heading", "Sjogren Example, Type 2"] },
    { id: "2", terms: ["Example Syndromes", "Sjogren Example"] },
  ]);
  assertEquals(await heading(entry, "Sjögren  example"), "Example Syndromes");
});

Deno.test("meshLookup prefers an exact entry term, then the tightest containing one", async () => {
  // A descriptor that merely holds the phrase inside a long entry term
  // comes first in the live results; the one naming it outright wins.
  const exact = mesh([
    { id: "1", terms: ["Other Heading", "Brain Example Lesion Type 2"] },
    { id: "2", terms: ["Example Lesions", 4, "Example Lesion"] },
  ]);
  assertEquals(await heading(exact, "example lesion"), "Example Lesions");
  const tightest = mesh([
    {
      id: "1",
      terms: ["Other Heading", "Rare Familial Example Lesion Type 2"],
    },
    { id: "2", terms: ["Example Lesions", "Brain Example Lesion"] },
    { id: "3", terms: ["Unrelated"] },
  ]);
  assertEquals(await heading(tightest, "example lesion"), "Example Lesions");
  // Nothing names the phrase at all: MeSH has no heading for it. The first
  // descriptor, which it once took, is only the newest record found.
  const first = mesh([
    { id: "1", terms: ["First Heading"] },
    { id: "2", terms: ["Second Heading"] },
  ]);
  assertEquals(await heading(first, "example lesion"), null);
});

Deno.test("meshLookup reads a supplementary concept as no heading", async () => {
  // A supplementary record is no heading "[MeSH Terms]" can search: a
  // query built on one retrieves nothing.
  const supplementary = mesh([
    { id: "1", type: "supplemental-record", terms: ["Example Syndrome"] },
  ]);
  assertEquals(await heading(supplementary, "example syndrome"), null);
  // Beside it a descriptor is the answer only when it names the phrase.
  const mixed = mesh([
    { id: "1", type: "supplemental-record", terms: ["Example Syndrome"] },
    { id: "2", type: "descriptor", terms: ["Example Disorders"] },
    {
      id: "3",
      type: "descriptor",
      terms: ["Example Anomalies", "Example Syndrome, Familial"],
    },
  ]);
  assertEquals(await heading(mixed, "example syndrome"), "Example Anomalies");
  const unnamed = mesh([
    { id: "1", type: "supplemental-record", terms: ["Example Syndrome"] },
    { id: "2", type: "descriptor", terms: ["Example Disorders"] },
  ]);
  assertEquals(await heading(unnamed, "example syndrome"), null);
});

Deno.test("the MeSH count term quotes and fields its heading", () => {
  assertEquals(meshCountTerm("Exampleitis"), '"Exampleitis"[MeSH]');
});

Deno.test("pubmedCount reads the count and rejects a non-numeric one", async () => {
  assertEquals(
    await pubmedCount(
      fake([["rettype=count", { esearchresult: { count: "2140" } }]]),
      "t",
      AUTH,
    ),
    { ok: true, value: 2140 },
  );
  assertEquals(
    (await pubmedCount(
      fake([["rettype=count", { esearchresult: {} }]]),
      "t",
      AUTH,
    )).ok,
    false,
  );
});

Deno.test("olsSearch lists obo ids and labels", async () => {
  const f = fake([["ols4/api/search", {
    response: {
      docs: [{ obo_id: "HP:1", label: "Term one" }, { label: "no id" }],
    },
  }]]);
  assertEquals(await olsSearch(f, " trait "), {
    ok: true,
    value: [{ id: "HP:1", label: "Term one" }],
  });
  assertEquals(
    f.urls[0],
    "https://www.ebi.ac.uk/ols4/api/search?q=trait&ontology=efo%2Chp%2Cmondo&rows=5",
  );
  assertEquals(
    (await olsSearch(fake([["ols4", { response: {} }]]), "t")).ok,
    false,
  );
});

Deno.test("ctgovCount and ctgovSample read the v2 shapes", async () => {
  const count = fake([["countTotal=true", { totalCount: 617 }]]);
  assertEquals(await ctgovCount(count, " t "), { ok: true, value: 617 });
  assertEquals(
    count.urls[0],
    "https://clinicaltrials.gov/api/v2/studies?query.cond=t&countTotal=true&pageSize=1",
  );
  assertEquals(
    (await ctgovCount(fake([["countTotal=true", {}]]), "t")).ok,
    false,
  );
  const sample = fake([["pageSize=20", {
    studies: [
      {
        protocolSection: {
          conditionsModule: { conditions: ["A", "B"] },
          armsInterventionsModule: { interventions: [{ name: "drug1" }] },
        },
      },
      { protocolSection: { conditionsModule: { conditions: ["B"] } } },
    ],
  }]]);
  assertEquals(await ctgovSample(sample, "t "), {
    ok: true,
    value: { conditions: ["A", "B"], interventions: ["drug1"] },
  });
  assertEquals(
    sample.urls[0],
    "https://clinicaltrials.gov/api/v2/studies" +
      "?query.cond=t&pageSize=20&fields=NCTId%2CCondition%2CInterventionName",
  );
  assertEquals((await ctgovSample(fake([["pageSize=20", {}]]), "t")).ok, false);
});

Deno.test("officialSymbol reads the official spelling back from NCBI Gene", async () => {
  // "[sym]" matches aliases as well, so the answer is the record whose own
  // name is the symbol asked about, in the case HGNC writes it.
  const f = fake([
    ["db=gene&term=", { esearchresult: { idlist: ["203228", "9"] } }],
    ["db=gene&id=", {
      result: {
        uids: ["203228", "9"],
        "203228": { name: "C9orf72" },
        "9": { name: "OTHER1" },
      },
    }],
  ]);
  assertEquals(
    await officialSymbol(f, " c9orf72 ", AUTH),
    { ok: true, value: "C9orf72" },
  );
  assertEquals(
    f.urls[0],
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
      "?db=gene&term=c9orf72%5Bsym%5D+AND+human%5Borgn%5D" +
      "+AND+alive%5Bprop%5D&retmode=json",
  );
  assertEquals(
    f.urls[1],
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi" +
      "?db=gene&id=203228%2C9&retmode=json",
  );
  // AUTH carries no email or api key, so an empty-auth call adds neither.
  assertEquals(f.urls[0].includes("email="), false);
  assertEquals(f.urls[0].includes("api_key="), false);
});

Deno.test("officialSymbol refuses an alias and an unknown symbol", async () => {
  // An alias finds its gene, whose official name is a different word.
  const alias = fake([
    ["db=gene&term=", { esearchresult: { idlist: ["4854"] } }],
    ["db=gene&id=", { result: { "4854": { name: "NOTCH3" } } }],
  ]);
  assertEquals(await officialSymbol(alias, "CASIL", AUTH), {
    ok: true,
    value: null,
  });
  assertEquals(
    await officialSymbol(
      fake([["db=gene&term=", { esearchresult: { count: "0", idlist: [] } }]]),
      "NOPE",
      AUTH,
    ),
    { ok: true, value: null },
  );
  // A record without a name is no answer either.
  assertEquals(
    await officialSymbol(
      fake([
        ["db=gene&term=", { esearchresult: { idlist: ["1"] } }],
        ["db=gene&id=", { result: { "1": {} } }],
      ]),
      "X",
      AUTH,
    ),
    { ok: true, value: null },
  );
});

Deno.test("officialSymbol fails on a missing idlist, a broken summary and no result", async () => {
  assertEquals(
    (await officialSymbol(
      fake([["db=gene", { esearchresult: {} }]]),
      "X",
      AUTH,
    )).ok,
    false,
  );
  assertEquals(
    (await officialSymbol(
      esearchThenFailingEsummary({ esearchresult: { idlist: ["1"] } }),
      "X",
      AUTH,
    )).ok,
    false,
  );
  assertEquals(
    (await officialSymbol(
      fake([
        ["db=gene&term=", { esearchresult: { idlist: ["1"] } }],
        ["db=gene&id=", {}],
      ]),
      "X",
      AUTH,
    )).ok,
    false,
  );
});

Deno.test("officialSymbol fails when a record it could not read might have been the answer", async () => {
  // esummary's live entry for a record it could not summarise.
  const unread = (uid: string) => ({
    uid,
    error: "cannot get document summary",
  });
  const gene = (records: Record<string, unknown>) =>
    fake([
      ["db=gene&term=", { esearchresult: { idlist: Object.keys(records) } }],
      ["db=gene&id=", { result: { uids: Object.keys(records), ...records } }],
    ]);
  assertEquals(
    await officialSymbol(
      gene({
        "1": unread("1"),
        "2": unread("2"),
        "3": { uid: "3", name: "OTHER1" },
      }),
      "X",
      AUTH,
    ),
    { ok: false, error: "NCBI Gene could not summarise record 1" },
  );
  // A record carrying the symbol as its own name is the answer, whatever
  // another record says.
  assertEquals(
    await officialSymbol(
      gene({ "1": unread("1"), "2": { uid: "2", name: "GENEA" } }),
      "genea",
      AUTH,
    ),
    { ok: true, value: "GENEA" },
  );
});

Deno.test("clinvarTraits collects distinct named traits with their OMIM ids", async () => {
  // Since 2024 ClinVar files the traits under each classification; the
  // germline one names the inherited conditions. A top-level trait_set is
  // what the API returned before, and is no longer read.
  const germline = (traitSet: unknown) => ({
    genes: [{ symbol: "GENEA" }],
    germline_classification: { trait_set: traitSet },
  });
  const f = fake([
    ["db=clinvar&term=", { esearchresult: { idlist: ["1", "2", "3", "4"] } }],
    ["db=clinvar&id=", {
      result: {
        "1": germline([{
          trait_name: "Syndrome one",
          trait_xrefs: [{ db_source: "OMIM", db_id: "100001" }],
        }, { trait_name: "not specified", trait_xrefs: [] }]),
        "2": germline([{ trait_name: "Syndrome one", trait_xrefs: [] }, {
          trait_name: "Syndrome two",
          trait_xrefs: [{ db_source: "Orphanet", db_id: "9" }],
        }]),
        "3": germline([{
          trait_name: "Syndrome two",
          trait_xrefs: [{ db_source: "OMIM", db_id: "100003" }],
        }, { trait_name: 7 }]),
        "4": {
          genes: [{ symbol: "GENEA" }],
          trait_set: [{
            trait_name: "Old shape",
            trait_xrefs: [{ db_source: "OMIM", db_id: "100004" }],
          }],
        },
      },
    }],
  ]);
  // A name first seen with no OMIM id takes the id a later record carries.
  assertEquals(await clinvarTraits(f, " GENEA", AUTH), {
    ok: true,
    value: [{ name: "Syndrome one", omim: "100001" }, {
      name: "Syndrome two",
      omim: "100003",
    }],
  });
  assertEquals(
    f.urls[0],
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
      "?db=clinvar&term=GENEA%5Bgene%5D+AND+%22clinsig+pathogenic%22" +
      "%5BProperties%5D&retmode=json&retmax=200",
  );
  assertEquals(
    await clinvarTraits(
      fake([["db=clinvar&term=", { esearchresult: { idlist: [] } }]]),
      "G",
      AUTH,
    ),
    { ok: true, value: [] },
  );
  assertEquals(
    (await clinvarTraits(
      fake([["db=clinvar&term=", { esearchresult: {} }]]),
      "G",
      AUTH,
    )).ok,
    false,
  );
  assertEquals(
    (await clinvarTraits(
      fake([["db=clinvar&term=", { esearchresult: { idlist: ["1"] } }], [
        "db=clinvar&id=",
        {},
      ]]),
      "G",
      AUTH,
    )).ok,
    false,
  );
});

Deno.test("clinvarTraits takes an OMIM id only from an xref that carries one", async () => {
  const germline = (traitSet: unknown) => ({
    genes: [{ symbol: "G" }],
    germline_classification: { trait_set: traitSet },
  });
  const mondo = (n: number) => ({ db_source: "MONDO", db_id: `MONDO:${n}` });
  const f = fake([
    ["db=clinvar&term=", { esearchresult: { idlist: ["1", "2"] } }],
    ["db=clinvar&id=", {
      result: {
        "1": germline([
          {
            trait_name: "Syndrome one",
            trait_xrefs: [{ db_source: "OMIM" }, mondo(1)],
          },
          {
            trait_name: "Syndrome two",
            trait_xrefs: [{ db_source: "OMIM", db_id: null }, mondo(2)],
          },
          {
            trait_name: "Syndrome three",
            trait_xrefs: [
              { db_id: "5" },
              { db_source: "OMIM", db_id: " " },
              { db_source: "OMIM", db_id: 100003 },
            ],
          },
        ]),
        "2": germline([{
          trait_name: "Syndrome one",
          trait_xrefs: [{ db_source: "OMIM", db_id: "100001" }],
        }]),
      },
    }],
  ]);
  // An xref with no id is none: read as one it showed "OMIM undefined",
  // and the id a later record carries could no longer replace it.
  assertEquals(await clinvarTraits(f, "G", AUTH), {
    ok: true,
    value: [
      { name: "Syndrome one", omim: "100001" },
      { name: "Syndrome two", omim: null },
      { name: "Syndrome three", omim: "100003" },
    ],
  });
});

Deno.test("pubmedAbstract is the text, or null when there is no record", async () => {
  const f = fake([["efetch", "1. Journal. Title.\n"]]);
  assertEquals(
    await pubmedAbstract(f, " 1 ", AUTH),
    { ok: true, value: "1. Journal. Title." },
  );
  assertEquals(
    f.urls[0],
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi" +
      "?db=pubmed&id=1&rettype=abstract&retmode=text",
  );
  assertEquals(await pubmedAbstract(fake([["efetch", "  \n"]]), "1", AUTH), {
    ok: true,
    value: null,
  });
  // A PMID with no record comes back as its list number and nothing else.
  assertEquals(
    await pubmedAbstract(fake([["efetch", "1. \n\n"]]), "99999999", AUTH),
    { ok: true, value: null },
  );
  assertEquals(
    (await pubmedAbstract(fake([["efetch", ""]], 503), "1", AUTH)).ok,
    false,
  );
});

Deno.test("pubmedAbstract refuses a page or an NCBI error answered with a 200", async () => {
  assertEquals(
    await pubmedAbstract(
      fake([["efetch", "<!DOCTYPE html>\n<html><body>Down</body></html>\n"]]),
      "1",
      AUTH,
    ),
    { ok: false, error: "unreadable response from eutils.ncbi.nlm.nih.gov" },
  );
  // The live reply to an efetch whose id is empty.
  assertEquals(
    await pubmedAbstract(
      fake([["efetch", "Supplied+id+parameter+is+empty.\n"]]),
      "1",
      AUTH,
    ),
    { ok: false, error: 'NCBI reported "Supplied id parameter is empty."' },
  );
});

Deno.test("pubmedSummaries maps each pmid to its title or null", async () => {
  const f = fake([["db=pubmed&id=1%2C2", {
    result: {
      uids: ["1", "2"],
      "1": { title: "Paper one" },
      "2": { error: "cannot get document summary" },
    },
  }]]);
  assertEquals(await pubmedSummaries(f, ["1", "2"], AUTH), {
    ok: true,
    value: { "1": "Paper one", "2": null },
  });
  assertEquals(await pubmedSummaries(f, [], AUTH), { ok: true, value: {} });
  assertEquals(
    (await pubmedSummaries(fake([["db=pubmed", {}]]), ["1"], AUTH)).ok,
    false,
  );
});

/**
 * A fetch that answers the esearch call and fails the esummary call, so a
 * two-request lookup can exercise the second request's own failure path
 * distinctly from the first.
 */
function esearchThenFailingEsummary(esearchBody: unknown): Fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("esearch.fcgi")) {
      return Promise.resolve(
        new Response(JSON.stringify(esearchBody), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("", { status: 500 }));
  }) as unknown as Fetch;
}

Deno.test("meshLookup fails when the second request breaks, and defaults an absent heading or scope note", async () => {
  assertEquals(
    (await meshLookup(
      esearchThenFailingEsummary({
        esearchresult: { count: "1", idlist: ["1"] },
      }),
      "x",
      AUTH,
    )).ok,
    false,
  );
  assertEquals(
    (await meshLookup(
      fake([
        ["db=mesh&term=", { esearchresult: { count: "1", idlist: ["1"] } }],
        ["db=mesh&id=", { result: { "1": {} } }],
      ]),
      "x",
      AUTH,
    )).ok,
    false,
  );
  assertEquals(
    await meshLookup(
      fake([
        ["db=mesh&term=", { esearchresult: { count: "1", idlist: ["1"] } }],
        ["db=mesh&id=", { result: { "1": { ds_meshterms: ["Heading"] } } }],
      ]),
      "heading",
      AUTH,
    ),
    { ok: true, value: { heading: "Heading", scopeNote: "" } },
  );
});

Deno.test("a broken fetch fails pubmedCount, olsSearch, ctgovCount, ctgovSample, officialSymbol, pubmedSummaries and clinvarTraits' first request", async () => {
  const gone = fake([], 500);
  assertEquals((await pubmedCount(gone, "t", AUTH)).ok, false);
  assertEquals((await olsSearch(gone, "t")).ok, false);
  assertEquals((await ctgovCount(gone, "t")).ok, false);
  assertEquals((await ctgovSample(gone, "t")).ok, false);
  assertEquals((await officialSymbol(gone, "X", AUTH)).ok, false);
  assertEquals((await pubmedSummaries(gone, ["1"], AUTH)).ok, false);
  assertEquals((await clinvarTraits(gone, "G", AUTH)).ok, false);
});

Deno.test("clinvarTraits fails when the second request breaks", async () => {
  assertEquals(
    (await clinvarTraits(
      esearchThenFailingEsummary({ esearchresult: { idlist: ["1"] } }),
      "G",
      AUTH,
    )).ok,
    false,
  );
});

Deno.test("ctgovSample skips a non-string condition and an unnamed intervention", async () => {
  const odd = fake([["pageSize=20", {
    studies: [{
      protocolSection: {
        conditionsModule: { conditions: ["A", 7] },
        armsInterventionsModule: {
          interventions: [{ name: "drug1" }, {}, { name: 5 }],
        },
      },
    }],
  }]]);
  assertEquals(await ctgovSample(odd, "t"), {
    ok: true,
    value: { conditions: ["A"], interventions: ["drug1"] },
  });
});

Deno.test("a literal JSON null body fails ctgovCount, meshLookup and pubmedSummaries rather than throwing", async () => {
  const nullBody = fake([["", "null"]]);
  assertEquals((await ctgovCount(nullBody, "t")).ok, false);
  assertEquals((await meshLookup(nullBody, "x", AUTH)).ok, false);
  assertEquals((await pubmedSummaries(nullBody, ["1"], AUTH)).ok, false);
});

Deno.test("countOf rejects a non-string count instead of coercing it to zero", async () => {
  assertEquals(
    (await pubmedCount(
      fake([["rettype=count", { esearchresult: { count: null } }]]),
      "t",
      AUTH,
    )).ok,
    false,
  );
  assertEquals(
    (await pubmedCount(
      fake([["rettype=count", { esearchresult: { count: "abc" } }]]),
      "t",
      AUTH,
    )).ok,
    false,
  );
});

Deno.test("countOf takes only digits for a count", async () => {
  // Number() reads every one of these as a number, the blank ones as 0.
  for (const count of ["", " ", "0x10", "1e3", "-5", "12.0"]) {
    assertEquals(
      await pubmedCount(
        fake([["rettype=count", { esearchresult: { count } }]]),
        "t",
        AUTH,
      ),
      { ok: false, error: "no count in the response" },
    );
  }
  assertEquals(
    await pubmedCount(
      fake([["rettype=count", { esearchresult: { count: "0" } }]]),
      "t",
      AUTH,
    ),
    { ok: true, value: 0 },
  );
});

Deno.test("meshRow carries the heading, the scope note and the count", async () => {
  const f = fake([
    ["db=mesh&term=", { esearchresult: { count: "1", idlist: ["68001"] } }],
    ["db=mesh&id=68001", {
      result: {
        "68001": {
          ds_meshterms: ["Exampleitis"],
          ds_scopenote: "A made-up disease.",
        },
      },
    }],
    ["db=pubmed", { esearchresult: { count: "1200" } }],
  ]);
  assertEquals(await meshRow(f, "exampleitis", AUTH), {
    ok: true,
    value: {
      phrase: "exampleitis",
      heading: "Exampleitis",
      scopeNote: "A made-up disease.",
      count: 1200,
    },
  });
});

Deno.test("a phrase with no heading, an unavailable count and a failed lookup", async () => {
  // No MeSH hit is an answer -- a row the step shows and validate() flags --
  // and a count that will not come is a row with the heading and no number.
  const none = fake([["db=mesh&term=", { esearchresult: { idlist: [] } }]]);
  assertEquals(await meshRow(none, "nothing", AUTH), {
    ok: true,
    value: {
      phrase: "nothing",
      heading: null,
      scopeNote: null,
      count: null,
    },
  });
  const noCount = fake([
    ["db=mesh&term=", { esearchresult: { count: "1", idlist: ["1"] } }],
    ["db=mesh&id=1", { result: { "1": { ds_meshterms: ["One"] } } }],
    ["db=pubmed", { esearchresult: {} }],
  ]);
  assertEquals(await meshRow(noCount, "one", AUTH), {
    ok: true,
    value: { phrase: "one", heading: "One", scopeNote: "", count: null },
  });
  assertEquals(await meshRow(failing, "one", AUTH), {
    ok: false,
    error: "offline",
  });
});

Deno.test("a request that is never answered is abandoned at the deadline, naming the host", async () => {
  // As a browser's fetch does, the request fails only once the signal it
  // was given is aborted.
  const signals: Array<AbortSignal | null | undefined> = [];
  const silent = ((_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    );
  }) as Fetch;
  assertEquals(await pubmedCount(silent, "t", KEYED, instant(10)), {
    ok: false,
    error: "eutils.ncbi.nlm.nih.gov did not answer within 0.01 s; try again",
  });
  // A timeout is neither retried nor put down to the key.
  assertEquals(signals.length, 1);
  assertEquals(signals[0] instanceof AbortSignal, true);
  assertEquals(await ctgovCount(silent, "t", instant(10)), {
    ok: false,
    error: "clinicaltrials.gov did not answer within 0.01 s; try again",
  });
  // An answer whose body never ends is abandoned the same way.
  const trickle =
    ((_input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(init.signal?.reason),
              );
            },
          }),
        ),
      )) as Fetch;
  assertEquals(await olsSearch(trickle, "t", instant(10)), {
    ok: false,
    error: "www.ebi.ac.uk did not answer within 0.01 s; try again",
  });
});

Deno.test("a key NCBI refuses is named, rather than read as a failed fetch", async () => {
  const none = fake([
    ["db=mesh&term=", { esearchresult: { count: "0", idlist: [] } }],
  ]);
  const keyed = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi" +
    "?db=mesh&term=exampleitis&retmode=json&retmax=200" +
    "&email=ada%40example.org&api_key=k1";
  const refused = refusingKey(none);
  const timing = instant();
  assertEquals(await meshLookup(refused, "exampleitis", KEYED, timing), {
    ok: false,
    error: REFUSED,
  });
  // The keyed request, the same one without the key -- whose answer is not
  // used -- and the keyed one again after a pause, because one refusal is
  // also what a key over its own limit gets for a moment.
  assertEquals(refused.urls, [keyed, keyed.replace("&api_key=k1", ""), keyed]);
  assertEquals(timing.pauses, [1000]);
  // Without a key the same lookup is answered as ever, in one request.
  const keyless = refusingKey(none);
  assertEquals(await meshLookup(keyless, "exampleitis", AUTH, instant()), {
    ok: true,
    value: null,
  });
  assertEquals(keyless.urls.length, 1);
  // Were the gateway's 400 readable, it would be named the same way.
  const readable =
    ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).searchParams.has("api_key")
        ? Promise.resolve(
          new Response(
            '{"error":"API key invalid","api-key":"k1","type":"invalid",\n"status":"unknown"}',
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        )
        : none(input, init)) as Fetch;
  assertEquals(await meshLookup(readable, "exampleitis", KEYED, instant()), {
    ok: false,
    error: REFUSED,
  });
});

Deno.test("a keyed failure the key did not cause keeps its own error", async () => {
  // Offline: the request without the key fails as well, so the key is not
  // the fault, and the first failure is reported at once.
  const down = replies(new TypeError("Failed to fetch"));
  assertEquals(await pubmedCount(down, "t", KEYED, instant()), {
    ok: false,
    error: "Failed to fetch",
  });
  assertEquals(down.urls.length, 2);
  // A key over its own limit for a moment: the keyed retry is answered.
  const blip = replies(new TypeError("Failed to fetch"), count12(), count12());
  assertEquals(await pubmedCount(blip, "t", KEYED, instant()), {
    ok: true,
    value: 12,
  });
  assertEquals(blip.urls.length, 3);
  // A request NCBI read and refused is refused without the key too.
  const bad = replies(
    new Response("ID+list+is+empty!+Possibly+it+has+no+correct+IDs.\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=UTF-8" },
    }),
  );
  assertEquals(await pubmedAbstract(bad, "1", KEYED, instant()), {
    ok: false,
    error: "400 from eutils.ncbi.nlm.nih.gov: " +
      "ID list is empty! Possibly it has no correct IDs.",
  });
  assertEquals(bad.urls.length, 2);
});

Deno.test("an NCBI request over the rate limit is retried after a widening pause", async () => {
  const once = replies(overLimit(), count12());
  const timing = instant();
  assertEquals(await pubmedCount(once, "t", AUTH, timing), {
    ok: true,
    value: 12,
  });
  assertEquals(timing.pauses, [1000]);
  const always = replies(overLimit());
  const patient = instant();
  assertEquals(await pubmedCount(always, "t", AUTH, patient), {
    ok: false,
    error: "NCBI is rate-limiting this browser; " +
      "wait a moment and try again, or add an API key",
  });
  assertEquals(always.urls.length, 3);
  assertEquals(patient.pauses, [1000, 2000]);
  // With a key, adding one is no advice.
  assertEquals(await pubmedCount(replies(overLimit()), "t", KEYED, instant()), {
    ok: false,
    error: "NCBI is rate-limiting this browser; wait a moment and try again",
  });
});

Deno.test("a failed fetch without a key is retried, then put down to the rate limit perhaps", async () => {
  // The gateway's 429 carries no CORS header either, so the browser cannot
  // tell it from a dropped connection.
  const down = replies(new TypeError("Failed to fetch"));
  const timing = instant();
  assertEquals(await meshLookup(down, "x", AUTH, timing), {
    ok: false,
    error: "Failed to fetch (NCBI may be rate-limiting this browser; " +
      "wait a moment and try again, or add an API key)",
  });
  assertEquals(down.urls.length, 3);
  assertEquals(timing.pauses, [1000, 2000]);
  // Any other failure is reported at once.
  const broken = replies(new Response("", { status: 503 }));
  assertEquals(await pubmedCount(broken, "t", AUTH, instant()), {
    ok: false,
    error: "503 from eutils.ncbi.nlm.nih.gov",
  });
  assertEquals(broken.urls.length, 1);
});

Deno.test("a readable Retry-After sets the pause, up to ten seconds", async () => {
  const after = (seconds: string) =>
    new Response("", { status: 429, headers: { "retry-after": seconds } });
  for (
    const [seconds, pause] of [
      ["3", 3000],
      ["60", 10_000],
      // A date is not read; the pause is the usual one.
      ["Wed, 21 Oct 2015 07:28:00 GMT", 1000],
    ] as const
  ) {
    const timing = instant();
    assertEquals(
      await pubmedCount(replies(after(seconds), count12()), "t", AUTH, timing),
      { ok: true, value: 12 },
    );
    assertEquals(timing.pauses, [pause]);
  }
  // The real pause, waited out.
  assertEquals(await pubmedCount(replies(after("0"), count12()), "t", AUTH), {
    ok: true,
    value: 12,
  });
});

Deno.test("a refusal's reason reaches the error when it is given in words", async () => {
  // ClinicalTrials.gov's live answer to a term it cannot parse.
  const unparsed = new Response(
    "Error parsing query in Conditions or disease: no viable alternative" +
      " at input 'onset'\nmissing ')' at '<EOF>'",
    { status: 400, headers: { "content-type": "text/plain; charset=UTF-8" } },
  );
  assertEquals(
    await ctgovCount(replies(unparsed), "exampleitis (early onset"),
    {
      ok: false,
      error: "400 from clinicaltrials.gov: Error parsing query in Conditions" +
        " or disease: no viable alternative at input 'onset'; missing ')'" +
        " at '<EOF>'",
    },
  );
  // A page or a JSON document is not read out, nor a body that breaks off;
  // a long reason is cut short.
  assertEquals(
    await olsSearch(
      replies(new Response("<!DOCTYPE html><html></html>", { status: 503 })),
      "t",
    ),
    { ok: false, error: "503 from www.ebi.ac.uk" },
  );
  assertEquals(
    await ctgovSample(
      replies(new Response('{"message":"bad"}', { status: 400 })),
      "t",
    ),
    { ok: false, error: "400 from clinicaltrials.gov" },
  );
  const broken = new ReadableStream({
    start(controller) {
      controller.error(new TypeError("connection reset"));
    },
  });
  assertEquals(
    await ctgovCount(replies(new Response(broken, { status: 502 })), "t"),
    { ok: false, error: "502 from clinicaltrials.gov" },
  );
  assertEquals(
    await ctgovCount(
      replies(new Response("word ".repeat(100), { status: 400 })),
      "t",
    ),
    {
      ok: false,
      error: `400 from clinicaltrials.gov: ${
        "word ".repeat(40).slice(0, 199)
      }…`,
    },
  );
});

Deno.test("officialSymbol passes over a replaced or discontinued record that keeps the symbol", async () => {
  // A withdrawn symbol stays the name of the dead record that bore it, which
  // points at its successor; alive[prop] keeps such records out of the
  // search, and a record marked dead is passed over should one come back.
  const f = fake([
    ["db=gene&term=", { esearchresult: { idlist: ["114548", "9558"] } }],
    ["db=gene&id=", {
      result: {
        "114548": { name: "NEWSYM3", status: "0", currentid: "" },
        "9558": { name: "OLDSYM7", status: 1, currentid: 114548 },
      },
    }],
  ]);
  assertEquals(await officialSymbol(f, "oldsym7", AUTH), {
    ok: true,
    value: null,
  });
  assertEquals(f.urls[0].includes("+AND+alive%5Bprop%5D"), true);
  const discontinued = fake([
    ["db=gene&term=", { esearchresult: { idlist: ["1"] } }],
    ["db=gene&id=", { result: { "1": { name: "GONE1", status: "2" } } }],
  ]);
  assertEquals(await officialSymbol(discontinued, "GONE1", AUTH), {
    ok: true,
    value: null,
  });
});

Deno.test("clinvarTraits offers only records that describe the gene, as the pipeline reads them", async () => {
  const record = (
    genes: string[],
    trait: string,
    extra: Record<string, unknown> = {},
  ) => ({
    genes: genes.map((symbol) => ({ symbol })),
    germline_classification: {
      trait_set: [{
        trait_name: trait,
        trait_xrefs: [{ db_source: "OMIM", db_id: "600000" }],
      }],
    },
    ...extra,
  });
  const span = (start: number, stop: number) => ({
    variation_set: [{
      variant_type: "Deletion",
      variation_loc: [{ start: String(start), stop: String(stop) }],
    }],
  });
  const many = Array.from({ length: 17 }, (_, i) => `GENE${i}`);
  const f = fake([
    ["db=clinvar&term=", {
      esearchresult: {
        idlist: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      },
    }],
    ["db=clinvar&id=", {
      result: {
        // A 17-gene deletion carries its region's syndrome, not the gene's.
        "1": record(["GENEA", ...many], "Region syndrome", span(1, 2)),
        // A copy-number event, whatever it spans.
        "2": record(["GENEA", "GENEB"], "Copy loss syndrome", {
          obj_type: "copy number loss",
        }),
        // Two genes and a deletion wider than an overlap.
        "3": record(["GENEA", "GENEB"], "Neighbour disease", span(100, 5000)),
        // A record naming other genes only.
        "4": record(["GENEB", "GENEC"], "Other gene disease"),
        // A trait with no disease identifier is a placeholder.
        "5": {
          genes: [{ symbol: "GENEA" }],
          germline_classification: {
            trait_set: [{
              trait_name: "See cases",
              trait_xrefs: [{ db_source: "MedGen", db_id: "C0000001" }],
            }],
          },
        },
        // No gene at all.
        "6": record([], "Unplaced disease"),
        // An overlap within a kilobase, and a whole-gene deletion of the
        // gene alone, are the gene's own.
        "7": record(["GENEA-AS1", "genea"], "Overlap disease", span(10, 30)),
        "8": record(["GENEA"], "Whole gene disease", {
          obj_type: "copy number loss",
          ...span(1, 2_000_000),
        }),
        // A gene entry with no symbol still counts as a gene named.
        "9": {
          ...record(["GENEA"], "Unnamed neighbour disease"),
          genes: [{ symbol: "GENEA" }, {}],
          variation_set: [{ variation_loc: [{ start: "5" }, {}] }],
        },
      },
    }],
  ]);
  assertEquals(await clinvarTraits(f, "GENEA", AUTH), {
    ok: true,
    value: [
      { name: "Overlap disease", omim: "600000" },
      { name: "Whole gene disease", omim: "600000" },
      { name: "Unnamed neighbour disease", omim: "600000" },
    ],
  });
  assertEquals(
    f.urls[0].includes("+AND+%22clinsig+pathogenic%22%5BProperties%5D"),
    true,
  );
});

Deno.test("pubmedAbstract unwraps efetch's 80-column lines and keeps its paragraphs", async () => {
  const printed = "1. Example J. 2020;1:1.  \n\nA title that is long enough\n" +
    "to wrap onto a second line.  \n\n\nFirst sentence of the abstract\r\n" +
    "  continued here.\n\nPMID: 1\n";
  assertEquals(
    await pubmedAbstract(fake([["efetch", printed]]), "1", AUTH),
    {
      ok: true,
      value: "1. Example J. 2020;1:1.\n\n" +
        "A title that is long enough to wrap onto a second line.\n\n" +
        "First sentence of the abstract continued here.\n\nPMID: 1",
    },
  );
});

Deno.test("meshLookup's mapped search fails as a lookup, and falls back when it names nothing", async () => {
  const translated = {
    idlist: ["1"],
    translationset: [{
      from: "example disease",
      to: '"example disease"[MeSH Terms]',
    }],
  };
  const route = (direct: unknown, summary: unknown) =>
    fake([
      ["%5BMeSH+Terms%5D", direct],
      ["db=mesh&term=", { esearchresult: translated }],
      ["db=mesh&id=", summary],
    ]);
  const named = {
    result: {
      "1": { ds_meshterms: ["Example Diseases", "Example Disease"] },
      "2": { ds_meshterms: ["Other Heading", "Example Disease"] },
    },
  };
  // The mapped search failing fails the lookup, as the first one would.
  assertEquals(
    await meshLookup(
      route({ esearchresult: {} }, named),
      "example disease",
      AUTH,
    ),
    { ok: false, error: "no idlist in the response" },
  );
  assertEquals(
    await meshLookup(
      route({ esearchresult: { idlist: ["2"] } }, { result: { "2": {} } }),
      "example disease",
      AUTH,
    ),
    { ok: false, error: "no heading in the response" },
  );
  // A mapped term that is an entry term rather than a heading still names
  // its descriptor.
  assertEquals(
    await heading(
      route({ esearchresult: { idlist: ["2"] } }, named),
      "example disease",
    ),
    "Other Heading",
  );
  // A mapped search that finds nothing leaves the answer to the page of hits.
  assertEquals(
    await heading(
      route({ esearchresult: { idlist: [] } }, named),
      "example disease",
    ),
    "Example Diseases",
  );
});
