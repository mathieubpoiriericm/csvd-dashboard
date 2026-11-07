# Content fixes from the hand-kept corrections.csv, and the rules that report
# suspect values for a human to rule on. Suspects are never changed here.
suppressPackageStartupMessages({
  library(dplyr)
  library(tibble)
})

CORRECTION_COLUMNS <- c("sheet", "column", "source_row", "row_fingerprint", "old", "new", "reason")

# A short fingerprint of each row's values as assembled, before corrections:
# the first 8 hex digits of the MD5 of its cells (missing as \x1e) joined by
# \x1f. A row-targeted correction quotes it, so a correction can never land
# on another row after rows are inserted or removed in the workbook.
row_fingerprints <- function(t) {
  cells <- lapply(t[setdiff(names(t), "source_row")], function(col) {
    col <- as.character(col)
    col[is.na(col)] <- "\x1e"
    col
  })
  text <- enc2utf8(do.call(paste, c(unname(cells), sep = "\x1f")))
  fingerprint <- vapply(text, function(s) substr(unname(tools::md5sum(bytes = charToRaw(s))), 1, 8),
                        character(1), USE.NAMES = FALSE)
  tibble(source_row = t$source_row, row_fingerprint = fingerprint)
}

# Every field goes through clean_text, so a file saved by Excel (BOM, CRLF,
# padded fields, empty rows) reads like a hand-written one; an empty `old` or
# `new`, or one the workbook's way of writing "no value" ("NA"), is NA.
# Empty rows are read, so each row keeps its line number, and dropped.
read_corrections <- function(path) {
  bytes <- readBin(path, "raw", file.size(path))
  if (any(bytes == as.raw(0)) || !validUTF8(rawToChar(bytes))) {
    stop(sprintf("%s is not UTF-8 text: in Excel, save it as \"CSV UTF-8 (Comma delimited)\"", basename(path)),
         call. = FALSE)
  }
  raw <- withCallingHandlers(
    readr::read_csv(path, col_types = readr::cols(.default = "c"), na = character(), trim_ws = FALSE,
                    skip_empty_rows = FALSE, lazy = FALSE, show_col_types = FALSE, progress = FALSE),
    warning = function(w) if (grepl("parsing issues", conditionMessage(w))) invokeRestart("muffleWarning")
  )
  missing <- setdiff(CORRECTION_COLUMNS, names(raw))
  if (length(missing)) {
    stop(sprintf("%s: missing column(s) %s", basename(path), paste(missing, collapse = ", ")), call. = FALSE)
  }
  # readr folds a surplus field into the last column with only a warning, so
  # count each record's fields with base R, which counts physical lines: a
  # record's last line carries its count, a quoted field's earlier lines NA.
  # A record starts on the line after the previous one ends.
  counts <- utils::count.fields(path, sep = ",", quote = "\"", blank.lines.skip = FALSE, comment.char = "")
  ends <- which(!is.na(counts))
  if (length(ends) - 1L != nrow(raw)) {
    stop("corrections.csv: its rows could not be read; check its double quotes", call. = FALSE)
  }
  fields <- counts[ends][-1]
  out <- tibble(line = ends[-length(ends)] + 1L)
  for (col in CORRECTION_COLUMNS) out[[col]] <- clean_text(raw[[col]])
  out$old <- as_missing(out$old)
  out$new <- as_missing(out$new)
  blank <- rowSums(!is.na(as.data.frame(out[CORRECTION_COLUMNS]))) == 0
  wrong <- which(fields != ncol(raw) & !blank)
  if (length(wrong)) {
    stop(sprintf("corrections.csv line %d: expected %d fields, found %d; put a field that holds a comma in double quotes",
                 out$line[wrong[1]], ncol(raw), fields[wrong[1]]), call. = FALSE)
  }
  out <- out[!blank, ]
  bad <- which(!is.na(out$source_row) & !grepl("^\\d+$", out$source_row))
  if (length(bad)) {
    stop(sprintf("corrections.csv line %d: source_row %s is not a row number",
                 out$line[bad[1]], out$source_row[bad[1]]), call. = FALSE)
  }
  out$source_row <- as.integer(out$source_row)
  out
}

# Every correction is matched against the original tables before any is
# applied, so corrections never chain and their order does not matter.
apply_corrections <- function(tables, corrections) {
  at <- function(line) sprintf("corrections.csv line %d", line)
  fail <- function(line, ...) stop(paste0(at(line), ": ", sprintf(...)), call. = FALSE)
  # A cell's content for a message: an empty cell is "empty", never "NA".
  holds <- function(v) if (is.na(v)) "is empty" else sprintf("holds \"%s\"", v)
  now_holds <- function(v) if (is.na(v)) "is now empty" else sprintf("now holds \"%s\"", v)
  fingerprints <- list()
  fingerprints_of <- function(sheet) {
    if (is.null(fingerprints[[sheet]])) fingerprints[[sheet]] <<- row_fingerprints(tables[[sheet]])
    fingerprints[[sheet]]
  }
  targets <- bind_rows(
    tibble(line = integer(), sheet = character(), column = character(), index = integer(),
           new = character(), changed = logical()),
    lapply(seq_len(nrow(corrections)), function(i) {
      c <- corrections[i, ]
      if (is.na(c$reason)) fail(c$line, "reason is blank")
      sheets <- paste(names(tables), collapse = ", ")
      if (is.na(c$sheet)) fail(c$line, "sheet is blank (sheets: %s)", sheets)
      if (!(c$sheet %in% names(tables))) fail(c$line, "sheet %s does not exist (sheets: %s)", c$sheet, sheets)
      t <- tables[[c$sheet]]
      columns <- setdiff(names(t), "source_row")
      if (is.na(c$column)) fail(c$line, "column is blank (%s columns: %s)", c$sheet, paste(columns, collapse = ", "))
      if (!(c$column %in% columns)) {
        fail(c$line, "%s has no column %s (its columns: %s)", c$sheet, c$column, paste(columns, collapse = ", "))
      }
      x <- t[[c$column]]
      if (is.na(c$source_row) && !is.na(c$row_fingerprint)) {
        fail(c$line, "row_fingerprint %s needs the source_row it was copied from", c$row_fingerprint)
      }
      if (!is.na(c$source_row)) {
        if (is.na(c$row_fingerprint)) {
          fail(c$line, "a correction with a source_row needs that row's row_fingerprint (copy it from the output table or suspects.csv)")
        }
        fp <- fingerprints_of(c$sheet)
        index <- which(t$source_row == c$source_row)
        if (length(index) == 0 || fp$row_fingerprint[index] != c$row_fingerprint) {
          moved_to <- fp$source_row[fp$row_fingerprint == c$row_fingerprint]
          if (length(moved_to)) {
            fail(c$line, "%s row %d is no longer the row this correction was written for: that row (fingerprint %s) is now row %s, so update source_row",
                 c$sheet, c$source_row, c$row_fingerprint, paste(moved_to, collapse = " and "))
          }
          if (length(index) == 0) {
            fail(c$line, "%s has no row %d, and no row has fingerprint %s", c$sheet, c$source_row, c$row_fingerprint)
          }
          fail(c$line, "%s row %d has changed since this correction was written (no row has fingerprint %s); column %s %s, so update or remove this correction",
               c$sheet, c$source_row, c$row_fingerprint, c$column, now_holds(x[index]))
        }
        if (is.na(c$old) && !is.na(x[index])) {
          fail(c$line, "%s row %d, column %s, %s, not an empty cell: the workbook changed, so update or remove this correction",
               c$sheet, c$source_row, c$column, holds(x[index]))
        }
        if (!is.na(c$old) && (is.na(x[index]) || x[index] != c$old)) {
          fail(c$line, "%s row %d, column %s, %s, not \"%s\": the workbook changed, so update or remove this correction",
               c$sheet, c$source_row, c$column, holds(x[index]), c$old)
        }
        index <- merged_rows(t, c$column, index)
      } else {
        if (is.na(c$old)) fail(c$line, "old is blank: a correction without a source_row needs the value it replaces")
        index <- which(!is.na(x) & x == c$old)
        if (length(index) == 0) fail(c$line, "no cell in %s column %s holds \"%s\"", c$sheet, c$column, c$old)
      }
      tibble(line = c$line, sheet = c$sheet, column = c$column, index = index,
             new = c$new, changed = !identical(c$new, c$old))
    })
  )
  clashes <- targets |>
    group_by(sheet, column, index) |>
    filter(n_distinct(new) > 1) |>
    ungroup()
  if (nrow(clashes)) {
    first <- clashes[1, ]
    lines <- sort(unique(clashes$line[clashes$sheet == first$sheet & clashes$column == first$column &
                                        clashes$index == first$index]))
    stop(sprintf("corrections.csv %s give %s row %d, column %s, different values",
                 paste("line", lines, collapse = " and "), first$sheet,
                 tables[[first$sheet]]$source_row[first$index], first$column), call. = FALSE)
  }
  for (i in seq_len(nrow(targets))) {
    tg <- targets[i, ]
    tables[[tg$sheet]][[tg$column]][tg$index] <- tg$new
  }
  changed <- vapply(corrections$line, function(l) sum(targets$changed[targets$line == l]), integer(1))
  list(tables = tables, log = tibble(line = corrections$line, sheet = corrections$sheet,
                                     column = corrections$column, cells = changed))
}

# One printed line per correction: the cells it changed, or "kept" for a
# keep row, which changes none.
correction_report <- function(log) {
  what <- ifelse(log$cells == 0, "kept", paste(log$cells, ifelse(log$cells == 1, "cell", "cells")))
  sprintf("  line %-4d %-4s %-40s %s", log$line, log$sheet, log$column, what)
}

# The rows a merged workbook cell fills (attribute "merged", set by ST3's
# assembly): a fix to one of them is a fix to all of them.
merged_rows <- function(t, column, index) {
  m <- attr(t, "merged")
  if (is.null(m)) return(index)
  hit <- m[m$column == column & m$source_row == t$source_row[index], ]
  if (nrow(hit) == 0) return(index)
  which(t$source_row %in% m$source_row[m$column == column & m$anchor_row == hit$anchor_row[1]])
}

# An unparsed value, or the day of a date not on the 1st, survives only in
# suspects.csv, so a keep row must not hide it: those stay until corrected.
UNKEEPABLE <- c("unparsed", "date_not_first")

# A keep row (old equal to new) marks a suspect value as reviewed.
drop_kept <- function(suspects, corrections) {
  keeps <- corrections[!is.na(corrections$old) & !is.na(corrections$new) & corrections$old == corrections$new, ]
  if (nrow(keeps) == 0 || nrow(suspects) == 0) return(suspects)
  kept <- vapply(seq_len(nrow(suspects)), function(i) {
    s <- suspects[i, ]
    !(s$rule %in% UNKEEPABLE) &&
    any(keeps$sheet == s$sheet & keeps$column %in% s$column & keeps$old %in% s$value &
          (is.na(keeps$source_row) | keeps$source_row %in% s$source_row))
  }, logical(1))
  suspects[!kept, ]
}

# Spellings of one value that differ only in letter case, one suspect per
# spelling, listed in order of first appearance.
case_variants <- function(tables) {
  bind_rows(empty_suspects(), lapply(names(tables), function(id) {
    t <- tables[[id]]
    columns <- setdiff(names(t)[vapply(t, is.character, logical(1))], "source_row")
    bind_rows(lapply(columns, function(column) {
      x <- t[[column]]
      ok <- which(!is.na(x))
      bind_rows(lapply(split(ok, tolower(x[ok])), function(rows) {
        spellings <- unique(x[rows])
        if (length(spellings) < 2) return(NULL)
        counts <- vapply(spellings, function(s) sum(x[rows] == s), integer(1))
        detail <- paste0(spellings, " (", counts, ")", collapse = "; ")
        first <- vapply(spellings, function(s) t$source_row[rows[match(s, x[rows])]], integer(1))
        suspect(id, first, column, spellings, "case_variant", detail)
      }))
    }))
  })) |> arrange(sheet, column, source_row)
}

# HGNC-style symbols: capitals, digits and hyphens, or an "orf" symbol.
GENE_SYMBOL <- "^[A-Z0-9-]+(orf[0-9]+[A-Z0-9-]*)?$"

gene_symbol_suspects <- function(tables) {
  checks <- list(ST1 = "gene", ST5 = "gene_target")
  bind_rows(empty_suspects(), lapply(intersect(names(checks), names(tables)), function(id) {
    t <- tables[[id]]
    x <- t[[checks[[id]]]]
    bad <- which(!is.na(x) & !grepl(GENE_SYMBOL, x))
    if (length(bad) == 0) return(NULL)
    suspect(id, t$source_row[bad], checks[[id]], x[bad], "gene_symbol", "not a gene symbol")
  }))
}

duplicate_rows <- function(tables) {
  bind_rows(empty_suspects(), lapply(names(tables), function(id) {
    t <- tables[[id]]
    key <- do.call(paste, c(lapply(t[setdiff(names(t), "source_row")], as.character), sep = "\x1f"))
    repeats <- which(duplicated(key))
    rows <- suspect(id, t$source_row[repeats], NA, NA, "duplicate_row",
                    paste("same as row", t$source_row[match(key[repeats], key)]))
    genes <- NULL
    if (id == "ST1" && "gene" %in% names(t)) {
      g <- t$gene
      again <- which(!is.na(g) & duplicated(g))
      genes <- suspect(id, t$source_row[again], "gene", g[again], "duplicate_row",
                       paste("also row", t$source_row[match(g[again], g)]))
    }
    bind_rows(genes, rows)
  }))
}
