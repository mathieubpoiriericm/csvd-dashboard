import type { Answers } from "./answers.ts";
import { PREFILLED_SECTION_IDS, prefillSections } from "./prompt_sections.ts";

/**
 * Redraft the derived prompt sections still on their draft after an edit.
 *
 * "Draft the four derived sections" fills a section from the answers of
 * earlier steps: the trait keys and names, the OMIM rows' genes, the
 * glossary. Filled once and left, a section kept naming a trait key since
 * renamed or a gene since dropped, and the extraction prompt carried it
 * with every gate green. A section still holding exactly what the old
 * answers drafted is redrafted from the new ones; one the researcher has
 * edited no longer matches that draft and stays theirs, and one left
 * blank stays blank for the button. It follows redraftSite() in
 * site_drafts.ts.
 */
export function redraftPrompt(before: Answers, after: Answers): void {
  const was = prefillSections(before);
  const now = prefillSections(after);
  for (const id of PREFILLED_SECTION_IDS) {
    if (was[id] === "" || now[id] === was[id]) continue;
    if (after.prompt.sections[id] === was[id]) {
      after.prompt.sections[id] = now[id];
    }
  }
}
