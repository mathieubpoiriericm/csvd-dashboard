# Sourced by testthat before every test file: loads the cleaning code from
# the folder above, and names the workbook beside it that the real-data
# tests read.
GOLD_DIR <- normalizePath("..")
XLSX <- file.path(GOLD_DIR, "curated-gold-data.xlsx")
for (f in c("helpers.R", "cells.R", "sheets.R", "corrections.R", "clean_gold.R")) {
  p <- file.path(GOLD_DIR, f)
  if (file.exists(p)) source(p)
}
