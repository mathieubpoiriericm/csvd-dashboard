# Hand-made cell values: one row per cell, as cell_values() returns them.
vals_of <- function(row, col, value, sup = NA_character_, full = value) {
  tibble::tibble(row = as.integer(row), col = as.integer(col), value = value, sup = sup, full = full)
}
merge_of <- function(first_row, first_col, last_row, last_col) {
  tibble::tibble(first_row = as.integer(first_row), first_col = as.integer(first_col),
                 last_row = as.integer(last_row), last_col = as.integer(last_col))
}
no_merges <- merge_of(integer(), integer(), integer(), integer())

test_that("cell_values renders every cell as cleaned text and splits superscripts", {
  runs <- tibble::tibble(character = c("ACCORD", "1-4", " (NCT00000620)"), vertAlign = c(NA, "superscript", NA))
  plain <- tibble::tibble(character = "serum\u{00a0}", vertAlign = NA_character_)
  cells <- tibble::tibble(
    address = c("A4", "B4", "C4", "D4", "E4", "F4"), row = 4L, col = 1:6,
    data_type = c("character", "numeric", "date", "error", "character", "blank"),
    character = c("ACCORD1-4 (NCT00000620)", NA, NA, NA, "serum\u{00a0}", NA),
    character_formatted = list(runs, NULL, NULL, NULL, plain, NULL),
    numeric = c(NA, 6581, NA, NA, NA, NA),
    date = as.POSIXct(c(NA, NA, "2028-07-01", NA, NA, NA), tz = "UTC"),
    logical = NA, error = c(NA, NA, NA, "#N/A", NA, NA),
    formula = c(NA, "1087+5494", NA, NA, NA, NA)
  )
  v <- cell_values(cells)
  expect_equal(v$col, 1:5)
  expect_equal(v$value, c("ACCORD (NCT00000620)", "6581", "2028-07-01", NA, "serum"))
  expect_equal(v$sup, c("1-4", NA, NA, NA, NA))
  expect_equal(v$full[1], "ACCORD[1-4] (NCT00000620)")
})

one_cell <- function(...) {
  defaults <- list(address = "A1", row = 1L, col = 1L, data_type = "character", character = NA_character_,
                   character_formatted = list(NULL), numeric = NA_real_, date = as.POSIXct(NA),
                   logical = NA, error = NA_character_, formula = NA_character_)
  args <- list(...)
  defaults[names(args)] <- args
  tibble::as_tibble(defaults)
}

test_that("cell_values joins adjacent superscript runs and brackets each group in full", {
  runs <- tibble::tibble(character = c("package", "1", "-", "4", " and ", "7"),
                         vertAlign = c(NA, "superscript", "superscript", "superscript", NA, "superscript"))
  v <- cell_values(one_cell(character = "package1-4 and 7", character_formatted = list(runs)))
  expect_equal(v$sup, "1-4,7")
  expect_equal(v$value, "package and")
  expect_equal(v$full, "package[1-4] and [7]")
})

test_that("cell_values stops on an error value other than #N/A", {
  cells <- one_cell(address = "G7", row = 7L, col = 7L, data_type = "error", error = "#REF!", formula = "B7/C7")
  expect_error(cell_values(cells), "G7.*#REF!")
  expect_true(is.na(cell_values(one_cell(data_type = "error", error = "#N/A"))$value))
})

test_that("cell_values writes numbers out in full, never in scientific notation", {
  cells <- one_cell(address = c("A1", "B1", "C1"), col = 1:3, data_type = "numeric",
                    numeric = c(100000, 30970556, 1e-05))
  expect_equal(cell_values(cells)$value, c("100000", "30970556", "0.00001"))
})

test_that("cell_values stops on a formula with no saved result", {
  cells <- one_cell(address = "G200", row = 200L, col = 7L, data_type = "blank", formula = "1087+5494")
  expect_error(cell_values(cells), "G200.*open and save")
})

test_that("cell_values names the first cell that stops the run, whatever stops it", {
  cells <- one_cell(address = c("A1", "B1"), col = 1:2, data_type = c("blank", "error"),
                    error = c(NA, "#REF!"), formula = c("1+1", NA))
  expect_error(cell_values(cells), "A1: formula")
  expect_error(cell_values(cells[2:1, ]), "B1 holds the error")
})

test_that("expand_merges gives covered cells the top-left value", {
  e <- expand_merges(vals_of(4, 1, "ACCORD"), merge_of(4, 1, 5, 1))
  expect_equal(e$value[e$row == 5 & e$col == 1], "ACCORD")
})

test_that("table_bounds ends at the first row with no value and no merge", {
  v <- vals_of(c(4, 6, 8), 1, c("a", "b", "footnote"))
  expect_equal(table_bounds(v, merge_of(4, 1, 5, 1), 4), 6L)
  expect_equal(table_bounds(vals_of(c(4, 5), 1, c("a", "b")), no_merges, 4), 5L)
})

test_that("header_names joins header rows and cleans them", {
  v <- vals_of(c(3, 4, 3, 4), c(1, 1, 2, 2), c("Agent", "Agent", "Trial", "Phase"))
  h <- header_names(v, 3:4)
  expect_equal(h$name, c("agent", "trial_phase"))
})

test_that("rows_to_table names columns and keeps source rows", {
  h <- tibble::tibble(col = 1:2, name = c("gene", "tier"), legend = NA_character_)
  v <- vals_of(c(4, 4, 5), c(1, 2, 1), c("HTRA1", "1a", "NOTCH3"))
  t <- rows_to_table(v, h, 4:5)
  expect_equal(names(t), c("source_row", "gene", "tier"))
  expect_equal(t$source_row, 4:5)
  expect_equal(t$tier, c("1a", NA))
})

test_that("rows_to_table drops an empty header-less column and refuses one with values", {
  h <- tibble::tibble(col = 1L, name = "gene", legend = NA_character_)
  error_only <- vals_of(c(4, 4), c(1, 3), c("HTRA1", NA), full = c("HTRA1", "#N/A"))
  expect_equal(names(rows_to_table(error_only, h, 4)), c("source_row", "gene"))
  expect_error(rows_to_table(vals_of(c(4, 4), c(1, 3), c("HTRA1", "x")), h, 4), "column C")
})

test_that("rows_to_table adds footnote_refs only when a superscript exists", {
  h <- tibble::tibble(col = 1L, name = "trial_id", legend = NA_character_)
  expect_false("footnote_refs" %in% names(rows_to_table(vals_of(4, 1, "LEOPOLD"), h, 4)))
  t <- rows_to_table(vals_of(4, 1, "ACCORD", sup = "1-4"), h, 4)
  expect_equal(t$footnote_refs, "1-4")
})

test_that("records_to_table joins a record's rows", {
  h <- tibble::tibble(col = 1:2, name = c("trial_id", "sample_size"), legend = NA_character_)
  v <- vals_of(c(6, 6, 7, 8, 8), c(1, 2, 1, 1, 2),
               c("ASPREE", "19,114 (2010-2014)", "(NCT01038583)", "COMPASS", "27,395"),
               sup = c("5-7", NA, NA, NA, NA))
  t <- records_to_table(v, h, 6:8, key_col = 2, sep = " ")
  expect_equal(t$source_row, c(6L, 8L))
  expect_equal(t$trial_id, c("ASPREE (NCT01038583)", "COMPASS"))
  expect_equal(t$footnote_refs, c("5-7", NA))
})

test_that("footnote_rows keeps numbered references' numbers", {
  v <- vals_of(c(22, 25, 25), c(1, 1, 2), c("Non-exhaustive list", "1", "Action to Control"))
  f <- footnote_rows(v, c(22, 25))
  expect_equal(f$number, c(NA, 1L))
  expect_equal(f$text, c("Non-exhaustive list", "Action to Control"))
})

test_that("find_sheet matches names after trimming", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  expect_equal(find_sheet(XLSX, "SupplementaryTable5"), "SupplementaryTable5 ")
  expect_error(find_sheet(XLSX, "SupplementaryTable9"), "SupplementaryTable9")
})

test_that("read_merges lists a sheet's merged ranges", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  m <- read_merges(XLSX, "SupplementaryTable4")
  expect_equal(nrow(m), 37)
  expect_true(any(m$first_row == 2 & m$first_col == 1 & m$last_row == 3 & m$last_col == 1))
  expect_equal(nrow(read_merges(XLSX, "SupplementaryTable6")), 0)
})

test_that("read_cells finds ST4's superscripts and ST6's formula result", {
  skip_if_not(file.exists(XLSX), "workbook absent")
  v4 <- read_cells(XLSX, "SupplementaryTable4")
  expect_equal(v4$sup[v4$row == 16 & v4$col == 1], "19-21")
  expect_equal(v4$value[v4$row == 16 & v4$col == 1], "SPS3 (NCT00059306)")
  v6 <- read_cells(XLSX, "SupplementaryTable6")
  expect_true("6581" %in% v6$value[v6$col == 7])
})

test_that("check_below_table stops on data-like rows below the table", {
  data <- vals_of(rep(4:6, each = 3), rep(1:3, 3), letters[1:9])
  stray <- vals_of(c(8, 8, 8), 1:3, c("x", "y", "z"))
  expect_error(check_below_table(dplyr::bind_rows(data, stray), 6), "row 8.*blank row")
  footnotes <- vals_of(c(8, 9, 9), c(1, 1, 2), c("Non-exhaustive list", "1", "Action to Control"))
  expect_silent(check_below_table(dplyr::bind_rows(data, footnotes), 6))
})

test_that("cell_values keeps the spaces a superscript run carries", {
  runs <- tibble::tibble(character = c("ACCORD", "1-4 ", "(NCT00000620)"), vertAlign = c(NA, "superscript", NA))
  v <- cell_values(one_cell(character = "ACCORD1-4 (NCT00000620)", character_formatted = list(runs)))
  expect_equal(c(v$value, v$sup, v$full), c("ACCORD (NCT00000620)", "1-4", "ACCORD[1-4] (NCT00000620)"))
  runs <- tibble::tibble(character = c("word", " 2 ", "next", " ", "end"),
                         vertAlign = c(NA, "superscript", NA, "superscript", NA))
  v <- cell_values(one_cell(character = "word 2 next end", character_formatted = list(runs)))
  expect_equal(c(v$value, v$sup, v$full), c("word next end", "2", "word [2] next end"))
})

test_that("cell_values reads a sheet with no cells as no values", {
  expect_equal(nrow(cell_values(one_cell()[0, ])), 0)
})

test_that("table_bounds stops when the table has no data row, rather than reading its header as data", {
  expect_error(table_bounds(vals_of(1, 1:2, c("Gene", "Tier")), no_merges, 2), "no data.*row 2")
  expect_error(table_bounds(vals_of(integer(), integer(), character()), no_merges, 2), "no data")
})

test_that("records_to_table names a row holding values before the first record", {
  h <- tibble::tibble(col = 1:2, name = c("trial_id", "sample_size"), legend = NA_character_)
  expect_error(records_to_table(vals_of(c(5, 6, 6), c(1, 1, 2), c("stray", "A", "10")), h, 5:6, key_col = 2, sep = " "),
               "row 5 holds values before the first record")
  expect_error(records_to_table(vals_of(5, 1, "stray"), h, 5, key_col = 2, sep = " "),
               "row 5 holds values before the first record")
})

test_that("records_to_table stops on a cell merged down into the next record", {
  h <- tibble::tibble(col = 1:2, name = c("trial_id", "brain_mri_data"), legend = NA_character_)
  v <- vals_of(c(4, 4, 6), c(1, 2, 1), c("ASPREE", "Yes", "COMPASS"))
  expect_error(records_to_table(v, h, 4:6, key_col = 1, sep = " ", merges = merge_of(4, 2, 6, 2)),
               "B4:B6.*rows 4 and 6")
  within <- records_to_table(v, h, 4:6, key_col = 1, sep = " ", merges = merge_of(4, 2, 5, 2))
  expect_equal(within$brain_mri_data, c("Yes", NA))
})
