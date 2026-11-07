# Corrections in the shape read_corrections() returns, one per argument
# position; line numbers start at 2, the header being line 1.
corrections_of <- function(sheet, column, source_row, old, new,
                           reason = "test", fp = NA_character_) {
  tibble::tibble(line = seq_along(sheet) + 1L, sheet = sheet, column = column,
                 source_row = as.integer(source_row), row_fingerprint = fp,
                 old = old, new = new, reason = reason)
}
# The fingerprint a row-targeted correction must quote for `row` of `t`.
fp_of <- function(t, row) {
  row_fingerprints(t)$row_fingerprint[t$source_row == row]
}
tables_of <- function() {
  list(
    ST1 = tibble::tibble(source_row = 83L, protein = "TNC", gene = "Tenascin"),
    ST6 = tibble::tibble(source_row = 4:7,
                         methods = c("Regression", "regression", "regression",
                                     "MR"))
  )
}
# The ST1 gene fix of tables_of(), quoting its row's fingerprint.
gene_fix <- function(new = "TNC", old = "Tenascin", row = 83) {
  corrections_of("ST1", "gene", row, old, new,
                 fp = fp_of(tables_of()$ST1, 83))
}
HEADER <- "sheet,column,source_row,row_fingerprint,old,new,reason"

test_that("read_corrections tolerates an Excel-saved file", {
  path <- tempfile(fileext = ".csv")
  writeBin(charToRaw(paste0(
    "\u{feff}", HEADER, "\r\n",
    "ST1 , gene ,83, 0a1b2c3d , Tenascin ,TNC,swapped with protein\r\n",
    "ST6,methods,,,\"a\r\nb\",\"a\nc\",typo\r\n"
  )), path)
  corr <- read_corrections(path)
  expect_equal(names(corr), c("line", strsplit(HEADER, ",")[[1]]))
  expect_equal(corr$row_fingerprint, c("0a1b2c3d", NA))
  expect_equal(corr$sheet, c("ST1", "ST6"))
  expect_equal(corr$column[1], "gene")
  expect_equal(corr$old, c("Tenascin", "a\nb"))
  expect_equal(corr$source_row, c(83L, NA))
  expect_equal(corr$line, 2:3)
})

corrections_file <- function(...) {
  path <- tempfile(fileext = ".csv")
  writeBin(charToRaw(paste0(HEADER, "\n", ...)), path)
  path
}

test_that("read_corrections reads a missing-value marker as an empty cell", {
  corr <- read_corrections(corrections_file(
    "ST6,methods,7,0a1b2c3d,MR,NA,drop it\n",
    "ST6,methods,8,0a1b2c3d,N.A.,X,fill it\n"
  ))
  expect_equal(corr$new, c(NA, "X"))
  expect_equal(corr$old, c("MR", NA))
})

test_that("read_corrections skips empty rows, keeping each row's line", {
  corr <- read_corrections(corrections_file(
    "ST1,gene,,,a,b,r\r\n,,,,,,\r\n\r\nST6,methods,,,c,d,r\r\n,,,,,,\r\n"
  ))
  expect_equal(corr$sheet, c("ST1", "ST6"))
  expect_equal(corr$line, c(2L, 5L))
})

test_that("read_corrections stops on a row with the wrong number of fields", {
  path <- corrections_file("ST1,gene,,,a,b,r\n",
                           "ST6,methods,,,c,d,a reason, with a comma\n")
  expect_error(read_corrections(path), "line 3.*found 8")
  expect_error(read_corrections(corrections_file("ST1,gene,,,a,b\n")),
               "line 2.*found 6")
})

test_that("read_corrections numbers a row by its first line", {
  corr <- read_corrections(corrections_file(
    "ST2,description,,,\"two\nlines\",one line,r\nST6,methods,,,c,d,r\n"
  ))
  expect_equal(corr$line, c(2L, 4L))
})

test_that("read_corrections names the file when it is not UTF-8", {
  path <- tempfile(fileext = ".csv")
  writeBin(c(charToRaw(paste0(HEADER, "\nST6,names,,,caf")), as.raw(0xe9),
             charToRaw(",cafe,accent\n")), path)
  expect_error(read_corrections(path), paste(basename(path), "is not UTF-8"),
               fixed = TRUE)
})

test_that("read_corrections names the file in every message", {
  path <- corrections_file("ST1,gene,x,,a,b,r\n")
  expect_error(read_corrections(path),
               paste(basename(path), "line 2: source_row x"), fixed = TRUE)
})

test_that("read_corrections reads a header-only file as no corrections", {
  path <- tempfile(fileext = ".csv")
  writeLines(HEADER, path)
  corr <- read_corrections(path)
  expect_equal(nrow(corr), 0)
  expect_type(corr$source_row, "integer")
})

test_that("a row-targeted change touches one cell", {
  out <- apply_corrections(tables_of(), gene_fix())
  expect_equal(out$tables$ST1$gene, "TNC")
  expect_equal(out$log$cells, 1L)
})

test_that("a column-wide change touches every match", {
  corr <- corrections_of("ST6", "methods", NA, "regression", "Regression")
  out <- apply_corrections(tables_of(), corr)
  expect_equal(sum(out$tables$ST6$methods == "Regression"), 3)
  expect_equal(out$log$cells, 2L)
})

test_that("an empty new value sets the cell missing", {
  corr <- corrections_of("ST6", "methods", 7, "MR", NA,
                         fp = fp_of(tables_of()$ST6, 7))
  out <- apply_corrections(tables_of(), corr)
  expect_true(is.na(out$tables$ST6$methods[4]))
})

test_that("a keep row changes nothing and is valid", {
  corr <- corrections_of("ST1", "gene", NA, "Tenascin", "Tenascin")
  out <- apply_corrections(tables_of(), corr)
  expect_equal(out$tables$ST1$gene, "Tenascin")
  expect_equal(out$log$cells, 0L)
})

test_that("corrections do not chain", {
  tables <- list(ST6 = tibble::tibble(source_row = 4:5, methods = c("A", "B")))
  corr <- corrections_of(c("ST6", "ST6"), "methods", NA, c("A", "B"),
                         c("B", "C"))
  out <- apply_corrections(tables, corr)
  expect_equal(out$tables$ST6$methods, c("B", "C"))
})

test_that("apply_corrections uses the fingerprints it is given", {
  given <- list(ST1 = tibble::tibble(source_row = 83L,
                                     row_fingerprint = "0a1b2c3d"))
  corr <- corrections_of("ST1", "gene", 83, "Tenascin", "TNC", fp = "0a1b2c3d")
  out <- apply_corrections(tables_of(), corr, given)
  expect_equal(out$tables$ST1$gene, "TNC")
})

test_that("a stale row-targeted correction names the line and current value", {
  tables <- tables_of()
  tables$ST1$gene <- "TNC"
  expect_error(apply_corrections(tables, gene_fix()), "line 2.*TNC")
  expect_error(apply_corrections(tables, gene_fix("X", "TNC", 999)),
               "line 2.*999")
  right_row <- corrections_of("ST1", "gene", 83, "Tenascin", "X",
                              fp = fp_of(tables$ST1, 83))
  expect_error(apply_corrections(tables, right_row),
               "line 2.*holds \"TNC\", not \"Tenascin\"")
})

test_that("a column-wide correction matching no cell stops the run", {
  corr <- corrections_of("ST6", "methods", NA, "ANOVA", "anova")
  expect_error(apply_corrections(tables_of(), corr), "line 2.*no cell")
})

test_that("two corrections giving one cell different values stop the run", {
  corr <- corrections_of(c("ST1", "ST1"), "gene", c(83, NA), "Tenascin",
                         c("TNC", "TN-C"),
                         fp = c(fp_of(tables_of()$ST1, 83), NA))
  expect_error(apply_corrections(tables_of(), corr), "line 2.*line 3")
})

test_that("a blank reason, an unknown sheet or column stops the run", {
  no_reason <- corrections_of("ST1", "gene", 83, "Tenascin", "TNC", NA)
  expect_error(apply_corrections(tables_of(), no_reason), "reason")
  no_sheet <- corrections_of("ST9", "gene", 83, "Tenascin", "TNC")
  expect_error(apply_corrections(tables_of(), no_sheet), "ST9")
  no_column <- corrections_of("ST1", "symbol", 83, "Tenascin", "TNC")
  expect_error(apply_corrections(tables_of(), no_column), "protein, gene")
})

test_that("drop_kept removes a suspect a keep row covers", {
  s <- suspect("ST1", 6L, "gene", "COL4A1/2", "gene_symbol",
               "not a gene symbol")
  keep <- corrections_of("ST1", "gene", NA, "COL4A1/2", "COL4A1/2")
  expect_equal(nrow(drop_kept(s, keep)), 0)
  other <- corrections_of("ST1", "gene", 7, "COL4A1/2", "COL4A1/2")
  expect_equal(nrow(drop_kept(s, other)), 1)
})

test_that("case_variants reports each spelling once, until one is left", {
  s <- case_variants(tables_of())
  expect_equal(s$value, c("Regression", "regression"))
  expect_equal(s$source_row, c(4L, 5L))
  expect_equal(unique(s$detail), "Regression (1); regression (2)")
  expect_equal(unique(s$rule), "case_variant")
  corr <- corrections_of("ST6", "methods", NA, "regression", "Regression")
  fixed <- apply_corrections(tables_of(), corr)
  expect_equal(nrow(case_variants(fixed$tables)), 0)
})

test_that("gene_symbol_suspects flags what is not a gene symbol", {
  genes <- c("Tenascin", "STN1 (OBFC1)", "PVRL2:CTB-129P6.4", "COL4A1/2",
             "C6orf195", "HTRA1", "NOTCH3")
  tables <- list(
    ST1 = tibble::tibble(source_row = seq_along(genes), gene = genes),
    ST5 = tibble::tibble(source_row = 4:5, gene_target = c("PDE3A", NA))
  )
  s <- gene_symbol_suspects(tables)
  expect_equal(s$value, c("Tenascin", "STN1 (OBFC1)", "PVRL2:CTB-129P6.4",
                          "COL4A1/2"))
  expect_equal(unique(s$rule), "gene_symbol")
})

test_that("duplicate_rows flags a repeated row and a repeated ST1 gene", {
  tables <- list(
    ST1 = tibble::tibble(source_row = 4:6, gene = c("APOE", "LPAR1", "APOE"),
                         tier = c("2", "2", "4")),
    ST6 = tibble::tibble(source_row = 4:6, names = c("IL6", "IL6", "TFPI"),
                         pmid = c("1", "1", "2"))
  )
  s <- duplicate_rows(tables)
  expect_equal(s$sheet, c("ST1", "ST6"))
  expect_equal(s$source_row, c(6L, 5L))
  expect_equal(s$detail, c("also row 4", "same as row 4"))
})

test_that("a keep row never hides an unparsed or date_not_first value", {
  s <- dplyr::bind_rows(
    suspect("ST6", 213L, "se_ic", "0,922 - 0965", "unparsed",
            "expected a CI"),
    suspect("ST3", 9L, "trial_estimated_completion", "2031-08-15",
            "date_not_first", "not the 1st")
  )
  values <- c("0,922 - 0965", "2031-08-15")
  keep <- corrections_of(c("ST6", "ST3"),
                         c("se_ic", "trial_estimated_completion"), NA,
                         values, values)
  expect_equal(nrow(drop_kept(s, keep)), 2)
})

test_that("a row-targeted correction reaches every row its merge fills", {
  t <- tibble::tibble(source_row = 7:10,
                      mechanism_of_action = c("X", "X", "X", "Z"))
  attr(t, "merged") <- tibble::tibble(column = "mechanism_of_action",
                                      source_row = 7:9, anchor_row = 7L)
  corr <- corrections_of("ST3", "mechanism_of_action", 8, "X", "Y",
                         fp = fp_of(t, 8))
  out <- apply_corrections(list(ST3 = t), corr)
  expect_equal(out$tables$ST3$mechanism_of_action, c("Y", "Y", "Y", "Z"))
  expect_equal(out$log$cells, 3L)
})

test_that("a blank old with a source_row fills an empty cell", {
  tables <- list(ST5 = tibble::tibble(source_row = 16:17,
                                      gene_target = c("MUT", NA)))
  fill <- function(row) {
    corrections_of("ST5", "gene_target", row, NA, "XYZ",
                   fp = fp_of(tables$ST5, row))
  }
  out <- apply_corrections(tables, fill(17))
  expect_equal(out$tables$ST5$gene_target, c("MUT", "XYZ"))
  expect_error(apply_corrections(tables, fill(16)), "line 2.*holds \"MUT\"")
  anywhere <- corrections_of("ST5", "gene_target", NA, NA, "XYZ")
  expect_error(apply_corrections(tables, anywhere), "line 2.*old is blank")
})

test_that("row_fingerprints hashes a row's values, pinned to its algorithm", {
  t <- tibble::tibble(source_row = 1:3, a = c("x", "x", "x"),
                      b = c("\u{2265}", "\u{2265}", "y"), c = NA_character_)
  f <- row_fingerprints(t)
  expect_equal(f$source_row, 1:3)
  expect_equal(f$row_fingerprint[1], "d8594db1")
  expect_equal(f$row_fingerprint[1], f$row_fingerprint[2])
  expect_false(f$row_fingerprint[1] == f$row_fingerprint[3])
})

test_that("a row-targeted correction must quote its fingerprint, and only it", {
  unquoted <- corrections_of("ST1", "gene", 83, "Tenascin", "TNC")
  expect_error(apply_corrections(tables_of(), unquoted),
               "line 2.*row_fingerprint")
  rowless <- corrections_of("ST6", "methods", NA, "MR", "mr", fp = "0a1b2c3d")
  expect_error(apply_corrections(tables_of(), rowless), "line 2.*source_row")
})

test_that("a correction never follows its row number onto another row", {
  before <- tibble::tibble(source_row = 271:273,
                           names = c("CTSB", "Cystatin M", "CTSS"), n = "6581")
  corr <- corrections_of("ST6", "n", 272, "6581", "6580",
                         fp = fp_of(before, 272))
  after <- tibble::tibble(source_row = 271:274,
                          names = c("NEW", "CTSB", "Cystatin M", "CTSS"),
                          n = "6581")
  expect_error(apply_corrections(list(ST6 = after), corr),
               "line 2.*now row 273")
  expect_equal(apply_corrections(list(ST6 = before), corr)$tables$ST6$n,
               c("6581", "6580", "6581"))
})

test_that("an error message shows an empty cell as empty, never as NA", {
  message_of <- function(tables, corr) {
    tryCatch({
      apply_corrections(tables, corr)
      ""
    }, error = conditionMessage)
  }
  before <- tibble::tibble(source_row = 4L, methods = "MR")
  tables <- list(ST6 = tibble::tibble(source_row = 4L,
                                      methods = NA_character_))
  changed <- message_of(tables, corrections_of("ST6", "methods", 4, "MR", "X",
                                               fp = fp_of(before, 4)))
  expect_match(changed, "column methods is now empty")
  emptied <- message_of(tables, corrections_of("ST6", "methods", 4, "MR", "X",
                                               fp = fp_of(tables$ST6, 4)))
  expect_match(emptied, "column methods, is empty, not \"MR\"")
  no_sheet <- message_of(tables, corrections_of(NA_character_, "methods", NA,
                                                "MR", "X"))
  expect_match(no_sheet, "sheet is blank")
  no_column <- message_of(tables, corrections_of("ST6", NA_character_, NA,
                                                 "MR", "X"))
  expect_match(no_column, "column is blank")
  for (m in c(changed, emptied, no_sheet, no_column)) {
    expect_false(grepl("NA", m, fixed = TRUE), info = m)
  }
})

test_that("correction_report gives each line its cells, or says it kept", {
  corr <- corrections_of(c("ST6", "ST1", "ST1"),
                         c("methods", "gene", "protein"), NA,
                         c("regression", "Tenascin", "TNC"),
                         c("Regression", "Tenascin", "Tenascin"))
  r <- correction_report(apply_corrections(tables_of(), corr)$log)
  expect_length(r, 3)
  expect_match(r[1], "line 2 +ST6 +methods +2 cells$")
  expect_match(r[2], "line 3 +ST1 +gene +kept$")
  expect_match(r[3], "line 4 +ST1 +protein +1 cell$")
})

test_that("read_corrections reads a fingerprint in either case", {
  path <- corrections_file("ST1,gene,83,0A1B2C3D,a,b,r\n")
  expect_equal(read_corrections(path)$row_fingerprint, "0a1b2c3d")
})

test_that("read_corrections refuses a fingerprint Excel mangled", {
  path <- corrections_file("ST1,gene,,,a,b,r\n",
                           "ST1,gene,83,1.2345E+14,a,b,r\n")
  expect_error(read_corrections(path),
               "line 3.*1.2345E\\+14.*8 hex digits")
})
