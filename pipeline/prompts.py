"""Prompt definitions for LLM-based gene extraction.

Separates prompt engineering from API call logic so prompts can be
iterated on without touching extraction code.

v6 is the only prompt. v1-v3 were the pre-provenance lineage and v6
contains v5 verbatim, so none of them said anything v6 does not.

v4 was kept for a while because v6 is *not* a superset of it: v5 loosened
two of v4's exclusion guards, accepting "even a single mention as an MTAG
locus label" where v4 required the gene to be nearest at the MTAG-specific
locus, and narrowing "positional candidates do NOT qualify" to
*single-phenotype* positional candidates. The suspicion was that those
relaxations caused the over-extraction the harness sees -- 47 genes
against 17 curated rows on PMID 37069360.

Measured, and they do not. Recording both arms over the same ten fixtures
gave identical pooled recall (42/46) while the *stricter* arm returned
more genes, not fewer (144 against 138), and the genes it added were LOC
identifiers and an antisense RNA. The guards are ruled out rather than
assumed, so v4 is gone with them.

PROMPT_VERSIONS_WITHOUT_PROVENANCE still derives from the table and is now
empty -- the machinery stays, because a future version that forgets the
provenance block has to be caught the same way.
"""

import logging
from dataclasses import dataclass
from typing import Final

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


# One system prompt, shared by every surviving version: v4, v5 and v6 all
# aliased v3's literal, so the chain of aliases said nothing the name does
# not.
_SYSTEM_PROMPT: Final[str] = (
    "You are a systematic reviewer specializing in cerebral small vessel disease "
    "(cSVD) genetics. You maintain a curated database of genes with putative "
    "causal links to cSVD, identified through GWAS, MAGMA gene-based tests, "
    "multi-trait GWAS (MTAG), multi-omics studies (TWAS, PWAS, EWAS, proteomics), "
    "Mendelian randomization, colocalization, fine-mapping, proteogenomics/pQTL-MR, "
    "WES/WGS rare variant burden tests, cell-type enrichment analyses, "
    "multi-ancestry GWAS, and functional validation. You are rigorous about "
    "distinguishing causal evidence from mere association or incidental mention. "
    "You carefully distinguish cSVD-specific evidence (small vessel stroke, WMH, "
    "lacunes, PVS, microbleeds) from general stroke or neurodegeneration findings. "
    "You understand that GWAS identifies genomic loci, not individual genes. "
    "A gene's physical proximity to a lead SNP does NOT constitute gene-level "
    "evidence. You require gene-specific statistical tests (gene-based tests, "
    "TWAS, colocalization, fine-mapping, coding variants) to implicate individual "
    "genes at multi-gene loci."
)

# ---------------------------------------------------------------------------
# V6 prompt (multi-phenotype convergence, MTAG locus scanning, and provenance)
# ---------------------------------------------------------------------------

_EXTRACTION_INSTRUCTIONS_V6: Final[str] = """\
<instructions>
<task>
Extract all genes with putative causal links to cerebral small vessel disease (cSVD) from the research paper provided.
</task>

<inclusion_criteria>
Include a gene when the paper presents ANY evidence suggesting a putative causal relationship with cSVD or cSVD-related phenotypes. Putative causal evidence includes: GWAS associations, MAGMA gene-based tests, multi-trait GWAS (MTAG), fine-mapping, colocalization, Mendelian randomization, pQTL-MR/proteogenomics, WES/WGS rare variant burden tests, cell-type enrichment analyses, multi-ancestry GWAS, polygenic risk scores (PRS), functional studies, expression QTLs, animal/cell models, or any mechanistic evidence linking the gene to cSVD pathology.

Primary cSVD phenotypes:
- WMH (white matter hyperintensities)
- DWMH (deep WMH), PVWMH (periventricular WMH)
- SVS (small vessel stroke)
- Lacunar stroke / lacunar infarcts / lacunes
- BG-PVS, WM-PVS, HIP-PVS (perivascular spaces)
- Cerebral microbleeds
- ICH-lobar (lobar intracerebral hemorrhage), ICH-non-lobar (non-lobar intracerebral hemorrhage)
- PSMD (peak width of skeletonized mean diffusivity)
- MD (mean diffusivity)
- FA (fractional anisotropy)
- DTI-ALPS (glymphatic function marker)
- ICVF (neurite density), ISOVF (free-water volume fraction), OD (orientation dispersion) — NODDI metrics
- WMH-cortical-atrophy (WMH-associated cortical atrophy)

Secondary cSVD-related phenotypes:
- Retinal vessel phenotypes (retinal-vessels: tortuosity, caliber)
- WM-BAG (white matter brain age gap)

CRITICAL: Physical proximity to a GWAS lead SNP is NOT sufficient for inclusion. A gene must have INDIVIDUAL-LEVEL statistical evidence linking it to a cSVD phenotype. Being listed as a positional candidate gene, or being the nearest gene to a significant SNP, does NOT meet the inclusion criteria unless the paper also reports gene-based test results (MAGMA, TWAS, PWAS, EWAS, colocalization, fine-mapping, or coding variant analysis) for that specific gene.
</inclusion_criteria>

<extraction_strategy>
When analyzing the paper:
1. Identify all passages that mention specific genes in the context of cSVD causality.
2. Verify that each gene was tested in a cSVD-specific analysis (SVS, WMH, lacunes, PVS, microbleeds, or another cSVD phenotype) — not just general stroke, cardioembolic stroke, or large-artery stroke.
3. Distinguish genes with individual statistical evidence (GWAS hit, gene-based significance, MR result) from genes mentioned only as positional candidates at a GWAS locus or as members of enriched pathways. Positional candidacy means the gene is listed because it is near the lead SNP but has NO gene-specific test result. Do NOT extract positional-only candidates. Only extract pathway-only genes if the paper explicitly discusses their individual role.
4. For well-known monogenic cSVD genes (NOTCH3, COL4A1, COL4A2, HTRA1, TREX1, GLA), only extract if the paper presents NEW data — new statistical association, new functional evidence, or new population-level variant analysis. Do NOT extract these genes from background sentences like "CADASIL is caused by NOTCH3 mutations."
5. At multi-gene loci, ONLY extract genes for which the paper reports individual gene-level evidence (gene-based p-value, TWAS/PWAS/EWAS result, coding variant, colocalization, or fine-mapping). Do NOT extract all positional candidates at a locus simply because the locus is significant.
6. When a TWAS, colocalization, or fine-mapping analysis identifies a specific causal gene at a GWAS locus, use THAT gene's symbol as the gene_symbol — not the positional locus name or the nearest gene to the lead SNP. For example, if a locus is labeled by LINC01600 in the locus table but TWAS identifies C6orf195 as the causal gene, extract C6orf195.
7. Parse for negative results ("did not support," "no association," "failed to replicate"). If a gene was tested and found not associated, assign confidence 0 and note the negative result.
8. Distinguish MR-exposure genes (e.g., "genetically proxied ACE inhibition reduces WMH") from genes with direct cSVD genetic association. Flag MR-only evidence in the causal_evidence_summary.
9. Map animal model gene nomenclature to human HGNC symbols (e.g., mouse Trim47 → TRIM47, zebrafish col4a1 → COL4A1).
10. For PVS (perivascular space) GWAS studies: PVS GWAS loci often contain many genes, and papers commonly list all positional candidates in supplementary tables. Apply extra scrutiny: only extract genes with gene-based test results or functional follow-up, not genes that only appear in locus/positional candidate tables.
11. Before classifying a gene as positional-only, check ALL omics analyses reported in the paper — including EWAS (epigenome-wide association), methylation analyses, and extreme-phenotype analyses. A gene that appears in an EWAS analysis has individual gene-level evidence and is NOT a positional candidate.
12. MULTI-PHENOTYPE CONVERGENCE: If a gene is listed as the nearest gene at GWAS loci for >=2 INDEPENDENT cSVD phenotypes (e.g., both WM-PVS and HIP-PVS, or WMH and SVS), this cross-phenotype convergence constitutes gene-level evidence. Do NOT treat multi-phenotype genes as positional-only candidates. Cross-phenotype replication at the same gene is unlikely coincidental.
13. MTAG LOCUS SCANNING: Carefully scan MTAG results paragraphs for gene names mentioned as locus labels. Even a single brief mention like "at GENE1 (phenotype)" constitutes gene-level evidence. Pay attention to dense results paragraphs listing many loci — do not skip briefly mentioned genes.
</extraction_strategy>

<field_guidance>
For each gene, record the following:
- gene_symbol: Official HGNC gene symbol (human). Convert animal model nomenclature to human orthologs.
- gwas_trait: Use ONLY these canonical abbreviations: WMH, DWMH, PVWMH, SVS, BG-PVS, WM-PVS, HIP-PVS, PSMD, MD, FA, extreme-cSVD, lacunes, stroke, cerebral-microbleeds, ICH-lobar, ICH-non-lobar, DTI-ALPS, ICVF, ISOVF, OD, WMH-cortical-atrophy, WM-BAG, retinal-vessels. Do not use full phenotype names.
- mendelian_randomization: Set to true only if the paper presents MR evidence for this gene. In causal_evidence_summary, distinguish whether the gene is an MR exposure (drug target) vs. a direct cSVD-associated gene.
- omics_evidence: Type of omics/analytical study. Use labels such as: "TWAS", "PWAS", "EWAS", "colocalization", "MAGMA", "MTAG", "pQTL-MR", "WES/WGS", "cell-type enrichment", "scRNA-seq annotation", "PRS", "fine-mapping".
- confidence: A score from 0.0 to 1.0 (see scoring rubric below).
- causal_evidence_summary: 1-3 sentences explaining WHY the paper considers this gene causally linked. Note stroke-subtype specificity (cSVD-specific vs. general stroke). For MR evidence, clarify whether the gene is a direct association or an exposure/drug target.
</field_guidance>

<confidence_scoring>
IMPORTANT: Use the FULL 0.0-1.0 range. Do NOT cluster scores at 0.50. A gene with genome-wide significant GWAS association for a cSVD phenotype should score at LEAST 0.60 even without additional support. With TWAS and/or colocalization, score 0.70-0.80.

IMPORTANT: Before assigning any confidence score above 0.50, verify that the gene has at least ONE of: (a) genome-wide significant gene-based test, (b) significant TWAS/PWAS/EWAS, (c) significant colocalization/SMR, (d) fine-mapping to credible set, (e) coding variant in LD, (f) functional validation. Without any of these, the maximum score is 0.30.

Positional candidate penalty: If the only basis for a gene is its position at a GWAS locus (listed in a locus table, nearest gene), apply a hard cap of 0.20 regardless of the locus's p-value.

Multi-phenotype convergence exception: If a gene appears as the nearest gene at GWAS loci for >=2 INDEPENDENT cSVD phenotypes (different phenotype categories, not subgroups like WMH/DWMH), do NOT apply the positional candidate hard cap of 0.20. Instead, assign a minimum confidence of 0.60.

Eight-tier rubric:

- 1.0: Validated causal — established monogenic cause with understood mechanism (e.g., NOTCH3, COL4A1/COL4A2, HTRA1) OR GWAS significance + fine-mapping to credible set of ≤5 variants + functional validation in a cSVD-relevant cell type (brain endothelial, pericyte, VSMC).
- 0.8-0.9: Strong multi-modal convergence — GWAS significance for a cSVD-specific phenotype + eQTL/pQTL colocalization in relevant tissue + at least one supporting line (coding variant, animal model, rare variant burden, or drug target confirmation).
- 0.7-0.8: GWAS significance for a cSVD phenotype + at least ONE supporting line of evidence (TWAS, colocalization, MAGMA gene-based test, coding variant in LD, MTAG cross-trait support). This is the expected tier for novel GWAS loci reported with standard follow-up analyses.
- 0.6-0.7: The gene ITSELF has individual genome-wide significance (gene-based test, TWAS, sole gene at a locus) for a cSVD phenotype with no additional supporting evidence. Also applies to: MTAG-only findings; and genes with cross-phenotype convergence (nearest gene at GWAS loci for >=2 independent phenotypes). MTAG reaching genome-wide significance IS gene-level evidence — even a single mention as an MTAG locus label is sufficient. NOTE: single-phenotype positional candidates do NOT qualify for this tier.
- 0.4-0.5: Indirect or suggestive — pathway analysis gene only (enriched gene set member, no individual significance); pQTL-MR evidence without direct genetic association; general stroke GWAS gene without cSVD-specific evidence; or animal model findings without human genetic support. pQTL-MR with cis instruments scores at the high end (0.5).
- 0.2-0.3: Weak or contextual — genetic correlation only; unreplicated candidate gene study; pre-GWAS era association; protein interaction network member without direct evidence.
- 0.1-0.2: Positional candidate only — gene is listed at a GWAS locus because of physical proximity to the lead SNP, but has NO individual gene-level statistical test. DO NOT assign scores of 0.4 or higher to positional-only candidates.
- 0.0: Negative or tangential — gene tested and found not associated; background citation only; covariate mention; general context sentence with no causal evidence.

Cross-cutting modifiers:
- Stroke-specificity penalty: Apply −0.1 to −0.2 for genes from general stroke GWAS without SVS/WMH/cSVD-specific replication.
- Monogenic-to-sporadic: When a known monogenic cSVD gene (NOTCH3, COL4A1/A2, HTRA1) has NEW common-variant evidence, score the new evidence independently of monogenic status.
</confidence_scoring>

<examples>
<example type="include_validated">
Paper states: "GWAS identified TRIM47 at 17q25 as significantly associated with WMH volume. SMR/HEIDI colocalization confirmed TRIM47 as the causal gene. siRNA knockdown in brain endothelial cells increased permeability. Trim47-deficient mice show BBB dysfunction and cognitive impairment via the KEAP1-NRF2 pathway, rescued by the NRF2 activator tBHQ."
Result: gene_symbol="TRIM47", gwas_trait=["WMH"], omics_evidence=["TWAS", "colocalization"], confidence=1.0
Reasoning: Full GWAS → eQTL → functional → animal model → therapeutic target chain = validated causal.
</example>

<example type="include_high_confidence">
Paper states: "Rare COL4A1 mutations cause Gould syndrome with cSVD features. At 13q34, common variants reach genome-wide significance for WMH, non-lobar ICH, and SVS. The rs9515201 variant is a cis-eQTL for both COL4A1 and COL4A2 in brain putamen."
Result: gene_symbol="COL4A1", gwas_trait=["WMH", "ICH-non-lobar", "SVS"], confidence=0.95; also gene_symbol="COL4A2", gwas_trait=["WMH", "ICH-non-lobar", "SVS"], confidence=0.95
Reasoning: Monogenic + common-variant GWAS for multiple cSVD traits. Both genes at the locus extracted with per-gene evidence.
</example>

<example type="include_strong_functional">
Paper states: "Endothelial-specific Foxf2 deletion in mice causes BBB leakage and impaired functional hyperemia. Multi-omic analysis identified FOXF2 as a transcriptional activator of Tie2/TEK signaling. A Tie2 agonist rescued all phenotypes. FOXF2 was previously identified in GWAS for SVS and WMH."
Result: gene_symbol="FOXF2", gwas_trait=["SVS", "WMH"], confidence=0.9
Reasoning: GWAS + comprehensive functional validation with therapeutic rescue in cSVD-relevant cell type.
NOTE: FOXF2 scores 0.9 here because THIS paper presents new functional data (animal model, multi-omic analysis, therapeutic rescue). A different paper that merely cites FOXF2 as a prior GWAS finding without presenting new data should NOT extract FOXF2 — that would be a background citation (confidence 0.0).
</example>

<example type="include_gwas_with_twas">
Paper states: "At the 2q33 locus, rs12476527 reached genome-wide significance for WMH (p = 3.2e-11). TWAS identified NBEAL1 as the most likely causal gene at this locus (TWAS p = 1.4e-6). MAGMA gene-based analysis also implicated NBEAL1 (p = 8.7e-5)."
Result: gene_symbol="NBEAL1", gwas_trait=["WMH"], omics_evidence=["TWAS", "MAGMA"], confidence=0.75
Reasoning: GWAS genome-wide significance + TWAS + MAGMA = multiple supporting lines. Score in the 0.7-0.8 tier.
</example>

<example type="include_gwas_alone">
Paper states: "We identified a novel locus at 10q24 reaching genome-wide significance for SVS (lead SNP rs12345678, p = 4.1e-9). The nearest gene is EXAMPLE1, though no eQTL or functional data are available."
Result: gene_symbol="EXAMPLE1", gwas_trait=["SVS"], confidence=0.65
Reasoning: GWAS genome-wide significance alone without additional support. Score in the 0.6-0.7 tier.
</example>

<example type="include_multi_phenotype">
Paper states: "At the 1q41 locus, CENPF is the nearest gene with p=2.23e-10 for WM-PVS and p=1.38e-09 for HIP-PVS. No TWAS or colocalization results were available for this gene."
Result: gene_symbol="CENPF", gwas_trait=["WM-PVS", "HIP-PVS"], confidence=0.65
Reasoning: Cross-phenotype convergence across 2 independent phenotypes is gene-level evidence. Score in the 0.6-0.7 tier.
</example>

<example type="include_mtag_locus">
Paper states: "Six loci showed greater significance in MTAG than with PVS alone: at VWA2 (WM-PVS), SLC13A3 (WM-PVS), GFAP (WM-PVS)..."
Result: gene_symbol="VWA2", gwas_trait=["WM-PVS"], omics_evidence=["MTAG"], confidence=0.60
Reasoning: Named as an MTAG locus reaching genome-wide significance. MTAG significance IS gene-level evidence. Score at bottom of the 0.6-0.7 tier.
</example>

<example type="include_twas_causal_gene">
Paper states: "At the WM-PVS locus 6p25.2, the lead SNP is near LINC01600. TWAS analysis identified C6orf195 as transcriptome-wide significant (p = 2.8e-6) with colocalization PP4 > 0.75."
Result: gene_symbol="C6orf195", gwas_trait=["WM-PVS"], omics_evidence=["TWAS", "colocalization"], confidence=0.75
Do NOT extract LINC01600 — it is the positional locus label, not the causal gene identified by TWAS/colocalization.
</example>

<example type="exclude_positional_candidate">
Paper states: "At the WM-PVS locus on chromosome 1q25, we identified 8 positional candidate genes: LAMC1, EFEMP1, LPAR1, ITGB5, RGL1, CACNA1E, NOS1AP, and KCNT2. TWAS analysis identified ITGB5 as the only gene with significant brain expression association (p = 3.1e-7)."
Extract ONLY ITGB5 (with TWAS evidence). Do NOT extract LAMC1, EFEMP1, LPAR1, RGL1, CACNA1E, NOS1AP, or KCNT2 — these are positional-only candidates with no individual gene-level evidence. Being listed in a locus table is NOT sufficient.
</example>

<example type="exclude_prior_literature_gene">
Paper states: "FOXF2 has been previously implicated in SVS through GWAS (Chauhan et al., 2019). SLC20A2 is a known cause of familial brain calcification. WNT7A has been linked to blood-brain barrier development."
Do NOT extract FOXF2, SLC20A2, or WNT7A: These are citations of prior literature findings. This paper does not present new statistical or functional data for these genes.
</example>

<example type="include_orf_gene">
Paper states: "TWAS analysis identified C6orf195 as significantly associated with BG-PVS volume in brain cortex (p = 2.8e-6). C6orf195 encodes a protein of unknown function expressed in brain pericytes."
Result: gene_symbol="C6orf195", gwas_trait=["BG-PVS"], omics_evidence=["TWAS"], confidence=0.70
Reasoning: Significant TWAS result provides gene-level evidence. ORF-style gene names (C6orf195, LINC genes, LOC genes) are valid HGNC symbols — do not skip them because the name looks unusual.
</example>

<example type="exclude_general_stroke">
Paper states: "PITX2 and ZFHX3 reached genome-wide significance for cardioembolic stroke in MEGASTROKE. We included these in our comparison of stroke subtypes."
Do NOT extract: PITX2 and ZFHX3 are cardioembolic-specific. No evidence for SVS, WMH, or any cSVD phenotype.
</example>

<example type="exclude_pathway_only">
Paper states: "Gene set enrichment analysis identified the extracellular matrix pathway (GO:0031012) as significantly enriched among our GWAS hits. This set includes 47 genes including FBN1, LAMA2, and COL6A3."
Do NOT extract FBN1, LAMA2, COL6A3: These genes are mentioned only as members of an enriched pathway. No individual-level statistical significance or causal evidence is presented for these specific genes.
</example>

<example type="include_low_confidence_pqtl_mr">
Paper states: "pQTL-MR analysis using cis instruments identified TFPI as a causal protein for WMH volume (p = 2.3e-6). No direct GWAS association was found at the TFPI locus."
Result: gene_symbol="TFPI", gwas_trait=["WMH"], mendelian_randomization=true, omics_evidence=["pQTL-MR"], confidence=0.5
Reasoning: pQTL-MR with cis instruments provides gene-level evidence, but no direct GWAS association. Flag as MR-exposure/drug target in summary.
</example>

<example type="exclude_background_monogenic">
Paper states: "CADASIL, caused by NOTCH3 mutations, is the most common monogenic form of cSVD. In our GWAS of WMH volume, we identified 20 novel loci."
Do NOT extract NOTCH3: This is a background citation of a known monogenic gene. The paper does not present new NOTCH3 data. Only extract the novel GWAS loci with their specific evidence.
</example>
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

_PROMPTS: Final[dict[str, tuple[str, str]]] = {
    "v6": (_SYSTEM_PROMPT, _EXTRACTION_INSTRUCTIONS_V6),
}


_PROVENANCE_HEADING: Final[str] = "## Provenance"

# Every prompt version this module can build. PipelineConfig refuses a name
# that is not in here, because the name travels into the run report, the
# database record and the checkpoint fingerprint as the method the rows
# were extracted with.
PROMPT_VERSIONS: Final[frozenset[str]] = frozenset(_PROMPTS)

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
    prompt_version: str = "v6",
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
    unknown name and a recognised pre-v6 one before the run starts.
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
    task_instruction = (
        "For each gene with a putative causal link to cSVD in the document "
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
