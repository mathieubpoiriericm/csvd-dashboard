"""PDF text extraction for the retrieval fallback.

Docling rather than a raw text dump: on scientific papers a plain
page.get_text() loses all table structure, interleaves two-column layouts
into false adjacency, and fuses reference superscripts onto tokens
("COL4A1" + ref 12 -> "COL4A112") — poison when the extracted output *is*
gene symbols.

OCR is on, and it is a fallback rather than a mode. Docling's default
OcrMode is PDF_AWARE_LAYOUT_REGIONS, which drops every layout cluster that
already holds programmatic text, so a born-digital paper reaches the
recognizer with almost nothing to do; where OCR and PDF cells do overlap,
PDF_FIRST priority keeps the programmatic text. Measured on six corpus
papers (M1 Pro, 12-page cap, RapidOCR/ONNX Runtime), plus one of them
rasterised to strip its text layer:

    born-digital, OCR off, MPS   59.68 s   431613 chars
    born-digital, OCR on,  MPS  106.92 s   431613 chars  (+79%, same output)
    born-digital, OCR off, CPU   63.10 s   431613 chars  (MPS only 5% faster)
    rasterised,   OCR off         5.29 s     3947 chars
    rasterised,   OCR on         41.82 s    27421 chars  (97.5% of the original)

So the older "skipping it roughly halves runtime" note had the sign right and
the cause wrong: OCR nearly doubles this path, but it never alters a
born-digital paper's output, and it is the whole reason a scanned one yields
anything at all. PIPELINE_PDF_OCR=false disables it.
"""

import io
import logging
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from pipeline.config import PipelineConfig

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _ConverterSettings:
    """The converter's inputs, hashable so `_converter` can cache on them.

    PipelineConfig is a plain, mutable dataclass and therefore unhashable;
    this is the subset the converter actually reads.
    """

    ocr: bool
    coreml: bool
    device: str
    num_threads: int
    timeout_seconds: float
    max_pages: int
    artifacts_path: str

    @classmethod
    def from_config(cls, config: PipelineConfig) -> _ConverterSettings:
        return cls(
            ocr=config.pdf_ocr,
            coreml=config.pdf_ocr_coreml,
            device=config.pdf_device,
            num_threads=config.pdf_num_threads,
            timeout_seconds=config.pdf_timeout_seconds,
            max_pages=config.pdf_max_pages,
            artifacts_path=config.pdf_artifacts_path,
        )


@cache
def _converter(settings: _ConverterSettings) -> Any:
    """Build the Docling converter once; model loading is expensive.

    Every docling import is deliberately local. Docling is a hard
    requirement, so this is not an optionality guard — it keeps torch out of
    the import graph of every `pipeline.main` invocation, which is the same
    startup cost the argcomplete fast path in main.py exists to protect.
    """
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        PdfPipelineOptions,
        RapidOcrOptions,
        TableStructureOptions,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = settings.ocr
    options.do_table_structure = True
    # table_structure_options is typed as the abstract BaseTableStructureOptions
    # on PdfPipelineOptions, which has no do_cell_matching field — assign a
    # concrete TableStructureOptions instead of mutating the default in place.
    options.table_structure_options = TableStructureOptions(do_cell_matching=True)

    if settings.ocr:
        # Pinned rather than left at the default OcrAutoOptions(): that
        # probes the environment in an order docling may reorder on upgrade,
        # and when every probe misses it logs "No OCR engine found" once and
        # then emits no OCR text at all — a silent hole, not a failure.
        options.ocr_options = RapidOcrOptions(
            backend="onnxruntime",
            lang=["en"],
            rapidocr_params=_rapidocr_params(settings),
        )

    options.accelerator_options = AcceleratorOptions(
        device=settings.device, num_threads=settings.num_threads
    )
    # Conversion was previously unbounded: pdf_retrieval's PDF_TIMEOUT covers
    # the download only, so a pathological PDF could stall a whole run.
    options.document_timeout = settings.timeout_seconds
    if settings.artifacts_path:
        options.artifacts_path = Path(settings.artifacts_path)

    logger.info(
        "Docling converter: device=%s threads=%d ocr=%s%s timeout=%.0fs "
        "max_pages=%d",
        settings.device,
        settings.num_threads,
        "rapidocr/onnxruntime" if settings.ocr else "off",
        " (CoreML)" if settings.ocr and settings.coreml else "",
        settings.timeout_seconds,
        settings.max_pages,
    )
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )


def _rapidocr_params(settings: _ConverterSettings) -> dict[str, Any]:
    """RapidOCR engine overrides, passed through by Docling untouched."""
    if not settings.coreml:
        return {}
    return {
        "EngineConfig.onnxruntime.use_coreml": True,
        # RapidOCR's own default is /tmp/RapidOCR — world-writable, and shared
        # between every user on the machine.
        "EngineConfig.onnxruntime.coreml_ep_cfg.ModelCacheDirectory": str(
            Path.home() / ".cache" / "rapidocr-coreml"
        ),
    }


def _convert(data: bytes, settings: _ConverterSettings) -> Any:
    """Run Docling over PDF bytes, returning its document object.

    Returns None for a conversion Docling did not finish. A
    ``document_timeout`` is not an exception: the pipeline appends a
    ``TIMEOUT`` error item, sets ``PARTIAL_SUCCESS`` and hands back the
    pages it did manage, and ``convert()`` raises only for a status
    outside ``{SUCCESS, PARTIAL_SUCCESS}``. Taking ``.document`` off it
    published 12 pages of a 40-page paper as the paper -- ``fulltext:
    True``, counted in ``fulltextRetrieved``, the PMID retired on it, and
    the results tables past the cut-off never seen by the model. A page
    that failed to parse sets the same status, and means the same thing.
    The abstract is a smaller text but an honest one, so the cascade is
    left to fall through to it.
    """
    from docling.datamodel.base_models import ConversionStatus, DocumentStream

    stream = DocumentStream(name="paper.pdf", stream=io.BytesIO(data))
    # page_range truncates; max_num_pages *rejects* the document outright
    # (ConversionError, nothing returned). Truncation is the right guard
    # here: gene symbols are named in the body, and _truncate_back_matter
    # already discards the tail.
    result = _converter(settings).convert(stream, page_range=(1, settings.max_pages))
    if result.status is not ConversionStatus.SUCCESS:
        logger.warning(
            "Docling did not finish the PDF (status=%s); treating it as "
            "unavailable rather than as full text: %s",
            getattr(result.status, "value", result.status),
            "; ".join(error.error_message for error in result.errors) or "no detail",
        )
        return None
    return result.document


def parse_pdf_bytes(data: bytes, *, config: PipelineConfig | None = None) -> str | None:
    """Extract text from PDF bytes, preserving table structure.

    Tables are exported as HTML, not Markdown: GWAS association tables
    routinely carry merged two-row headers that pipe tables silently
    flatten, losing which column a p-value belongs to.
    """
    settings = _ConverterSettings.from_config(config or PipelineConfig())
    try:
        document = _convert(data, settings)
    except ImportError:
        # Docling is a hard requirement (see pyproject.toml), so this is a
        # broken install rather than a bad PDF. Degrading it to an abstract
        # would hide the breakage behind quietly worse extraction for every
        # paper in the run.
        raise
    # A malformed PDF is isolated to this paper rather than aborting the run.
    except Exception as exc:
        logger.warning("Docling could not parse the PDF: %s", exc)
        return None
    if document is None:
        return None

    try:
        text = document.export_to_html()
    # Export failures are likewise local to this paper.
    except Exception as exc:
        logger.warning("Docling could not parse the PDF: %s", exc)
        return None
    return text.strip() or None


def parse_pdf_file(path: Path, *, config: PipelineConfig | None = None) -> str | None:
    """Extract text from a PDF on disk."""
    try:
        return parse_pdf_bytes(path.read_bytes(), config=config)
    except OSError as exc:
        logger.warning("Could not read %s: %s", path, exc)
        return None
