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
    stop(sprintf("sheet %s not found in %s (it has: %s)", name, basename(path),
                 paste(trimws(sheets), collapse = ", ")), call. = FALSE)
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
  vapply(strsplit(letters, ""), function(ch) Reduce(function(a, b) a * 26 + b, match(ch, LETTERS), 0),
         numeric(1))
}

# A number as the workbook holds it, never in scientific notation, so that a
# count of 100000 still reads as a count.
plain_number <- function(x) format(x, scientific = FALSE, digits = 15, trim = TRUE)

# `value` is the cell's text without its superscripts, `sup` the superscripts
# ("1-4,7"), `full` everything, each superscript in brackets so a reference
# number never runs into the word before it ("package[1]"). Adjacent
# superscript runs are one superscript: Excel may split "1-4" into "1", "-",
# "4". Numbers, dates and #N/A are rendered as text; any other error value
# stops the run. Every column is typed later, explicitly.
cell_values <- function(cells) {
  rendered <- lapply(seq_len(nrow(cells)), function(i) {
    type <- cells$data_type[i]
    value <- sup <- full <- NA_character_
    if (type == "character") {
      runs <- cells$character_formatted[[i]]
      if (is.null(runs) || nrow(runs) == 0) {
        value <- full <- cells$character[i]
      } else {
        raised <- !is.na(runs$vertAlign) & runs$vertAlign == "superscript"
        value <- paste0(runs$character[!raised], collapse = "")
        group <- cumsum(c(TRUE, raised[-1] != raised[-length(raised)]))
        pieces <- vapply(split(runs$character, group), paste0, "", collapse = "", USE.NAMES = FALSE)
        up <- vapply(split(raised, group), `[`, TRUE, 1, USE.NAMES = FALSE) & nzchar(trimws(pieces))
        full <- paste0(ifelse(up, paste0("[", pieces, "]"), pieces), collapse = "")
        if (any(up)) sup <- paste(pieces[up], collapse = ",")
      }
    } else if (type == "numeric" && !is.na(cells$numeric[i])) {
      value <- full <- plain_number(cells$numeric[i])
    } else if (type == "date" && !is.na(cells$date[i])) {
      value <- full <- format(as.Date(cells$date[i]), "%Y-%m-%d")
    } else if (type == "logical" && !is.na(cells$logical[i])) {
      value <- full <- as.character(cells$logical[i])
    } else if (type == "error") {
      if (cells$error[i] != "#N/A") {
        stop(sprintf("cell %s holds the error %s: fix it in the workbook", cells$address[i], cells$error[i]),
             call. = FALSE)
      }
      full <- cells$error[i]
    }
    if (!is.na(cells$formula[i]) && is.na(value) && type != "error") {
      stop(sprintf("cell %s: formula =%s has no saved result; open and save the workbook in Excel",
                   cells$address[i], cells$formula[i]), call. = FALSE)
    }
    c(value, sup, full)
  })
  m <- matrix(unlist(rendered), ncol = 3, byrow = TRUE)
  out <- tibble(
    row = as.integer(cells$row), col = as.integer(cells$col),
    value = as_missing(clean_text(m[, 1])), sup = clean_text(m[, 2]), full = clean_text(m[, 3])
  )
  out[!is.na(out$full), ] |> arrange(row, col)
}

read_cells <- function(path, sheet) {
  cell_values(tidyxl::xlsx_cells(path, sheets = sheet))
}

# Merged ranges of one sheet, read from the sheet's XML: workbook.xml names
# the sheet's relationship id, the workbook's rels file maps it to a file.
read_merges <- function(path, sheet) {
  dir <- tempfile("xlsx-")
  on.exit(unlink(dir, recursive = TRUE))
  utils::unzip(path, exdir = dir)
  read <- function(f) {
    doc <- xml2::read_xml(file.path(dir, f))
    xml2::xml_ns_strip(doc)
    doc
  }
  sheets <- xml2::xml_find_all(read("xl/workbook.xml"), "//sheets/sheet")
  node <- sheets[xml2::xml_attr(sheets, "name") == sheet]
  if (length(node) != 1) stop(sprintf("sheet %s not found in workbook.xml", sheet), call. = FALSE)
  attrs <- xml2::xml_attrs(node[[1]])
  rid <- attrs[[grep("(^|:)id$", names(attrs))[1]]]
  rels <- xml2::xml_find_all(read("xl/_rels/workbook.xml.rels"), "//Relationship")
  target <- xml2::xml_attr(rels, "Target")[xml2::xml_attr(rels, "Id") == rid]
  target <- if (startsWith(target, "/")) sub("^/", "", target) else file.path("xl", target)
  refs <- xml2::xml_attr(xml2::xml_find_all(read(target), "//mergeCell"), "ref")
  ends <- strsplit(refs, ":", fixed = TRUE)
  first <- vapply(ends, `[`, "", 1)
  last <- vapply(ends, function(e) e[length(e)], "")
  tibble(
    first_row = as.integer(sub("^[A-Z]+", "", first)), first_col = as.integer(col_number(sub("\\d+$", "", first))),
    last_row = as.integer(sub("^[A-Z]+", "", last)), last_col = as.integer(col_number(sub("\\d+$", "", last)))
  )
}

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
  vals |>
    anti_join(added, by = c("row", "col")) |>
    bind_rows(added) |>
    arrange(row, col)
}

# The last data row: the row before the first one, from `first_data_row` on,
# that holds no value and lies in no merged range.
table_bounds <- function(vals, merges, first_data_row) {
  last <- max(vals$row)
  if (first_data_row > last) return(as.integer(last))
  for (r in seq.int(first_data_row, last)) {
    covered <- any(merges$first_row <= r & merges$last_row >= r)
    if (!(r %in% vals$row) && !covered) return(as.integer(r - 1))
  }
  as.integer(last)
}

# Pass merge-expanded values: the distinct header texts of each column, top
# to bottom, joined by a space, then cleaned.
header_names <- function(vals, header_rows) {
  joined <- vals[vals$row %in% header_rows & !is.na(vals$value), ] |>
    arrange(col, row) |>
    group_by(col) |>
    summarise(text = paste(unique(value), collapse = " "), .groups = "drop")
  cleaned <- clean_header(joined$text)
  tibble(col = joined$col, name = cleaned$name, legend = cleaned$legend)
}

# The named columns, checked: a column holding values must have a header.
named_columns <- function(body, header) {
  named <- header[!is.na(header$name), ] |> arrange(col)
  stray <- setdiff(unique(body$col[!is.na(body$value)]), named$col)
  if (length(stray)) {
    stop(sprintf("column %s has values but no header", paste(col_letter(sort(stray)), collapse = ", ")),
         call. = FALSE)
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
# row before the next start.
records_to_table <- function(vals, header, rows, key_col, sep) {
  body <- vals[vals$row %in% rows, ]
  starts <- sort(unique(body$row[body$col == key_col & !is.na(body$value)]))
  body$key <- starts[findInterval(body$row, starts)]
  orphans <- body$row[is.na(body$key) & !is.na(body$value)]
  if (length(orphans)) {
    stop(sprintf("row %d holds values before the first record", orphans[1]), call. = FALSE)
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
