# These read the real workbook; each one skips when it is absent.
COUNTS <- c(ST1 = 115, ST2 = 10, ST3 = 16, ST4 = 11, ST5 = 14, ST6 = 1945)

test_that("every sheet assembles to its expected rows and columns", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  for (id in names(SHEETS)) {
    a <- assemble_sheet(XLSX, SHEETS[[id]])
    expect_equal(nrow(a$table), COUNTS[[id]], info = id)
    expect_equal(setdiff(names(a$table), c("source_row", "footnote_refs")), SHEETS[[id]]$columns, info = id)
  }
})

test_that("records are rebuilt from merged and continuation rows", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  st4 <- assemble_sheet(XLSX, SHEETS$ST4)$table
  expect_equal(st4$trial_id[st4$source_row == 4], "ASPREE (NCT01038583)")
  expect_equal(st4$footnote_refs[st4$source_row == 2], "1-4")
  expect_equal(st4$footnote_refs[st4$source_row == 16], "19-21")
  st2 <- assemble_sheet(XLSX, SHEETS$ST2)$table
  expect_equal(st2$cons[1], "Scoring framework is semi-subjective")
  expect_length(strsplit(st2$pros[1], "\n")[[1]], 4)
  expect_false(any(grepl("\u{00b7}", c(st2$pros, st2$cons))))
  st3 <- assemble_sheet(XLSX, SHEETS$ST3)$table
  expect_equal(st3$agent[st3$source_row == 7], "Cilostazol")
  expect_equal(sum(st3$trial_name_id == "LACI-3 (ISRCTN44436843)"), 2)
})

test_that("footnotes and header legends are kept", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  f4 <- assemble_sheet(XLSX, SHEETS$ST4)$footnotes
  expect_equal(f4$number[!is.na(f4$number)], 1:24)
  expect_equal(unique(f4$sheet), "ST4")
  f5 <- assemble_sheet(XLSX, SHEETS$ST5)$footnotes
  expect_true("Other indications (*approved; \u{2020}in trial)" %in% f5$text)
})

# ST1's cell-type footnote and its reference list were removed from the
# workbook once their PMIDs had been added to every row's References.
test_that("ST1 keeps only its header legend below the table, and its caption", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  a <- assemble_sheet(XLSX, SHEETS$ST1)
  expect_equal(a$footnotes$text, "Other omics (*significant colocalization)")
  expect_equal(a$caption, "Supplementary Table 1: Putative causal genes and proteins associated with cSVD traits")
})

finished <- function(id) finish_sheet(SHEETS[[id]], assemble_sheet(XLSX, SHEETS[[id]])$table)

test_that("ST3 splits trials, populations, evidence and dates", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  t <- finished("ST3")$table
  r5 <- t[t$source_row == 3, ]
  expect_equal(r5$registry_id, "ChiCTR2500109773")
  expect_equal(r5$population, "Acute lacunar stroke")
  expect_equal(r5$target_n, 3156L)
  expect_equal(r5$estimated_completion, "2028-07")
  expect_equal(r5$genetic_evidence, "No")
  expect_true(is.na(r5$genetic_target))
  expect_equal(t$completion_note[t$source_row == 16], "Completed")
  expect_equal(t$genetic_target[t$source_row == 5], "GWAS for ischemic stroke: PDE3A")
  expect_equal(t$trial_name[t$source_row == 10], "TASTE-SVD (testing edaravone dexborneol)")
  expect_equal(names(t), c(
    "source_row", "agent", "mechanism_of_action", "genetic_evidence", "genetic_target", "trial_name",
    "registry_id", "trial_phase", "population", "target_n", "estimated_completion", "completion_note",
    "trial_primary_outcome", "trial_sponsor_type"
  ))
})

test_that("ST4 separates names, registry ids, footnotes and sample sizes", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  t <- finished("ST4")$table
  expect_equal(unlist(t[t$source_row == 2, c("trial_name", "registry_ids", "footnote_refs")], use.names = FALSE),
               c("ACCORD", "NCT00000620", "1-4"))
  expect_equal(t$trial_name[t$source_row == 16], "SPS3")
  expect_equal(t$registry_ids[t$source_row == 7], "NCT02484547; NCT02477800")
  expect_equal(t$sample_size[t$source_row == 9], 820L)
  expect_equal(t$inclusion_period[t$source_row == 9], "ongoing")
})

test_that("ST6 parses counts, intervals and p-values", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  f <- finished("ST6")
  t <- f$table
  expect_true(6581L %in% t$n)
  expect_equal(t$p_value[t$source_row == 52], 0.001)
  expect_equal(t$p_value_qualifier[t$source_row == 52], "<")
  expect_equal(c(t$ci_low[t$source_row == 3], t$ci_high[t$source_row == 3]), c(-0.33, -0.09))
  expect_true(any(f$suspects$rule == "unparsed" & f$suspects$source_row == 211 & f$suspects$column == "se_ic"))
  expect_equal(nrow(f$references), 1945)
})

test_that("ST1 references are split, cleaned and deduplicated", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  f <- finished("ST1")
  lpar1 <- f$table$source_row[f$table$gene == "LPAR1"]
  # The nine PMIDs of the cell-type footnote's references close every row.
  cell_types <- c("37231261", "38868715", "35084939", "35165441", "38987604",
                  "35158371", "37824663", "29443965", "30129931")
  expect_equal(f$table$references[f$table$gene == "LPAR1"],
               paste(c("37069360", "39805841", cell_types), collapse = "; "))
  ends <- vapply(split(f$references$id, f$references$source_row), function(ids) identical(tail(ids, 9), cell_types), TRUE)
  expect_equal(sum(ends), 115)
  expect_true(any(f$suspects$rule == "duplicate_reference" & f$suspects$source_row == lpar1))
  expect_equal(sort(unique(f$references$kind)), c("doi", "pmid"))
})

test_that("ST2 and ST5 are typed and their references listed", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  f2 <- finished("ST2")
  expect_type(f2$table$year, "integer")
  expect_equal(nrow(f2$references), 10)
  f5 <- finished("ST5")
  expect_equal(f5$table$references[f5$table$gene_target %in% "SERPIND1"], "41266628; 37069360")
  expect_true(is.na(f5$table$gene_target[f5$table$source_row == 15]))
})

run_empty <- function() {
  corr <- tempfile(fileext = ".csv")
  writeLines("sheet,column,source_row,row_fingerprint,old,new,reason", corr)
  run_cleaning(XLSX, corr)
}

test_that("no output cell carries whitespace noise or a missing marker", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  r <- run_empty()
  for (t in c(r$tables, list(r$references, r$footnotes))) {
    chr <- unlist(lapply(t[vapply(t, is.character, TRUE)], na.omit))
    expect_false(any(grepl("^\\s|\\s$|\u{00a0}", chr)))
    expect_false(any(chr %in% c("NA", "N.A.", "#N/A")))
  }
})

test_that("typed columns have their types and references point at real rows", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  r <- run_empty()
  expect_type(r$tables$st6_biomarkers.csv$n, "integer")
  expect_type(r$tables$st6_biomarkers.csv$p_value, "double")
  expect_type(r$tables$st3_trials.csv$target_n, "integer")
  expect_type(r$tables$st2_methods.csv$year, "integer")
  ids <- c(ST1 = "st1_genes.csv", ST2 = "st2_methods.csv", ST5 = "st5_repositioning.csv", ST6 = "st6_biomarkers.csv")
  for (id in names(ids)) {
    refs <- r$references[r$references$sheet == id, ]
    expect_true(all(refs$source_row %in% r$tables[[ids[[id]]]]$source_row), info = id)
  }
  expect_equal(names(r$suspects), c("sheet", "source_row", "row_fingerprint", "column", "value", "rule", "detail"))
  expect_true(all(r$suspects$sheet %in% names(SHEETS)))
})

test_that("non-ASCII text survives the CSV round trip, and Excel reads every file as UTF-8", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  r <- run_empty()
  out <- tempfile()
  write_outputs(r, out)
  back <- readr::read_csv(file.path(out, "st3_trials.csv"), col_types = readr::cols(.default = "c"))
  expect_true("Recent SVS with Fazekas score \u{2265}2" %in% back$population)
  expect_setequal(list.files(out), c(unname(sapply(SHEETS, `[[`, "out")), "references.csv", "footnotes.csv",
                                     "suspects.csv", "captions.csv"))
  for (f in list.files(out, full.names = TRUE)) {
    expect_equal(readBin(f, "raw", 3), as.raw(c(0xef, 0xbb, 0xbf)), info = basename(f))
  }
  captions <- readr::read_csv(file.path(out, "captions.csv"), col_types = readr::cols(.default = "c"))
  expect_equal(names(captions), c("sheet", "caption"))
  expect_equal(captions$sheet, names(SHEETS))
  expect_true(all(startsWith(captions$caption, paste0("Supplementary Table ", 1:6, ":"))))
})

test_that("a keep row in corrections.csv silences its suspect", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  corr <- tempfile(fileext = ".csv")
  writeLines(c("sheet,column,source_row,row_fingerprint,old,new,reason",
               "ST1,gene,,,COL4A1/2,COL4A1/2,combined COL4A1 and COL4A2 row"), corr)
  r <- run_cleaning(XLSX, corr)
  expect_false(any(r$suspects$rule == "gene_symbol" & r$suspects$value %in% "COL4A1/2"))
  expect_true(any(run_empty()$suspects$value %in% "COL4A1/2"))
})

test_that("ST3 records which rows each merged cell fills, and a fix reaches them all", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  m <- attr(assemble_sheet(XLSX, SHEETS$ST3)$table, "merged")
  expect_equal(m$source_row[m$column == "mechanism_of_action" & m$anchor_row == 5], 5:7)
  corr <- tempfile(fileext = ".csv")
  fp <- row_fingerprints(assemble_sheet(XLSX, SHEETS$ST3)$table)
  writeLines(c("sheet,column,source_row,row_fingerprint,old,new,reason",
               paste0("ST3,mechanism_of_action,5,", fp$row_fingerprint[fp$source_row == 5],
                      ",\"Antiplatelet, vasodilator (phosphodiesterase 3 inhibitor)\",Antiplatelet,test")), corr)
  t <- run_cleaning(XLSX, corr)$tables$st3_trials.csv
  expect_equal(t$mechanism_of_action[t$source_row %in% 5:7], rep("Antiplatelet", 3))
})

test_that("every output row carries its fingerprint, and a correction can quote it", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  r <- run_empty()
  for (name in names(r$tables)) {
    expect_equal(names(r$tables[[name]])[1:2], c("source_row", "row_fingerprint"), info = name)
    expect_true(all(grepl("^[0-9a-f]{8}$", r$tables[[name]]$row_fingerprint)), info = name)
  }
  expect_equal(names(r$suspects)[1:3], c("sheet", "source_row", "row_fingerprint"))
  expect_true(all(grepl("^[0-9a-f]{8}$", r$suspects$row_fingerprint[!is.na(r$suspects$source_row)])))
  fp <- r$tables$st6_biomarkers.csv$row_fingerprint[r$tables$st6_biomarkers.csv$source_row == 211]
  corr <- tempfile(fileext = ".csv")
  writeLines(c("sheet,column,source_row,row_fingerprint,old,new,reason",
               paste0("ST6,se_ic,211,", fp, ",\"0,922 - 0965\",\"0,922 - 0,965\",missing decimal comma")), corr)
  fixed <- run_cleaning(XLSX, corr)
  st6 <- fixed$tables$st6_biomarkers.csv
  expect_equal(st6$ci_high[st6$source_row == 211], 0.965)
  expect_false(any(fixed$suspects$rule == "unparsed" & fixed$suspects$source_row %in% 211))
  expect_equal(st6$row_fingerprint[st6$source_row == 211], fp)
})

test_that("an error while assembling a sheet names the sheet", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  spec <- SHEETS$ST4
  spec$build <- function(sd) stop("column C has values but no header", call. = FALSE)
  expect_error(assemble_sheet(XLSX, spec), "ST4 (SupplementaryTable4): column C", fixed = TRUE)
})
