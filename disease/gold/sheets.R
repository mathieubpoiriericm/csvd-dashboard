# The six supplementary tables. Each is assembled (records rebuilt, text
# cleaned, nothing split) before corrections, then finished (split, typed,
# references listed) after them.
suppressPackageStartupMessages({
  library(dplyr)
  library(tibble)
})

# ---- assembly --------------------------------------------------------------

# One record per row. A merged cell fills every row it spans (ST3's agents
# span all of their trials); read unexpanded, it would reach only its first
# row. The table remembers which rows each merged cell fills (attribute
# "merged"), so a correction to one of them reaches all of them.
build_rows <- function(sd) {
  t <- rows_to_table(sd$expanded, sd$header, sd$data_rows)
  attr(t, "merged") <- merged_groups(sd)
  t
}

merged_groups <- function(sd) {
  m <- sd$merges[sd$merges$last_row > sd$merges$first_row & sd$merges$first_row %in% sd$data_rows, ]
  named <- sd$header[!is.na(sd$header$name), ]
  bind_rows(
    tibble(column = character(), source_row = integer(), anchor_row = integer()),
    lapply(seq_len(nrow(m)), function(i) {
      columns <- named$name[named$col >= m$first_col[i] & named$col <= m$last_col[i]]
      rows <- seq.int(m$first_row[i], m$last_row[i])
      tibble(column = rep(columns, each = length(rows)), source_row = rep(rows, times = length(columns)),
             anchor_row = m$first_row[i])
    })
  )
}

# ST2: a method spans the rows of its merged column A; each pro and con is a
# bullet row of its own.
build_st2 <- function(sd) {
  t <- records_to_table(sd$vals, sd$header, sd$data_rows, key_col = 1, sep = "\n", merges = sd$merges)
  t$pros <- strip_bullets(t$pros)
  t$cons <- strip_bullets(t$cons)
  t
}

# ST4: a trial spans the rows of its merged column B; a continuation row
# holds the trial's "(NCT...)" in column A.
build_st4 <- function(sd) {
  records_to_table(sd$vals, sd$header, sd$data_rows, key_col = 2, sep = " ", merges = sd$merges)
}

# An error in reading or building a sheet names the sheet, since a cell
# address or a row number alone fits any of the six.
assemble_sheet <- function(path, spec) {
  in_sheet <- function(expr) {
    tryCatch(expr, error = function(e) {
      stop(sprintf("%s (%s): %s", spec$id, spec$sheet, conditionMessage(e)), call. = FALSE)
    })
  }
  sheet <- find_sheet(path, spec$sheet)
  sd <- in_sheet(read_sheet(path, sheet, spec$header_rows, spec$first_data_row))
  table <- in_sheet(spec$build(sd))
  found <- setdiff(names(table), c("source_row", "footnote_refs"))
  if (!identical(found, spec$columns)) {
    stop(sprintf("%s (%s): the columns changed.\n  expected: %s\n  found:    %s",
                 spec$id, spec$sheet, paste(spec$columns, collapse = ", "), paste(found, collapse = ", ")),
         call. = FALSE)
  }
  list(table = table, caption = spec$caption,
       footnotes = tibble(sheet = spec$id, number = sd$footnotes$number, text = sd$footnotes$text))
}

# ---- finishing -------------------------------------------------------------

EMPTY_REFERENCES <- tibble(sheet = character(), source_row = integer(), position = integer(),
                           kind = character(), id = character())

finished_parts <- function(table, references = NULL, suspects = NULL) {
  list(table = table, references = bind_rows(EMPTY_REFERENCES, references),
       suspects = bind_rows(empty_suspects(), suspects))
}

# A source value that should have parsed and did not. The suspect names the
# source column and value, so a correction or a keep row can target it.
unparsed <- function(sheet, table, column, parsed, what) {
  bad <- which(!is.na(table[[column]]) & is.na(parsed))
  suspect(sheet, table$source_row[bad], column, table[[column]][bad], "unparsed", paste("expected", what))
}

# A superscript anywhere in a sheet gives its table a footnote_refs column,
# which a finish that rebuilds the table must carry over.
carry_footnote_refs <- function(table, t) {
  if ("footnote_refs" %in% names(t)) table$footnote_refs <- t$footnote_refs
  table
}

finish_references <- function(id, column) {
  function(t) {
    r <- collect_references(id, t, column)
    finished_parts(r$table, r$references, r$suspects)
  }
}

finish_st2 <- function(t) {
  year <- parse_count(t$year)
  s <- unparsed("ST2", t, "year", year, "a year")
  t$year <- year
  r <- collect_references("ST2", t, "pmid")
  finished_parts(r$table, r$references, bind_rows(s, r$suspects))
}

finish_st3 <- function(t) {
  ev <- split_trailing_group(t$genetic_evidence_target)
  ok_ev <- ev$head %in% c("Yes", "No")
  genetic_evidence <- ifelse(ok_ev, ev$head, NA_character_)
  genetic_target <- ifelse(ok_ev, as_missing(ev$group), t$genetic_evidence_target)

  reg <- split_registry_ids(t$trial_name_id)
  one_id <- !is.na(reg$registry_ids) & !grepl(";", reg$registry_ids, fixed = TRUE)
  registry_id <- ifelse(one_id, reg$registry_ids, NA_character_)

  pop <- split_trailing_group(t$trial_population_target_n)
  target_n <- parse_count(pop$group)

  completion <- t$trial_estimated_completion
  estimated_completion <- to_month(completion)
  not_first <- which(!is.na(estimated_completion) & substr(completion, 9, 10) != "01")

  table <- tibble(
    source_row = t$source_row, agent = t$agent, mechanism_of_action = t$mechanism_of_action,
    genetic_evidence = genetic_evidence, genetic_target = genetic_target,
    trial_name = ifelse(one_id, reg$name, t$trial_name_id), registry_id = registry_id,
    trial_phase = t$trial_phase,
    population = ifelse(is.na(target_n), t$trial_population_target_n, pop$head), target_n = target_n,
    estimated_completion = estimated_completion,
    completion_note = ifelse(is.na(estimated_completion), completion, NA_character_),
    trial_primary_outcome = t$trial_primary_outcome, trial_sponsor_type = t$trial_sponsor_type
  ) |> carry_footnote_refs(t)
  finished_parts(table, suspects = bind_rows(
    unparsed("ST3", t, "genetic_evidence_target", genetic_evidence, "Yes or No (target)"),
    unparsed("ST3", t, "trial_name_id", registry_id, "a trial name and one registry id in brackets"),
    unparsed("ST3", t, "trial_population_target_n", target_n, "a population and its target N in brackets"),
    suspect("ST3", t$source_row[not_first], "trial_estimated_completion", completion[not_first],
            "date_not_first", "a completion date not on the 1st of the month")
  ))
}

finish_st4 <- function(t) {
  reg <- split_registry_ids(t$trial_id)
  size <- split_trailing_group(t$sample_size_inclusion_period)
  sample_size <- parse_count(size$head)
  table <- tibble(
    source_row = t$source_row, trial_name = reg$name, registry_ids = reg$registry_ids,
    footnote_refs = if ("footnote_refs" %in% names(t)) t$footnote_refs else NA_character_,
    sample_size = sample_size,
    inclusion_period = ifelse(is.na(sample_size), t$sample_size_inclusion_period, size$group),
    major_inclusion_criteria = t$major_inclusion_criteria,
    intervention_and_comparator = t$intervention_and_comparator,
    primary_outcome_follow_up = t$primary_outcome_follow_up, brain_mri_data = t$brain_mri_data,
    genetic_and_brain_mri_data_n = t$genetic_and_brain_mri_data_n
  )
  finished_parts(table, suspects = unparsed("ST4", t, "sample_size_inclusion_period", sample_size,
                                            "a sample size and its inclusion period in brackets"))
}

finish_st6 <- function(t) {
  n <- parse_count(t$n)
  beta_or <- parse_decimal(t$beta_or)
  ci <- split_ci(t$se_ic)
  p <- split_pvalue(t$pval)
  table <- tibble(
    source_row = t$source_row, pheno = t$pheno, names = t$names, full_name = t$full_name,
    type = t$type, platform = t$platform, origin = t$origin, n = n, study = t$study,
    population = t$population, ethnie = t$ethnie, methods = t$methods, beta_or = beta_or,
    se = ci$se, ci_low = ci$ci_low, ci_high = ci$ci_high,
    p_value = p$p_value, p_value_qualifier = p$p_value_qualifier,
    author_journal_year = t$author_journal_year, pmid = t$pmid
  ) |> carry_footnote_refs(t)
  r <- collect_references("ST6", table, "pmid")
  finished_parts(r$table, r$references, bind_rows(
    unparsed("ST6", t, "n", n, "a whole number"),
    unparsed("ST6", t, "beta_or", beta_or, "a number"),
    unparsed("ST6", t, "se_ic", ifelse(is.na(ci$se), ci$ci_low, ci$se),
             "a standard error or a confidence interval with its bounds in order"),
    unparsed("ST6", t, "pval", p$p_value, "a p-value"),
    r$suspects
  ))
}

finish_sheet <- function(spec, table) spec$finish(table)

# ---- the sheets ------------------------------------------------------------

# Each sheet starts with its column names in row 1 (ST3's span rows 1-2).
# The captions are the published ones: the workbook no longer holds them.
sheet_spec <- function(id, sheet, caption, columns, out, build, finish, header_rows = 1L, first_data_row = 2L) {
  list(id = id, sheet = sheet, caption = caption, header_rows = header_rows,
       first_data_row = first_data_row, columns = columns, out = out, build = build, finish = finish)
}

SHEETS <- list(
  ST1 = sheet_spec("ST1", "SupplementaryTable1",
    "Supplementary Table 1: Putative causal genes and proteins associated with cSVD traits", c(
    "tier", "protein", "gene", "chr_location", "gwas_trait", "proteomic_trait",
    "ngs_rare_deleterious_or_protective_variant", "proteogenomics_mr", "other_omics",
    "other_incl_experimental", "monogenic", "brain_cell_types_mice", "brain_cell_types_human",
    "pathway_goa_function", "gps_druggability_score_drug_ses", "drug_repositioning_candidate",
    "references"
  ), "st1_genes.csv", build_rows, finish_references("ST1", "references")),
  ST2 = sheet_spec("ST2", "SupplementaryTable2", paste(
    "Supplementary Table 2: Examples of human genetics-supported approaches to identify drug targets",
    "and evidence for drug repositioning"), c(
    "method", "description", "year", "pmid", "pros", "cons"
  ), "st2_methods.csv", build_st2, finish_st2),
  ST3 = sheet_spec("ST3", "SupplementaryTable3", paste(
    "Supplementary Table 3: Planned or ongoing phase I-III randomized controlled trials examining the",
    "effect of pharmacological interventions in people with cSVD"), c(
    "agent", "mechanism_of_action", "genetic_evidence_target", "trial_name_id", "trial_phase",
    "trial_population_target_n", "trial_estimated_completion", "trial_primary_outcome",
    "trial_sponsor_type"
  ), "st3_trials.csv", build_rows, finish_st3, header_rows = 1:2, first_data_row = 3L),
  ST4 = sheet_spec("ST4", "SupplementaryTable4", paste(
    "Supplementary Table 4: Examples of randomised controlled trials for the prevention of",
    "cSVD-related phenotypes with brain MRI and genetics data"), c(
    "trial_id", "sample_size_inclusion_period", "major_inclusion_criteria",
    "intervention_and_comparator", "primary_outcome_follow_up", "brain_mri_data",
    "genetic_and_brain_mri_data_n"
  ), "st4_rcts.csv", build_st4, finish_st4),
  ST5 = sheet_spec("ST5", "SupplementaryTable5",
    "Supplementary Table 5: Genomics-driven drug repositioning candidates for cSVD, methods and original indications", c(
    "gene_target", "phenotype", "method", "directionality", "drug_repositioning_candidate",
    "other_indications", "references"
  ), "st5_repositioning.csv", build_rows, finish_references("ST5", "references")),
  ST6 = sheet_spec("ST6", "SupplementaryTable6",
    "Supplementary Table 6: Putative biomarkers of cSVD derived from agnostic multiomics analyses", c(
    "pheno", "names", "full_name", "type", "platform", "origin", "n", "study", "population",
    "ethnie", "methods", "beta_or", "se_ic", "pval", "author_journal_year", "pmid"
  ), "st6_biomarkers.csv", build_rows, finish_st6)
)
