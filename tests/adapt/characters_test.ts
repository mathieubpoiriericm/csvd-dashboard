import { assert, assertEquals } from "@std/assert";

import type { Answers } from "../../lib/adapt/answers.ts";
import {
  diagnose,
  nameChar,
  type Rule,
  ruleFor,
  toKey,
} from "../../lib/adapt/characters.ts";
import { parseConfidence } from "../../lib/adapt/edits.ts";
import { covers } from "../../lib/adapt/feedback.ts";
import { emailOk, validate } from "../../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

interface Case {
  rule: Rule;
  path: string;
  set: (answers: Answers, text: string) => void;
}

const split = (text: string) =>
  text.split(",").map((s) => s.trim()).filter((s) => s !== "");

/** One writable field per rule, each into a copy of the valid fixture. */
const CASES: Case[] = [
  {
    rule: "key",
    path: "disease.key",
    set: (a, t) => a.identity.disease.key = t,
  },
  {
    rule: "exampleType",
    path: "examples[0].type",
    set: (a, t) => a.prompt.examples[0].type = t,
  },
  {
    rule: "url",
    path: "institute.url",
    set: (a, t) => a.identity.institute.url = t,
  },
  {
    rule: "email",
    path: "maintainer.email",
    set: (a, t) => a.identity.maintainer.email = t,
  },
  {
    rule: "quoteless",
    path: "diseaseTerms[0]",
    set: (a, t) => a.search.diseaseTerms[0] = t,
  },
  {
    rule: "quoteless",
    path: "markerTerms[0]",
    set: (a, t) => a.search.markerTerms[0].term = t,
  },
  {
    rule: "traitKey",
    path: "traits[0].key",
    set: (a, t) => a.vocabulary.traits[0].key = t,
  },
  {
    rule: "reservedKey",
    path: "populations[0].key",
    set: (a, t) => a.trials.populations[0].key = t,
  },
  {
    rule: "reservedKey",
    path: "mechanisms[0].name",
    set: (a, t) => a.trials.mechanisms[0].name = t,
  },
  {
    rule: "conditions",
    path: "conditions",
    set: (a, t) => a.trials.conditions = split(t),
  },
  {
    rule: "condition",
    path: "conditionPairs[0]",
    set: (a, t) => a.trials.conditionPairs = [[t, "dementia"]],
  },
  {
    rule: "condition",
    path: "conditionPairs[0].1",
    set: (a, t) => a.trials.conditionPairs = [["dementia", t]],
  },
  {
    rule: "ctgovTerm",
    path: "searchTerms[0]",
    set: (a, t) => a.trials.searchTerms[0].term = t,
  },
  {
    rule: "slotless",
    path: "disease.name",
    set: (a, t) => a.identity.disease.name = t,
  },
  {
    rule: "slotless",
    path: "examples[0].reasoning",
    set: (a, t) => a.prompt.examples[0].reasoning = t,
  },
  {
    rule: "slotlessLines",
    path: "examples[0].sentence",
    set: (a, t) => a.prompt.examples[0].sentence = t,
  },
  {
    rule: "plain",
    path: "site.title",
    set: (a, t) => a.identity.site.title = t,
  },
  {
    rule: "plain",
    path: "rows[0].note",
    set: (a, t) => a.gold.rows[0].note = t,
  },
  {
    rule: "plainLines",
    path: "site.aboutLede",
    set: (a, t) => a.identity.site.aboutLede = t,
  },
  {
    rule: "plainLines",
    path: "traits[0].definition",
    set: (a, t) => a.vocabulary.traits[0].definition = t,
  },
  {
    rule: "plainKey",
    path: "aliases[0]",
    set: (a, t) => a.monogenic.aliases[0].alias = t,
  },
  {
    rule: "plainKey",
    path: "cellTypes.glossary[0]",
    set: (a, t) => a.identity.cellTypes.glossary[0].abbrev = t,
  },
  {
    rule: "traitLabel",
    path: "traits[0].label",
    set: (a, t) => a.vocabulary.traits[0].label = t,
  },
  {
    rule: "ascii",
    path: "omimRows[0].phenotype",
    set: (a, t) => a.monogenic.omimRows[0].phenotype = t,
  },
  {
    rule: "doi",
    path: "citationStandard.doi",
    set: (a, t) =>
      a.vocabulary.citationStandard = {
        name: "Example standard",
        label: "Example et al. 2020",
        doi: t,
        linkLabel: "Example standard",
      },
  },
  {
    rule: "symbol",
    path: "genes[0]",
    set: (a, t) => a.monogenic.genes[0].symbol = t,
  },
  {
    rule: "mim",
    path: "omimRows[0].omimNum",
    set: (a, t) => a.monogenic.omimRows[0].omimNum = t,
  },
  {
    rule: "number",
    path: "examples[0].pmid",
    set: (a, t) => a.prompt.examples[0].pmid = t,
  },
  {
    rule: "number",
    path: "rows[0].pmid",
    set: (a, t) => a.gold.rows[0].pmid = t,
  },
  {
    rule: "confidence",
    path: "examples[0].confidence",
    set: (a, t) => a.prompt.examples[0].confidence = parseConfidence(t),
  },
  {
    rule: "inline",
    path: "sections.persona.specificity",
    set: (a, t) => a.prompt.sections["persona.specificity"] = t,
  },
  {
    rule: "section",
    path: "sections.rubric.modifiers",
    set: (a, t) => a.prompt.sections["rubric.modifiers"] = t,
  },
  {
    rule: "steps",
    path: "sections.strategy.disease_steps",
    set: (a, t) => a.prompt.sections["strategy.disease_steps"] = t,
  },
];

/**
 * Messages about a value's relation to other answers, not its characters:
 * a duplicate, a label another trait has, a marker term that repeats a
 * disease phrase, a gene symbol in public text. The rules judge one value
 * alone, so these are left out of the agreement.
 */
const RELATIONAL =
  /twice|is already another|repeats a disease phrase|is a gene symbol/;

/** Whether validate() reports a format problem on the case's path for this text. */
function flagged(c: Case, text: string): boolean {
  const answers = structuredClone(EXAMPLEITIS);
  c.set(answers, text);
  return validate(answers).some((issue) =>
    covers(c.path, issue.field) && !RELATIONAL.test(issue.message)
  );
}

const ALPHABET = [
  "E",
  "-",
  " ",
  "\u00a0",
  '"',
  ",",
  "{",
  "#",
  "\n",
  "0",
  "1",
  "7",
  "é",
  "@",
  ".",
  "x",
  "e",
  "_",
  "/",
  ":",
  "[",
  "\r",
  "\t",
  "\u2028",
  "\u2029",
  "\u200b",
];
const SAMPLES = [
  "Example-itis",
  "example_itis",
  "2fast",
  "  exampleitis ",
  "exampleitis",
  "https://example.org",
  "example.org",
  "HTTPS://example.org",
  "https://",
  "ada@example.org",
  "ada@example",
  "ada",
  "@example.org",
  "ada@",
  "Ada <ada@example.org>",
  "a@b@c",
  '"exampleitis"',
  "vascular dementia",
  "small-vessel",
  "small-vessel, dementia",
  ",",
  "Alzheimer’s",
  "PMID: 12345678",
  "OMIM: 600001",
  "61716",
  "6171680",
  "617168",
  "#600001",
  "0123",
  "1e-1",
  "0,75",
  "0x1",
  "1.5",
  "0.",
  ".",
  "## Heading",
  "a {{slot}}",
  "step one\nmore",
  "step one\n\nstep two",
  "  ## x",
  "one\n\n  ## two",
  "all",
  " All ",
  "(none)",
  "APP,",
  "APP, PSEN1",
  "x\u200by",
  "exampleitis[tiab]",
  "a OR b",
  "Ornithine",
  "small  vessel",
  "beh\u00e7et",
  "mailto:ada@example.org",
  "ada@example.org,",
  "<ada@example.org",
  "https//www.example.org",
  "https:/www.example.org",
  "https:www.example.org",
  "htps://www.example.org",
  "https://https:www.example.org",
  "https://ada@example.org",
  "10.1000/xyz123",
  "https://doi.org/10.1000/xyz123",
  "doi:10.1000/xyz123",
  "DOI: 10.1000/xyz123",
  "Sj\u00f6gren\u2013Larsson syndrome",
  "a\u2028## b",
  "__proto__",
  "include_validated",
  'include_x" y="z',
  "exclude_background",
  "x (y",
  "N/A",
  "EX{{D",
  // Taking the invisible character out would write a slot, or a heading.
  "T{​{1",
  "a{​{b",
  "#​# x",
  "##\nx",
  "a very long trait label here",
  "caf\u0065\u0301",
];

/** Every string of up to two characters, the samples, and seeded noise. */
function texts(): string[] {
  const out = [...SAMPLES];
  for (const a of ALPHABET) {
    out.push(a);
    for (const b of ALPHABET) out.push(a + b);
  }
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 300; n++) {
    let s = "";
    const length = 3 + Math.floor(next() * 8);
    for (let i = 0; i < length; i++) {
      s += ALPHABET[Math.floor(next() * ALPHABET.length)];
    }
    out.push(s);
  }
  return out;
}

Deno.test("every rule agrees with validate(), and every fix passes both", () => {
  const all = texts();
  for (const c of CASES) {
    for (const text of all) {
      if (text.trim() === "") continue;
      const d = diagnose(c.rule, text);
      const label = `${c.path} ${JSON.stringify(text)}`;
      assertEquals(d.ok, !flagged(c, text), label);
      if (d.offences.length > 0) {
        assert(!d.ok, `an offence implies a failure: ${label}`);
        assert(d.message !== null, `an offence is named: ${label}`);
        const from = text.length - text.trimStart().length;
        const to = text.trimEnd().length;
        for (const o of d.offences) {
          assert(
            o.start >= from && o.end <= to,
            `inside the trimmed text: ${label}`,
          );
        }
        // Final: nothing typed after it clears it.
        for (const suffix of ["", "x", "1", " ", "e", "a"]) {
          assert(
            diagnose(c.rule, text + suffix).offences.length > 0,
            `final: ${label}+${suffix}`,
          );
        }
      }
      if (d.fix !== null) {
        assert(
          diagnose(c.rule, d.fix).ok,
          `the fix passes: ${label} -> ${d.fix}`,
        );
        assert(
          !flagged(c, d.fix),
          `validate() takes the fix: ${label} -> ${d.fix}`,
        );
      }
    }
  }
});

Deno.test("a trait key's gaps are single spaces, and it opens no heading", () => {
  const gap = diagnose("traitKey", "T \t 1");
  assertEquals(gap.ok, false);
  assertEquals(gap.fix, "T 1");
  assertEquals(diagnose("traitKey", "T\u00a01").fix, "T 1");
  assertEquals(diagnose("traitKey", "T 1").ok, true);
  const heading = diagnose("traitKey", "## T1");
  assertEquals(heading.offences.map((o) => o.char), ["#"]);
  assertEquals(heading.fix, null);
  // A hidden character before the "#" is fixable only to a key that
  // still opens a heading, so nothing is offered.
  assertEquals(diagnose("traitKey", "\u200b#T").fix, null);
  // One between two braces is fixable only to a slot, likewise.
  assertEquals(diagnose("traitKey", "T{\u200b{1").fix, null);
  assertEquals(diagnose("slotless", "a{\u200b{b").fix, null);
  assertEquals(diagnose("slotless", "a\u200bb").fix, "ab");
});

Deno.test("the key names each character it cannot hold and offers the key", () => {
  const d = diagnose("key", "Example-itis");
  assertEquals(
    d.message,
    '"E" and "-" can\'t be used here: lower-case letters, digits and underscores only.',
  );
  assertEquals(d.offences.map((o) => [o.start, o.char]), [[0, "E"], [7, "-"]]);
  assertEquals(d.fix, "example_itis");
  assertEquals(
    diagnose("key", "2fast").message,
    'It has to start with a letter, not "2".',
  );
  assertEquals(diagnose("key", "2fast").fix, null);
  assertEquals(diagnose("key", "   "), {
    ok: true,
    offences: [],
    message: null,
    note: null,
    fix: null,
  });
  assertEquals(
    diagnose("exampleType", "Include-Validated").message,
    '"I", "-" and "V" can\'t be used here: lower-case letters, digits and underscores only, e.g. include_validated.',
  );
});

Deno.test("an incomplete email or URL gets a note, and a fix where one exists", () => {
  assertEquals(
    diagnose("email", "ada").note,
    'Still needed: an "@" and a domain, e.g. name@example.org.',
  );
  assertEquals(
    diagnose("email", "@example.org").note,
    'Still needed: the name before the "@".',
  );
  assertEquals(
    diagnose("email", "ada@").note,
    'Still needed: the domain after the "@", e.g. example.org.',
  );
  assertEquals(
    diagnose("email", "ada@example").note,
    "Still needed: the rest of the domain, e.g. example.org.",
  );
  const named = diagnose("email", "Ada <ada@example.org>");
  assertEquals(
    named.message,
    'A space can\'t be used in an email address. "<" and ">" can\'t be used in an email address.',
  );
  assertEquals(named.fix, "ada@example.org");
  // A mailto: link's address, and one copied with the comma after it.
  assertEquals(
    diagnose("email", "mailto:ada@example.org").fix,
    "ada@example.org",
  );
  assertEquals(diagnose("email", "ada@example.org,").fix, "ada@example.org");
  assertEquals(diagnose("email", "ada@example.org,").ok, false);
  assertEquals(
    diagnose("email", "a@b@c.org").message,
    '"@" appears once in an address.',
  );
  assertEquals(diagnose("url", "example.org").fix, "https://example.org");
  assertEquals(diagnose("url", "example").fix, null);
  assertEquals(
    diagnose("url", "HTTPS://example.org").fix,
    "https://example.org",
  );
  assertEquals(
    diagnose("url", "https://").note,
    "Still needed: the address after the scheme.",
  );
  assertEquals(
    diagnose("url", "https://a b").message,
    "A web address can't hold a space.",
  );
  // A scheme one slip from https:// is written whole, not put behind another.
  for (
    const typo of [
      "https//www.example.org",
      "https:/www.example.org",
      "https:www.example.org",
      "htps://www.example.org",
    ]
  ) {
    assertEquals(diagnose("url", typo).fix, "https://www.example.org", typo);
  }
  assertEquals(diagnose("url", "https://https:www.example.org").ok, false);
  assertEquals(diagnose("url", "https://https:www.example.org").fix, null);
  assertEquals(diagnose("url", "mailto:ada@example.org").fix, null);
  assertEquals(diagnose("url", "https://localhost").ok, false);
});

Deno.test("an address is checked in time proportional to its length", () => {
  const long = "a@" + "a.".repeat(50_000) + "!";
  const started = performance.now();
  assertEquals(emailOk(long), false);
  assertEquals(diagnose("email", long).ok, false);
  assert(performance.now() - started < 200, "a linear check");
  // The fix reads the punctuation off the end once: as a pattern with no
  // anchor at its start, it read a run inside the value from every place in it.
  for (
    const inside of [
      "a@b.cd" + ",".repeat(100_000) + "x",
      "a@b" + ".".repeat(100_000) + "x",
    ]
  ) {
    const from = performance.now();
    assertEquals(diagnose("email", inside).fix, null);
    assert(performance.now() - from < 200, inside.slice(0, 12));
  }
  // The address before the punctuation is still the one offered.
  assertEquals(diagnose("email", "ada@example.org.;").fix, "ada@example.org");
  assertEquals(
    diagnose("email", "ada@example.org" + ",".repeat(100_000)).fix,
    "ada@example.org",
  );
});

Deno.test("lists, numbers and confidences offer the value they meant", () => {
  assertEquals(
    diagnose("conditions", "small-vessel, dementia").fix,
    "small vessel, dementia",
  );
  assertEquals(
    diagnose("conditions", ",").note,
    "Still needed: at least one condition.",
  );
  assertEquals(diagnose("condition", "small-vessel").fix, "small vessel");
  assertEquals(diagnose("condition", "--").fix, null);
  // Two spaces in a row never match, and an accent comes off rather than
  // taking its letter with it.
  const doubled = diagnose("condition", "small  vessel");
  assertEquals(doubled.offences.map((o) => o.start), [6]);
  assertEquals(doubled.fix, "small vessel");
  const accented = diagnose("condition", "beh\u00e7et");
  assertEquals(accented.fix, "behcet");
  assert(accented.message!.includes("unaccented"));
  // A fixed list keeps the separator it was typed up to.
  assertEquals(diagnose("conditions", "small-vessel, ").fix, "small vessel, ");
  assertEquals(diagnose("conditions", "small-vessel,").fix, "small vessel, ");
  assertEquals(diagnose("number", "PMID: 12345678").fix, "12345678");
  assertEquals(diagnose("number", "0123").message, "It can't start with 0.");
  assertEquals(diagnose("number", "0123").fix, "123");
  assertEquals(diagnose("number", "1-2").fix, null);
  assertEquals(diagnose("mim", "617168").ok, true);
  assertEquals(diagnose("mim", "61716").note, "An OMIM number is six digits.");
  assertEquals(diagnose("mim", "61716").offences, []);
  assertEquals(diagnose("mim", "6171680").ok, false);
  assertEquals(diagnose("mim", "#600001").fix, "600001");
  // A fix the field would still refuse is not offered.
  assertEquals(diagnose("mim", "PMID: 12345678").fix, null);
  assertEquals(diagnose("confidence", "0,75").fix, "0.75");
  assertEquals(
    diagnose("confidence", "1.5").note,
    "Still needed: a number from 0 to 1, e.g. 0.75.",
  );
  assertEquals(diagnose("symbol", "APP,").fix, "APP");
  assertEquals(diagnose("symbol", "APP, PSEN1").fix, null);
  assertEquals(diagnose("quoteless", '"exampleitis"').fix, "exampleitis");
  assertEquals(diagnose("quoteless", '""').fix, null);
  // The search tags each phrase itself, and joins the phrases itself.
  assertEquals(diagnose("quoteless", "exampleitis[tiab]").fix, "exampleitis");
  const joined = diagnose("quoteless", "exampleitis OR example");
  assertEquals([joined.ok, joined.offences.length], [false, 0]);
  assertEquals(diagnose("quoteless", "Ornithine").ok, true);
  assertEquals(diagnose("ctgovTerm", "exampleitis [x]").fix, "exampleitis");
  assertEquals(diagnose("ctgovTerm", "exampleitis (early").offences, []);
  assertEquals(diagnose("ctgovTerm", "exampleitis (early").ok, false);
  assertEquals(diagnose("ctgovTerm", "exampleitis (early onset)").ok, true);
  assertEquals(
    diagnose("doi", "https://doi.org/10.1000/xyz123").fix,
    "10.1000/xyz123",
  );
  assertEquals(diagnose("doi", "DOI: 10.1000/xyz123").fix, "10.1000/xyz123");
  assertEquals(diagnose("doi", "10.1000/xyz123").ok, true);
  assertEquals(
    diagnose("ascii", "Sj\u00f6gren\u2013Larsson\u00a0syndrome").fix,
    "Sjogren-Larsson syndrome",
  );
  assertEquals(diagnose("plain", "a\u200bb").fix, "ab");
  assertEquals(
    diagnose("plain", "a\u200bb").message!.startsWith("U+200B"),
    true,
  );
  assertEquals(diagnose("plainKey", "__proto__").ok, false);
  assertEquals(diagnose("traitKey", "T{{1").offences.map((o) => o.char), [
    "{{",
  ]);
  assertEquals(diagnose("traitLabel", "x".repeat(21)).ok, false);
  assertEquals(diagnose("traitLabel", "x".repeat(20)).ok, true);
  assertEquals(diagnose("slotless", "EX{{D").fix, null);
  assertEquals(diagnose("exampleType", "exclude_background").ok, false);
  assertEquals(diagnose("exampleType", "exclude_background").fix, null);
  assertEquals(
    diagnose("traitKey", "T1,T2").message,
    "A comma can't be used: the filters would read two keys.",
  );
  assertEquals(diagnose("traitKey", "all").ok, false);
  assertEquals(diagnose("reservedKey", "(none)").ok, false);
});

Deno.test("prompt sections mark slots, headings and a broken step", () => {
  const section = diagnose("section", "a {{x}}\n## b");
  assertEquals(section.offences.map((o) => o.char), ["{{", "## "]);
  assertEquals(
    section.message,
    '"{{" can\'t be used: the prompt reads it as a slot. A line can\'t start with "## ": it would read as a new section heading.',
  );
  // A line break is a fault in a section spliced into one line, and the
  // fix joins the lines.
  const inline = diagnose("inline", "mouse Genea\n  zebrafish genea");
  assertEquals(inline.offences.map((o) => o.char), ["\n"]);
  assertEquals(inline.fix, "mouse Genea zebrafish genea");
  // Joined, a first line of "##" alone would open a heading: no fix.
  assertEquals(diagnose("inline", "##\nx").fix, null);
  // "## " opening the trimmed text is a heading, as the file holds it.
  assertEquals(
    diagnose("section", "  ## heading").offences.map((o) => o.char),
    ["## "],
  );
  const steps = diagnose("steps", "one\ntwo\n\n  ## three");
  assertEquals(steps.offences.map((o) => o.char), ["\n", "## "]);
  assert(
    steps.message!.endsWith(
      "Each step is one paragraph: join its lines, or leave a blank line between two steps.",
    ),
  );
  assertEquals(diagnose("steps", "one\n\ntwo").offences, []);
  // A heading mid-paragraph, on the line right after a line break rather
  // than at the paragraph's own start.
  assertEquals(
    diagnose("steps", "one\n## two").offences.map((o) => o.char),
    ["\n", "## "],
  );
  // A blank leading paragraph (two paragraph breaks in a row) is skipped
  // rather than read as an empty step.
  assertEquals(diagnose("steps", "\n\nstep").offences, []);
});

Deno.test("blank text is clean for every rule that trims first", () => {
  const BLANK_CLEAN: Rule[] = [
    "url",
    "email",
    "quoteless",
    "ctgovTerm",
    "traitKey",
    "traitLabel",
    "reservedKey",
    "plainKey",
    "plain",
    "plainLines",
    "slotless",
    "slotlessLines",
    "ascii",
    "doi",
    "inline",
    "condition",
    "conditions",
    "symbol",
    "number",
    "mim",
    "confidence",
    "section",
    "steps",
  ];
  for (const rule of BLANK_CLEAN) {
    assertEquals(diagnose(rule, "   "), {
      ok: true,
      offences: [],
      message: null,
      note: null,
      fix: null,
    }, rule);
  }
});

Deno.test("ruleFor maps each field path to its rule", () => {
  assertEquals(ruleFor("disease.key"), "key");
  assertEquals(ruleFor("conditionPairs[2].1"), "condition");
  assertEquals(ruleFor("sections.strategy.disease_steps"), "steps");
  assertEquals(ruleFor("sections.rubric.modifiers"), "section");
  assertEquals(ruleFor("sections.persona.specificity"), "inline");
  assertEquals(ruleFor("disease.name"), "slotless");
  assertEquals(ruleFor("site.pages.genes"), "plainLines");
  assertEquals(ruleFor("families[0].label"), "plain");
  assertEquals(ruleFor("omimRows[0].inheritance"), "ascii");
  assertEquals(ruleFor("omimRows[0].omimNum"), "mim");
  assertEquals(ruleFor("rows[0].pmid"), "number");
  assertEquals(ruleFor("citationStandard.doi"), "doi");
  assertEquals(ruleFor("traits[0].family"), null);
});

Deno.test("nameChar names what a reader cannot see", () => {
  assertEquals(nameChar(" "), "a space");
  assertEquals(nameChar("\u00a0"), "a non-breaking space");
  assertEquals(nameChar("\n"), "a line break");
  assertEquals(nameChar("\t"), "a tab");
  assertEquals(nameChar("\u200b"), "U+200B");
  assertEquals(nameChar("\u00e9"), '"\u00e9"');
  // An accent left alone by a decomposed spelling is named, not quoted.
  assertEquals(nameChar("\u0301"), "a combining mark (U+0301)");
  assertEquals(toKey("\u00c9xample Itis!"), "example_itis");
  assertEquals(toKey("!!"), null);
  // A ligature and a letter with no decomposition keep their letters.
  assertEquals(toKey("cystic \ufb01brosis"), "cystic_fibrosis");
  assertEquals(toKey("\u0141a\u0144cut"), "lancut");
});

Deno.test("a line break is an offence in an answer typed on one line", () => {
  // An <input> shows none, so the field names it and offers the one line.
  const name = diagnose("slotless", "exampleitis\n\n## 0. First\n\n    run");
  assertEquals(name.ok, false);
  assertEquals(name.offences.map((o) => o.char), ["\n", "\n", "\n", "\n"]);
  assertEquals(
    name.message,
    "A line break can't be used: this answer is one line.",
  );
  assertEquals(name.fix, "exampleitis ## 0. First run");
  assertEquals(diagnose("plain", "one \n two").fix, "one two");
  assertEquals(
    diagnose("plain", "one\n​two").message,
    "A line break can't be used: this answer is one line. U+200B can't be used: an invisible character would reach the files unseen.",
  );
  assertEquals(diagnose("plain", "one\n​two").fix, "one two");
  assertEquals(diagnose("traitLabel", "T\n1").fix, "T 1");
  assertEquals(diagnose("reservedKey", "a\nll").ok, false);
  assertEquals(diagnose("plainKey", "E\nC").fix, "E C");
  assertEquals(
    diagnose("quoteless", "example\ndisease").fix,
    "example disease",
  );
  assertEquals(
    diagnose("quoteless", "example\ndisease").message,
    "A line break can't be used: this answer is one line.",
  );
  // Joined, the lines can read as the search's own syntax: no fix.
  assertEquals(diagnose("quoteless", "example\nOR\ndisease").fix, null);
  assertEquals(
    diagnose("ctgovTerm", "exampleitis\n[x] (early)").fix,
    "exampleitis (early)",
  );
  assertEquals(diagnose("ctgovTerm", "example\nitis").fix, "example itis");
  // One at either end is trimmed off the answer, as the files write it.
  assertEquals(diagnose("plain", "\none two\n").ok, true);
  // The boxes of several lines keep theirs.
  assertEquals(diagnose("plainLines", "one\ntwo").ok, true);
  assertEquals(diagnose("plainLines", "one\n​two").fix, "one\ntwo");
  assertEquals(diagnose("slotlessLines", "one\ntwo").ok, true);
  assertEquals(diagnose("slotlessLines", "one\n{{two").fix, null);
  assertEquals(ruleFor("site.title"), "plain");
  assertEquals(ruleFor("site.heading"), "plainLines");
  assertEquals(ruleFor("traits[0].definition"), "plainLines");
  assertEquals(ruleFor("traits[0].name"), "plain");
  assertEquals(ruleFor("populations[0].lines"), "plainLines");
  assertEquals(ruleFor("populations[0].label"), "plain");
  assertEquals(ruleFor("examples[0].sentence"), "slotlessLines");
  assertEquals(ruleFor("examples[0].reasoning"), "slotless");
});

Deno.test("a fix is offered only when the field would take it", () => {
  // A scheme slip with nothing after it has no address to offer.
  assertEquals(diagnose("url", "https//").fix, null);
  assertEquals(
    diagnose("url", "http//www.example.org").fix,
    "http://www.example.org",
  );
  // Taking the invisible character out must leave a value the field takes.
  assertEquals(diagnose("plainKey", "__proto__\u200b").fix, null);
  assertEquals(diagnose("plainKey", "\u200b").fix, null);
  assertEquals(diagnose("plainKey", "E\u200bC").fix, "EC");
  assertEquals(
    diagnose("traitLabel", "x".repeat(25) + "\u200b").fix,
    null,
  );
  assertEquals(diagnose("traitLabel", "T\u200b1").fix, "T1");
  assertEquals(diagnose("reservedKey", "all\u200b").fix, null);
  assertEquals(diagnose("reservedKey", "Ea\u200brly").fix, "Early");
});
