---
paths:
  - "pipeline/pdf_parse.py"
  - "pipeline/pdf_retrieval.py"
  - "pipeline/config.py"
  - "pipeline/main.py"
  - "tests/pipeline/conftest.py"
  - "tests/pipeline/test_pdf_parse.py"
  - "tests/pipeline/test_pdf_retrieval.py"
---

# PDF fallback

`pipeline/pdf_parse.py` is the only module that imports Docling, and every
runtime import inside it is local — not an optionality guard (Docling is a core
dependency) but a startup-cost one, keeping torch out of the import graph the
argcomplete fast path at the top of `main.py` exists to protect. Its annotations
name Docling's classes through `TYPE_CHECKING`, which deferred annotations never
evaluate.

- **OCR is a fallback, not a mode.** It is on by default (`PIPELINE_PDF_OCR`),
  and `PDF_AWARE_LAYOUT_REGIONS` plus `PDF_FIRST` priority mean it never alters
  a born-digital paper's output -- it is the whole reason a scanned one yields
  anything. The measurements are the module docstring of
  `pipeline/pdf_parse.py`.
- **Threads default to performance cores, not `os.cpu_count()`.**
  `default_pdf_threads()` in `pipeline/config.py` reads
  `hw.perflevel0.logicalcpu` on macOS; its docstring has the numbers. Larger
  Docling batch sizes regress on unified memory too.
- **The engine is pinned, never `OcrAutoOptions()`.** That default probes the
  environment in an order Docling may reorder on upgrade, and on a total miss
  logs `"No OCR engine found"` once and then emits no OCR text at all -- a hole
  no exception marks. `RapidOcrOptions(backend="onnxruntime", lang=["en"])`.
- **CoreML is a loss here** (PP-OCR's dynamic input shapes fall back to CPU
  after paying conversion); `PIPELINE_PDF_OCR_COREML` keeps the knob, off.
- **`page_range` truncates; `max_num_pages` rejects.** Docling raises
  `ConversionError` and returns nothing at all for a document over
  `max_num_pages`, so it is the wrong guard: a long supplement would yield no
  text whatsoever. `page_range=(1, pdf_max_pages)` keeps the body, which is
  where gene symbols are named.
- **A failed Docling import travels all the way out.** `parse_pdf_bytes`
  re-raises `ImportError` from `_convert` deliberately -- Docling is a core
  dependency, so this is a broken install, not a bad PDF -- and both callers
  used to catch bare `Exception` around it, which made the invariant unreachable
  from any run mode. On the network path `download_and_parse_pdf` logged one
  warning per paper and returned `None`, so every Unpaywall paper in the run
  fell through to its abstract and was retired in `pubmed_refs` with
  `source: "abstract"`, under a `completed` report whose low `fulltextRetrieved`
  reads like an ordinary short window. Both callers now re-raise it: on the
  network path `process_paper_safe` records the paper as failed, so it is never
  written to `pubmed_refs` and the next run retries it; on `--local-pdfs`
  `_process_local_pdf_file` lets it out of the run entirely, because every file
  in the directory would fail the same way and one error apiece would report a
  broken environment as a corpus of unreadable papers. An `ImportError` raised
  later, inside `export_to_html`, is still handled as a bad-PDF failure --
  Docling imported fine there.

**On Python 3.15 the startup imports are lazy, and the tests see them
resolved.** `__lazy_modules__` in `main.py` and `config.py` (PEP 810; 3.14
ignores the name) took `import pipeline.main` from 994 ms to 165 ms, most of it
the SDK `config.py` imported for `transform_schema` alone. A module only needs
listing to be lazy, but one used at import time — a module-level constant, a
dataclass default — loads eagerly regardless. `_resolve_lazy_imports` in
`tests/pipeline/conftest.py` binds every lazy name before the first test:
`mock.patch` reads a still-lazy name as its proxy and builds a `MagicMock` where
the function is async, which failed four tests on 3.15 before it existed.
Docling's imports stay local rather than lazy, because 3.14 would import a
module-scope one eagerly.
