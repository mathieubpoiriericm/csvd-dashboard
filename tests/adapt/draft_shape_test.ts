import { assertEquals } from "@std/assert";

import {
  aligned,
  bool,
  count,
  dict,
  file,
  list,
  nullable,
  nullIfBlank,
  num,
  obj,
  pair,
  rebuild,
  str,
} from "../../lib/adapt/draft_shape.ts";

// Shapes the answers do not use, so every kind is read as an entry and as a
// nullable value here, where parseDraft's own shape never asks.
Deno.test("a list of lists and a list of nullables keep every entry of their kind", () => {
  assertEquals(rebuild(list(list(str)), [["a", "b"], ["c"], "d"]), {
    value: [["a", "b"], ["c"]],
    dropped: ["[2]"],
  });
  assertEquals(rebuild(list(nullable(str)), ["a", null, 3]), {
    value: ["a", null],
    dropped: ["[2]"],
  });
  assertEquals(rebuild(nullable(list(str)), ["a"]), {
    value: ["a"],
    dropped: [],
  });
  assertEquals(rebuild(list(nullable(obj({ a: str }))), [{ a: "x" }, null]), {
    value: [{ a: "x" }, null],
    dropped: [],
  });
});

const EVERY_KIND = obj({
  s: str,
  n: num,
  b: bool,
  c: count,
  x: nullIfBlank,
  p: nullable(str),
  l: list(str),
  d: dict,
  f: file(3),
  o: obj({ a: str }),
});
const EMPTY = {
  s: "",
  n: NaN,
  b: false,
  c: null,
  x: null,
  p: null,
  l: [],
  d: {},
  f: null,
  o: { a: "" },
};

Deno.test("a value of another kind takes the empty value, and its path is named", () => {
  assertEquals(
    rebuild(EVERY_KIND, {
      s: 1,
      n: "1",
      b: "true",
      c: "1",
      x: 1,
      p: 1,
      l: 1,
      d: [],
      f: "logo.svg",
      o: "a",
    }),
    {
      value: EMPTY,
      dropped: ["s", "n", "b", "c", "x", "p", "l", "d", "f", "o"],
    },
  );
  assertEquals(rebuild(EVERY_KIND, 3), { value: EMPTY, dropped: [""] });
});

Deno.test("a missing or null value held no answer, so nothing is named", () => {
  assertEquals(rebuild(EVERY_KIND, {}), { value: EMPTY, dropped: [] });
  assertEquals(
    rebuild(
      EVERY_KIND,
      Object.fromEntries(Object.keys(EMPTY).map((key) => [key, null])),
    ),
    { value: EMPTY, dropped: [] },
  );
  assertEquals(rebuild(EVERY_KIND, null), { value: EMPTY, dropped: [] });
});

Deno.test("a key the shape does not name is left behind unnamed", () => {
  assertEquals(rebuild(obj({ a: str }), { a: "x", gone: 1 }), {
    value: { a: "x" },
    dropped: [],
  });
});

Deno.test("a number is finite, and an unset one is NaN", () => {
  // JSON writes NaN as null, and reads 1e400 as Infinity, which no field
  // could have held.
  assertEquals(rebuild(obj({ n: num }), { n: 0.5 }).value, { n: 0.5 });
  assertEquals(rebuild(obj({ n: num }), JSON.parse('{"n":1e400}')), {
    value: { n: NaN },
    dropped: ["n"],
  });
});

Deno.test("a count is a whole number of at least zero, or null", () => {
  assertEquals(
    rebuild(list(count), [0, 12, null, -1, 2.5, JSON.parse("-1e400"), "3"]),
    {
      value: [0, 12, null, null, null, null],
      dropped: ["[3]", "[4]", "[5]", "[6]"],
    },
  );
});

Deno.test("nullIfBlank reads a blank string as null, as a form stores a cleared field", () => {
  assertEquals(rebuild(list(nullIfBlank), ["HP:1", "", " \t", null, 2]), {
    value: ["HP:1", null, null, null],
    dropped: ["[4]"],
  });
});

Deno.test("a file holds at least one byte and at most its cap, and decodes", () => {
  const shape = obj({ f: file(3) });
  const kept = { name: "a.png", base64: btoa("abc") };
  assertEquals(rebuild(shape, { f: { ...kept, extra: 1 } }), {
    value: { f: kept },
    dropped: [],
  });
  for (
    const f of [
      { name: "a.png", base64: btoa("abcd") },
      { name: "a.png", base64: "" },
      { name: "a.png", base64: "not base64!" },
      { name: 1, base64: btoa("a") },
      { name: "a.png" },
    ]
  ) {
    assertEquals(rebuild(shape, { f }), { value: { f: null }, dropped: ["f"] });
  }
});

Deno.test("a pair is two words, whatever it held", () => {
  assertEquals(
    rebuild(list(pair), [
      ["a", "b"],
      ["a"],
      ["a", "b", "c"],
      [["x"], "b"],
      "ab",
    ]),
    {
      value: [["a", "b"], ["a", ""], ["a", "b"], ["", "b"]],
      dropped: ["[1]", "[2]", "[3][0]", "[4]"],
    },
  );
});

Deno.test("a dict keeps its strings under their own keys", () => {
  assertEquals(
    rebuild(obj({ d: dict }), { d: { "a.b": "x", c: 2, d: null } }),
    { value: { d: { "a.b": "x" } }, dropped: ["d.c"] },
  );
});

Deno.test("one entry where a list belongs is a list of it", () => {
  assertEquals(rebuild(list(str), "a"), { value: ["a"], dropped: [] });
  assertEquals(rebuild(list(obj({ a: str })), { a: "x" }), {
    value: [{ a: "x" }],
    dropped: [],
  });
  // A null is no entry, whatever the list holds.
  assertEquals(rebuild(list(nullable(str)), null), { value: [], dropped: [] });
});

Deno.test("an aligned list keeps an unreadable entry's place as its empty value", () => {
  assertEquals(rebuild(aligned(str), ["a", 7, "b"]), {
    value: ["a", "", "b"],
    dropped: ["[1]"],
  });
  assertEquals(
    rebuild(aligned(obj({ a: str, n: count })), [null, { a: "x", n: 2 }]),
    { value: [{ a: "", n: null }, { a: "x", n: 2 }], dropped: [] },
  );
  // Anything but a list is still the empty list, not one empty entry.
  assertEquals(rebuild(aligned(str), 7), { value: [], dropped: [""] });
});

Deno.test("a list of numbers keeps the numbers, and a lone pair field its words", () => {
  assertEquals(rebuild(list(num), [1, "a", 2]), {
    value: [1, 2],
    dropped: ["[1]"],
  });
  assertEquals(rebuild(obj({ p: pair }), { p: "ab" }), {
    value: { p: ["", ""] },
    dropped: ["p"],
  });
  assertEquals(rebuild(obj({ p: pair }), {}), {
    value: { p: ["", ""] },
    dropped: [],
  });
});
