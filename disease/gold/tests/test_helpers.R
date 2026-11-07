test_that("clean_text normalises spaces and lines", {
  expect_equal(clean_text("serum\u{00a0}"), "serum")
  expect_equal(clean_text("  CARASIL2,  600142, AR "), "CARASIL2, 600142, AR")
  expect_equal(clean_text("a \r\n\n  b\t\tc "), "a\nb c")
  expect_equal(clean_text(c(" ", "", NA)), c(NA_character_, NA, NA))
})

test_that("as_missing maps only the missing markers", {
  kept <- c("NOT FOUND", "No GPS data", "No (NA)", "ALL < 40", "Completed")
  expect_equal(as_missing(c("NA", "N.A.", "#N/A", kept)), c(NA, NA, NA, kept))
})

test_that("strip_bullets removes the bullet on every line", {
  expect_equal(
    strip_bullets("\u{00b7} Uses many sources\n\u{00b7}  Calculates scores"),
    "Uses many sources\nCalculates scores"
  )
})

test_that("clean_header snake-cases and moves legends out", {
  h <- clean_header(c(
    "Brain cell types (mice)\u{2021}", "Other omics (*significant colocalization)",
    "GPS druggability score / Drug SEs\u{2020}", "Trial Population (target N)",
    "Gene/Target", "Author, journal, year",
    "Other indications (*approved; \u{2020}in trial)"
  ))
  expect_equal(h$name, c(
    "brain_cell_types_mice", "other_omics", "gps_druggability_score_drug_ses",
    "trial_population_target_n", "gene_target", "author_journal_year",
    "other_indications"
  ))
  expect_equal(h$legend, c(
    NA, "Other omics (*significant colocalization)", NA, NA, NA, NA,
    "Other indications (*approved; \u{2020}in trial)"
  ))
})

test_that("reference_tokens splits, strips prefixes and classifies", {
  r <- reference_tokens(paste0(
    "39216230\n31430377,32358547; 10.1212/WNL.0000000000209666, ",
    "https://doi.org/10.21203/rs.3.rs-5926137/v1"
  ))
  expect_equal(r$kind, c("pmid", "pmid", "pmid", "doi", "doi"))
  expect_equal(r$id[5], "10.21203/rs.3.rs-5926137/v1")
  expect_equal(reference_tokens("PMID: 41266628, 37069360")$id, c("41266628", "37069360"))
  expect_equal(reference_tokens("doi:10.1038/s41591-023-02268-w")$kind, "doi")
  expect_equal(reference_tokens("see text")$kind, c("other", "other"))
  expect_equal(nrow(reference_tokens(NA_character_)), 0)
  expect_equal(reference_tokens("37069360,39805841,39805841")$duplicate, c(FALSE, FALSE, TRUE))
})

test_that("collect_references joins, lists and reports", {
  t <- tibble::tibble(source_row = c(4L, 5L), references = c("1,2,2", "x 3"))
  out <- collect_references("ST1", t, "references")
  expect_equal(out$table$references, c("1; 2", "x; 3"))
  expect_equal(out$references$source_row, c(4L, 4L, 5L, 5L))
  expect_equal(out$references$position, c(1L, 2L, 1L, 2L))
  expect_equal(out$references$kind, c("pmid", "pmid", "other", "pmid"))
  expect_equal(out$suspects$rule, c("duplicate_reference", "reference_token"))
  expect_equal(out$suspects$value, c("1,2,2", "x 3"))
  expect_equal(out$suspects$sheet, c("ST1", "ST1"))
  expect_equal(names(out$suspects), c("sheet", "source_row", "column", "value", "rule", "detail"))
})

test_that("collect_references on a column with no references returns empty parts", {
  out <- collect_references("ST5", tibble::tibble(source_row = 4L, references = NA_character_), "references")
  expect_true(is.na(out$table$references))
  expect_equal(nrow(out$references), 0)
  expect_equal(nrow(out$suspects), 0)
  expect_equal(names(out$suspects), c("sheet", "source_row", "column", "value", "rule", "detail"))
})

test_that("split_trailing_group takes the last bracketed group", {
  s <- split_trailing_group(c(
    "Acute lacunar stroke (3,156)", "820 (ongoing)",
    "TASTE-SVD (testing edaravone dexborneol) (NCT06674460)", "LEOPOLD", NA
  ))
  expect_equal(s$head, c("Acute lacunar stroke", "820", "TASTE-SVD (testing edaravone dexborneol)", "LEOPOLD", NA))
  expect_equal(s$group, c("3,156", "ongoing", "NCT06674460", NA, NA))
})

test_that("split_registry_ids pulls out every registry id", {
  r <- split_registry_ids(c(
    "EMERGE (NCT02484547) & ENGAGE (NCT02477800)",
    "TASTE-SVD (testing edaravone dexborneol) (NCT06674460)",
    "ASPREE (NCT01038583)", "LEOPOLD", "TOSCCAA-TXA (ACTRN12624001477516)"
  ))
  expect_equal(r$name, c(
    "EMERGE & ENGAGE", "TASTE-SVD (testing edaravone dexborneol)", "ASPREE",
    "LEOPOLD", "TOSCCAA-TXA"
  ))
  expect_equal(r$registry_ids, c(
    "NCT02484547; NCT02477800", "NCT06674460", "NCT01038583", NA,
    "ACTRN12624001477516"
  ))
})

test_that("parse_count reads integers with thousands separators only", {
  expect_equal(
    parse_count(c("10,251", "238", "8096", "3,156", "1,0", "12a", NA)),
    c(10251L, 238L, 8096L, 3156L, NA, NA, NA)
  )
})

test_that("parse_decimal reads decimal commas and rejects leading zeros", {
  expect_equal(
    parse_decimal(c("0,02", "-0.017", "8.76101678861604e-09", "1e-05", "0965", "abc")),
    c(0.02, -0.017, 8.76101678861604e-09, 1e-05, NA, NA)
  )
})

test_that("parse_decimal returns the double nearest the decimal, as Excel stores it", {
  # Pinned against Python's correctly rounded float(); R's own as.numeric()
  # is one step off on each of these.
  x <- c("0.00000000480586318657296", "0,00000000876101678861604", "0.000000000000728101998779992")
  expect_equal(sprintf("%.17g", parse_decimal(x)),
               c("4.8058631865729598e-09", "8.7610167886160395e-09", "7.2810199877999204e-13"))
})

test_that("split_ci reads every separator the workbook uses", {
  ci <- split_ci(c(
    "0.005", "0,02, 0,30", "-0,33, -0,09", "0,183-0,545", "0,071\u{2013}0,532",
    "1,014  -1,031", "-0,0456 ; -0,0123", "1,06 - 1,171", "0,922 - 0965", "0,5 - 0,1", NA
  ))
  expect_equal(ci$se, c(0.005, rep(NA, 10)))
  expect_equal(ci$ci_low, c(NA, 0.02, -0.33, 0.183, 0.071, 1.014, -0.0456, 1.06, NA, NA, NA))
  expect_equal(ci$ci_high, c(NA, 0.30, -0.09, 0.545, 0.532, 1.031, -0.0123, 1.171, NA, NA, NA))
})

test_that("split_pvalue separates the qualifier", {
  p <- split_pvalue(c("<0,001", "0.0002", "1.99221875410286e-05", "n.s.", NA))
  expect_equal(p$p_value, c(0.001, 0.0002, 1.99221875410286e-05, NA, NA))
  expect_equal(p$p_value_qualifier, c("<", NA, NA, NA, NA))
})

test_that("to_month keeps month precision", {
  expect_equal(to_month(c("2028-07-01", "2026-12-15", "Completed", NA)), c("2028-07", "2026-12", NA, NA))
})

test_that("every source and test file is ASCII, so the run reads the same in any locale", {
  files <- c(list.files(GOLD_DIR, "\\.R$", full.names = TRUE),
             list.files(file.path(GOLD_DIR, "tests"), "\\.R$", full.names = TRUE))
  for (f in files) {
    bytes <- readBin(f, "raw", file.size(f))
    expect_false(any(bytes > as.raw(0x7f)), info = basename(f))
  }
})

test_that("split_trailing_group gives an empty head or group as missing", {
  s <- split_trailing_group(c("(3,156)", "Cilostazol ()"))
  expect_equal(s$head, c(NA, "Cilostazol"))
  expect_equal(s$group, c("3,156", NA))
})

test_that("reference_tokens finds a repeated DOI written in another case", {
  expect_equal(reference_tokens("10.1038/S41591-023-02268-W, 10.1038/s41591-023-02268-w")$duplicate, c(FALSE, TRUE))
})
