# The interview

Nine questions, in dependency order. For each: what it asks, which keys the
answer feeds, the lookup to run **before** asking so the researcher decides
over numbers rather than guesses, and the rule that validates the answer. Run
every lookup with `curl -s` and show the researcher what came back; the sample
responses below are real, trimmed, and there to tell you what to read out of
the JSON, not to be reused as answers.

E-utilities base: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`. Add
`&email=<ENTREZ_EMAIL>` from `.env` once it exists, and
`&api_key=<NCBI_API_KEY>` only when there is a real key: NCBI answers any
other value, an empty one included, with HTTP 400. Without a key it allows
three requests a second.

---

## 1. Name, key, abbreviation, institute, maintainer

**Asks:** the disease's full name in lower case as it reads mid-sentence, a
short form, an abbreviation, an adjective form for headings, a one-word
lowercase key; the institute's name, short name, URL and how its copyright
line reads; the maintainer's name and email.

**Feeds:** `manifest.json` → `disease.{key,name,short,abbreviation,adjective}`,
every string under `site.*`, `institute.*`, `contact.maintainer`.

**Pre-fill:** none. Draft the `site.*` strings from the answers by the cSVD
pattern and read them back — the researcher edits prose more readily than
they compose it:

- `site.title`: `<institute.short> <adjective> Dashboard`
- `site.heading`:
  `Putative Causal Genes and Clinical Trial Drugs for <Name In Title Case>`
- `site.metaDescription`:
  `Interactive dashboard of putative causal genes and clinical trial drugs for <name>, from the <institute.name> (<institute.short>).`
- `site.aboutTitle`: `Welcome to the <institute.name>'s <adjective> Dashboard`
- `site.aboutLede`, `site.loginLede`, `site.pages.{genes,trials,timeline,map}`:
  the cSVD sentences with the name substituted; read them back.

**Validates:** `disease.key` is `^[a-z][a-z0-9_]*$` — it becomes the database
name (`<key>_dashboard`), the Deploy project name (with each `_` written `-`,
since a project name becomes a host name) and the `disease` column every
extracted row carries. The logo files `institute.logo.src` and `srcOnDark`
name must exist under `static/`; ask for an SVG or PNG for each, one for a
light background and one for a dark one, or set `srcOnDark` to `null` and use
one file. A single file is drawn on the dark navigation bar and on the light
login card alike, so it has to read on both. `institute.url` may be omitted.

---

## 2. Disease phrases and MeSH headings

**Asks:** the phrases a paper about this disease writes in its title or
abstract (one to three). The MeSH headings come from them: each phrase is
resolved to the heading PubMed's own translation maps it to, and a phrase
MeSH has no heading for adds none.

**Feeds:** `pipeline.json` → `search.pubmed.diseaseTerms`,
`search.pubmed.meshTerms`. Every `diseaseTerms` entry anchors the two
Title/Abstract branches of `SVD_QUERY` (they are OR'd together);
`meshTerms` is the third branch, gated by the genetic terms of question 4. A
heading that is not one of the phrases (the cSVD file adds `White Matter`)
is written into `meshTerms` by hand, with its count in the block's
`$comment`, and the recall is measured again; the adapt page has no field
for one.

**Pre-fill:** resolve each phrase to a heading, then count what the heading
retrieves.

```text
GET esearch.fcgi?db=mesh&term=<phrase>&retmode=json
{"esearchresult":{"count":"1","idlist":["68059345"], …}}

GET esummary.fcgi?db=mesh&id=68059345&retmode=json
{"result":{"68059345":{"ds_meshterms":["Cerebral Small Vessel Diseases", …],
                       "ds_scopenote":"Pathological processes or diseases where cerebral MICROVESSELS …"}}}

GET esearch.fcgi?db=pubmed&term=%22Cerebral+Small+Vessel+Diseases%22%5BMeSH%5D&rettype=count&retmode=json
{"esearchresult":{"count":"11699"}}
```

The heading is the one the translation maps the whole phrase to: the
`esearchresult.translationset` entry whose `from` is the phrase names it in
its `to` as `"<Heading>"[MeSH Terms]`; take that descriptor's
`ds_meshterms[0]`, not the first hit's. Only when the translation names none,
take the hit with a term equal to the phrase, or else the one whose shortest
term contains it, among up to 200 hits. Read `ds_scopenote` back to the
researcher so they confirm it is their disease. Print the all-time count per
heading; a heading in the hundreds of thousands (`"Stroke"`, `"Dementia"`)
is a parent, not a disease, and the researcher should pick a child.

**Validates:** at least one phrase; every heading resolved by
`esearch db=mesh` with `count` ≥ 1.

---

## 3. Marker terms

**Asks:** the phenotypes, biomarkers or clinical terms papers about this
disease write beside its name — five to ten.

**Feeds:** `pipeline.json` → `search.pubmed.markerTerms`. They are the second
Title/Abstract branch of `SVD_QUERY`: a paper holding a disease phrase and a
marker is kept even with none of question 4's genetic terms. A marker never
reaches a paper that names no disease phrase. Each adds papers, so a long or
broad list is what the cost estimate sends the researcher back to trim.

**Pre-fill:** a count per term, anchored on every disease phrase so the
number means "papers holding a phrase and this term":

```text
GET esearch.fcgi?db=pubmed&term=(%22<diseaseTerms[0]>%22%5BTitle%2FAbstract%5D+OR+%22<diseaseTerms[1]>%22%5BTitle%2FAbstract%5D)+AND+%22<term>%22%5BTitle%2FAbstract%5D&rettype=count&retmode=json
{"esearchresult":{"count":"2140"}}
```

**Validates:** one to fifteen terms, none empty, none a duplicate of a
disease phrase.

---

## 4. Confirm the genetic terms

**Asks:** whether the ten genetic terms in `GENETIC_TERMS`
(`pipeline/pubmed_search.py`) — the vocabulary of GWAS, Mendelian
randomization, TWAS, exome and other genetics papers — fit the field. They
stay in code because they are about genetics, not the disease.

**Feeds:** nothing in `disease/`. Accepted by default.

**Pre-fill:** print the list. If the researcher wants a term added, it is a
code change to `GENETIC_TERMS` with a test, and it belongs upstream: say so
and move on.

---

## 5. Trait vocabulary

**Asks:** the phenotypes the dashboard filters on and the karyogram pins —
**four to sixteen**, each with a key (the value the model writes and the
data stores), a label (the short text on the karyogram's pills and the
filter choices, 20 characters or fewer), a long name, a one-sentence
definition, and a family (a grouping of two to five keys that share a
colour). If the field has a
phenotype standard (as STRIVE-2 is for cSVD), its citation fills
`citationStandard`; otherwise that key is `null` and the definitions are the
researcher's.

**Feeds:** `vocabulary.json` → `traits[]` (`key`, `label`, `family`, `name`,
`standard`, `definition`, `xref`, `xrefNote`); `phenogram.json` → one
`families[]` entry per distinct `family`; `manifest.json` →
`citationStandard`; `prompt.md` → `## traits.canonical`,
`## criteria.phenotypes`, `## strategy.phenotype_shortlist`.

**Pre-fill:** an ontology cross-reference per trait:

```text
GET https://www.ebi.ac.uk/ols4/api/search?q=<trait+name>&ontology=efo,hp,mondo&rows=5
{"response":{"docs":[
  {"obo_id":"HP:0030890","label":"Hyperintensity of cerebral white matter on MRI",
   "ontology_name":"hp","exact_synonyms":["White matter hyperintensity"]}, …]}}
```

Offer the top hit's `obo_id` and `label`; the researcher accepts, picks
another row, or says none fits. A miss becomes `"xref": null` with an
`xrefNote` saying what was searched and why nothing matched. `xref` is a
curation aid and drift check, never published.

**Validates:** 4 ≤ traits ≤ 16; keys unique, no comma in a key (the
canonical sentence is comma-separated); `standard` is `true` only when the
definition is quoted from the named standard; every family has at least one
trait.

---

## 6. Trial populations, CT.gov terms, and the first mechanism family

**Asks:** three things about trials. (a) The populations the trials page
files a trial under — one to six (one is drawn as the radar's whole
circle), with a key and a label, and the column
label the table shows (the cSVD dashboard's is "SVD Population"). (b) The
condition terms to search ClinicalTrials.gov with, and the substrings (and
word pairs) a stated condition must contain for a discovered trial to be
kept. (c) At least one mechanism of action already being tested for the
disease, with the family it belongs to — `timeline.json` cannot start with
no family, and the first curated trial row will need one.

**Feeds:** `manifest.json` → `populations[]`, `populationField.{label,detailsLabel}`;
`timeline.json` → `populations[]` (same keys, same order, each with
`label` as an array of lines, `color`, `band`), `mechanisms{}`, `families[]`;
`pipeline.json` → `search.clinicalTrials.{searchTerms,conditions,conditionPairs}`.

**Pre-fill:** a count per search term, and the interventions the first page
names, as candidates for (c):

```text
GET https://clinicaltrials.gov/api/v2/studies?query.cond=<term>&countTotal=true&pageSize=1
{"totalCount":617,"studies":[{"protocolSection":{"identificationModule":{"nctId":"NCT01241305"}}}]}

GET https://clinicaltrials.gov/api/v2/studies?query.cond=<term>&pageSize=20&fields=NCTId,Condition,InterventionName
{"studies":[{"protocolSection":{
   "identificationModule":{"nctId":"NCT00430105"},
   "conditionsModule":{"conditions":["ANCA Associated Systemic Vasculitis", …]},
   "armsInterventionsModule":{"interventions":[{"name":"cyclophosphamide"}]}}}, …]}
```

`query.cond` expands through CT.gov's own concept graph, which is why the
first page above is vasculitis trials for a small-vessel query: read the
`conditions` back and let the researcher choose the `conditions` substrings
that would have kept the right ones and dropped the rest. A mechanism string
is the researcher's wording (`Cholinesterase inhibition (acetylcholinesterase
inhibitor)`), never an intervention name copied as-is. A family keyed
`uncharacterised` is the one the radar flags: it holds the mechanisms a trial
states too thinly to classify.

**Validates:** populations ≥ 1 with unique keys; `timeline.json` populations
equal the manifest's in order; every mechanism in `mechanisms{}` appears in
exactly one family and every family has ≥ 1 mechanism; mechanism colours are
distinct and none equals `unknownMechanism`; `searchTerms` and `conditions`
each ≥ 1.

---

## 7. Monogenic genes

**Asks:** the genes in which rare variants cause a Mendelian form of the
disease — zero to ten — and, per gene, the OMIM phenotype entries the
researcher wants the tooltips to show.

**Feeds:** `pipeline.json` → `monogenicGenes[]`, `geneAliases{}` (a name
the dashboard files genes under _instead of_ their HGNC symbols, mapped to
the symbols it stands for: every extraction of a member is stored and
published under the name. Use one for a group the literature treats as one,
`COL4A1/2`, or a symbol NCBI has retired that the literature still writes,
`C6orf195`; never for a synonym of a gene that should show as itself); `omim_info.csv` (one row per confirmed OMIM phenotype entry:
`omim_num,omim_link,location,phenotype,phenotype_mim_number,inheritance,phenotype_mapping_key,gene_or_locus,gene_or_locus_mim_number`);
`prompt.md` → `## strategy.monogenic_genes` (exactly the `monogenicGenes`
list joined by `, `), `## rubric.monogenic_examples`,
`## strategy.background_example`.

**Pre-fill:** ClinVar for the disease xrefs a gene carries, Orphadata for the
gene-disorder associations of an ORPHAcode ClinVar names:

```text
GET esearch.fcgi?db=clinvar&term=<GENE>%5Bgene%5D&retmode=json&retmax=200
{"esearchresult":{"count":"443","idlist":["4887740","4873483", …]}}

GET esummary.fcgi?db=clinvar&id=<ids>&retmode=json
… "germline_classification":{"trait_set":[{"trait_name":"CARASIL syndrome",
    "trait_xrefs":[{"db_source":"OMIM","db_id":"600142"},
                   {"db_source":"Orphanet","db_id":"199354"}]}]} …

GET https://api.orphadata.com/rd-associated-genes/orphacodes/199354
{"data":{"__licence":{"identifier":"CC-BY-4.0", …},
         "results":{"DisorderGeneAssociation":[{"DisorderGeneAssociationType":"Disease-causing germline mutation(s) in",
                                                 "Gene":{"ExternalReference":[{"Reference":"HTRA1","Source":"ClinVar"}, …]}}]}}}
```

Search pathogenic records only (`AND "clinsig pathogenic"[Properties]` on
the esearch), and read a record only when it describes the gene itself: its
one gene, or one of at most five genes with no copy-number type
(`copy number gain`/`loss`) and variants spanning no more than 1 kb.
Collect the distinct `trait_name` / OMIM `db_id` pairs of the traits that
carry an OMIM, MONDO or Orphanet xref (that drops `not provided`, `not
specified` and `See cases`) and read them back. The
traits sit under each record's `germline_classification`; the record has no
top-level `trait_set` since ClinVar's 2024 change, so reading one finds
nothing. The
researcher confirms each phenotype row on omim.org and supplies `location`,
`inheritance`, `phenotype_mapping_key` and the gene MIM number from the entry
page — the pipeline has no OMIM key, and the CSV has always been web
copy-paste. `omim_link` is
`https://www.omim.org/entry/<num>?search=<num>&highlight=<num>`.

**Validates:** every symbol is the official HGNC symbol: `esearch db=gene
term=<SYMBOL>[sym] AND human[orgn]` finds it and `esummary db=gene` of the
hits names it (`name`), in HGNC's case (`C9orf72`). `[sym]` also matches
aliases and former symbols (`CASIL` finds NOTCH3), so a hit alone is not
enough; search current records only (`AND alive[prop]`), since a replaced
record (`status` 1) answers with its old name, which is not the official
symbol; the CSV parses with the nine columns and
`omim_num` an integer; with no monogenic gene, `monogenicGenes` is `[]`,
`## strategy.monogenic_genes` is empty, and the CSV is the header line.

---

## 8. Papers for the prompt's examples

**Asks:** two to four papers by PMID that each report a causal-gene finding
for the disease, and for each: the gene symbol, the trait key(s) from
question 5, the sentence in the paper that states the finding, and how
confident the researcher is that the gene is causal (a number in 0–1 the
rubric explains).

**Feeds:** `prompt.md` → `## examples`, one `<example type="…">` block per
paper in the cSVD file's format (`Paper states:`, `Result:`, `Reasoning:`),
plus `## strategy.causal_gene_example`, `## strategy.mr_example`,
`## strategy.ortholog_example` and `## strategy.convergence_example`, which
are one-clause examples drawn from the same papers or left as the
researcher's wording.

**Pre-fill:** confirm each PMID exists and fetch its abstract, so a quote
the researcher gives from memory can be checked against the text and a
quote they do not give can be copied from it verbatim:

```text
GET efetch.fcgi?db=pubmed&id=<pmid>&rettype=abstract&retmode=text
1. Lancet Neurol. 2021 May;20(5):351-361. doi: 10.1016/S1474-4422(21)00031-4.
Genetic basis of lacunar stroke: a pooled analysis of individual patient data
and genome-wide association studies.
Traylor M(1), Persyn E(2), …
```

A PMID with no record comes back as its list number and nothing else (`1.`);
say so and ask for another.

**Validates:** the rule in `SKILL.md`. Every example cites one of these
PMIDs; every `Paper states:` sentence is the researcher's or the abstract's,
verbatim; every gene in a `Result:` is one the researcher named for that
paper; every trait is a key from question 5. Fewer than two papers →
`<!-- examples: none yet -->`.

---

## 9. Gold PMIDs for recall

**Asks:** ten to thirty PMIDs of papers the PubMed query **must** retrieve —
the genetics papers on this disease the researcher would be alarmed to see a
run miss. The question-8 papers count.

**Feeds:** `disease/recall_gold.csv` (`pmid,note`, one row each; the note
says why the paper is gold, e.g. `landmark GWAS`).

**Pre-fill:** none beyond existence — `esummary.fcgi?db=pubmed&id=<pmids>&retmode=json`
in one request returns a `title` per uid; a uid with an `error` key does not
exist.

**Validates:** 10 ≤ rows ≤ 30, every PMID numeric and existing, no
duplicates. Then `scripts.measure_recall` as `SKILL.md` describes; the misses
are questions for the researcher.
