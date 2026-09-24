import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import pipeline.pdf_parse as pdf_parse
from pipeline.config import PipelineConfig
from pipeline.pdf_parse import _ConverterSettings, parse_pdf_bytes, parse_pdf_file


def _settings(
    *,
    ocr: bool = True,
    coreml: bool = False,
    device: str = "auto",
    num_threads: int = 4,
    timeout_seconds: float = 120.0,
    max_pages: int = 200,
    artifacts_path: str = "",
) -> _ConverterSettings:
    """Converter settings with the production defaults, overridable per test."""
    return _ConverterSettings(
        ocr=ocr,
        coreml=coreml,
        device=device,
        num_threads=num_threads,
        timeout_seconds=timeout_seconds,
        max_pages=max_pages,
        artifacts_path=artifacts_path,
    )


def test_tables_are_exported_as_html_not_markdown() -> None:
    """GWAS tables have merged two-row headers that pipe tables flatten."""
    doc = MagicMock()
    doc.export_to_html.return_value = "<table><tr><td>HTRA1</td></tr></table>"
    with patch("pipeline.pdf_parse._convert", return_value=doc):
        text = parse_pdf_bytes(b"%PDF-1.7 fake")
    assert text is not None
    assert "HTRA1" in text
    doc.export_to_html.assert_called_once()


def test_a_conversion_failure_returns_none_rather_than_raising() -> None:
    with patch("pipeline.pdf_parse._convert", side_effect=RuntimeError("boom")):
        assert parse_pdf_bytes(b"%PDF-1.7 fake") is None


def test_empty_output_is_none() -> None:
    doc = MagicMock()
    doc.export_to_html.return_value = "   "
    with patch("pipeline.pdf_parse._convert", return_value=doc):
        assert parse_pdf_bytes(b"%PDF-1.7 fake") is None


def test_missing_docling_propagates_rather_than_degrading() -> None:
    """Docling is a hard requirement, so its absence is a broken install.

    Degrading it to None would send every paper in the run to its abstract
    while the logs showed only a per-paper warning -- quietly worse
    extraction, corpus-wide, from a one-line environment fault. The pdf
    extra used to make absence legitimate; it no longer exists.
    """
    with (
        patch(
            "pipeline.pdf_parse._convert",
            side_effect=ModuleNotFoundError("No module named 'docling'"),
        ),
        pytest.raises(ModuleNotFoundError, match="docling"),
    ):
        parse_pdf_bytes(b"%PDF-1.7 fake")


def test_import_error_during_export_is_not_misdiagnosed_as_a_broken_install(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An ImportError raised only while exporting must not abort the run.

    Only _convert -- the import/conversion boundary -- treats ImportError as
    a broken install worth raising on. A failure surfacing later, inside
    export_to_html, means docling itself imported fine, so it is handled
    like any other bad-PDF failure and the run continues.
    """
    doc = MagicMock()
    doc.export_to_html.side_effect = ImportError("an unrelated docling-internal import")
    with (
        patch("pipeline.pdf_parse._convert", return_value=doc),
        caplog.at_level(logging.WARNING),
    ):
        result = parse_pdf_bytes(b"%PDF-1.7 fake")
    assert result is None
    assert "Docling could not parse the PDF" in caplog.text


class TestConverterConfiguration:
    """Pin _converter()'s Docling pipeline configuration.

    Every other test here patches _convert, one level up, so nothing else
    would catch an edit that silently dropped OCR, cell matching, the
    timeout or the accelerator settings. Building a real converter loads
    models, so DocumentConverter and PdfPipelineOptions are patched and the
    PdfFormatOption handed to the (mocked) converter is inspected instead.
    """

    @staticmethod
    def _build(settings: _ConverterSettings) -> Any:
        # _converter is @cache'd; clear before so the real body runs under
        # the patches, and after so a cached Mock cannot leak into a later
        # test.
        pdf_parse._converter.cache_clear()
        try:
            with (
                patch(
                    "docling.datamodel.pipeline_options.PdfPipelineOptions",
                    autospec=True,
                ),
                patch("docling.document_converter.DocumentConverter") as converter,
            ):
                pdf_parse._converter(settings)
                from docling.datamodel.base_models import InputFormat

                converter.assert_called_once()
                format_options = converter.call_args.kwargs["format_options"]
                return format_options[InputFormat.PDF].pipeline_options
        finally:
            pdf_parse._converter.cache_clear()

    def test_table_structure_keeps_cell_matching(self) -> None:
        from docling.datamodel.pipeline_options import TableStructureOptions

        options = self._build(_settings())
        assert options.do_table_structure is True
        assert isinstance(options.table_structure_options, TableStructureOptions)
        assert options.table_structure_options.do_cell_matching is True

    def test_ocr_uses_rapidocr_on_onnxruntime_in_english(self) -> None:
        from docling.datamodel.pipeline_options import RapidOcrOptions

        options = self._build(_settings(ocr=True))
        assert options.do_ocr is True
        assert isinstance(options.ocr_options, RapidOcrOptions)
        assert options.ocr_options.backend == "onnxruntime"
        assert options.ocr_options.lang == ["en"]

    def test_the_engine_is_pinned_rather_than_auto_selected(self) -> None:
        """OcrAutoOptions probes the environment and fails silently on a miss.

        Its fallback order is docling's to change on upgrade, and when every
        probe misses it logs "No OCR engine found" once and then emits no
        OCR text at all -- a hole no exception marks.
        """
        from docling.datamodel.pipeline_options import OcrAutoOptions

        options = self._build(_settings(ocr=True))
        assert not isinstance(options.ocr_options, OcrAutoOptions)

    def test_disabling_ocr_leaves_the_engine_unset(self) -> None:
        options = self._build(_settings(ocr=False))
        assert options.do_ocr is False

    def test_accelerator_and_timeout_are_explicit(self) -> None:
        options = self._build(_settings(device="cpu", num_threads=7))
        assert options.accelerator_options.device == "cpu"
        assert options.accelerator_options.num_threads == 7
        assert options.document_timeout == 120.0

    def test_artifacts_path_is_set_only_when_configured(self, tmp_path) -> None:
        from pathlib import Path

        assert self._build(_settings(artifacts_path=str(tmp_path))).artifacts_path == (
            Path(tmp_path)
        )
        # An empty override means "use docling's own cache", so the option is
        # left untouched rather than set to Path(""), which would point the
        # converter at the working directory. The autospec'd mock only grows
        # an attribute when the code assigns one, so absence is observable.
        assert not hasattr(self._build(_settings(artifacts_path="")), "artifacts_path")


def test_coreml_is_off_by_default_and_redirects_its_cache() -> None:
    """CoreML measured 1.65x slower than CPU on this corpus (68.9s vs 41.8s).

    PP-OCR detection and recognition use dynamic input shapes, which CoreML
    commonly kicks back to CPU, paying the conversion cost for nothing. The
    knob stays because the result is hardware- and version-specific; the
    default does not.
    """
    assert pdf_parse._rapidocr_params(_settings(coreml=False)) == {}

    params = pdf_parse._rapidocr_params(_settings(coreml=True))
    assert params["EngineConfig.onnxruntime.use_coreml"] is True
    # RapidOCR's own default is /tmp/RapidOCR -- world-writable and shared.
    cache_dir = params[
        "EngineConfig.onnxruntime.coreml_ep_cfg.ModelCacheDirectory"
    ]
    assert not str(cache_dir).startswith("/tmp/")


def test_settings_are_read_from_the_pipeline_config(monkeypatch) -> None:
    """Env var -> PipelineConfig -> converter, the whole plumbing."""
    monkeypatch.setenv("PIPELINE_PDF_OCR", "false")
    monkeypatch.setenv("PIPELINE_PDF_DEVICE", "cpu")
    monkeypatch.setenv("PIPELINE_PDF_NUM_THREADS", "2")
    monkeypatch.setenv("PIPELINE_PDF_MAX_PAGES", "30")

    settings = _ConverterSettings.from_config(PipelineConfig())

    assert settings.ocr is False
    assert settings.device == "cpu"
    assert settings.num_threads == 2
    assert settings.max_pages == 30


def test_settings_are_hashable_so_the_converter_can_cache_on_them() -> None:
    """PipelineConfig itself is unhashable, which is why this type exists."""
    assert hash(_settings()) == hash(_settings())
    assert _settings(device="cpu") != _settings(device="auto")


def test_convert_truncates_by_page_range_rather_than_rejecting() -> None:
    """max_num_pages *rejects* an over-long document; page_range truncates.

    Docling raises ConversionError and returns nothing at all when a
    document exceeds max_num_pages, so using it as a guard would turn a long
    supplement into no text whatsoever. Gene symbols are named in the body,
    and _truncate_back_matter already discards the tail.
    """
    from docling.datamodel.base_models import ConversionStatus

    document = object()
    stream_class = MagicMock()
    converter = MagicMock()
    converter.convert.return_value = SimpleNamespace(
        document=document, status=ConversionStatus.SUCCESS, errors=[]
    )

    with (
        patch("docling.datamodel.base_models.DocumentStream", stream_class),
        patch("pipeline.pdf_parse._converter", return_value=converter),
    ):
        result = pdf_parse._convert(b"%PDF-data", _settings(max_pages=30))

    assert result is document
    assert converter.convert.call_args.kwargs["page_range"] == (1, 30)
    assert "max_num_pages" not in converter.convert.call_args.kwargs

    stream = stream_class.call_args.kwargs
    assert stream["name"] == "paper.pdf"
    assert stream["stream"].read() == b"%PDF-data"


def test_a_timed_out_conversion_is_not_published_as_full_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A document_timeout is PARTIAL_SUCCESS, not an exception.

    Docling appends a TIMEOUT error item and hands back the pages it did
    manage; convert() raises only outside {SUCCESS, PARTIAL_SUCCESS}. Taking
    .document off that published 12 of 40 pages as the paper -- fulltext:
    True, the PMID retired on it, the results tables never seen.
    """
    from docling.datamodel.base_models import (
        ConversionStatus,
        DoclingComponentType,
        ErrorItem,
        FailureCategory,
    )

    converter = MagicMock()
    converter.convert.return_value = SimpleNamespace(
        document=MagicMock(),
        status=ConversionStatus.PARTIAL_SUCCESS,
        errors=[
            ErrorItem(
                component_type=DoclingComponentType.PIPELINE,
                module_name="base_pipeline",
                error_message=(
                    "Document processing timeout: exceeded 120.000s limit "
                    "after 121.500s. Processed 12/40 pages."
                ),
                category=FailureCategory.TIMEOUT,
            )
        ],
    )

    with (
        patch("pipeline.pdf_parse._converter", return_value=converter),
        caplog.at_level(logging.WARNING),
    ):
        assert pdf_parse._convert(b"%PDF-data", _settings()) is None

    assert "partial_success" in caplog.text
    assert "Processed 12/40 pages" in caplog.text


def test_an_unfinished_conversion_yields_no_text() -> None:
    """_convert answering None must not be exported as a document."""
    with patch("pipeline.pdf_parse._convert", return_value=None):
        assert parse_pdf_bytes(b"%PDF-1.7 fake") is None


def test_parse_pdf_file_reads_bytes(tmp_path) -> None:
    path = tmp_path / "paper.pdf"
    path.write_bytes(b"%PDF-data")

    with patch("pipeline.pdf_parse.parse_pdf_bytes", return_value="parsed") as parse:
        assert parse_pdf_file(path) == "parsed"

    parse.assert_called_once_with(b"%PDF-data", config=None)


def test_parse_pdf_file_read_error_returns_none(tmp_path, caplog) -> None:
    with caplog.at_level(logging.WARNING):
        assert parse_pdf_file(tmp_path) is None

    assert "Could not read" in caplog.text
