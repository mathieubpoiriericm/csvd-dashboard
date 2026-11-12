"""Prompt definitions for LLM-based gene extraction.

Separates prompt engineering from API call logic so prompts can be
iterated on without touching extraction code.

v8 is the only prompt. v1-v3 were the pre-provenance lineage and v6
contains v5 verbatim, so none of them said anything v6 does not.

v8 is v7 asking for structured omics evidence: each study's type (the
published vocabulary, `OMICS_STUDY_TYPES`), the biomarker it tested and the
items the gene was significant in, each flagged when the paper reports
significant colocalization there -- so a gene the pipeline adds arrives in
the curated table's format. Its omics guidance was tightened on 2026-11-09,
before any run had used it (gold-only mode refused --pubmed): tissues named
specifically or not at all, colocalization only on a named tissue, items that
are names rather than sentences, an Experimental item as a model or
intervention in a few words, and SMR placed under TWAS or Proteogenomic
MR -- the first recording had written "multiple tissues*" and reference-panel
lists as colocalized items. v7 asked for bare labels ("TWAS",
"colocalization", "MAGMA") that the export then dropped or starred, and its
`omics_evidence=[...]` examples would teach a shape the v8 schema refuses, so
v7 left the table the way v6 did and a run naming it is refused. Its rendered
prompt for this repository's disease hashed (`prompt_sha256`) to e94fa49c33a2788a4901d3e1fcd242712735b624309c4834c1e85531b0b303bb,
the value earlier run reports carry; its bytes are the v6 fixtures in
`tests/pipeline/csvd/fixtures/`.

v4 was kept for a while because v6 is *not* a superset of it: v5 loosened
two of v4's exclusion guards, accepting "even a single mention as an MTAG
locus label" where v4 required the gene to be nearest at the MTAG-specific
locus, and narrowing "positional candidates do NOT qualify" to
*single-phenotype* positional candidates. The suspicion was that those
relaxations caused the over-extraction the harness sees -- 43 genes
against 17 curated rows on PMID 37069360 in the recorded golden cassette.

Measured, and they do not. Recording both arms over the same ten fixtures
gave identical pooled recall (42/46) while the *stricter* arm returned
more genes, not fewer (144 against 138), and the genes it added were LOC
identifiers and an antisense RNA. The guards are ruled out rather than
assumed, so v4 is gone with them.

Three more changes were built as a would-be v9 and recorded twice on
2026-11-11 (Claude Opus 5.5, effort "high", the same fixtures), one of them
never alone. Neither recording met the bar fixed before it, so v8 stands
byte for byte. `.claude/rules/pipeline/extraction.md` has the figures, the
genes and the model's own account of each.

One reporting threshold, in a recording that also carried the two changes
below. v8 contradicts itself: a positional candidate is capped at 0.20, yet
a genome-wide significant GWAS gene scores at least 0.60 and the
`include_gwas_alone` example scores a *nearest* gene 0.65. Stating one rule
instead ("report a gene only if you would score it 0.30 or higher", with the
cap, the confidence-0 step for negative results and that example rewritten
to agree) left one paper at 5 of its 10 reachable gold genes, where v8 found
10 and the recording without the rule 8, and pooled recall over the six
papers that recorded at 33/45 against 39/45. Under v8's text the model
resolves the contradiction toward reporting the nearest gene at a
significant locus, which is what the curated table does; the single rule
resolved it the other way. On that one recording the contradiction is
load-bearing. Do not tidy it without a recording.

One cited line per gene. The task instruction asked for a line "SYMBOL:
traits" per gene, citing the sentence the model would give as that gene's
`source_quote`, in place of the evidence sentence it asks for now; the API's
cited sentence then repaired a quote that was not verbatim. Quotes matched
to an API citation rose from 72% to 83%, and pooled recall was 37/46 against
the same day's 40/46 (clean 19/26 against 22/26), two below the low end of
v8's own recordings: on one paper the model dropped two gold genes it had
scored, because their only support is a table row and it had been asked to
show a sentence first. It saved no output either -- on most papers the model
wrote each sentence on its line anyway, and where it wrote the bare line the
API cited nothing.

Both recordings also carried a rewritten tool definition (a description for
every field, a longer tool description, two `input_examples`, no `pmid` in
the schema), which was never recorded alone.

v7 was v6 with every disease noun moved to `disease/prompt.md`, and v8 keeps
that split; `tests/pipeline/csvd/test_csvd_prompt_assembly.py` pins this
repository's rendering to the v6 bytes but for the omics lines it lists. What stays here
is the method -- the inclusion rule, the strategy, the rubric's tiers -- and
what moved is the disease it is aimed at.

PROMPT_VERSIONS_WITHOUT_PROVENANCE still derives from the table and is now
empty -- the machinery stays, because a future version that forgets the
provenance block has to be caught the same way.
"""

import hashlib
import logging
import re
from collections.abc import Container, Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from pipeline.disease import Disease, load_disease
from pipeline.omics import OMICS_STUDY_TYPES

logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class ExtractionPrompt:
    """Provider-agnostic prompt payload for gene extraction."""

    system_prompt: str
    extraction_instructions: str
    # The paper's text, raw. It travels in an Anthropic `document` content
    # block, so it carries no wrapper of its own: citation offsets index
    # into exactly these bytes, and a wrapper would shift every one of them
    # by the length of its opening tag.
    document_text: str
    task_instruction: str


# ---------------------------------------------------------------------------
# The renderer
# ---------------------------------------------------------------------------

_SLOT: Final[re.Pattern[str]] = re.compile(r"\{\{ (?P<id>[a-z][a-z0-9_.]*) \}\}")


def render_prompt(template: str, sections: Mapping[str, str]) -> str:
    """Substitute ``{{ id }}`` slots; refuse anything that would change bytes silently.

    A slot the sections lack, a section the template never asks for, and a
    ``{{`` surviving the render are each an error rather than a fallback:
    the rendered string is the recorded method, and a quiet default would
    publish a prompt nobody wrote.

    Deliberately neither Jinja nor ``str.format``. Jinja's defaults
    (`keep_trailing_newline`, `trim_blocks`, autoescape) each silently alter
    bytes, and a data file has no business carrying control flow;
    ``str.format`` would make a disease author escape every brace in prose.
    The v6 literals contain no braces at all, which is why byte identity is
    reachable here.
    """
    used: set[str] = set()

    def fill(match: re.Match[str]) -> str:
        key = match.group("id")
        if key not in sections:
            raise ValueError(
                f"prompt template names {key}, which the disease file lacks"
            )
        used.add(key)
        return sections[key]

    rendered = _SLOT.sub(fill, template)
    # The residual-brace check comes first: a section body that itself
    # carries a slot leaves both a `{{` in the output *and* the section it
    # names unused, and "unrendered" is the diagnosis of the two.
    if "{{" in rendered:
        raise ValueError("unrendered '{{' left in the prompt")
    unused = sorted(set(sections) - used)
    if unused:
        raise ValueError(f"disease sections never referenced by the template: {unused}")
    return rendered


def _named_by(template: str, sections: Mapping[str, str]) -> dict[str, str]:
    """The sections this template names, and only those.

    Three templates are rendered from one disease file and none of them
    uses every section, so handing each the whole mapping would make
    `render_prompt`'s unused-section refusal fire on every render. The
    union is checked once instead, by `_refuse_orphan_sections`, which is
    where an orphan section in `disease/prompt.md` is caught.
    """
    slots = set(_SLOT.findall(template))
    return {key: value for key, value in sections.items() if key in slots}


def _refuse_orphan_sections(sections: Iterable[str], used: Container[str]) -> None:
    """A section no template reads is an edit that changed nothing, silently."""
    orphans = sorted(key for key in sections if key not in used)
    if orphans:
        raise ValueError(f"disease sections no prompt template reads: {orphans}")


# ---------------------------------------------------------------------------
# V8 templates (v6's method, the disease nouns in disease/prompt.md, structured omics)
# ---------------------------------------------------------------------------

# One system prompt, shared by every surviving version: v4, v5 and v6 all
# aliased v3's literal, so the chain of aliases said nothing the name does
# not.
_SYSTEM_TEMPLATE_V8: Final[str] = (
    "You are a systematic reviewer specializing in {{ disease.name }} "
    "({{ disease.abbreviation }}) genetics. You maintain a curated database of "
    "genes with putative causal links to {{ disease.abbreviation }}, identified "
    "through GWAS, MAGMA gene-based tests, "
    "multi-trait GWAS (MTAG), multi-omics studies (TWAS, PWAS, EWAS, proteomics), "
    "Mendelian randomization, colocalization, fine-mapping, proteogenomics/pQTL-MR, "
    "WES/WGS rare variant burden tests, cell-type enrichment analyses, "
    "multi-ancestry GWAS, and functional validation. You are rigorous about "
    "distinguishing causal evidence from mere association or incidental mention. "
    "{{ persona.specificity }} "
    "You understand that GWAS identifies genomic loci, not individual genes. "
    "A gene's physical proximity to a lead SNP does NOT constitute gene-level "
    "evidence. You require gene-specific statistical tests (gene-based tests, "
    "TWAS, colocalization, fine-mapping, coding variants) to implicate individual "
    "genes at multi-gene loci."
)


class _DiseaseSteps:
    """Sentinel: splice the disease's own steps here, numbered in sequence."""


# The one step about the disease's monogenic genes. A disease with none -- a
# legal answer for one with no Mendelian form -- leaves its list empty, and
# the step would tell the model about "monogenic genes ()" that do not exist,
# so it is left out and the steps after it close up.
_MONOGENIC_STEP: Final[str] = (
    'For well-known monogenic {{ disease.abbreviation }} genes ({{ strategy.monogenic_genes }}), only extract if the paper presents NEW data — new statistical association, new functional evidence, or new population-level variant analysis. Do NOT extract these genes from background sentences like "{{ strategy.background_example }}"'
)


# The numbered strategy list is assembled rather than substituted, because
# the numbers have to stay contiguous: this disease contributes one step
# and keeps v6's 11-13 at their numbers, while a disease contributing none
# gets 1-12 and a disease contributing three gets 1-15. A `{{ }}` slot could
# only ever paste a fixed block of text at a fixed number.
_STRATEGY_STEPS: Final[tuple[str | type[_DiseaseSteps], ...]] = (
    "Identify all passages that mention specific genes in the context of {{ disease.abbreviation }} causality.",
    "Verify that each gene was tested in a {{ disease.abbreviation }}-specific analysis ({{ strategy.phenotype_shortlist }}, or another {{ disease.abbreviation }} phenotype) — not just {{ strategy.neighbouring_conditions }}.",
    "Distinguish genes with individual statistical evidence (GWAS hit, gene-based significance, MR result) from genes mentioned only as positional candidates at a GWAS locus or as members of enriched pathways. Positional candidacy means the gene is listed because it is near the lead SNP but has NO gene-specific test result. Do NOT extract positional-only candidates. Only extract pathway-only genes if the paper explicitly discusses their individual role.",
    _MONOGENIC_STEP,
    "At multi-gene loci, ONLY extract genes for which the paper reports individual gene-level evidence (gene-based p-value, TWAS/PWAS/EWAS result, coding variant, colocalization, or fine-mapping). Do NOT extract all positional candidates at a locus simply because the locus is significant.",
    "When a TWAS, colocalization, or fine-mapping analysis identifies a specific causal gene at a GWAS locus, use THAT gene's symbol as the gene_symbol — not the positional locus name or the nearest gene to the lead SNP. {{ strategy.causal_gene_example }}",
    'Parse for negative results ("did not support," "no association," "failed to replicate"). If a gene was tested and found not associated, assign confidence 0 and note the negative result.',
    'Distinguish MR-exposure genes (e.g., "{{ strategy.mr_example }}") from genes with direct {{ disease.abbreviation }} genetic association. Flag MR-only evidence in the causal_evidence_summary.',
    "Map animal model gene nomenclature to human HGNC symbols (e.g., {{ strategy.ortholog_example }}).",
    _DiseaseSteps,
    "Before classifying a gene as positional-only, check ALL omics analyses reported in the paper — including EWAS (epigenome-wide association), methylation analyses, and extreme-phenotype analyses. A gene that appears in an EWAS analysis has individual gene-level evidence and is NOT a positional candidate.",
    "MULTI-PHENOTYPE CONVERGENCE: If a gene is listed as the nearest gene at GWAS loci for >=2 INDEPENDENT {{ disease.abbreviation }} phenotypes (e.g., {{ strategy.convergence_example }}), this cross-phenotype convergence constitutes gene-level evidence. Do NOT treat multi-phenotype genes as positional-only candidates. Cross-phenotype replication at the same gene is unlikely coincidental.",
    'MTAG LOCUS SCANNING: Carefully scan MTAG results paragraphs for gene names mentioned as locus labels. Even a single brief mention like "at GENE1 (phenotype)" constitutes gene-level evidence. Pay attention to dense results paragraphs listing many loci — do not skip briefly mentioned genes.',
)


def _render_steps(disease_steps: str, *, monogenic: bool = True) -> str:
    """Number the template's steps and the disease's own as one list.

    Every item is stripped. One step per line is the whole shape of this
    list, so a disease step carrying a leading blank line or a trailing
    space would put whitespace between its number and its first word, or
    an empty line inside the numbering -- neither of which any reader of
    `disease/prompt.md` intended to write. Without ``monogenic`` the
    monogenic step is left out.
    """
    items: list[str] = []
    for step in _STRATEGY_STEPS:
        if step is _MONOGENIC_STEP and not monogenic:
            continue
        if isinstance(step, str):
            items.append(step.strip())
        else:  # the _DiseaseSteps sentinel
            items.extend(
                stripped
                for s in disease_steps.split("\n\n")
                if (stripped := s.strip())
            )
    return "\n".join(f"{n}. {body}" for n, body in enumerate(items, 1))


_INSTRUCTIONS_TEMPLATE_V8: Final[str] = """\
<instructions>
<task>
Extract all genes with putative causal links to {{ disease.name }} ({{ disease.abbreviation }}) from the research paper provided.
</task>

<inclusion_criteria>
Include a gene when the paper presents ANY evidence suggesting a putative causal relationship with {{ disease.abbreviation }} or {{ disease.abbreviation }}-related phenotypes. Putative causal evidence includes: GWAS associations, MAGMA gene-based tests, multi-trait GWAS (MTAG), fine-mapping, colocalization, Mendelian randomization, pQTL-MR/proteogenomics, WES/WGS rare variant burden tests, cell-type enrichment analyses, multi-ancestry GWAS, polygenic risk scores (PRS), functional studies, expression QTLs, animal/cell models, or any mechanistic evidence linking the gene to {{ disease.abbreviation }} pathology.

{{ criteria.phenotypes }}

CRITICAL: Physical proximity to a GWAS lead SNP is NOT sufficient for inclusion. A gene must have INDIVIDUAL-LEVEL statistical evidence linking it to a {{ disease.abbreviation }} phenotype. Being listed as a positional candidate gene, or being the nearest gene to a significant SNP, does NOT meet the inclusion criteria unless the paper also reports gene-based test results (MAGMA, TWAS, PWAS, EWAS, colocalization, fine-mapping, or coding variant analysis) for that specific gene.
</inclusion_criteria>

<extraction_strategy>
When analyzing the paper:
{{ strategy.steps }}
</extraction_strategy>

<field_guidance>
For each gene, record the following:
- gene_symbol: Official HGNC gene symbol (human). Convert animal model nomenclature to human orthologs.
- gwas_trait: Use ONLY these canonical abbreviations: {{ traits.canonical }}. Do not use full phenotype names.
- mendelian_randomization: Set to true only if the paper presents MR evidence for this gene. In causal_evidence_summary, distinguish whether the gene is an MR exposure (drug target) vs. a direct {{ disease.abbreviation }}-associated gene.
- omics_evidence: One entry per omics or analytical study the paper reports for this gene, other than the GWAS itself. For each: study_type, one of {{ omics.study_types }} ("Experimental" for functional or animal-model work); biomarker, the phenotype the study tested, using the canonical trait abbreviations above where one applies; items, each tissue, cell type or reference dataset the gene was significant in, named as specifically as the paper names it (a reference dataset as "<dataset>: <tissue>", e.g. "YFS: blood"), with colocalized set to true only when the paper reports significant colocalization for that named tissue, and as a last item any other evidence the study adds, in a few words (e.g. "RNA-Seq"). Each item is a name, never a sentence: methods and effect sizes belong in causal_evidence_summary. For Experimental, the items are instead each model or intervention, in a few words (e.g. "Trim47-deficient mice"). When the paper names no specific tissue -- only "multiple tissues", or the reference panels it used -- give no items rather than a summary. SMR on expression QTLs is a TWAS and on protein QTLs a Proteogenomic MR; list a tissue for it only where the result was significant and passed the HEIDI test. Colocalization, MAGMA, MTAG and PRS are not study types: colocalization is the per-item flag, and the others belong to the GWAS evidence.
- confidence: A score from 0.0 to 1.0 (see scoring rubric below).
- causal_evidence_summary: 1-3 sentences explaining WHY the paper considers this gene causally linked. {{ guidance.specificity_note }} For MR evidence, clarify whether the gene is a direct association or an exposure/drug target.
</field_guidance>

<confidence_scoring>
IMPORTANT: Use the FULL 0.0-1.0 range. Do NOT cluster scores at 0.50. A gene with genome-wide significant GWAS association for a {{ disease.abbreviation }} phenotype should score at LEAST 0.60 even without additional support. With TWAS and/or colocalization, score 0.70-0.80.

IMPORTANT: Before assigning any confidence score above 0.50, verify that the gene has at least ONE of: (a) genome-wide significant gene-based test, (b) significant TWAS/PWAS/EWAS, (c) significant colocalization/SMR, (d) fine-mapping to credible set, (e) coding variant in LD, (f) functional validation. Without any of these, the maximum score is 0.30.

Positional candidate penalty: If the only basis for a gene is its position at a GWAS locus (listed in a locus table, nearest gene), apply a hard cap of 0.20 regardless of the locus's p-value.

Multi-phenotype convergence exception: If a gene appears as the nearest gene at GWAS loci for >=2 INDEPENDENT {{ disease.abbreviation }} phenotypes (different phenotype categories, not subgroups like {{ rubric.subgroup_example }}), do NOT apply the positional candidate hard cap of 0.20. Instead, assign a minimum confidence of 0.60.

Eight-tier rubric:

- 1.0: Validated causal — established monogenic cause with understood mechanism{{ rubric.monogenic_clause }} OR GWAS significance + fine-mapping to credible set of ≤5 variants + functional validation in a {{ disease.abbreviation }}-relevant cell type ({{ rubric.cell_types }}).
- 0.8-0.9: Strong multi-modal convergence — GWAS significance for a {{ disease.abbreviation }}-specific phenotype + eQTL/pQTL colocalization in relevant tissue + at least one supporting line (coding variant, animal model, rare variant burden, or drug target confirmation).
- 0.7-0.8: GWAS significance for a {{ disease.abbreviation }} phenotype + at least ONE supporting line of evidence (TWAS, colocalization, MAGMA gene-based test, coding variant in LD, MTAG cross-trait support). This is the expected tier for novel GWAS loci reported with standard follow-up analyses.
- 0.6-0.7: The gene ITSELF has individual genome-wide significance (gene-based test, TWAS, sole gene at a locus) for a {{ disease.abbreviation }} phenotype with no additional supporting evidence. Also applies to: MTAG-only findings; and genes with cross-phenotype convergence (nearest gene at GWAS loci for >=2 independent phenotypes). MTAG reaching genome-wide significance IS gene-level evidence — even a single mention as an MTAG locus label is sufficient. NOTE: single-phenotype positional candidates do NOT qualify for this tier.
- 0.4-0.5: Indirect or suggestive — pathway analysis gene only (enriched gene set member, no individual significance); pQTL-MR evidence without direct genetic association; {{ rubric.neighbour_gwas_gene }}; or animal model findings without human genetic support. pQTL-MR with cis instruments scores at the high end (0.5).
- 0.2-0.3: Weak or contextual — genetic correlation only; unreplicated candidate gene study; pre-GWAS era association; protein interaction network member without direct evidence.
- 0.1-0.2: Positional candidate only — gene is listed at a GWAS locus because of physical proximity to the lead SNP, but has NO individual gene-level statistical test. DO NOT assign scores of 0.4 or higher to positional-only candidates.
- 0.0: Negative or tangential — gene tested and found not associated; background citation only; covariate mention; general context sentence with no causal evidence.

Cross-cutting modifiers:
{{ rubric.modifiers }}
</confidence_scoring>

<examples>
{{ examples }}
</examples>
</instructions>

## Provenance

For every gene you report, set `source_quote` to a single verbatim sentence
copied from the paper that supports the association. Copy it exactly — do
not paraphrase, summarise, or stitch two sentences together. If no single
sentence supports the entry, do not report the gene.
"""


# ---------------------------------------------------------------------------
# Version dispatch
# ---------------------------------------------------------------------------


# The rubric's examples of validated monogenic causality, when there are any:
# with none, "(e.g., )" would name nothing.
_MONOGENIC_EXAMPLES_CLAUSE: Final[str] = " (e.g., {{ rubric.monogenic_examples }})"

# Sections a disease with no monogenic gene may leave blank, and which then
# reach no template: read all the same, so no orphan check fires on them.
_MONOGENIC_SECTIONS: Final[frozenset[str]] = frozenset(
    {
        "strategy.monogenic_genes",
        "strategy.background_example",
        "rubric.monogenic_examples",
    }
)


def _assemble(disease: Disease) -> tuple[str, str]:
    """Render the templates against one disease file."""
    sections: dict[str, str] = dict(disease.prompt_sections)
    sections["disease.name"] = disease.name
    sections["disease.abbreviation"] = disease.abbreviation
    # The schema's enum, so what the model is asked for and what it may say
    # cannot drift apart.
    sections["omics.study_types"] = ", ".join(
        f'"{study_type}"' for study_type in OMICS_STUDY_TYPES
    )
    sections["rubric.monogenic_clause"] = (
        render_prompt(
            _MONOGENIC_EXAMPLES_CLAUSE,
            {"rubric.monogenic_examples": sections["rubric.monogenic_examples"]},
        )
        if sections.get("rubric.monogenic_examples", "").strip()
        else ""
    )

    steps_template = _render_steps(
        sections.pop("strategy.disease_steps", ""),
        monogenic=bool(sections.get("strategy.monogenic_genes", "").strip()),
    )
    sections["strategy.steps"] = render_prompt(
        steps_template, _named_by(steps_template, sections)
    )
    system = render_prompt(
        _SYSTEM_TEMPLATE_V8, _named_by(_SYSTEM_TEMPLATE_V8, sections)
    )
    instructions = render_prompt(
        _INSTRUCTIONS_TEMPLATE_V8, _named_by(_INSTRUCTIONS_TEMPLATE_V8, sections)
    )
    _refuse_orphan_sections(
        disease.prompt_sections,
        set(_SLOT.findall(steps_template))
        | set(_SLOT.findall(_SYSTEM_TEMPLATE_V8))
        | set(_SLOT.findall(_INSTRUCTIONS_TEMPLATE_V8))
        | {"strategy.disease_steps"}
        | _MONOGENIC_SECTIONS,
    )
    return system, instructions


def _assemble_v8() -> tuple[str, str]:
    """Render the templates against the disease file, once at import."""
    return _assemble(load_disease())


_PROMPTS: Final[Mapping[str, tuple[str, str]]] = MappingProxyType({"v8": _assemble_v8()})


_PROVENANCE_HEADING: Final[str] = "## Provenance"

# Every prompt version this module can build. PipelineConfig refuses a name
# that is not in here, because the name travels into the run report, the
# database record and the checkpoint fingerprint as the method the rows
# were extracted with.
PROMPT_VERSIONS: Final[frozenset[str]] = frozenset(_PROMPTS)

# The production version: the default PipelineConfig.prompt_version takes and
# the one build_extraction_prompt and prompt_sha256 render when not told
# otherwise. One name, so promoting a v8 is one edit rather than three.
PROMPT_VERSION: Final[str] = "v8"
assert PROMPT_VERSION in PROMPT_VERSIONS

# Prompt versions that do not instruct the model to copy a verbatim
# sentence into source_quote. The field is required by the schema with
# min_length=1, so a model given one of these prompts still returns
# something for it -- a paraphrase, or an invention -- and validation
# passes it. The provenance the field exists to carry becomes
# untrustworthy with nothing to signal it, which is why PipelineConfig
# refuses to start a run on one of these rather than warning.
#
# Derived from the prompt table rather than spelled "v1".."v5", so a
# future version that forgets the block is caught the same way and a
# future version that keeps it is not caught by mistake.
PROMPT_VERSIONS_WITHOUT_PROVENANCE: Final[frozenset[str]] = frozenset(
    version
    for version, (_, instructions) in _PROMPTS.items()
    if _PROVENANCE_HEADING not in instructions
)


def prompt_sha256(version: str = PROMPT_VERSION) -> str:
    """The rendered prompt's hash: what a run report records as the method's bytes.

    The version name alone stopped being enough the moment half the prompt
    moved into a data file: an edit to `disease/prompt.md` changes what the
    model is asked without changing the name the run publishes.
    """
    system, instructions = _PROMPTS[version]
    return hashlib.sha256(
        system.encode("utf-8") + b"\n\n" + instructions.encode("utf-8")
    ).hexdigest()


def paper_text_truncated(paper_text: str, max_chars: int) -> bool:
    """Whether `build_extraction_prompt` will cut this paper short.

    The run report names the papers the model read only part of, and it
    has to ask exactly the question the prompt builder answers or the two
    drift and the report goes quiet about a real loss.
    """
    return len(paper_text) > max_chars


def build_extraction_prompt(
    paper_text: str,
    pmid: str,
    max_chars: int,
    prompt_version: str = PROMPT_VERSION,
) -> ExtractionPrompt:
    """Build a provider-agnostic extraction prompt.

    The caller wraps the returned parts in its own wire format — for the
    one provider in this repo, Anthropic cache-controlled system blocks.

    An unrecognised `prompt_version` raises. It used to warn and fall back
    to v6, which cost no run and told no truth: every record of the run --
    report_metadata, the published run report, the checkpoint fingerprint
    -- carried the name that was asked for, so a typo published a prompt
    version that never existed as the method behind the rows. A real run
    cannot reach this branch, because PipelineConfig refuses both an
    unknown name and a recognised pre-provenance one before the run starts.
    """
    prompt_parts = _PROMPTS.get(prompt_version)
    if prompt_parts is None:
        raise ValueError(
            f"Unknown prompt version {prompt_version!r}; known versions are "
            f"{sorted(_PROMPTS)}."
        )

    system_prompt, extraction_instructions = prompt_parts

    if paper_text_truncated(paper_text, max_chars):
        logger.info(
            f"PMID {pmid}: truncating paper text from "
            f"{len(paper_text):,} to {max_chars:,} chars"
        )
        paper_text = paper_text[:max_chars]

    # No XML wrapper and no </document> escaping: the paper now travels in
    # a real document content block, so the API owns the boundary. This is
    # load-bearing for citations -- start_char_index/end_char_index index
    # into exactly these bytes, and a wrapper would shift every offset.
    # Prose first, then the tool call. Citations attach to text blocks
    # only -- a turn that goes straight to the tool emits no text and so
    # no citation spans, leaving every source_quote unverifiable. Asking
    # for the sentence in prose is what produces something to verify
    # against.
    abbreviation = load_disease().abbreviation
    task_instruction = (
        f"For each gene with a putative causal link to {abbreviation} in the document "
        "above, first state the supporting evidence in one sentence, quoting "
        "the sentence from the document that supports it. Then call "
        "report_genes with the structured result."
    )

    return ExtractionPrompt(
        system_prompt=system_prompt,
        extraction_instructions=extraction_instructions,
        document_text=paper_text,
        task_instruction=task_instruction,
    )
