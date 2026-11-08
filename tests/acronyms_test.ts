import { assertEquals, assertThrows } from "@std/assert";

import { resolveAcronyms } from "../lib/disease/acronyms.ts";

const GENERIC = { AB: { name: "Alpha Beta", kind: "k1" } };

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
