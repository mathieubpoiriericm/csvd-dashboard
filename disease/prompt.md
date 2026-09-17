# Disease sections of the extraction prompt

Rendered into the v7 template in `pipeline/prompts.py`. Each `## id` is one
slot; the body is the text between headings with surrounding blank lines
stripped. `disease.name` and `disease.abbreviation` come from manifest.json.
tests/pipeline/test_prompt_assembly.py pins the cSVD rendering to the v6 bytes.

## persona.specificity

You carefully distinguish cSVD-specific evidence (small vessel stroke, WMH, lacunes, PVS, microbleeds) from general stroke or neurodegeneration findings.

## criteria.phenotypes

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

## strategy.phenotype_shortlist

SVS, WMH, lacunes, PVS, microbleeds

## strategy.neighbouring_conditions

general stroke, cardioembolic stroke, or large-artery stroke

## strategy.monogenic_genes

NOTCH3, COL4A1, COL4A2, HTRA1, TREX1, GLA

## strategy.background_example

CADASIL is caused by NOTCH3 mutations.

## strategy.causal_gene_example

For example, if a locus is labeled by LINC01600 in the locus table but TWAS identifies C6orf195 as the causal gene, extract C6orf195.

## strategy.mr_example

genetically proxied ACE inhibition reduces WMH

## strategy.ortholog_example

mouse Trim47 → TRIM47, zebrafish col4a1 → COL4A1

## strategy.disease_steps

For PVS (perivascular space) GWAS studies: PVS GWAS loci often contain many genes, and papers commonly list all positional candidates in supplementary tables. Apply extra scrutiny: only extract genes with gene-based test results or functional follow-up, not genes that only appear in locus/positional candidate tables.

## strategy.convergence_example

both WM-PVS and HIP-PVS, or WMH and SVS

## traits.canonical

WMH, DWMH, PVWMH, SVS, BG-PVS, WM-PVS, HIP-PVS, PSMD, MD, FA, extreme-cSVD, lacunes, stroke, cerebral-microbleeds, ICH-lobar, ICH-non-lobar, DTI-ALPS, ICVF, ISOVF, OD, WMH-cortical-atrophy, WM-BAG, retinal-vessels

## guidance.specificity_note

Note stroke-subtype specificity (cSVD-specific vs. general stroke).

## rubric.subgroup_example

WMH/DWMH

## rubric.monogenic_examples

NOTCH3, COL4A1/COL4A2, HTRA1

## rubric.cell_types

brain endothelial, pericyte, VSMC

## rubric.neighbour_gwas_gene

general stroke GWAS gene without cSVD-specific evidence

## rubric.modifiers

- Stroke-specificity penalty: Apply −0.1 to −0.2 for genes from general stroke GWAS without SVS/WMH/cSVD-specific replication.
- Monogenic-to-sporadic: When a known monogenic cSVD gene (NOTCH3, COL4A1/A2, HTRA1) has NEW common-variant evidence, score the new evidence independently of monogenic status.

## examples

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
