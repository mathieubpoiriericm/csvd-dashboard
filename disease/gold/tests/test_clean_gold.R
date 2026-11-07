test_that("script_dir finds the script's folder when its path holds spaces", {
  dir <- file.path(tempfile(), "gold data")
  dir.create(dir, recursive = TRUE)
  file.create(file.path(dir, "clean_gold.R"))
  # Rscript writes each space of the script's path as "~+~".
  arg <- paste0("--file=", gsub(" ", "~+~", file.path(dir, "clean_gold.R"), fixed = TRUE))
  expect_equal(script_dir(c("R", "--no-echo", arg)), normalizePath(dir))
  expect_error(script_dir(c("R", "--no-echo")), "Rscript")
})
