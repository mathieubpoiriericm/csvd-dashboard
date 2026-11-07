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
  suspect(character(), integer(), character(), character(), character(), character())
}

# Non-breaking spaces become spaces, line endings become LF, each line is
# trimmed with its runs of spaces collapsed, empty lines are dropped, and an
# empty result is NA.
clean_text <- function(x) {
  vapply(as.character(x), function(s) {
    if (is.na(s)) return(NA_character_)
    s <- gsub("\u{00a0}", " ", s, fixed = TRUE)
    s <- gsub("\r\n?", "\n", s)
    lines <- trimws(gsub("[ \t]+", " ", strsplit(s, "\n", fixed = TRUE)[[1]]))
    lines <- lines[nzchar(lines)]
    if (length(lines) == 0) NA_character_ else paste(lines, collapse = "\n")
  }, character(1), USE.NAMES = FALSE)
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
# `legend` so it can be kept among the footnotes.
clean_header <- function(x) {
  legend_group <- paste0("\\s*\\([^()]*", FOOTNOTE_MARKS, "[^()]*\\)")
  has_legend <- !is.na(x) & grepl(legend_group, x, perl = TRUE)
  name <- gsub(legend_group, "", x, perl = TRUE)
  name <- snake_case(gsub(FOOTNOTE_MARKS, "", name, perl = TRUE))
  tibble(name = name, legend = ifelse(has_legend, x, NA_character_))
}

# The ids in one reference cell, in order: PMIDs, bare DOIs, and anything
# else as "other". `duplicate` marks a repeat of an earlier id in the cell.
reference_tokens <- function(x) {
  empty <- tibble(kind = character(), id = character(), duplicate = logical())
  if (length(x) != 1 || is.na(x)) return(empty)
  s <- gsub("(?i)\\bPMID\\s*:", " ", x, perl = TRUE)
  s <- gsub("(?i)https?://(dx\\.)?doi\\.org/", " ", s, perl = TRUE)
  s <- gsub("(?i)\\bdoi\\s*:\\s*", " ", s, perl = TRUE)
  tokens <- sub("\\.+$", "", strsplit(s, "[,;\\s]+", perl = TRUE)[[1]])
  tokens <- tokens[nzchar(tokens)]
  if (length(tokens) == 0) return(empty)
  kind <- ifelse(grepl("^\\d+$", tokens), "pmid",
    ifelse(grepl("^10\\.\\d{4,9}/\\S+$", tokens), "doi", "other")
  )
  tibble(kind = kind, id = tokens, duplicate = duplicated(paste(kind, tokens)))
}

# Splits `column` of `table` into one row per id. The column keeps the ids
# without repeats, joined by "; "; repeats and unrecognised tokens become
# suspects carrying the original cell.
collect_references <- function(sheet, table, column) {
  cells <- table[[column]]
  per_cell <- lapply(cells, reference_tokens)
  references <- bind_rows(
    tibble(sheet = character(), source_row = integer(), position = integer(),
           kind = character(), id = character()),
    lapply(seq_along(cells), function(i) {
      kept <- per_cell[[i]][!per_cell[[i]]$duplicate, ]
      if (nrow(kept) == 0) return(NULL)
      tibble(sheet = sheet, source_row = table$source_row[i], position = seq_len(nrow(kept)),
             kind = kept$kind, id = kept$id)
    })
  )
  suspects <- bind_rows(empty_suspects(), lapply(seq_along(cells), function(i) {
    t <- per_cell[[i]]
    repeats <- t$id[t$duplicate]
    others <- t$id[!t$duplicate & t$kind == "other"]
    bind_rows(
      if (length(repeats)) suspect(sheet, table$source_row[i], column, cells[i],
                                   "duplicate_reference", paste(repeats, collapse = "; ")),
      if (length(others)) suspect(sheet, table$source_row[i], column, cells[i],
                                  "reference_token", others)
    )
  }))
  table[[column]] <- vapply(per_cell, function(t) {
    ids <- t$id[!t$duplicate]
    if (length(ids)) paste(ids, collapse = "; ") else NA_character_
  }, character(1))
  list(table = table, references = references, suspects = suspects)
}

# "head (group)" with the group at the very end; without one, head is the
# whole value and group is NA.
split_trailing_group <- function(x) {
  re <- "^(.*?)\\s*\\(([^()]*)\\)\\s*$"
  hit <- !is.na(x) & grepl(re, x, perl = TRUE)
  head <- x
  group <- rep(NA_character_, length(x))
  head[hit] <- sub(re, "\\1", x[hit], perl = TRUE)
  group[hit] <- trimws(sub(re, "\\2", x[hit], perl = TRUE))
  tibble(head = head, group = group)
}

# Removes every "(registry id)" group from a trial cell; the ids are joined
# by "; ", NA when there are none.
split_registry_ids <- function(x) {
  group <- paste0("\\((", REGISTRY_ID, ")\\)")
  ids <- vapply(x, function(s) {
    if (is.na(s)) return(NA_character_)
    found <- regmatches(s, gregexpr(group, s, perl = TRUE))[[1]]
    if (length(found)) paste(gsub("[()]", "", found), collapse = "; ") else NA_character_
  }, character(1), USE.NAMES = FALSE)
  name <- clean_text(gsub(paste0("\\s*", group), "", x, perl = TRUE))
  tibble(name = name, registry_ids = ids)
}

# Whole numbers, optionally with comma thousands separators ("10,251").
parse_count <- function(x) {
  ok <- !is.na(x) & grepl("^(\\d+|\\d{1,3}(,\\d{3})+)$", x)
  out <- rep(NA_integer_, length(x))
  out[ok] <- as.integer(gsub(",", "", x[ok], fixed = TRUE))
  out
}

# Decimals with a point or a comma. A leading zero before a digit ("0965")
# is a typo, not a number, so it does not parse.
DECIMAL <- "^-?(0|[1-9]\\d*)([.,]\\d+)?([eE][-+]?\\d+)?$"

# Once its comma is a point, a DECIMAL is a JSON number, and jsonlite reads
# it with C's strtod, which rounds to the nearest double. R's as.numeric()
# does not always, and lands one step off on some tiny p-values.
parse_decimal <- function(x) {
  ok <- !is.na(x) & grepl(DECIMAL, x)
  out <- rep(NA_real_, length(x))
  if (any(ok)) {
    json <- paste0("[", paste(sub(",", ".", x[ok], fixed = TRUE), collapse = ","), "]")
    out[ok] <- jsonlite::parse_json(json, simplifyVector = TRUE)
  }
  out
}

# ST6's SE/IC column: a single decimal is a standard error; two decimal-comma
# numbers separated by ";", ", ", "-" or an en dash are a confidence interval,
# valid only when both bounds parse and are in order.
split_ci <- function(x) {
  se <- parse_decimal(x)
  ci_low <- ci_high <- rep(NA_real_, length(x))
  bound <- "(-?\\d+(?:,\\d+)?)"
  re <- paste0("^\\s*", bound, "\\s*(?:;|,\\s+|\u{2013}|-)\\s*", bound, "\\s*$")
  i <- which(!is.na(x) & is.na(se) & grepl(re, x, perl = TRUE))
  low <- parse_decimal(sub(re, "\\1", x[i], perl = TRUE))
  high <- parse_decimal(sub(re, "\\2", x[i], perl = TRUE))
  ok <- !is.na(low) & !is.na(high) & low <= high
  ci_low[i[ok]] <- low[ok]
  ci_high[i[ok]] <- high[ok]
  tibble(se = se, ci_low = ci_low, ci_high = ci_high)
}

split_pvalue <- function(x) {
  re <- "^([<>\u{2264}\u{2265}]?)\\s*(.*)$"
  p_value <- parse_decimal(sub(re, "\\2", x, perl = TRUE))
  qualifier <- sub(re, "\\1", x, perl = TRUE)
  qualifier[is.na(p_value) | qualifier == ""] <- NA_character_
  tibble(p_value = p_value, p_value_qualifier = qualifier)
}

# An ISO date ("2028-07-01") at month precision ("2028-07"); anything else NA.
to_month <- function(x) {
  ifelse(!is.na(x) & grepl("^\\d{4}-\\d{2}-\\d{2}$", x), substr(x, 1, 7), NA_character_)
}
