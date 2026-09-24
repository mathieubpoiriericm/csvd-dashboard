import { assertEquals, assertThrows } from "@std/assert";

import {
  type Schema,
  schemaErrors,
  unhandledKeywords,
} from "../../lib/adapt/schema.ts";

const ROOT: Schema = {
  $defs: { term: { type: "string", minLength: 1 } },
  type: "object",
  additionalProperties: false,
  required: ["name", "terms"],
  properties: {
    name: { type: "string", pattern: "^[a-z]+$" },
    terms: { type: "array", minItems: 1, items: { $ref: "#/$defs/term" } },
    version: { const: 1 },
    flag: { type: ["boolean", "null"] },
    nested: { type: "object", additionalProperties: { type: "integer" } },
    either: { oneOf: [{ type: "null" }, { type: "string" }] },
  },
};

const check = (value: unknown) => schemaErrors(ROOT, value, ROOT, "doc");

Deno.test("a conforming document yields no errors", () => {
  assertEquals(
    check({
      name: "abc",
      terms: ["x"],
      version: 1,
      flag: null,
      nested: { a: 1 },
      either: "s",
    }),
    [],
  );
});

Deno.test("a wrong type stops the walk at that node", () => {
  assertEquals(check({ name: 3, terms: ["x"] }), [
    "doc.name: expected string, got integer",
  ]);
});

Deno.test("pattern, minLength, minItems, const and $ref are reported", () => {
  assertEquals(check({ name: "A1", terms: [], version: 2 }), [
    "doc.name: does not match ^[a-z]+$",
    "doc.terms: fewer than 1 items",
    "doc.version: must be 1",
  ]);
  assertEquals(check({ name: "a", terms: [""] }), [
    "doc.terms[0]: shorter than 1",
  ]);
});

Deno.test("required, unknown and additionalProperties-typed keys are reported", () => {
  assertEquals(check({ terms: ["x"], stray: 1, nested: { a: "no" } }), [
    "doc.name: required, missing",
    "doc.stray: not allowed",
    "doc.nested.a: expected integer, got string",
  ]);
});

Deno.test("oneOf passes when exactly one branch passes", () => {
  assertEquals(check({ name: "a", terms: ["x"], either: null }), []);
  assertEquals(check({ name: "a", terms: ["x"], either: 4 }), [
    "doc.either: matches no oneOf branch",
  ]);
});

Deno.test("a node with no type accepts any value and a union type accepts each member", () => {
  assertEquals(check({ name: "a", terms: ["x"], flag: true }), []);
  assertEquals(check({ name: "a", terms: ["x"], flag: "no" }), [
    "doc.flag: expected boolean|null, got string",
  ]);
});

Deno.test("oneOf fails when more than one branch passes", () => {
  const overlap: Schema = {
    oneOf: [{ type: "string" }, { type: "string", minLength: 1 }],
  };
  assertEquals(schemaErrors(overlap, "a", overlap, "doc"), [
    "doc: matches more than one oneOf branch",
  ]);
  assertEquals(schemaErrors(overlap, "", overlap, "doc"), []);
});

Deno.test("maxItems, minimum and the other bounds are reported", () => {
  const bounded: Schema = {
    type: "object",
    properties: {
      pair: { type: "array", maxItems: 2 },
      cap: { type: "integer", minimum: 1, maximum: 9 },
      open: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      word: { type: "string", maxLength: 2 },
    },
  };
  assertEquals(
    schemaErrors(
      bounded,
      {
        pair: ["a", "b", "c"],
        cap: 0,
        open: 1,
        word: "abc",
      },
      bounded,
      "doc",
    ),
    [
      "doc.pair: more than 2 items",
      "doc.cap: minimum 1",
      "doc.open: exclusiveMaximum 1",
      "doc.word: longer than 2",
    ],
  );
  assertEquals(
    schemaErrors(bounded, { cap: 10, open: 0 }, bounded, "doc"),
    ["doc.cap: maximum 9", "doc.open: exclusiveMinimum 0"],
  );
});

Deno.test("a number takes an integer, a length counts code points, a pattern reads Unicode", () => {
  const node: Schema = {
    type: "object",
    properties: {
      n: { type: "number" },
      s: { type: "string", minLength: 2, maxLength: 2 },
      p: { type: "string", pattern: "^\\p{L}+$" },
    },
  };
  // Two astral characters are two characters, not four UTF-16 units.
  assertEquals(
    schemaErrors(
      node,
      { n: 3, s: "\u{1f600}\u{1f600}", p: "\u00e9t\u00e9" },
      node,
      "doc",
    ),
    [],
  );
});

Deno.test("an own key named like an object property is checked as any other", () => {
  const closed: Schema = {
    type: "object",
    additionalProperties: false,
    required: ["constructor", "toString"],
    properties: { a: { type: "string" } },
  };
  assertEquals(
    schemaErrors(
      closed,
      JSON.parse('{"constructor":1,"toString":2}'),
      closed,
      "doc",
    ),
    ["doc.constructor: not allowed", "doc.toString: not allowed"],
  );
  assertEquals(schemaErrors(closed, {}, closed, "doc"), [
    "doc.constructor: required, missing",
    "doc.toString: required, missing",
  ]);
});

Deno.test("a keyword it does not handle, or a $ref it cannot resolve, throws", () => {
  const unknown: Schema = { type: "string", format: "email" };
  assertThrows(() => schemaErrors(unknown, "a", unknown, "doc"));
  const dangling: Schema = { $ref: "#/$defs/nothing" };
  assertThrows(() => schemaErrors(dangling, "a", dangling, "doc"));
  assertEquals(unhandledKeywords(unknown), ["format"]);
});

Deno.test("every keyword the committed schemas use is handled", async () => {
  for (const name of ["manifest.schema.json", "pipeline.schema.json"]) {
    const schema = JSON.parse(
      await Deno.readTextFile(
        new URL(`../../disease/${name}`, import.meta.url),
      ),
    );
    assertEquals(unhandledKeywords(schema), [], name);
  }
});

Deno.test("enum takes one of its values", () => {
  const node: Schema = { enum: ["a", 1] };
  assertEquals(schemaErrors(node, 1, node, "doc"), []);
  assertEquals(schemaErrors(node, "b", node, "doc"), [
    'doc: must be one of ["a",1]',
  ]);
});
