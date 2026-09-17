---
name: debug-paper-retrieval
description: "Use when a paper fails to retrieve or parses badly: the Europe PMC and PDF retrieval traps and what each one looks like in the run log."
---

# Debugging paper retrieval

The cascade is Europe PMC full text, then PMC's efetch, then an Unpaywall PDF
through Docling, then the PubMed abstract; a paper that reaches the end with
nothing is recorded as `source: "none"` and never retried, so a retrieval fault
that reads as "no text" retires the paper for good. What follows is what each
known fault looks like, in the run log and in the data.

Ten things about what reaches the model, each found in shipped data, a recorded
run or a live document rather than reasoned about:

- **Every paginated esearch repeats the date filter.** `search_recent_papers`
  pages with `usehistory`, and esearch re-runs `term` even when a WebEnv and
  query_key are supplied, so a page naming only the term searched the
  _unfiltered_ index. A 365-day window (795 papers) came back from page 2 with
  Count=8265 -- the all-time set -- and 205 of its 500 ids were outside the
  window. The truncation guard never fired because 500 + 500 exceeds 795, so
  `len(pmids) < total_count` was false and `--test-mode` reported "1000 papers"
  as the answer. Paging the history set by `#query_key` instead returns nothing;
  repeating `datetype`/`mindate`/`maxdate` is what works.
- **PMC's "does not allow downloading" notice is not full text.** Europe PMC
  serves the OA subset first, so `fetch_pmc_fulltext` is reached mostly for
  articles PMC holds but does not license for XML download, and efetch answers
  those with a well-formed document whose whole body is one sentence saying so.
  `_parse_pmc_xml` returned it, the model extracted from that sentence, and the
  PMID was retired with `fulltext_available = true` -- 8 of the 9
  `source: "pmc"` papers in the first published run report produced zero genes.
  The parser now returns `None` for the notice, and for a front-mattered article
  with no `<sec>` and under 500 characters of body, so the cascade falls through
  to Unpaywall and the abstract. It also emits a nested paragraph once:
  `.//body//p` matched a list item's `<p>` as well as the paragraph holding it.
- **A record's DOI is read from its own `ArticleIdList` only.** `PubmedData`
  carries the article's identifiers and then a `ReferenceList` whose entries use
  the same `<ArticleId IdType="doi">`, so `.//ArticleId` read a cited paper's
  DOI for a record with none of its own -- into `refs.json`, and into Unpaywall,
  which then fetched the other paper's PDF for this PMID. Both readers
  (`pubmed_citations._doi` and `main._own_doi`) take `PubmedData/ArticleIdList`
  first and `ELocationID[@EIdType='doi']` second; a book chapter's comes from
  `BookDocument/ArticleIdList`.
- **A 200 that is not a PubMed document is a retrieval failure, not "no
  abstract".** NCBI's maintenance page and E-utilities' in-band
  `<eFetchResult><ERROR>` both arrive as a 200; parsed as XML they hold no
  `AbstractText`, and `fetch_abstract` used to answer `None`, which
  `process_paper` records as `source: "none"` for good. Only a
  `<PubmedArticleSet>` may say "none"; anything else raises `RetrievalError` and
  the paper is retried. `fetch_abstract` parses the response once and hands the
  root element to both that check and `_extract_abstract`, which reads
  `<Abstract>` alone: `<OtherAbstract>` is a publisher translation or a
  plain-language summary, and `.//AbstractText` was appending its sections to
  the abstract.
- **A truncated search reaches the report, and a rejected query fails it.** A
  short search still returns the PMIDs it did retrieve -- those papers are real
  -- but `search_recent_papers` calls `on_truncated` with `(retrieved, total)`
  **whenever `len(pmids) < Count`**, which `_discover_new_pmids` raises as a
  `search_truncated` warning on step 1; a log line was the only record and the
  run ended `completed`. That covers all four ways of coming up short, not just
  the pagination failure it was written for: the `MAX_TOTAL_RESULTS` cap of
  5000, which a `--days-back 3650` window (~795 papers/year, so ~8000 matches)
  reaches every time and a cumulative `scripts.backfill_pubmed` walk reaches
  past ~6 years; a `Count` over 500 that NCBI answered with no
  `WebEnv`/`QueryKey` to page through, which was silent; and an empty `IdList`
  mid-walk, likewise silent. The cap is the one that matters, because every
  window ends at _now_: the papers past the cut are in no later window either,
  so a clean step-1 badge over 5000 of 8000 was a permanent, invisible hole.
  `ErrorList/FieldNotFound` (a field tag NCBI does not know) arrives inside a
  200 with `Count` 0, which read as "no new papers" and a green run for as long
  as the tag stayed wrong; it raises `PubMedSearchError`. `PhraseNotFound` is
  one OR-branch matching nothing while the rest answers, and is logged. A failed
  esearch is recorded in the services panel as an error (status 0 when the
  transport carried none), where only a successful one was.
- **JATS tables are row-wise.** `parse_jats` emitted `th`/`td` one cell per
  line, so a gene, its trait and its p-value reached the model as three
  unrelated lines and the association the table stated was left for it to
  re-infer -- while the module docstring said table structure was why Europe PMC
  leads the cascade. Each `<tr>` is now one line, cells joined with `|` in
  column order and empty cells kept so the columns still line up with the header
  row. This changes the document text sent to the model for Europe PMC papers,
  and the golden fixtures with it: `scripts/fetch_paper_fixtures.py` writes them
  through the current `parse_jats`, so a parser change moves their hash off the
  manifest and the harness has to be re-recorded. Matching on URI is why that
  has to be observed by a test rather than by replay --
  `test_the_cassettes_were_recorded_with_the_request_the_code_sends` in
  `tests/pipeline/test_extraction_golden.py` is the test that observes it.
- **A table can sit beside the body, not in it.** JATS allows `<table-wrap>` and
  `<fig>` in a `<floats-group>` that is a _sibling_ of `<body>`, and publishers
  use it: PMC12385738 (a 2025 CADASIL review) has zero `<tr>` in its body and
  three in its floats-group, so `parse_jats`'s `root.find(".//body")` walk
  dropped the paper's whole table set and its captions while `get_fulltext`
  still recorded `source: "europepmc", fulltext: True` and retired the PMID.
  `_blocks` is now run over the body and then over each `<floats-group>`,
  sharing one `emitted` set, so the floats follow the body in document order and
  a nested `<p>` inside a `<td>` is still emitted once. A live survey of 60 OA
  cSVD documents found two with `<tr>` outside `<body>`; the other one's are in
  `<back>`, which is deliberately still not read -- that is where the reference
  list lives.
- **A JATS body that is only a "available as a PDF" notice is not a paper.**
  PMC's scanned back-issue deposits (PMC3053794, PMC2116354) carry `<front>`, a
  `<sec>` and one sentence pointing at a PDF, so neither `_parse_pmc_xml`'s
  publisher-stub regex nor its unsectioned-length guard sees them, and _both_
  JATS readers returned the notice as the paper. `is_pdf_only_notice` in
  `europepmc.py` is checked by both; it is anchored to the first 200 characters
  of the extracted text, because the notice is the body's first block and a
  data-availability sentence deep in a real article must not cut it.
- **A back-matter heading is not always one bare word.** `_BACK_MATTER_PATTERN`
  matched exactly six words, so `<h2>5. References</h2>`,
  `<h2>References and Notes</h2>` and `<h2>Literature Cited</h2>` left the
  bibliography in the text the model extracts from -- where a cited title names
  genes the paper never studied and `locate_quote` passes, because the quote
  really is in the document. It now takes an optional section number, the
  variants (`Literature Cited`, `Works Cited`, `Reference List`, both spellings
  of `Acknowledg(e)ments`) and a trailing colon. Docling misclassifies a heading
  as body text often enough to matter, so a whole `<p>` that is only a
  bibliography word counts too -- bibliography words only, because a stray
  `<p>Methods</p>` in the second half of a paper would cut the results away. The
  midpoint guard is unchanged.
- **Unpaywall's `submittedVersion` is a different document.** `best_oa_location`
  ranks `publishedVersion > acceptedVersion > submittedVersion`, so it is a
  preprint exactly when nothing better exists -- a paywalled article whose only
  open copy is its medRxiv or bioRxiv deposit. Extracting that stored the
  preprint's association table under the peer-reviewed PMID, published quotes
  that appear nowhere in the article of record, and retired the PMID so the
  published version was never read. `_unpaywall_oa_url` refuses it and the
  cascade falls through to the article's own abstract; the version chosen is
  logged either way.
- **A Docling `PARTIAL_SUCCESS` is not full text.** A `document_timeout` is not
  an exception: the pipeline appends a `TIMEOUT` error item, sets
  `PARTIAL_SUCCESS` and hands back the pages it finished, and `convert()` raises
  only for a status outside `{SUCCESS, PARTIAL_SUCCESS}`. Taking `.document` off
  that published 12 pages of a 40-page paper as the paper -- `fulltext: True`,
  counted in `fulltextRetrieved`, the PMID retired on it, the results tables
  past the cut-off never seen, and `_truncate_back_matter`'s midpoint now moved
  earlier so a `Methods` heading that was safe could cut again. A page that
  failed to parse sets the same status and means the same thing. `_convert`
  returns `None` for any non-`SUCCESS` status, logging the status and Docling's
  own error messages, so the cascade falls through to the abstract -- a smaller
  text, but an honest one.

`_read_pdf_bytes` decides on the bytes: repositories serve PDFs as
`application/octet-stream` behind `download.pdf?token=...`, which
`url.endswith(".pdf")` refused before a byte was read, and label real PDFs
`text/html`. A body that does not start with `%PDF-` is rejected on its first
chunk, so a landing page costs no more than the header gate saved.
`_format_citation` HTML-escapes its text fields, because `formatted_ref` is
rendered as HTML and a title reading "levels <40" would reach the page as
markup; `_pub_date` falls back to `<MedlineDate>`, which PubMed uses for ranges
and irregular issues in place of `Year`/`Month`.
