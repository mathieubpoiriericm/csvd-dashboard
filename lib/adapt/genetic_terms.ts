/**
 * The genetics vocabulary of the PubMed query. Mirrors GENETIC_TERMS in
 * pipeline/pubmed_search.py, which is where it is used; the wizard only
 * shows it (interview question 4), and tests/adapt/constants_test.ts pins
 * the two lists equal.
 */
export const GENETIC_TERMS: readonly string[] = [
  "gene",
  "genetic",
  "GWAS",
  "EWAS",
  "TWAS",
  "PWAS",
  "genome-wide",
  "variant",
  "mutation",
  "polymorphism",
];
