test_that("script_dir finds the script's folder when its path holds spaces", {
  dir <- file.path(tempfile(), "gold data")
  dir.create(dir, recursive = TRUE)
  file.create(file.path(dir, "clean_gold.R"))
  # Rscript writes each space of the script's path as "~+~".
  script <- gsub(" ", "~+~", file.path(dir, "clean_gold.R"), fixed = TRUE)
  arg <- paste0("--file=", script)
  expect_equal(script_dir(c("R", "--no-echo", arg)), normalizePath(dir))
  expect_error(script_dir(c("R", "--no-echo")), "Rscript")
})

test_that("missing_requirements names an old R, then any missing package", {
  expect_null(missing_requirements())
  expect_match(missing_requirements("4.4.3"), "R 4.5.0 or later.*R 4.4.3")
  expect_match(missing_requirements("4.10.0", c("dplyr", "no.such.pkg")),
               "install.packages(c(\"no.such.pkg\"))", fixed = TRUE)
})
