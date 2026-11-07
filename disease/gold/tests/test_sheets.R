st3_row <- function(...) {
  t <- tibble::tibble(
    source_row = 3L, agent = "Cilostazol", mechanism_of_action = "Antiplatelet", genetic_evidence_target = "No",
    trial_name_id = "LACI-3 (ISRCTN44436843)", trial_phase = "3", trial_population_target_n = "Lacunar stroke (1,300)",
    trial_estimated_completion = "2028-12-01", trial_primary_outcome = "Recurrent stroke", trial_sponsor_type = "Academic"
  )
  args <- list(...)
  t[names(args)] <- args
  t
}

st6_row <- function(...) {
  t <- tibble::as_tibble(as.list(stats::setNames(rep(NA_character_, length(SHEETS$ST6$columns)), SHEETS$ST6$columns)))
  t <- tibble::add_column(t, source_row = 2L, .before = 1)
  t$names <- "IL6"
  t$pmid <- "37069360"
  args <- list(...)
  t[names(args)] <- args
  t
}

test_that("finishing ST3 and ST6 keeps the superscripts' footnote_refs", {
  expect_equal(finish_st3(st3_row(footnote_refs = "1"))$table$footnote_refs, "1")
  expect_equal(finish_st6(st6_row(footnote_refs = "2"))$table$footnote_refs, "2")
  expect_false("footnote_refs" %in% names(finish_st3(st3_row())$table))
  expect_false("footnote_refs" %in% names(finish_st6(st6_row())$table))
})

test_that("a row-per-record sheet fills a merged cell down and remembers the rows it fills", {
  vals <- tibble::tibble(row = c(1L, 1L, 2L, 2L, 3L), col = c(1L, 2L, 1L, 2L, 2L),
                         value = c("Pheno", "Names", "WMH", "IL6", "TFPI"), sup = NA_character_)
  vals$full <- vals$value
  merges <- tibble::tibble(first_row = 2L, first_col = 1L, last_row = 3L, last_col = 1L)
  sd <- list(vals = vals, expanded = expand_merges(vals, merges), merges = merges,
             header = header_names(vals, 1L), data_rows = 2:3)
  t <- build_rows(sd)
  expect_equal(t$pheno, c("WMH", "WMH"))
  expect_equal(attr(t, "merged")$source_row, 2:3)
})
