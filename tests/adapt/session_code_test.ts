import { assert, assertEquals } from "@std/assert";

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  formatCode,
  generateCode,
  normaliseCode,
  SESSION_TTL_MS,
} from "../../lib/adapt/session_code.ts";

const SAMPLE = "0123456789ABCDEFGHJK";

Deno.test("a generated code is twenty characters of the alphabet", () => {
  const code = generateCode();
  assertEquals(code.length, CODE_LENGTH);
  assert([...code].every((c) => CODE_ALPHABET.includes(c)));
});

Deno.test("a generated code maps each byte's low five bits to the alphabet", () => {
  const fill = (bytes: Uint8Array) => {
    bytes.forEach((_, i) => bytes[i] = i);
    return bytes;
  };
  assertEquals(generateCode(fill), SAMPLE);
});

Deno.test("a code is shown in four groups of five", () => {
  assertEquals(formatCode(SAMPLE), "01234-56789-ABCDE-FGHJK");
});

Deno.test("a code is read back leniently", () => {
  for (
    const input of [
      "01234-56789-ABCDE-FGHJK",
      " 01234 56789 abcde fghjk ",
      "O1234-56789-ABCDE-FGHJK",
      "0I234-56789-ABCDE-FGHJK",
      "0l234-56789-ABCDE-FGHJK",
    ]
  ) {
    assertEquals(normaliseCode(input), SAMPLE, input);
  }
});

Deno.test("anything that is not a code reads back as null", () => {
  assertEquals(normaliseCode(""), null);
  assertEquals(normaliseCode(SAMPLE.slice(0, 19)), null);
  assertEquals(normaliseCode(SAMPLE + "0"), null);
  assertEquals(normaliseCode("U" + SAMPLE.slice(1)), null);
  assertEquals(normaliseCode("!" + SAMPLE.slice(1)), null);
});

Deno.test("a session lives fourteen days", () => {
  assertEquals(SESSION_TTL_MS, 1_209_600_000);
});
