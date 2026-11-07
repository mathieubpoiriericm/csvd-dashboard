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
# Lint:  Rscript -e 'lintr::lint_dir("disease/gold")'

PACKAGES <- c("tidyxl", "readr", "dplyr", "tibble", "xml2", "jsonlite")

# Row fingerprints hash raw bytes with tools::md5sum(bytes =), and
# script_dir() calls grepv(), both new in R 4.5.0.
MIN_R_VERSION <- "4.5.0"

run_cleaning <- function(xlsx, corrections_path) {
  assembled <- lapply(SHEETS, \(spec) assemble_sheet(xlsx, spec))
  assembled_tables <- lapply(assembled, `[[`, "table")
  # Fingerprints of the rows as assembled, before corrections, which is what
  # a row-targeted correction quotes; each row carries its own beside its
  # source_row.
  fingerprints <- lapply(assembled_tables, row_fingerprints)
  corrections <- read_corrections(corrections_path)
  applied <- apply_corrections(assembled_tables, corrections, fingerprints)
  finished <- Map(finish_sheet, SHEETS, applied$tables)
  by_id <- lapply(finished, `[[`, "table")
  add_fingerprints <- function(t, fp, by) {
    dplyr::left_join(t, fp, by = by) |>
      dplyr::relocate("row_fingerprint", .after = "source_row")
  }
  suspects <- dplyr::bind_rows(
    empty_suspects(),
    case_variants(applied$tables),
    gene_symbol_suspects(applied$tables),
    unname(lapply(finished, `[[`, "suspects")),
    duplicate_rows(by_id)
  ) |>
    drop_kept(corrections) |>
    add_fingerprints(dplyr::bind_rows(fingerprints, .id = "sheet"),
                     by = c("sheet", "source_row")) |>
    dplyr::arrange(.data$rule, .data$sheet, .data$source_row)
  tables <- Map(add_fingerprints, by_id, fingerprints, by = "source_row")
  names(tables) <- vapply(SHEETS, `[[`, "", "out")
  pluck_all <- \(parts, name) unname(lapply(parts, `[[`, name))
  list(
    tables = tables,
    references = dplyr::bind_rows(pluck_all(finished, "references")),
    footnotes = dplyr::bind_rows(pluck_all(assembled, "footnotes")),
    captions = tibble::tibble(
      sheet = names(assembled),
      caption = vapply(assembled, `[[`, "", "caption", USE.NAMES = FALSE)
    ),
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
  for (name in names(files)) {
    readr::write_excel_csv(files[[name]], file.path(out_dir, name), na = "")
  }
  invisible(file.path(out_dir, names(files)))
}

main <- function(args, gold_dir) {
  xlsx <- if (length(args) >= 1) {
    args[[1]]
  } else {
    file.path(gold_dir, "curated-gold-data.xlsx")
  }
  if (!file.exists(xlsx)) stop("workbook not found: ", xlsx, call. = FALSE)
  result <- run_cleaning(xlsx, file.path(gold_dir, "corrections.csv"))
  out_dir <- file.path(gold_dir, "out")
  write_outputs(result, out_dir)

  line <- function(label, n, unit = " rows") {
    cat(sprintf("  %-24s %6d%s\n", label, n, unit))
  }
  cat("Cleaned", normalizePath(xlsx), "\n")
  for (name in names(result$tables)) line(name, nrow(result$tables[[name]]))
  line("references.csv", nrow(result$references))
  line("footnotes.csv", nrow(result$footnotes))
  line("captions.csv", nrow(result$captions))
  cat(sprintf("Corrections: %d rows, %d cells changed\n", nrow(result$log),
              sum(result$log$cells)))
  writeLines(correction_report(result$log))
  cat(sprintf("Suspects: %d (out/suspects.csv)\n", nrow(result$suspects)))
  counts <- table(result$suspects$rule)
  for (rule in names(counts)) line(rule, counts[[rule]], "")
  cat("Written to", normalizePath(out_dir), "\n")
}

# The folder of the script Rscript runs. Rscript passes the script as
# --file=, writing each space of its path as "~+~".
script_dir <- function(command_args) {
  file_arg <- grepv("^--file=", command_args)
  if (length(file_arg) == 0) {
    stop("run clean_gold.R with Rscript", call. = FALSE)
  }
  path <- gsub("~+~", " ", sub("^--file=", "", file_arg[1]), fixed = TRUE)
  dirname(normalizePath(path, mustWork = TRUE))
}

# What this R lacks to run the clean-up, as one message, or NULL.
missing_requirements <- function(r_version = getRversion(),
                                 packages = PACKAGES) {
  r_version <- package_version(r_version)
  if (r_version < MIN_R_VERSION) {
    return(sprintf("R %s or later is needed; this is R %s", MIN_R_VERSION,
                   as.character(r_version)))
  }
  have <- vapply(packages, requireNamespace, logical(1), quietly = TRUE)
  if (all(have)) return(NULL)
  sprintf("missing R packages; install them with:\n  install.packages(c(%s))",
          toString(dQuote(packages[!have], q = FALSE)))
}

if (sys.nframe() == 0L) {
  local({
    # Checked first: script_dir() itself needs R 4.5.0, for grepv().
    problem <- missing_requirements()
    if (!is.null(problem)) stop(problem, call. = FALSE)
    gold_dir <- script_dir(commandArgs(FALSE))
    sources <- c("helpers.R", "cells.R", "sheets.R", "corrections.R")
    for (f in sources) source(file.path(gold_dir, f))
    main(commandArgs(trailingOnly = TRUE), gold_dir)
  })
}
