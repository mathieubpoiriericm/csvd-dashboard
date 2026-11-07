# Cleans disease/gold/curated-gold-data.xlsx, the review's six supplementary
# tables, into tidy CSVs under disease/gold/out/.
#
#   Rscript disease/gold/clean_gold.R [path/to/workbook.xlsx]
#
# Each sheet is assembled (records rebuilt, text cleaned), corrections.csv is
# applied, then each sheet is finished (split, typed, references listed).
# Suspect values are reported in out/suspects.csv and never changed: a
# content fix is a row in corrections.csv. The workbook is only ever read.
#
# Tests: Rscript -e 'testthat::test_dir("disease/gold/tests")'

PACKAGES <- c("tidyxl", "readr", "dplyr", "tibble", "xml2", "jsonlite")

run_cleaning <- function(xlsx, corrections_path) {
  assembled <- lapply(SHEETS, function(spec) assemble_sheet(xlsx, spec))
  corrections <- read_corrections(corrections_path)
  applied <- apply_corrections(lapply(assembled, `[[`, "table"), corrections)
  finished <- lapply(names(SHEETS), function(id) finish_sheet(SHEETS[[id]], applied$tables[[id]]))
  names(finished) <- names(SHEETS)
  by_id <- lapply(finished, `[[`, "table")
  # Fingerprints of the rows as assembled, before corrections, which is what
  # a row-targeted correction quotes.
  fingerprints <- lapply(lapply(assembled, `[[`, "table"), row_fingerprints)
  suspects <- dplyr::bind_rows(
    empty_suspects(),
    case_variants(applied$tables),
    gene_symbol_suspects(applied$tables),
    unname(lapply(finished, `[[`, "suspects")),
    duplicate_rows(by_id)
  ) |>
    drop_kept(corrections) |>
    dplyr::left_join(dplyr::bind_rows(fingerprints, .id = "sheet"), by = c("sheet", "source_row")) |>
    dplyr::relocate(row_fingerprint, .after = source_row) |>
    dplyr::arrange(rule, sheet, source_row)
  tables <- lapply(names(by_id), function(id) {
    dplyr::left_join(by_id[[id]], fingerprints[[id]], by = "source_row") |>
      dplyr::relocate(row_fingerprint, .after = source_row)
  })
  names(tables) <- vapply(SHEETS, `[[`, "", "out")
  list(
    tables = tables,
    references = dplyr::bind_rows(unname(lapply(finished, `[[`, "references"))),
    footnotes = dplyr::bind_rows(unname(lapply(assembled, `[[`, "footnotes"))),
    captions = tibble::tibble(sheet = names(assembled),
                              caption = vapply(assembled, `[[`, "", "caption", USE.NAMES = FALSE)),
    suspects = suspects,
    log = applied$log
  )
}

# Replaces the CSVs in `out_dir`; any other file there is left alone. Each
# starts with a UTF-8 byte order mark, without which Excel reads the text as
# its legacy code page and garbles every non-ASCII character.
write_outputs <- function(result, out_dir) {
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  unlink(list.files(out_dir, pattern = "\\.csv$", full.names = TRUE))
  files <- c(result$tables, list(
    references.csv = result$references,
    footnotes.csv = result$footnotes,
    captions.csv = result$captions,
    suspects.csv = result$suspects
  ))
  for (name in names(files)) readr::write_excel_csv(files[[name]], file.path(out_dir, name), na = "")
  invisible(file.path(out_dir, names(files)))
}

main <- function(args, gold_dir) {
  xlsx <- if (length(args) >= 1) args[[1]] else file.path(gold_dir, "curated-gold-data.xlsx")
  if (!file.exists(xlsx)) stop("workbook not found: ", xlsx, call. = FALSE)
  result <- run_cleaning(xlsx, file.path(gold_dir, "corrections.csv"))
  out_dir <- file.path(gold_dir, "out")
  write_outputs(result, out_dir)

  line <- function(label, n, unit = "rows") cat(sprintf("  %-24s %6d %s\n", label, n, unit))
  cat("Cleaned", normalizePath(xlsx), "\n")
  for (name in names(result$tables)) line(name, nrow(result$tables[[name]]))
  line("references.csv", nrow(result$references))
  line("footnotes.csv", nrow(result$footnotes))
  line("captions.csv", nrow(result$captions))
  cat(sprintf("Corrections: %d rows, %d cells changed\n", nrow(result$log), sum(result$log$cells)))
  writeLines(correction_report(result$log))
  cat(sprintf("Suspects: %d (out/suspects.csv)\n", nrow(result$suspects)))
  counts <- table(result$suspects$rule)
  for (rule in names(counts)) line(rule, counts[[rule]], "")
  cat("Written to", normalizePath(out_dir), "\n")
}

if (sys.nframe() == 0L) {
  local({
    file_arg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
    gold_dir <- dirname(normalizePath(sub("^--file=", "", file_arg[1])))
    missing <- PACKAGES[!vapply(PACKAGES, requireNamespace, logical(1), quietly = TRUE)]
    if (length(missing)) {
      stop(sprintf("missing R packages; install them with:\n  install.packages(c(%s))",
                   paste0("\"", missing, "\"", collapse = ", ")), call. = FALSE)
    }
    for (f in c("helpers.R", "cells.R", "sheets.R", "corrections.R")) source(file.path(gold_dir, f))
    main(commandArgs(trailingOnly = TRUE), gold_dir)
  })
}
