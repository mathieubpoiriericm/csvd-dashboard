# Pure string functions shared by every sheet: text cleanup, header names,
# reference splitting, bracket splitting, and number/date parsing.
suppressPackageStartupMessages({
  library(dplyr)
  library(tibble)
})

# Footnote marks used in the workbook's headers and legends.
FOOTNOTE_MARKS <- "[*\u{2020}\u{2021}\u{00a7}]"

# Trial registry ids as the workbook writes them.
REGISTRY_ID <- "(NCT|ISRCTN|ChiCTR|ACTRN)\\d{8,14}"

# One row per value the run reports for a human to judge; never a change.
suspect <- function(sheet, source_row, column, value, rule, detail) {
  tibble(
    sheet = as.character(sheet), source_row = as.integer(source_row),
    column = as.character(column), value = as.character(value),
    rule = as.character(rule), detail = as.character(detail)
  )
}

empty_suspects <- function() {
  none <- character()
  suspect(none, integer(), none, none, none, none)
}

# Non-breaking spaces become spaces, line endings become LF, each line is
# trimmed with its runs of spaces collapsed, empty lines are dropped, and an
# empty result is NA.
clean_text <- function(x) {
  x <- gsub("\u{00a0}", " ", as.character(x), fixed = TRUE)
  x <- gsub("[ \t]+", " ", gsub("\r\n?", "\n", x))
  # A line break takes the spaces around it and the empty lines after it.
  x <- gsub("^[ \n]+|[ \n]+$", "", gsub(" *\n[ \n]*", "\n", x))
  x[!nzchar(x)] <- NA_character_
  x
}

# The workbook's spellings of "no value". Anything else, "NOT FOUND" or
# "No (NA)" included, says something and is kept.
as_missing <- function(x) {
  x[x %in% c("NA", "N.A.", "#N/A")] <- NA_character_
  x
}

strip_bullets <- function(x) {
  gsub("(^|\n)[\u{00b7}\u{2022}][ \t]*", "\\1", x, perl = TRUE)
}

snake_case <- function(x) {
  x <- gsub("[^a-z0-9]+", "_", tolower(x))
  gsub("^_+|_+$", "", x)
}

# A bracketed group holding a footnote mark is a legend, not part of the
# name: it is removed from the name and the whole header is returned as
# `legend` so it can be kept among the footnotes. A header with no letter or
# digit left ("*", "-") has no name, so its column counts as unnamed.
clean_header <- function(x) {
  legend_group <- paste0("\\s*\\([^()]*", FOOTNOTE_MARKS, "[^()]*\\)")
  has_legend <- !is.na(x) & grepl(legend_group, x, perl = TRUE)
  name <- gsub(legend_group, "", x, perl = TRUE)
  name <- snake_case(gsub(FOOTNOTE_MARKS, "", name, perl = TRUE))
  name[!is.na(name) & !nzchar(name)] <- NA_character_
  tibble(name = name, legend = ifelse(has_legend, x, NA_character_))
}

# The ids in reference cells, one row per id in order: the `cell` of `x` it
# came from and its `kind`, a PMID, a bare DOI, or anything else as "other".
# `duplicate` marks a repeat of an earlier id in the same cell; DOIs are
# case-insensitive, so one repeated in another case is a repeat.
reference_tokens <- function(x) {
  s <- gsub("(?i)\\bPMID\\s*:", " ", x, perl = TRUE)
  s <- gsub("(?i)https?://(dx\\.)?doi\\.org/", " ", s, perl = TRUE)
  s <- gsub("(?i)\\bdoi\\s*:\\s*", " ", s, perl = TRUE)
  per_cell <- strsplit(s, "[,;\\s]+", perl = TRUE)
  tokens <- sub("\\.+$", "", unlist(per_cell))
  cell <- rep(seq_along(per_cell), lengths(per_cell))
  found <- !is.na(tokens) & nzchar(tokens)
  tokens <- tokens[found]
  cell <- cell[found]
  kind <- case_when(
    grepl("^\\d+$", tokens) ~ "pmid",
    grepl("^10\\.\\d{4,9}/\\S+$", tokens) ~ "doi",
    .default = "other"
  )
  key <- paste(cell, kind, ifelse(kind == "doi", tolower(tokens), tokens))
  tibble(cell = cell, kind = kind, id = tokens, duplicate = duplicated(key))
}

# Splits `column` of `table` into one row per id. The column keeps the ids
# without repeats, joined by "; "; repeats and unrecognised tokens become
# suspects carrying the original cell, a cell's repeats first.
collect_references <- function(sheet, table, column) {
  cells <- table[[column]]
  tokens <- reference_tokens(cells)
  kept <- tokens |>
    filter(!.data$duplicate) |>
    mutate(position = row_number(), .by = "cell")
  repeats <- tokens |>
    filter(.data$duplicate) |>
    summarise(detail = paste(.data$id, collapse = "; "), .by = "cell") |>
    mutate(rule = "duplicate_reference")
  others <- kept |>
    filter(.data$kind == "other") |>
    transmute(cell = .data$cell, detail = .data$id, rule = "reference_token")
  found <- arrange(bind_rows(repeats, others), .data$cell)
  ids <- split(kept$id, factor(kept$cell, levels = seq_along(cells)))
  joined <- vapply(ids, paste, "", collapse = "; ", USE.NAMES = FALSE)
  table[[column]] <- na_if(joined, "")
  list(
    table = table,
    references = tibble(
      sheet = sheet, source_row = table$source_row[kept$cell],
      position = kept$position, kind = kept$kind, id = kept$id
    ),
    suspects = suspect(
      sheet, table$source_row[found$cell], column, cells[found$cell],
      found$rule, found$detail
    )
  )
}

# "head (group)" with the group at the very end; without one, head is the
# whole value and group is NA. An empty head ("(3,156)") or group is NA.
split_trailing_group <- function(x) {
  re <- "^(.*?)\\s*\\(([^()]*)\\)\\s*$"
  hit <- !is.na(x) & grepl(re, x, perl = TRUE)
  head <- x
  group <- rep(NA_character_, length(x))
  head[hit] <- sub(re, "\\1", x[hit], perl = TRUE)
  group[hit] <- trimws(sub(re, "\\2", x[hit], perl = TRUE))
  head[hit & !nzchar(head)] <- NA_character_
  group[hit & !nzchar(group)] <- NA_character_
  tibble(head = head, group = group)
}

# Removes every "(registry id)" group from a trial cell; the ids are joined
# by "; ", NA when there are none.
split_registry_ids <- function(x) {
  group <- paste0("\\((", REGISTRY_ID, ")\\)")
  found <- regmatches(x, gregexpr(group, x, perl = TRUE))
  ids <- vapply(found, \(f) paste(gsub("[()]", "", f), collapse = "; "), "")
  name <- clean_text(gsub(paste0("\\s*", group), "", x, perl = TRUE))
  tibble(name = name, registry_ids = na_if(ids, ""))
}

# Whole numbers, optionally with comma thousands separators ("10,251"). As
# with DECIMAL, a leading zero ("007") is a typo, not a number, and so is a
# count too large for an R integer.
parse_count <- function(x) {
  ok <- !is.na(x) & grepl("^(0|[1-9]\\d*|[1-9]\\d{0,2}(,\\d{3})+)$", x)
  n <- as.numeric(gsub(",", "", x[ok], fixed = TRUE))
  n[n > .Machine$integer.max] <- NA
  out <- rep(NA_integer_, length(x))
  out[ok] <- as.integer(n)
  out
}

# Decimals with a point or a comma. A leading zero before a digit ("0965")
# is a typo, not a number, so it does not parse.
DECIMAL <- "^-?(0|[1-9]\\d*)([.,]\\d+)?([eE][-+]?\\d+)?$"

# Once its comma is a point, a DECIMAL is a JSON number, and jsonlite reads
# it with C's strtod, which rounds to the nearest double. R's as.numeric()
# does not always, and lands one step off on some tiny p-values. A value too
# large for a double ("1e400") does not parse.
parse_decimal <- function(x) {
  ok <- !is.na(x) & grepl(DECIMAL, x)
  out <- rep(NA_real_, length(x))
  if (any(ok)) {
    numbers <- paste(sub(",", ".", x[ok], fixed = TRUE), collapse = ",")
    out[ok] <- jsonlite::parse_json(paste0("[", numbers, "]"),
                                    simplifyVector = TRUE)
  }
  out[!is.finite(out)] <- NA_real_
  out
}

# ST6's SE/IC column: a single decimal is a standard error; two decimals
# separated by ";", ", ", "-" or an en dash are a confidence interval, valid
# only when both bounds parse and are in order. A bound takes a decimal comma
# or point; a comma followed by a space always separates the bounds.
split_ci <- function(x) {
  se <- parse_decimal(x)
  ci_low <- ci_high <- rep(NA_real_, length(x))
  bound <- "(-?\\d+(?:[.,]\\d+)?)"
  re <- paste0("^\\s*", bound, "\\s*(?:;|,\\s+|\u{2013}|-)\\s*", bound,
               "\\s*$")
  i <- which(!is.na(x) & is.na(se) & grepl(re, x, perl = TRUE))
  low <- parse_decimal(sub(re, "\\1", x[i], perl = TRUE))
  high <- parse_decimal(sub(re, "\\2", x[i], perl = TRUE))
  ok <- !is.na(low) & !is.na(high) & low <= high
  ci_low[i[ok]] <- low[ok]
  ci_high[i[ok]] <- high[ok]
  tibble(se = se, ci_low = ci_low, ci_high = ci_high)
}

# A p-value with an optional qualifier ("<0,001"). One outside [0, 1] is not
# a p-value, so it does not parse.
split_pvalue <- function(x) {
  re <- "^([<>\u{2264}\u{2265}]?)\\s*(.*)$"
  p_value <- parse_decimal(sub(re, "\\2", x, perl = TRUE))
  p_value[!is.na(p_value) & (p_value < 0 | p_value > 1)] <- NA_real_
  qualifier <- sub(re, "\\1", x, perl = TRUE)
  qualifier[is.na(p_value) | !nzchar(qualifier, keepNA = TRUE)] <- NA_character_
  tibble(p_value = p_value, p_value_qualifier = qualifier)
}

# An ISO date ("2028-07-01") at month precision ("2028-07"); anything else,
# a month or day out of range included, is NA.
to_month <- function(x) {
  iso <- "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$"
  ifelse(!is.na(x) & grepl(iso, x), substr(x, 1, 7), NA_character_)
}
