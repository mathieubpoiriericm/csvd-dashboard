# Sourced by testthat before every test file: loads the cleaning code from
# the folder above, and names the workbook beside it that the real-data
# tests read.
GOLD_DIR <- normalizePath("..")
XLSX <- file.path(GOLD_DIR, "curated-gold-data.xlsx")
SOURCES <- c("helpers.R", "cells.R", "sheets.R", "corrections.R",
             "clean_gold.R")
for (f in file.path(GOLD_DIR, SOURCES)) source(f)
