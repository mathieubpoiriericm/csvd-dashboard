import { assertEquals, assertThrows } from "@std/assert";

import {
  acronymTooltip,
  CLARIFICATION_MARK,
  clarificationTooltip,
  glossaryGaps,
  splitAcronyms,
  uncoveredAcronyms,
} from "../lib/acronyms.ts";
import { ACRONYMS, resolveAcronyms } from "../lib/disease/acronyms.ts";
import { sampleGene } from "./fixtures/rows.ts";

const GENERIC = { AB: { name: "Alpha Beta", kind: "k1" } };

const G = new Map([
  ["AB", { name: "Alpha Beta", kind: "k1" }],
  ["AB-CD", { name: "Alpha Beta Charlie Delta", kind: "k1" }],
  ["X1", { name: "Xray One", kind: "k2" }],
  ["P/Q", { name: "Papa Quebec", kind: "k2" }],
]);

Deno.test("splitAcronyms boxes whole glossary terms, longest first", () => {
  assertEquals(splitAcronyms("AB-CD and AB (X1), P/Q", G), [
    { text: "AB-CD", acronym: true },
    { text: " and ", acronym: false },
    { text: "AB", acronym: true },
    { text: " (", acronym: false },
    { text: "X1", acronym: true },
    { text: "), ", acronym: false },
    { text: "P/Q", acronym: true },
  ]);
});

Deno.test("splitAcronyms boxes an acronym before a hyphenated word, not before another code", () => {
  assertEquals(splitAcronyms("AB-based", G), [
    { text: "AB", acronym: true },
    { text: "-based", acronym: false },
  ]);
  assertEquals(splitAcronyms("AB-X9", G), [{ text: "AB-X9", acronym: false }]);
});

Deno.test("uncoveredAcronyms leaves out a term marked as awaiting clarification", () => {
  assertEquals(uncoveredAcronyms("ZZ9[?] and QQ-RR[?], ZZ8", G), ["ZZ8"]);
});

Deno.test("clarificationTooltip says the point is open, whatever the mark stands for", () => {
  // The mark follows an unconfirmed term, an item whose colocalization is
  // unclear, or stands where the source gives no biomarker at all.
  assertEquals(clarificationTooltip(), {
    rows: [{
      label: "Needs clarification",
      value:
        "The curated source leaves this point unclear, and the curators have yet to settle it.",
    }],
  });
  assertEquals(CLARIFICATION_MARK, "[?]");
});

Deno.test("splitAcronyms never boxes part of a word", () => {
  assertEquals(splitAcronyms("ABC xAB", G), [
    { text: "ABC xAB", acronym: false },
  ]);
  assertEquals(splitAcronyms("AB/X1", G).map((s) => s.text), [
    "AB",
    "/",
    "X1",
  ]);
  assertEquals(splitAcronyms("plain", new Map()), [
    { text: "plain", acronym: false },
  ]);
  assertEquals(splitAcronyms("", G), []);
});

Deno.test("a glossary key holding regex syntax matches literally", () => {
  const g = new Map([["A.B", { name: "Dotted", kind: "k" }]]);
  assertEquals(splitAcronyms("AxB A.B", g), [
    { text: "AxB ", acronym: false },
    { text: "A.B", acronym: true },
  ]);
});

Deno.test("acronymTooltip gives the name and kind, and colocalization when given", () => {
  assertEquals(acronymTooltip("AB", undefined, G), {
    rows: [{ label: "AB", value: "Alpha Beta · k1" }],
  });
  assertEquals(acronymTooltip("X1", "artery aorta", G), {
    rows: [
      { label: "X1", value: "Xray One · k2" },
      { label: "Significant colocalization", value: "artery aorta" },
    ],
  });
  assertEquals(acronymTooltip("ZZ", undefined, G), null);
});

Deno.test("uncoveredAcronyms reports acronym-like tokens the glossary lacks", () => {
  assertEquals(
    uncoveredAcronyms("AB, ZZ9 and Brain, AB-based, ZZ-based, c1, P/Q, ZZ9", G),
    ["ZZ9", "ZZ-based"],
  );
  assertEquals(uncoveredAcronyms("AB here", new Map()), ["AB"]);
});

Deno.test("glossaryGaps holds curated rows to the glossary and only reports extracted ones", () => {
  const rows = [
    sampleGene({
      gene: "G1",
      sourceQuote: "(not yet extracted)",
      gwasTrait: ["AB and ZZ1"],
    }),
    sampleGene({
      gene: "G2",
      sourceQuote: "A sentence.",
      evidenceFromOtherOmicsStudies: ["TWAS;QQ9: G2 tissue*, YY7[?] x"],
    }),
  ];
  const glossary = new Map([...G, ["TWAS", { name: "T", kind: "k" }]]);
  assertEquals(glossaryGaps(rows, glossary), {
    curated: ["G1: ZZ1"],
    extracted: ["G2: QQ9"],
  });
});

Deno.test("glossaryGaps reads the resolved glossary by default", () => {
  // TWAS is generic, so this holds on any disease's manifest and on empty data.
  const row = sampleGene({ evidenceFromOtherOmicsStudies: ["TWAS;QQ9: x"] });
  assertEquals(glossaryGaps([row]), { curated: [], extracted: ["GENE1: QQ9"] });
});

Deno.test("the defaults read the resolved glossary, generic terms included", () => {
  assertEquals(splitAcronyms("TWAS")[0], { text: "TWAS", acronym: true });
  assertEquals(acronymTooltip("TWAS")?.rows[0].label, "TWAS");
  assertEquals(uncoveredAcronyms("TWAS"), []);
  assertEquals(ACRONYMS.get("TWAS")?.kind, "omics methodology");
});

Deno.test("disease entries override generic ones and take a missing name from the vocabulary", () => {
  const map = resolveAcronyms(
    GENERIC,
    { AB: { name: null, kind: "k2" }, CD: { name: null, kind: "k3" } },
    new Map([["CD", "Charlie Delta"]]),
  );
  assertEquals(map.get("AB"), { name: "Alpha Beta", kind: "k2" });
  assertEquals(map.get("CD"), { name: "Charlie Delta", kind: "k3" });
});

Deno.test("a disease entry's own name wins over the vocabulary's", () => {
  const map = resolveAcronyms(
    {},
    { CD: { name: "Own", kind: "k" } },
    new Map([["CD", "Vocabulary"]]),
  );
  assertEquals(map.get("CD"), { name: "Own", kind: "k" });
});

Deno.test("an acronym nothing names is refused", () => {
  assertThrows(
    () => resolveAcronyms({}, { ZZ: { name: null, kind: "k" } }, new Map()),
    Error,
    "acronyms.ZZ has no name",
  );
});
