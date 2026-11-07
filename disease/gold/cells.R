# From the workbook to tables: every cell as cleaned text plus its
# superscript runs (tidyxl), merged ranges (xml2, which tidyxl does not
# report), where each table ends, its header, its rows or multi-row records,
# and the footnotes below it.
suppressPackageStartupMessages({
  library(dplyr)
  library(tibble)
})

# The workbook's own name for a sheet, matched after trimming
# ("SupplementaryTable5 " has a trailing space).
find_sheet <- function(path, name) {
  sheets <- tidyxl::xlsx_sheet_names(path)
  hit <- sheets[trimws(sheets) == name]
  if (length(hit) == 0) {
    stop(sprintf("sheet %s not found in %s (it has: %s)", name, basename(path), toString(trimws(sheets))),
         call. = FALSE)
  }
  hit[[1]]
}

col_letter <- function(n) {
  vapply(n, function(k) {
    s <- ""
    while (k > 0) {
      s <- paste0(LETTERS[(k - 1) %% 26 + 1], s)
      k <- (k - 1) %/% 26
    }
    s
  }, character(1))
}

col_number <- function(letters) {
  vapply(strsplit(letters, ""), \(ch) Reduce(\(n, digit) n * 26L + digit, match(ch, LETTERS), 0L), integer(1))
}

# A number as the workbook holds it, never in scientific notation, so that a
# count of 100000 still reads as a count. Pass one number at a time: format()
# gives a vector one precision, so c(1, 0.5) would read "1.0", "0.5".
plain_number <- function(x) format(x, scientific = FALSE, digits = 15, trim = TRUE)

# One rich-text cell's runs as c(value, sup, full): `value` is its text
# without its superscripts, `sup` the superscripts ("1-4,7"), `full`
# everything, each superscript in brackets so a reference number never runs
# into the word before it ("package[1]"). Adjacent superscript runs are one
# superscript: Excel may split "1-4" into "1", "-", "4". The spaces at either
# end of a superscript run stay in the text, so "ACCORD" + "1-4 " +
# "(NCT...)" reads "ACCORD (NCT...)".
split_superscripts <- function(runs) {
  space <- "[\\s\\x{a0}]*"
  raised <- rle(runs$vertAlign %in% "superscript")
  group <- rep(seq_along(raised$lengths), raised$lengths)
  pieces <- vapply(split(runs$character, group), paste0, "", collapse = "", USE.NAMES = FALSE)
  lead <- sub(paste0("^(", space, ")[\\s\\S]*$"), "\\1", pieces, perl = TRUE)
  trail <- sub(paste0("^[\\s\\S]*?(", space, ")$"), "\\1", pieces, perl = TRUE)
  core <- substr(pieces, nchar(lead) + 1L, nchar(pieces) - nchar(trail))
  up <- raised$values & nzchar(core)
  c(value = paste0(ifelse(up, paste0(lead, trail), pieces), collapse = ""),
    sup = if (any(up)) paste(core[up], collapse = ",") else NA_character_,
    full = paste0(ifelse(up, paste0(lead, "[", core, "]", trail), pieces), collapse = ""))
}

# Every cell as cleaned text in `value`, `sup` and `full`, as
# split_superscripts() describes them; a cell without a superscript is its
# own value and full text. Numbers, dates and #N/A are rendered as text; any
# other error value, or a formula with no saved result, stops the run at the
# first such cell. Every column is typed later, explicitly.
cell_values <- function(cells) {
  type <- cells$data_type
  shown <- rep(NA_character_, nrow(cells))
  text <- which(type == "character")
  shown[text] <- cells$character[text]
  number <- which(type == "numeric" & !is.na(cells$numeric))
  shown[number] <- vapply(cells$numeric[number], plain_number, "")
  day <- which(type == "date" & !is.na(cells$date))
  shown[day] <- format(as.Date(cells$date[day]), "%Y-%m-%d")
  flag <- which(type == "logical" & !is.na(cells$logical))
  shown[flag] <- as.character(cells$logical[flag])
  value <- full <- shown
  sup <- rep(NA_character_, nrow(cells))
  rich <- text[vapply(cells$character_formatted[text], \(runs) any(runs$vertAlign %in% "superscript"), NA)]
  parts <- vapply(cells$character_formatted[rich], split_superscripts, c(value = "", sup = "", full = ""))
  value[rich] <- parts["value", ]
  sup[rich] <- parts["sup", ]
  full[rich] <- parts["full", ]
  error <- type == "error"
  full[error] <- cells$error[error]
  unsaved <- !error & !is.na(cells$formula) & is.na(value)
  first <- which((error & cells$error != "#N/A") | unsaved)[1]
  if (!is.na(first) && error[first]) {
    stop(sprintf("cell %s holds the error %s: fix it in the workbook", cells$address[first], cells$error[first]),
         call. = FALSE)
  }
  if (!is.na(first)) {
    stop(sprintf("cell %s: formula =%s has no saved result; open and save the workbook in Excel",
                 cells$address[first], cells$formula[first]), call. = FALSE)
  }
  tibble(
    row = as.integer(cells$row), col = as.integer(cells$col),
    value = as_missing(clean_text(value)), sup = clean_text(sup), full = clean_text(full)
  ) |>
    filter(!is.na(full)) |>
    arrange(row, col)
}

read_cells <- function(path, sheet) {
  cell_values(tidyxl::xlsx_cells(path, sheets = sheet))
}

# Merged ranges of one sheet, read from the sheet's XML: workbook.xml names
# the sheet's relationship id, the workbook's rels file maps it to a file.
# The XML is read straight from the zip, and its elements are matched by
# local name, which spares stripping the namespaces of a whole sheet.
read_merges <- function(path, sheet) {
  elements <- function(file, name) {
    xml2::xml_find_all(xml2::read_xml(unz(path, file)), sprintf("//*[local-name()='%s']", name))
  }
  sheets <- elements("xl/workbook.xml", "sheet")
  node <- sheets[xml2::xml_attr(sheets, "name") %in% sheet]
  if (length(node) != 1) stop(sprintf("sheet %s not found in workbook.xml", sheet), call. = FALSE)
  attrs <- xml2::xml_attrs(node[[1]])
  rid <- attrs[[grep("(^|:)id$", names(attrs))[1]]]
  rels <- elements("xl/_rels/workbook.xml.rels", "Relationship")
  target <- xml2::xml_attr(rels, "Target")[xml2::xml_attr(rels, "Id") == rid]
  target <- if (startsWith(target, "/")) sub("^/", "", target) else file.path("xl", target)
  refs <- xml2::xml_attr(elements(target, "mergeCell"), "ref")
  # A one-cell ref ("A1") is its own first and last cell.
  first <- sub(":.*", "", refs)
  last <- sub(".*:", "", refs)
  row_of <- function(ref) as.integer(sub("^[A-Z]+", "", ref))
  col_of <- function(ref) col_number(sub("\\d+$", "", ref))
  tibble(first_row = row_of(first), first_col = col_of(first), last_row = row_of(last), last_col = col_of(last))
}

# Every cell a merged range covers takes the value of its top-left cell.
expand_merges <- function(vals, merges) {
  added <- bind_rows(vals[0, ], lapply(seq_len(nrow(merges)), function(i) {
    m <- merges[i, ]
    anchor <- vals[vals$row == m$first_row & vals$col == m$first_col, ]
    if (nrow(anchor) == 0) return(NULL)
    grid <- expand.grid(row = m$first_row:m$last_row, col = m$first_col:m$last_col)
    grid <- grid[!(grid$row == m$first_row & grid$col == m$first_col), ]
    tibble(row = as.integer(grid$row), col = as.integer(grid$col),
           value = anchor$value, sup = anchor$sup, full = anchor$full)
  }))
  rows_upsert(vals, added, by = c("row", "col")) |> arrange(row, col)
}

# The last data row: the row before the first one, from `first_data_row` on,
# that holds no value and lies in no merged range. A table without a single
# data row stops the run; read on, its header would become its data.
table_bounds <- function(vals, merges, first_data_row) {
  last <- max(vals$row, 0L)
  r <- as.integer(first_data_row)
  while (r <= last && (r %in% vals$row || any(merges$first_row <= r & merges$last_row >= r))) r <- r + 1L
  if (r == first_data_row) {
    stop(sprintf("the table has no data: row %d, where its data start, is empty", first_data_row), call. = FALSE)
  }
  r - 1L
}

# Pass merge-expanded values: the distinct header texts of each column, top
# to bottom, joined by a space, then cleaned.
header_names <- function(vals, header_rows) {
  joined <- vals[vals$row %in% header_rows & !is.na(vals$value), ] |>
    arrange(col, row) |>
    summarise(text = paste(unique(value), collapse = " "), .by = col)
  cleaned <- clean_header(joined$text)
  tibble(col = joined$col, name = cleaned$name, legend = cleaned$legend)
}

# The named columns, checked: a column holding values must have a header.
named_columns <- function(body, header) {
  named <- header[!is.na(header$name), ] |> arrange(col)
  stray <- setdiff(unique(body$col[!is.na(body$value)]), named$col)
  if (length(stray)) {
    stop(sprintf("column %s has values but no header", toString(col_letter(sort(stray)))), call. = FALSE)
  }
  named
}

# One output row per key (source_row): each column's non-missing values in
# row order, joined by `sep`; superscripts go to footnote_refs.
keyed_table <- function(body, header, keys, sep) {
  columns <- named_columns(body, header)
  body <- arrange(body, row, col)
  out <- tibble(source_row = as.integer(keys))
  join_by_key <- function(values, key, with) {
    if (length(values) == 0) return(rep(NA_character_, length(keys)))
    joined <- tapply(values, key, paste, collapse = with)
    unname(as.character(joined[as.character(keys)]))
  }
  for (i in seq_len(nrow(columns))) {
    cells <- body[body$col == columns$col[i] & !is.na(body$value), ]
    out[[columns$name[i]]] <- join_by_key(cells$value, cells$key, sep)
  }
  raised <- body[!is.na(body$sup), ]
  if (nrow(raised)) out$footnote_refs <- join_by_key(raised$sup, raised$key, ",")
  out
}

rows_to_table <- function(vals, header, rows) {
  body <- vals[vals$row %in% rows, ]
  body$key <- body$row
  keyed_table(body, header, sort(unique(body$row)), sep = " ")
}

# A record starts at each row whose `key_col` holds a value and runs to the
# row before the next start. Pass the sheet's merges: a cell merged down into
# the next record would reach only the first, so it stops the run.
records_to_table <- function(vals, header, rows, key_col, sep, merges = NULL) {
  body <- vals[vals$row %in% rows, ]
  starts <- sort(unique(body$row[body$col == key_col & !is.na(body$value)]))
  record_of <- function(r) c(NA_integer_, starts)[findInterval(r, starts) + 1L]
  body$key <- record_of(body$row)
  orphans <- body$row[is.na(body$key) & !is.na(body$value)]
  if (length(orphans)) {
    stop(sprintf("row %d holds values before the first record", orphans[1]), call. = FALSE)
  }
  if (!is.null(merges)) {
    filled <- paste(body$row, body$col)[!is.na(body$value)]
    m <- merges[merges$last_row > merges$first_row & paste(merges$first_row, merges$first_col) %in% filled, ]
    across <- which(record_of(m$first_row) != record_of(m$last_row))
    if (length(across)) {
      i <- across[1]
      stop(sprintf("%s%d:%s%d is merged across the records starting at rows %d and %d; only the first would get its value",
                   col_letter(m$first_col[i]), m$first_row[i], col_letter(m$last_col[i]), m$last_row[i],
                   record_of(m$first_row[i]), record_of(m$last_row[i])), call. = FALSE)
    }
  }
  keyed_table(body[!is.na(body$key), ], header, starts, sep)
}

footnote_rows <- function(vals, rows) {
  body <- vals[vals$row %in% rows & !is.na(vals$full), ] |> arrange(row, col)
  bind_rows(tibble(number = integer(), text = character()), lapply(unname(split(body$full, body$row)), function(cells) {
    if (length(cells) > 1 && grepl("^\\d+$", cells[1])) {
      tibble(number = as.integer(cells[1]), text = paste(cells[-1], collapse = " "))
    } else {
      tibble(number = NA_integer_, text = paste(cells, collapse = " "))
    }
  }))
}

# Footnotes fill one or two cells (ST4's number and text). A row below the
# table filling three or more is data cut off by a blank row inside the
# table, and reading on would drop it silently.
check_below_table <- function(vals, last) {
  below <- vals[vals$row > last, ]
  filled <- table(below$row)
  wide <- as.integer(names(filled)[filled >= 3])
  if (length(wide)) {
    stop(sprintf(paste0("row %d below the table holds %d cells and looks like data: is there a blank row ",
                        "inside the table? (the table ends at row %d)"),
                 wide[1], filled[[as.character(wide[1])]], last), call. = FALSE)
  }
  invisible(NULL)
}

# Everything one sheet's assembly needs: raw and merge-expanded values, the
# merges, the header, the data rows, and the footnotes below the table
# followed by the header legends.
read_sheet <- function(path, sheet, header_rows, first_data_row) {
  vals <- read_cells(path, sheet)
  merges <- read_merges(path, sheet)
  expanded <- expand_merges(vals, merges)
  last <- table_bounds(vals, merges, first_data_row)
  check_below_table(vals, last)
  header <- header_names(expanded, header_rows)
  footnotes <- bind_rows(
    footnote_rows(vals, unique(vals$row[vals$row > last])),
    tibble(number = NA_integer_, text = header$legend[!is.na(header$legend)])
  )
  list(vals = vals, expanded = expanded, merges = merges, header = header,
       data_rows = seq.int(first_data_row, last), footnotes = footnotes)
}
