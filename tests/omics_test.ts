import { assertEquals } from "@std/assert";

import { formatOmicsValue } from "../lib/filters.ts";
import {
  colocalizedItems,
  colocalizedText,
  formatOmicsEntry,
  parseOmicsEntry,
} from "../lib/omics.ts";

Deno.test("parseOmicsEntry reads type, biomarker and starred items", () => {
  assertEquals(
    parseOmicsEntry(
      "TWAS;Q: nerve tibial, artery aorta*, YFS: blood*, CMC: brain (RNA-Seq)",
    ),
    {
      type: "TWAS",
      biomarker: "Q",
      items: [
        { text: "nerve tibial", colocalized: false },
        { text: "artery aorta", colocalized: true },
        { text: "YFS: blood", colocalized: true },
        { text: "CMC: brain (RNA-Seq)", colocalized: false },
      ],
    },
  );
});

Deno.test("parseOmicsEntry: no colon means no biomarker; commas in parentheses stay", () => {
  assertEquals(parseOmicsEntry("Proteomics"), {
    type: "Proteomics",
    biomarker: null,
    items: [],
  });
  assertEquals(parseOmicsEntry("TWAS;artery aorta*"), {
    type: "TWAS",
    biomarker: null,
    items: [{ text: "artery aorta", colocalized: true }],
  });
  assertEquals(parseOmicsEntry("TWAS;Q:whole blood (a, (b, c))*").items, [
    { text: "whole blood (a, (b, c))", colocalized: true },
  ]);
  assertEquals(parseOmicsEntry("TWAS;Q (x>1): a").biomarker, "Q (x>1)");
  assertEquals(parseOmicsEntry("  TWAS ; ").type, "TWAS");
  assertEquals(parseOmicsEntry("TWAS;Q:").items, []);
  // An empty biomarker slot: what pipeline/omics.py's to_wire writes when an
  // item carries a colon of its own.
  assertEquals(parseOmicsEntry("TWAS;: YFS: blood*"), {
    type: "TWAS",
    biomarker: null,
    items: [{ text: "YFS: blood", colocalized: true }],
  });
  assertEquals(parseOmicsEntry("TWAS;: a").biomarker, null);
});

Deno.test("formatOmicsEntry prints the format with no asterisk", () => {
  assertEquals(
    formatOmicsEntry(parseOmicsEntry("TWAS;Q:whole blood*, YFS: blood")),
    "TWAS (Q: whole blood, YFS: blood)",
  );
  assertEquals(
    formatOmicsValue("TWAS;Q:whole blood*, YFS: blood"),
    "TWAS (Q: whole blood, YFS: blood)",
  );
  assertEquals(formatOmicsValue("Proteogenomic MR;Q"), "Proteogenomic MR (Q)");
  assertEquals(formatOmicsValue("TWAS;Q:"), "TWAS (Q)");
  assertEquals(
    colocalizedItems(parseOmicsEntry("TWAS;Q: a*, b, c*")),
    ["a", "c"],
  );
});

Deno.test("a star in the type or the biomarker is no text either", () => {
  assertEquals(parseOmicsEntry("TWAS*;Q*: a").type, "TWAS");
  assertEquals(parseOmicsEntry("TWAS*;Q*: a").biomarker, "Q");
  assertEquals(formatOmicsValue("TWAS;Q*"), "TWAS (Q)");
});

Deno.test("colocalizedText names a colocalized item as printed, and nothing else", () => {
  const [plain, marked] = parseOmicsEntry("TWAS;Q: a, BB[?] c*").items;
  assertEquals(colocalizedText(plain), undefined);
  assertEquals(colocalizedText(marked), "BB? c");
});

Deno.test("text-only surfaces print the clarification mark as the cell does", () => {
  assertEquals(
    formatOmicsValue("TWAS;[?]: a, BB[?] c*"),
    "TWAS (?: a, BB? c)",
  );
  assertEquals(colocalizedItems(parseOmicsEntry("TWAS;Q: BB[?] c*")), [
    "BB? c",
  ]);
});
