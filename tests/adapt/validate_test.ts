import { assert, assertEquals } from "@std/assert";

import type { Answers } from "../../lib/adapt/answers.ts";
import { EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { clean, trim } from "../../lib/adapt/generate/json.ts";
import {
  FAMILY_PALETTE,
  MECHANISM_PALETTE,
  POPULATION_PALETTE,
} from "../../lib/adapt/palette.ts";
import {
  CONDITION,
  confidenceOk,
  emailOk,
  EXAMPLE_TYPE,
  HEADING_LINE,
  issuesFor,
  KEY,
  reserved,
  SLOT,
  STEP_ORDER,
  validate,
  WEB_URL,
} from "../../lib/adapt/validate.ts";
import { SHOW_ALL } from "../../lib/constants.ts";
import { NONE_FOUND, UNKNOWN } from "../../lib/sentinels.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";
import { FORK_HARD } from "./fixtures/fork_hard.ts";

const withChange = (change: (a: Answers) => void): Answers => {
  const copy = structuredClone(EXAMPLEITIS);
  change(copy);
  return copy;
};
const fields = (answers: Answers) =>
  validate(answers).map((i) => `${i.step}:${i.field}`);
const has = (answers: Answers, field: string) =>
  assert(fields(answers).includes(field), fields(answers).join("\n"));

Deno.test("the complete fixture has no issues and the empty answers have one per required field", () => {
  assertEquals(validate(EXAMPLEITIS), []);
  // The answers scripts/adapt_fork_check.ts builds its harder fork from.
  assertEquals(validate(FORK_HARD), []);
  const empty = validate(EMPTY_ANSWERS);
  assert(empty.length > 20);
  assertEquals(STEP_ORDER, [
    "identity",
    "search",
    "vocabulary",
    "trials",
    "monogenic",
    "prompt",
    "gold",
  ]);
  // Every issue belongs to exactly one step, and the gold step is not the
  // empty filter's fixed point: a per-step count that summed to less than
  // the whole would hide issues from the stepper that renders them.
  assert(issuesFor(empty, "gold").length > 0);
  assertEquals(
    STEP_ORDER.reduce((sum, id) => sum + issuesFor(empty, id).length, 0),
    empty.length,
  );
});

Deno.test("identity rules", () => {
  has(
    withChange((a) => a.identity.disease.key = "Bad Key"),
    "identity:disease.key",
  );
  has(
    withChange((a) => a.identity.disease.name = " "),
    "identity:disease.name",
  );
  has(
    withChange((a) => a.identity.disease.short = ""),
    "identity:disease.short",
  );
  has(
    withChange((a) => a.identity.disease.abbreviation = ""),
    "identity:disease.abbreviation",
  );
  has(
    withChange((a) => a.identity.disease.adjective = ""),
    "identity:disease.adjective",
  );
  has(withChange((a) => a.identity.site.title = ""), "identity:site.title");
  has(
    withChange((a) => a.identity.site.pages.map = ""),
    "identity:site.pages.map",
  );
  has(
    withChange((a) => a.identity.institute.name = ""),
    "identity:institute.name",
  );
  has(
    withChange((a) => a.identity.institute.short = ""),
    "identity:institute.short",
  );
  has(
    withChange((a) => a.identity.institute.copyright = ""),
    "identity:institute.copyright",
  );
  has(
    withChange((a) => a.identity.institute.logoAlt = ""),
    "identity:institute.logoAlt",
  );
  has(
    withChange((a) => a.identity.institute.url = "example.org"),
    "identity:institute.url",
  );
  has(withChange((a) => a.identity.logoLight = null), "identity:logoLight");
  has(
    withChange((a) => a.identity.maintainer.name = ""),
    "identity:maintainer.name",
  );
  has(
    withChange((a) => a.identity.maintainer.email = "nope"),
    "identity:maintainer.email",
  );
  has(
    withChange((a) => a.identity.cellTypes.label = ""),
    "identity:cellTypes.label",
  );
  has(
    withChange((a) => a.identity.cellTypes.glossary = []),
    "identity:cellTypes.glossary",
  );
  has(
    withChange((a) =>
      a.identity.cellTypes.glossary.push({ abbrev: "EC", name: "Again" })
    ),
    "identity:cellTypes.glossary[1]",
  );
  has(
    withChange((a) =>
      a.identity.cellTypes.glossary.push({ abbrev: "", name: "" })
    ),
    "identity:cellTypes.glossary[1]",
  );
});

Deno.test("search rules", () => {
  has(withChange((a) => a.search.diseaseTerms = []), "search:diseaseTerms");
  has(
    withChange((a) => a.search.diseaseTerms = [""]),
    "search:diseaseTerms[0]",
  );
  has(withChange((a) => a.search.meshTerms = []), "search:meshTerms");
  // A phrase MeSH has no heading for is an answer; the only heading gone
  // is the one missing.
  const noHeading = withChange((a) => a.search.meshTerms[0].heading = null);
  lacks(noHeading, "search:meshTerms[0]");
  has(noHeading, "search:meshTerms");
  has(withChange((a) => a.search.markerTerms = []), "search:markerTerms");
  has(
    withChange((a) =>
      a.search.markerTerms = Array.from(
        { length: 16 },
        (_, i) => ({ term: `t${i}`, count: 1 }),
      )
    ),
    "search:markerTerms",
  );
  has(
    withChange((a) => a.search.markerTerms[0].term = ""),
    "search:markerTerms[0]",
  );
  has(
    withChange((a) => a.search.markerTerms[0].term = "Exampleitis"),
    "search:markerTerms[0]",
  );
  has(
    withChange((a) => a.search.markerTerms[1].term = "example marker"),
    "search:markerTerms[1]",
  );
});

Deno.test("vocabulary rules", () => {
  has(withChange((a) => a.vocabulary.traits.pop()), "vocabulary:traits");
  has(
    withChange((a) => {
      for (let i = 0; i < 13; i++) {
        a.vocabulary.traits.push({ ...a.vocabulary.traits[0], key: `K${i}` });
      }
    }),
    "vocabulary:traits",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].key = ""),
    "vocabulary:traits[1].key",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].key = "T1"),
    "vocabulary:traits[1].key",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].key = "a,b"),
    "vocabulary:traits[1].key",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].label = ""),
    "vocabulary:traits[1].label",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].name = ""),
    "vocabulary:traits[1].name",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].definition = ""),
    "vocabulary:traits[1].definition",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].family = "nope"),
    "vocabulary:traits[1].family",
  );
  has(
    withChange((a) => {
      a.vocabulary.traits[1].xref = null;
      a.vocabulary.traits[1].xrefNote = "";
    }),
    "vocabulary:traits[1].xrefNote",
  );
  has(
    withChange((a) =>
      a.vocabulary.families.push({ key: "empty", label: "Empty" })
    ),
    "vocabulary:families[2]",
  );
  has(
    withChange((a) => a.vocabulary.families.push({ key: "", label: "" })),
    "vocabulary:families[2]",
  );
  has(
    withChange((a) =>
      a.vocabulary.families.push({ key: "fam-a", label: "Dup" })
    ),
    "vocabulary:families[2]",
  );
  has(
    withChange((a) => {
      for (let i = 0; i <= FAMILY_PALETTE.length; i++) {
        a.vocabulary.families.push({ key: `f${i}`, label: `F${i}` });
      }
    }),
    "vocabulary:families",
  );
  has(
    withChange((a) =>
      a.vocabulary.citationStandard = {
        name: "",
        label: "",
        doi: "",
        linkLabel: "",
      }
    ),
    "vocabulary:citationStandard.name",
  );
});

Deno.test("trials rules", () => {
  has(withChange((a) => a.trials.populations = []), "trials:populations");
  has(
    withChange((a) => {
      for (let i = 0; i <= POPULATION_PALETTE.length; i++) {
        a.trials.populations.push({
          key: `p${i}`,
          label: `P${i}`,
          lines: [`P${i}`],
        });
      }
    }),
    "trials:populations",
  );
  has(
    withChange((a) => a.trials.populations[1].key = ""),
    "trials:populations[1].key",
  );
  has(
    withChange((a) => a.trials.populations[1].key = "Early"),
    "trials:populations[1].key",
  );
  has(
    withChange((a) => a.trials.populations[1].label = ""),
    "trials:populations[1].label",
  );
  has(
    withChange((a) => a.trials.populations[1].lines = []),
    "trials:populations[1].lines",
  );
  has(
    withChange((a) => a.trials.populationField.label = ""),
    "trials:populationField.label",
  );
  has(
    withChange((a) => a.trials.populationField.detailsLabel = ""),
    "trials:populationField.detailsLabel",
  );
  has(withChange((a) => a.trials.searchTerms = []), "trials:searchTerms");
  has(
    withChange((a) => a.trials.searchTerms[0].term = ""),
    "trials:searchTerms[0]",
  );
  has(withChange((a) => a.trials.conditions = []), "trials:conditions");
  has(withChange((a) => a.trials.conditions = [""]), "trials:conditions[0]");
  has(
    withChange((a) => a.trials.conditionPairs = [["a", ""]]),
    "trials:conditionPairs[0].1",
  );
  has(withChange((a) => a.trials.mechanisms = []), "trials:mechanisms");
  has(
    withChange((a) => a.trials.mechanisms[0].name = ""),
    "trials:mechanisms[0].name",
  );
  has(
    withChange((a) => a.trials.mechanisms[0].family = "nope"),
    "trials:mechanisms[0].family",
  );
  has(
    withChange((a) => a.trials.mechanisms.push({ ...a.trials.mechanisms[0] })),
    "trials:mechanisms[1].name",
  );
  has(
    withChange((a) => {
      for (let i = 0; i <= MECHANISM_PALETTE.length; i++) {
        a.trials.mechanisms.push({ name: `m${i}`, family: "anti-example" });
      }
    }),
    "trials:mechanisms",
  );
  has(
    withChange((a) => a.trials.mechanismFamilies.push({ key: "", label: "" })),
    "trials:mechanismFamilies[1]",
  );
  has(
    withChange((a) =>
      a.trials.mechanismFamilies.push({ key: "anti-example", label: "Dup" })
    ),
    "trials:mechanismFamilies[1]",
  );
  has(
    withChange((a) =>
      a.trials.mechanismFamilies.push({ key: "lonely", label: "Lonely" })
    ),
    "trials:mechanismFamilies[1]",
  );
});

Deno.test("monogenic rules", () => {
  has(
    withChange((a) => {
      for (let i = 0; i < 10; i++) {
        a.monogenic.genes.push({
          symbol: `G${i}`,
          verified: true,
          clinvarTraits: [],
        });
      }
    }),
    "monogenic:genes",
  );
  has(
    withChange((a) => a.monogenic.genes[0].symbol = ""),
    "monogenic:genes[0]",
  );
  has(
    withChange((a) => a.monogenic.genes[0].verified = false),
    "monogenic:genes[0]",
  );
  has(
    withChange((a) => a.monogenic.genes[0].verified = null),
    "monogenic:genes[0]",
  );
  has(
    withChange((a) => a.monogenic.genes.push({ ...a.monogenic.genes[0] })),
    "monogenic:genes[1]",
  );
  has(
    withChange((a) => a.monogenic.aliases[0].alias = ""),
    "monogenic:aliases[0]",
  );
  has(
    withChange((a) => a.monogenic.aliases[0].symbols = []),
    "monogenic:aliases[0].symbols",
  );
  has(
    withChange((a) => a.monogenic.omimRows[0].omimNum = "x"),
    "monogenic:omimRows[0].omimNum",
  );
  has(
    withChange((a) => a.monogenic.omimRows[0].phenotype = ""),
    "monogenic:omimRows[0].phenotype",
  );
  has(
    withChange((a) => a.monogenic.omimRows[0].geneOrLocus = "OTHER"),
    "monogenic:omimRows[0].geneOrLocus",
  );
  // No genes at all is valid, and then no OMIM row may name one.
  assertEquals(
    validate(withChange((a) => {
      a.monogenic = { genes: [], aliases: [], omimRows: [] };
    })),
    [],
  );
});

Deno.test("prompt rules", () => {
  has(
    withChange((a) => a.prompt.sections["persona.specificity"] = ""),
    "prompt:sections.persona.specificity",
  );
  has(
    withChange((a) => delete a.prompt.sections["rubric.modifiers"]),
    "prompt:sections.rubric.modifiers",
  );
  has(
    withChange((a) =>
      a.prompt.sections["rubric.modifiers"] = "- fine\n## not a heading"
    ),
    "prompt:sections.rubric.modifiers",
  );
  has(withChange((a) => a.prompt.examples.pop()), "prompt:examples");
  has(
    withChange((a) => {
      for (let i = 0; i < 3; i++) {
        a.prompt.examples.push({ ...a.prompt.examples[0] });
      }
    }),
    "prompt:examples",
  );
  has(
    withChange((a) => a.prompt.examples[0].pmid = "abc"),
    "prompt:examples[0].pmid",
  );
  has(
    withChange((a) => a.prompt.examples[0].type = ""),
    "prompt:examples[0].type",
  );
  has(
    withChange((a) => a.prompt.examples[0].gene = ""),
    "prompt:examples[0].gene",
  );
  has(
    withChange((a) => a.prompt.examples[0].traits = []),
    "prompt:examples[0].traits",
  );
  has(
    withChange((a) => a.prompt.examples[0].traits = ["nope"]),
    "prompt:examples[0].traits",
  );
  has(
    withChange((a) => a.prompt.examples[0].sentence = ""),
    "prompt:examples[0].sentence",
  );
  has(
    withChange((a) => a.prompt.examples[0].confidence = 1.5),
    "prompt:examples[0].confidence",
  );
  has(
    withChange((a) => a.prompt.examples[0].reasoning = ""),
    "prompt:examples[0].reasoning",
  );
  assertEquals(validate(withChange((a) => a.prompt.examples = [])), []);
});

Deno.test("a key the filters keep for themselves is refused", () => {
  // SHOW_ALL is "Show All"'s value; the sentinels are what an absent value
  // reads as. The filters compare case and spacing aside, and so does this.
  has(
    withChange((a) => a.vocabulary.traits[0].key = SHOW_ALL),
    "vocabulary:traits[0].key",
  );
  has(
    withChange((a) =>
      a.vocabulary.traits[0].key = ` ${NONE_FOUND.toUpperCase()}`
    ),
    "vocabulary:traits[0].key",
  );
  has(
    withChange((a) => a.trials.populations[0].key = "All"),
    "trials:populations[0].key",
  );
  has(
    withChange((a) => a.trials.mechanisms[0].name = UNKNOWN),
    "trials:mechanisms[0].name",
  );
  lacks(
    withChange((a) => a.trials.populations[0].key = "All ages"),
    "trials:populations[0].key",
  );
});

Deno.test("a trait marked as the standard's needs a standard named", () => {
  const unnamed = withChange((a) => a.vocabulary.traits[0].standard = true);
  has(unnamed, "vocabulary:traits[0].standard");
  lacks(
    withChange((a) => {
      a.vocabulary.traits[0].standard = true;
      a.vocabulary.citationStandard = {
        name: "STD",
        label: "Std et al.",
        doi: "10.1/x",
        linkLabel: "View STD",
      };
    }),
    "vocabulary:traits[0].standard",
  );
});

Deno.test("a gene symbol holds no comma, and an OMIM row may leave inheritance blank", () => {
  // Checked or not: an imported draft can say a symbol was verified.
  has(
    withChange((a) => a.monogenic.genes[0].symbol = "GENEA, GENEB"),
    "monogenic:genes[0]",
  );
  // OMIM states no inheritance for many phenotypes.
  lacks(
    withChange((a) => a.monogenic.omimRows[0].inheritance = ""),
    "monogenic:omimRows[0].inheritance",
  );
  has(
    withChange((a) => a.monogenic.omimRows[0].location = ""),
    "monogenic:omimRows[0].location",
  );
});

Deno.test("a MeSH heading that finds no papers is flagged", () => {
  has(
    withChange((a) => a.search.meshTerms[0].count = 0),
    "search:meshTerms[0]",
  );
  // A count that could not be taken is no evidence either way.
  lacks(
    withChange((a) => a.search.meshTerms[0].count = null),
    "search:meshTerms[0]",
  );
});

Deno.test("a disease step is one paragraph", () => {
  const steps = (body: string) =>
    withChange((a) => a.prompt.sections["strategy.disease_steps"] = body);
  // A single line break would reach the model as an unnumbered line.
  has(steps("Step one.\nStep two."), "prompt:sections.strategy.disease_steps");
  // A separating line holding spaces is the blank line it looks like.
  lacks(
    steps("Step one.\n  \nStep two."),
    "prompt:sections.strategy.disease_steps",
  );
  lacks(steps(""), "prompt:sections.strategy.disease_steps");
});

Deno.test("a PMID is compared trimmed and refused with a leading zero", () => {
  // Padded as typed, the row is the number the file will hold.
  lacks(
    withChange((a) => a.gold.rows[0].pmid = " 10000001 "),
    "gold:rows[0].pmid",
  );
  // PubMed reads "010000001" as another number, so no lookup confirms it.
  has(
    withChange((a) => a.gold.rows[0].pmid = "010000001"),
    "gold:rows[0].pmid",
  );
  has(
    withChange((a) => a.prompt.examples[0].pmid = "0"),
    "prompt:examples[0].pmid",
  );
  has(
    withChange((a) => a.monogenic.omimRows[0].omimNum = "0100001"),
    "monogenic:omimRows[0].omimNum",
  );
});

Deno.test("gold rules", () => {
  has(withChange((a) => a.gold.rows.pop()), "gold:rows");
  has(
    withChange((a) => {
      for (let i = 0; i < 21; i++) {
        a.gold.rows.push({
          pmid: `2${i}`,
          note: "n",
          title: null,
          exists: true,
        });
      }
    }),
    "gold:rows",
  );
  has(withChange((a) => a.gold.rows[0].pmid = "x"), "gold:rows[0].pmid");
  has(
    withChange((a) => a.gold.rows[1].pmid = a.gold.rows[0].pmid),
    "gold:rows[1].pmid",
  );
  has(withChange((a) => a.gold.rows[0].exists = false), "gold:rows[0].pmid");
  has(withChange((a) => a.gold.rows[0].exists = null), "gold:rows[0].pmid");
  has(withChange((a) => a.gold.rows[0].note = ""), "gold:rows[0].note");
});

Deno.test("a padded key still matches the row that names it", () => {
  // The generators trim on the way out, so validate() has to compare the
  // same way: flagging a family as trait-less, or an OMIM row's gene as
  // unknown, over a trailing space sends the researcher looking for a
  // mismatch that the generated files do not have.
  assertEquals(
    validate(withChange((a) => {
      a.vocabulary.families[0].key = "fam-a ";
      a.trials.mechanismFamilies[0].key = " anti-example";
      a.monogenic.genes[0].symbol = "GENEA ";
      a.prompt.examples[0].traits = [" T1 "];
    })),
    [],
  );
  // And a key that differs only by a space is the same key twice.
  has(
    withChange((a) => a.vocabulary.traits[1].key = "T1 "),
    "vocabulary:traits[1].key",
  );
  has(
    withChange((a) => a.trials.populations[1].key = " Early"),
    "trials:populations[1].key",
  );
});

Deno.test("clean() strips what either language strips, and writes NFC", () => {
  // pipeline/disease.py reads each value back with str.strip(), which also
  // strips U+001C-U+001F and U+0085: a value ending in one would read
  // shorter than the file holds it, and the fork's equality gates fail.
  assertEquals(clean("exampleitis\u0085"), "exampleitis");
  assertEquals(clean("\u001c\u001dT1\u001e\u001f"), "T1");
  assertEquals(clean("\ufeff T1\u3000"), "T1");
  assertEquals(trim("\u0085 \u0085"), "");
  // Inside the value nothing moves.
  assertEquals(clean("a\u0085b"), "a\u0085b");
  // The decomposed spelling a PDF or a macOS paste gives is written as the
  // composed one typed, so the two are one key in every file.
  assertEquals(clean("Café"), "Café");
});

Deno.test("a value holding only Python's whitespace is blank, and one ending in it is not a fault", () => {
  has(
    withChange((a) => a.identity.disease.name = "\u0085"),
    "identity:disease.name",
  );
  has(
    withChange((a) => a.vocabulary.traits[1].key = "\u001f"),
    "vocabulary:traits[1].key",
  );
  // The file holds the value without it, as the loader reads it.
  assertEquals(
    validate(withChange((a) => {
      a.identity.disease.name = "exampleitis\u0085";
      a.vocabulary.families[0].key = "fam-a\u001e";
    })),
    [],
  );
});

Deno.test("the NFC and NFD spellings of one key are one key", () => {
  const twice = withChange((a) => {
    a.vocabulary.traits[0].key = "Café";
    a.vocabulary.traits[1].key = "Café";
  });
  has(twice, "vocabulary:traits[1].key");
  assert(
    validate(twice).some((i) =>
      i.field === "traits[1].key" && i.message.endsWith("is used twice.")
    ),
  );
  has(
    withChange((a) => {
      a.trials.mechanisms[0].name = "Café receptor antagonist";
      a.trials.mechanisms.push({
        name: "Café receptor antagonist",
        family: "anti-example",
      });
    }),
    "trials:mechanisms[1].name",
  );
});

Deno.test("a confidence left empty fails, before and after a reload", () => {
  // An empty number field reads as NaN, and JSON writes NaN as null; null
  // passes >= 0 and <= 1, so the reloaded draft has to be checked for a
  // number rather than a range alone.
  has(
    withChange((a) => a.prompt.examples[0].confidence = NaN),
    "prompt:examples[0].confidence",
  );
  has(
    withChange((a) =>
      a.prompt.examples[0].confidence = null as unknown as number
    ),
    "prompt:examples[0].confidence",
  );
  has(
    withChange((a) => a.prompt.examples[0].confidence = -0.5),
    "prompt:examples[0].confidence",
  );
});

/** The eight bytes every PNG opens with, and the start of its header. */
const PNG = btoa(
  String.fromCharCode(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
  ),
);
const lacks = (answers: Answers, field: string) =>
  assert(!fields(answers).includes(field), fields(answers).join("\n"));

Deno.test("identity: padded answers pass, and a logo must be SVG or PNG", () => {
  lacks(
    withChange((a) => {
      a.identity.disease.key = " exampleitis ";
      a.identity.maintainer.email = " ada@example.org ";
      a.identity.institute.url = " https://example.org ";
    }),
    "identity:disease.key",
  );
  has(
    withChange((a) => a.identity.institute.url = "https://exa mple.org"),
    "identity:institute.url",
  );
  has(
    withChange((a) => a.identity.logoLight = { name: "logo.jpg", base64: "" }),
    "identity:logoLight",
  );
  has(
    withChange((a) => a.identity.logoDark = { name: "logo", base64: "" }),
    "identity:logoDark",
  );
  lacks(
    withChange((a) => a.identity.logoDark = { name: "Logo.PNG", base64: PNG }),
    "identity:logoDark",
  );
});

Deno.test("search: every phrase must be checked, at least one must have a heading, and no quote", () => {
  // A phrase added after the check has no row of its own.
  has(
    withChange((a) => a.search.diseaseTerms.push("example disease")),
    "search:meshTerms[1]",
  );
  // A phrase retyped after the check still has the old words' row.
  has(
    withChange((a) => a.search.diseaseTerms[0] = "exampleosis"),
    "search:meshTerms[0]",
  );
  // A blank phrase is reported once, as blank, not as unchecked too.
  const blank = withChange((a) => a.search.diseaseTerms.push(" "));
  has(blank, "search:diseaseTerms[1]");
  lacks(blank, "search:meshTerms[1]");
  has(
    withChange((a) => a.search.diseaseTerms.push("Exampleitis")),
    "search:diseaseTerms[1]",
  );
  has(
    withChange((a) => a.search.diseaseTerms[0] = 'the "x" disease'),
    "search:diseaseTerms[0]",
  );
  has(
    withChange((a) => a.search.markerTerms[0].term = 'a "b"'),
    "search:markerTerms[0]",
  );
  // Rows that all resolved to nothing are not a heading.
  has(
    withChange((a) => a.search.meshTerms[0].heading = null),
    "search:meshTerms",
  );
  // Nor is the heading a retyped phrase's old words resolved to.
  has(
    withChange((a) => a.search.diseaseTerms[0] = "exampleosis"),
    "search:meshTerms",
  );
  // A second phrase MeSH does not know stays, beside one it does.
  lacks(
    withChange((a) => {
      a.search.diseaseTerms.push("example disease");
      a.search.meshTerms.push({
        phrase: "example disease",
        heading: null,
        scopeNote: null,
        count: null,
      });
    }),
    "search:meshTerms[1]",
  );
});

Deno.test("trials: a condition outside the fetch's alphabet can never match", () => {
  lacks(
    withChange((a) => a.trials.conditions = ["Exampleitis", "type 2"]),
    "trials:conditions[0]",
  );
  has(
    withChange((a) => a.trials.conditions = ["exampleitis", "alzheimer's"]),
    "trials:conditions[1]",
  );
  has(
    withChange((a) => a.trials.conditionPairs = [["small-vessel", "disease"]]),
    "trials:conditionPairs[0]",
  );
});

Deno.test("monogenic: an alias or an OMIM number listed twice", () => {
  has(
    withChange((a) =>
      a.monogenic.aliases.push({ ...a.monogenic.aliases[0], alias: " genea/b" })
    ),
    "monogenic:aliases[1]",
  );
  has(
    withChange((a) =>
      a.monogenic.omimRows.push({
        ...a.monogenic.omimRows[0],
        omimNum: ` ${a.monogenic.omimRows[0].omimNum}`,
      })
    ),
    "monogenic:omimRows[1].omimNum",
  );
});

Deno.test("prompt: a slot or a heading anywhere in the file, and a bad example type", () => {
  has(
    withChange((a) =>
      a.prompt.sections["persona.specificity"] = "the {{ disease.name }} kind"
    ),
    "prompt:sections.persona.specificity",
  );
  // An example's typed text is reported on the field that holds it, not on
  // a computed section no field shows. Its lines are joined in the block,
  // so a "## " inside one cannot open a line.
  lacks(
    withChange((a) => a.prompt.examples[0].sentence = "one\n## two"),
    "prompt:examples[0].sentence",
  );
  has(
    withChange((a) => a.prompt.examples[0].reasoning = "{{ x }}"),
    "prompt:examples[0].reasoning",
  );
  has(
    withChange((a) => a.prompt.examples[1].gene = "GENE{{"),
    "prompt:examples[1].gene",
  );
  has(
    withChange((a) => a.vocabulary.traits[0].key = "T{{1"),
    "vocabulary:traits[0].key",
  );
  assert(
    !fields(withChange((a) => a.vocabulary.traits[0].key = "T{{1")).includes(
      "prompt:traits.canonical",
    ),
  );
  has(
    withChange((a) => a.prompt.examples[0].type = 'include" x="y'),
    "prompt:examples[0].type",
  );
  lacks(
    withChange((a) => a.prompt.examples[0].pmid = " 10000001 "),
    "prompt:examples[0].pmid",
  );
});

Deno.test("the patterns validate() applies are exported unchanged", () => {
  assert(KEY.test("exampleitis") && !KEY.test("Example-itis"));
  assert(EXAMPLE_TYPE.test("include_validated") && !EXAMPLE_TYPE.test("2x"));
  assert(CONDITION.test("small vessel") && !CONDITION.test("small-vessel"));
  assert(emailOk("ada@example.org") && !emailOk("ada@example"));
  assert(WEB_URL.test("https://example.org") && !WEB_URL.test("example.org"));
  assert(HEADING_LINE.test("a\n## b") && !HEADING_LINE.test("a ## b"));
  assertEquals(SLOT, "{{");
  assert(confidenceOk(0) && confidenceOk(1) && !confidenceOk(1.5));
  assert(!confidenceOk(NaN));
  assert(reserved(" All ") && reserved("(none)") && !reserved("T1"));
});

const kinds = (answers: Answers) =>
  validate(answers).map((i) => `${i.field}:${i.kind}`);

Deno.test("each issue says whether its answer is missing, pending or wrong", () => {
  const empty = kinds(EMPTY_ANSWERS);
  assert(empty.includes("disease.key:missing"));
  assert(empty.includes("logoLight:missing"));
  assert(!empty.some((k) => k.endsWith(":wrong")), empty.join("\n"));
  const typed = kinds(withChange((a) => {
    a.monogenic.genes.push({
      symbol: "GENEZ",
      verified: null,
      clinvarTraits: [],
    });
    a.gold.rows[0].exists = null;
    a.search.diseaseTerms.push("example disease");
    a.monogenic.genes[0].symbol = "GENEA,";
    a.trials.conditionPairs = [["a", "b-c"]];
  }));
  assert(typed.includes("genes[1]:pending"));
  assert(typed.includes("rows[0].pmid:pending"));
  assert(typed.includes("meshTerms[1]:pending"));
  assert(typed.includes("genes[0]:wrong"));
  assert(typed.includes("conditionPairs[0].1:wrong"));
});

Deno.test("a row's fault is filed under the control that holds it", () => {
  const blankLabel = withChange((a) => a.vocabulary.families[1].label = "");
  has(blankLabel, "vocabulary:families[1].label");
  lacks(blankLabel, "vocabulary:families[1]");
  has(
    withChange((a) => a.vocabulary.families[1].key = ""),
    "vocabulary:families[1]",
  );
  has(
    withChange((a) => a.trials.mechanismFamilies[0].label = " "),
    "trials:mechanismFamilies[0].label",
  );
  has(
    withChange((a) => a.identity.cellTypes.glossary[0].name = ""),
    "identity:cellTypes.glossary[0].name",
  );
  lacks(
    withChange((a) => a.identity.cellTypes.glossary[0].name = ""),
    "identity:cellTypes.glossary[0]",
  );
  const secondWord = withChange((a) =>
    a.trials.conditionPairs = [["vascular", "small-vessel"]]
  );
  has(secondWord, "trials:conditionPairs[0].1");
  lacks(secondWord, "trials:conditionPairs[0]");
});

Deno.test("an empty family list is asked for", () => {
  has(
    withChange((a) => {
      a.vocabulary.families = [];
    }),
    "vocabulary:families",
  );
});

Deno.test("a PubMed phrase holding the search's own syntax is refused", () => {
  has(
    withChange((a) => a.search.diseaseTerms[0] = "exampleitis[tiab]"),
    "search:diseaseTerms[0]",
  );
  has(
    withChange((a) => a.search.diseaseTerms[0] = "exampleitis OR examplosis"),
    "search:diseaseTerms[0]",
  );
  has(
    withChange((a) => a.search.markerTerms[0].term = "marker AND other"),
    "search:markerTerms[0]",
  );
  lacks(
    withChange((a) => a.search.markerTerms[0].term = "Ornithine marker"),
    "search:markerTerms[0]",
  );
});

Deno.test("conditions hold single spaces and unaccented letters", () => {
  has(
    withChange((a) => a.trials.conditions = ["small  vessel"]),
    "trials:conditions[0]",
  );
  has(
    withChange((a) => a.trials.conditionPairs = [["small  vessel", "x"]]),
    "trials:conditionPairs[0]",
  );
  const accented = validate(
    withChange((a) => a.trials.conditions = ["behçet"]),
  );
  assert(accented.some((i) => i.message.includes("unaccented")));
});

Deno.test("a DOI is written alone", () => {
  const standard = (doi: string) =>
    withChange((a) =>
      a.vocabulary.citationStandard = {
        name: "Example standard",
        label: "Example et al. 2020",
        doi,
        linkLabel: "Example standard",
      }
    );
  has(
    standard("https://doi.org/10.1000/xyz"),
    "vocabulary:citationStandard.doi",
  );
  has(standard("doi:10.1000/xyz"), "vocabulary:citationStandard.doi");
  lacks(standard("10.1000/xyz"), "vocabulary:citationStandard.doi");
});

Deno.test("an institute URL must parse with a real host", () => {
  for (
    const url of [
      "https://https:www.example.org",
      "https://https//www.example.org",
      "https://localhost",
      "https://ada@example.org",
    ]
  ) {
    has(
      withChange((a) => a.identity.institute.url = url),
      "identity:institute.url",
    );
  }
  lacks(
    withChange((a) =>
      a.identity.institute.url = "https://www.example.org/a?b=c"
    ),
    "identity:institute.url",
  );
});

Deno.test("a maintainer address is one address, checked in linear time", () => {
  for (
    const email of [
      "mailto:ada@example.org",
      "<ada@example.org",
      "ada@example.org,",
      "ada@example.o",
    ]
  ) {
    has(
      withChange((a) => a.identity.maintainer.email = email),
      "identity:maintainer.email",
    );
  }
  const started = performance.now();
  assertEquals(emailOk("a@" + "a.".repeat(50_000) + "!"), false);
  assert(performance.now() - started < 200);
});

Deno.test("a ClinicalTrials.gov term its parser refuses is refused", () => {
  for (
    const term of [
      "exampleitis (SVD",
      'the "example',
      "exampleitis [x]",
      "OR exampleitis",
      "exampleitis AND",
    ]
  ) {
    has(
      withChange((a) => a.trials.searchTerms[0].term = term),
      "trials:searchTerms[0]",
    );
  }
  lacks(
    withChange((a) =>
      a.trials.searchTerms[0].term = "exampleitis (early onset)"
    ),
    "trials:searchTerms[0]",
  );
});

Deno.test("a heading line starts only after a line feed, as the pipeline reads it", () => {
  // Any other line terminator is refused as the invisible character it is,
  // not as a heading: diagnose() marks the same character.
  for (const separator of ["\u2028", "\r", "\u2029"]) {
    const issues = validate(
      withChange((a) =>
        a.prompt.sections["rubric.modifiers"] = `- one${separator}## two`
      ),
    );
    assertEquals(
      issues.map((i) => i.message.startsWith("It holds an invisible")),
      [true],
    );
  }
  has(
    withChange((a) => a.prompt.sections["rubric.modifiers"] = "- one\n## two"),
    "prompt:sections.rubric.modifiers",
  );
});

Deno.test("the disease name and abbreviation cannot hold a slot", () => {
  has(
    withChange((a) => a.identity.disease.abbreviation = "EX{{D"),
    "identity:disease.abbreviation",
  );
  has(
    withChange((a) => a.identity.disease.name = "example{{itis"),
    "identity:disease.name",
  );
});

Deno.test("a name an object keeps for itself is refused where it becomes a map key", () => {
  has(
    withChange((a) => a.trials.mechanisms[0].name = "__proto__"),
    "trials:mechanisms[0].name",
  );
  has(
    withChange((a) => a.monogenic.aliases[0].alias = "__proto__"),
    "monogenic:aliases[0]",
  );
  has(
    withChange((a) => a.identity.cellTypes.glossary[0].abbrev = "constructor"),
    "identity:cellTypes.glossary[0]",
  );
});

Deno.test("NA and N/A are reserved, as the export folds them", () => {
  has(
    withChange((a) => a.vocabulary.traits[0].key = "NA"),
    "vocabulary:traits[0].key",
  );
  has(
    withChange((a) => a.trials.populations[0].key = "N/A"),
    "trials:populations[0].key",
  );
  has(
    withChange((a) => a.trials.mechanisms[0].name = " na "),
    "trials:mechanisms[0].name",
  );
});

Deno.test("an empty radar line is named by its number", () => {
  const trailing = validate(
    withChange((a) => a.trials.populations[1].lines = ["Late", "stage", ""]),
  );
  assert(trailing.some((i) => i.message.startsWith("Line 3 is empty")));
  const inside = validate(
    withChange((a) => a.trials.populations[1].lines = ["Late", " ", "stage"]),
  );
  assert(inside.some((i) => i.message.startsWith("Line 2 is empty")));
  const none = validate(
    withChange((a) => a.trials.populations[1].lines = ["", ""]),
  );
  assert(
    none.some((i) =>
      i.message === "Give the radar at least one non-empty label line."
    ),
  );
});

Deno.test("a trait label fits the karyogram's label column", () => {
  has(
    withChange((a) => a.vocabulary.traits[0].label = "x".repeat(21)),
    "vocabulary:traits[0].label",
  );
  lacks(
    withChange((a) => a.vocabulary.traits[0].label = "x".repeat(20)),
    "vocabulary:traits[0].label",
  );
});

Deno.test("a logo's bytes are what its name says, and inert", () => {
  const svg = (text: string) => ({ name: "logo.svg", base64: btoa(text) });
  const NS = 'xmlns="http://www.w3.org/2000/svg"';
  for (
    const logo of [
      svg(`<svg ${NS}><script>fetch("/genes")</script></svg>`),
      svg(`<svg ${NS} onload="fetch('/genes')"/>`),
      svg(`<svg ${NS}><a href="javascript:alert(1)"><text>x</text></a></svg>`),
      svg(`<svg ${NS}><a href="&#106;avascript:alert(1)"/></svg>`),
      svg(`<svg ${NS}><foreignObject><p>x</p></foreignObject></svg>`),
      svg(`<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}/>`),
      svg("<svg/>"),
      { name: "logo.svg", base64: PNG },
      { name: "logo.png", base64: btoa(`<svg ${NS}/>`) },
      { name: "logo.png", base64: "" },
      { name: "logo.svg", base64: "not base64!" },
    ]
  ) {
    has(withChange((a) => a.identity.logoLight = logo), "identity:logoLight");
    has(withChange((a) => a.identity.logoDark = logo), "identity:logoDark");
  }
  for (
    const logo of [
      svg(`<svg ${NS} viewBox="0 0 10 10"/>`),
      svg(
        `<?xml version="1.0"?>\n<!-- made by hand -->\n<svg ${NS} width="40" height="10"><rect width="40" height="10" fill="#123456"/><text x="1" y="8">EI</text></svg>`,
      ),
      { name: "logo.png", base64: PNG },
    ]
  ) {
    lacks(withChange((a) => a.identity.logoLight = logo), "identity:logoLight");
  }
});

Deno.test("an example cites a paper whose abstract was fetched", () => {
  const unfetched = withChange((a) => a.prompt.examples[1].abstract = null);
  has(unfetched, "prompt:examples[1].pmid");
  assert(kinds(unfetched).includes("examples[1].pmid:pending"));
});

Deno.test("only an inclusion can be an example", () => {
  has(
    withChange((a) => a.prompt.examples[1].type = "exclude_background"),
    "prompt:examples[1].type",
  );
  lacks(
    withChange((a) => a.prompt.examples[1].type = "include_validated"),
    "prompt:examples[1].type",
  );
});

Deno.test("a gene symbol cannot reach the text shown before login", () => {
  has(
    withChange((a) => a.trials.populations[0].label = "GENEA carriers"),
    "trials:populations[0].label",
  );
  has(
    withChange((a) => a.identity.site.aboutLede = "Caused by GENEA mutations."),
    "identity:site.aboutLede",
  );
  lacks(
    withChange((a) => a.trials.populations[0].label = "Genea carriers"),
    "trials:populations[0].label",
  );
  lacks(
    withChange((a) => a.trials.populations[0].label = "GENEAB carriers"),
    "trials:populations[0].label",
  );
});

Deno.test("an alias cannot rename a monogenic gene", () => {
  has(
    withChange((a) =>
      a.monogenic.aliases = [{ alias: "genea-like", symbols: ["GENEA"] }]
    ),
    "monogenic:aliases[0]",
  );
  has(
    withChange((a) => {
      a.monogenic.genes.push({
        symbol: "GENEB",
        verified: true,
        clinvarTraits: [],
      });
    }),
    "monogenic:aliases[0]",
  );
  // The fixture's combined key over one monogenic member and one other.
  lacks(EXAMPLEITIS, "monogenic:aliases[0]");
});

Deno.test("the OMIM table is plain ASCII", () => {
  has(
    withChange((a) =>
      a.monogenic.omimRows[0].phenotype = "Sjögren\u2013Larsson syndrome"
    ),
    "monogenic:omimRows[0].phenotype",
  );
  has(
    withChange((a) => a.monogenic.omimRows[0].inheritance = "A\u00a0D"),
    "monogenic:omimRows[0].inheritance",
  );
});

Deno.test("a section spliced into one line holds no line break", () => {
  has(
    withChange((a) =>
      a.prompt.sections["strategy.ortholog_example"] =
        "mouse Genea → GENEA,\nzebrafish genea → GENEA"
    ),
    "prompt:sections.strategy.ortholog_example",
  );
  lacks(
    withChange((a) => a.prompt.sections["rubric.modifiers"] = "- one\n- two"),
    "prompt:sections.rubric.modifiers",
  );
  // A body padded with blank lines is trimmed as the file writes it.
  lacks(
    withChange((a) =>
      a.prompt.sections["persona.specificity"] =
        "\nYou carefully distinguish EXD.\n "
    ),
    "prompt:sections.persona.specificity",
  );
});

Deno.test("with no monogenic gene the monogenic sections may be blank", () => {
  const none = withChange((a) => {
    a.monogenic = { genes: [], aliases: [], omimRows: [] };
    a.prompt.sections["rubric.monogenic_examples"] = "";
    a.prompt.sections["strategy.background_example"] = "";
  });
  assertEquals(validate(none), []);
  has(
    withChange((a) => a.prompt.sections["rubric.monogenic_examples"] = ""),
    "prompt:sections.rubric.monogenic_examples",
  );
});

Deno.test("an invisible character is refused inside a label", () => {
  has(
    withChange((a) => a.vocabulary.traits[0].label = "T\u200b1"),
    "vocabulary:traits[0].label",
  );
  has(
    withChange((a) => a.identity.site.title = "Example\u00adsite"),
    "identity:site.title",
  );
  has(
    withChange((a) => a.identity.site.title = "\u200bExample"),
    "identity:site.title",
  );
});

Deno.test("the rest of what a logo, a term and an alias are held to", () => {
  // A logo over the cap, read from bytes rather than a stored draft.
  has(
    withChange((a) =>
      a.identity.logoLight = {
        name: "logo.svg",
        base64: btoa("x".repeat(1_000_001)),
      }
    ),
    "identity:logoLight",
  );
  // A character reference out of Unicode's range decodes to nothing.
  lacks(
    withChange((a) =>
      a.identity.logoLight = {
        name: "logo.svg",
        base64: btoa(
          '<svg xmlns="http://www.w3.org/2000/svg"><text>&#x110000;&#0;</text></svg>',
        ),
      }
    ),
    "identity:logoLight",
  );
  // A parenthesis closed before it is opened.
  has(
    withChange((a) => a.trials.searchTerms[0].term = "exampleitis) (onset"),
    "trials:searchTerms[0]",
  );
  has(
    withChange((a) => a.monogenic.aliases[0].alias = "GENE\u200bA/B"),
    "monogenic:aliases[0]",
  );
});
