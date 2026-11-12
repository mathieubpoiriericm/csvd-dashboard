---
paths:
  - "pipeline/citations.py"
  - "pipeline/config.py"
  - "pipeline/anthropic_client.py"
  - "tests/pipeline/test_citations.py"
  - "tests/pipeline/test_config.py"
  - "tests/pipeline/csvd/test_extraction_golden.py"
  - "tests/pipeline/test_anthropic_client.py"
---

# Provenance

`source_quote` is checked two ways by `pipeline/citations.py`, and the two do
not cover the same ground. `verify_quote` matches it against a span the **API**
cited; `locate_quote` finds it in the **document** itself. Enabling that
required two changes the API forces together: the schema had to leave
`output_config.format` (citations beside it are a 400) and the paper had to
travel in a real `document` block, because `start_char_index`/`end_char_index`
index into exactly the bytes sent there — an XML wrapper would shift every
offset by its own length.

**The tool is deliberately not `strict`.** On Claude Opus 5, `strict: true`
corrupts every free-text string in a tool's input -- `source_quote` above all,
the one field this work exists to make trustworthy -- so the schema guarantee
moved from the decoder to validate-and-retry. The measurement (9/9 corrupt with
the flag, 4/4 clean without, 2026-08-31) is in the `extraction_tool` docstring
in `pipeline/config.py` and pinned by `tests/pipeline/test_config.py`; do not
flip it back on the strength of how it reads. It has not been repeated on Opus
5.5, so it stays off there until it is.

**The two numbers this produced, and they are not the same number.** Across the
124 genes in the golden cassettes, re-recorded 2026-11-02 on Claude Opus 5.5
over the same fixture text as the Opus 5 recording before it:

| Measure                                | Rate              |
| -------------------------------------- | ----------------- |
| quotes verbatim in the paper           | **122/124 = 98%** |
| quotes matched to an API citation span | **98/124 = 79%**  |
| quotes corrupted                       | 0/124             |

The two unverified quotes are one sentence, quoted for both `VCAN` and
`SH3PXD2A` on PMID 33293549: the paper has it after a semicolon as "four WMH
risk loci individually showed…", and the model capitalised it into a sentence of
its own. That is a transcription edit the check is right to refuse, not invented
prose. Opus 5.5 still writes its evidence as cited `text` blocks before the tool
call, the same block shape as Opus 5 — the change that sends text _between_ tool
calls to `thinking` blocks did not reach this single-call response.

The gap between them is not a quality problem. The API returns spans only where
the model wrote prose, because the instruction asks for supporting evidence in
prose rather than one sentence per gene, so the citation rate tracks prose
volume rather than quote fidelity: papers with few genes verify near 100% and
the gene-dense ones drag it down.

**Both numbers move on every re-record, and neither move is a code change.** The
Opus 5 recordings measured 137/138 = 99%, 130/134 = 97% and 140/140 verbatim,
and 45/138 = 33%, 87/134 = 65% and 61/140 = 44% cited; the last Opus 5
cassettes, counted by the same replay as the Opus 5.5 ones, gave 139/139 and
74/139 = 53%. The citation rate is the one that swings, because the model writes
a different amount of prose each time; Opus 5.5 wrote more of it (about 20,100
characters before the tool call against 13,100) and attached 56 citations
against 43. The verbatim rate reached 100% on 2026-09-11 because the refetched
fixtures no longer carry the artifact every earlier failure was: the model
reproducing a sentence with a superscript reference marker spliced into it
(`( Fig. 111 2 )` for the document's `( Fig. 2 )`, all on PMID 35511193), which
the parser's row joining and whitespace collapse removed from the text the model
reads. That is a retrieval-and-transcription artifact worth knowing about, not
invented prose, and it is exactly what the verbatim check exists to surface.

**So the gate turns on the verbatim check, not the citation match.**
`require_verified_quotes` (`PIPELINE_REQUIRE_VERIFIED_QUOTES`) filters on
`locate_quote`: gating on citations would discard between a third and two thirds
of the genes for want of prose, while gating on the document has dropped at most
two genes in 124, and those two for one capitalised letter. The citation match
is still computed and logged, because it is the stronger claim where it exists —
the API attests the model used that span — but it cannot be the gate at 33–79%
coverage.

It still defaults to `False`. This lands as measurement: a quote that fails is a
finding worth seeing before it is a gene worth losing, and each failure is
logged by gene symbol. The first recording's one failure is instructive —
`CENPF` on PMID 37069360, where the quote is a genomic-table row the model
reassembled from cells (`9,033/38,008 8.20 × 10 −11 …`) rather than a sentence.
That is a retrieval artifact worth knowing about, not a hallucination.

Raising the _citation_ rate would mean asking for one supporting sentence per
gene, which buys a signal already available for free from the document and costs
output tokens on every run forever. Measured and not done.

**A cited line per gene was measured too, on 2026-11-11, and ruled out.** The
task instruction asked for one line `SYMBOL: traits` per gene, citing the
sentence the model would give as its `source_quote`, and the API's cited
sentence replaced a quote that was not verbatim. Quotes matched to a citation
rose from 96/133 = 72% (the v8 baseline of that day) to 86/104 = 83%. The
model's own quotes were 103/104 verbatim against v8's 133/133, and the one
failure (CENPF on PMID 37069360, the reassembled table row again) was repaired
from its cited line, which is also one of the 86. Recall was pooled 37/46
against 40/46: on one paper the model dropped two gold genes it had scored,
because their only support is a table row, which v8 quotes as a row (an arm
without the line dropped the same two in the same words, so that is not shown to
be the line's doing). It saved no output: on most papers the model wrote the
sentence on the line anyway, and on one it wrote the bare lines as asked and the
API cited none of them, so a line earned a citation only by carrying the
sentence. The figures and the model's own account are in `extraction.md` ("A v9
was recorded twice"). The citation match stays what it was: a stronger claim
where it exists, with coverage this prompt change did not buy at v8's recall.

Whitespace is collapsed before comparing, and that is load-bearing rather than
cosmetic; the docstring of `pipeline/citations.py` records why, what it
recovered, and the containment option measured and not taken.

**The reasoning trace is retained as an audit artifact, never as evidence.**
`_record_thinking_trace` in `anthropic_client.py` writes each response's
extended-thinking text to the SQLite event log, capped and labelled with its
attempt number and whether that attempt was the accepted one. It is never
published -- no `data/*.json` key, no `lib/types.ts` field -- because an
extended-thinking block is not a verified causal account of how the model
reached its answer; `source_quote` remains the cited evidence. The
single-sentence rule `locate_quote` enforces (`is_sentence_like`,
`_MIN_QUOTE_WORDS`) is documented in `pipeline/citations.py`.
