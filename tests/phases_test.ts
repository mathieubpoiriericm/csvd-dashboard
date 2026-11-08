import { assertEquals } from "@std/assert";

import { parentPhase } from "../lib/phases.ts";

Deno.test("parentPhase collapses a lettered sub-phase onto its parent", () => {
  assertEquals(parentPhase("Ib"), "I");
  assertEquals(parentPhase("Ia"), "I");
  assertEquals(parentPhase("IIa"), "II");
  assertEquals(parentPhase("IIIb"), "III");
  assertEquals(parentPhase("IVa"), "IV");
  assertEquals(parentPhase("I/IIb"), "I/II");
});

Deno.test("parentPhase leaves every other phase as it is", () => {
  for (const phase of ["I", "II/III", "IV", "(unknown)", "Ic", "ib", "IIB"]) {
    assertEquals(parentPhase(phase), phase);
  }
  // Inside a word it is not a phase.
  assertEquals(parentPhase("Iberian"), "Iberian");
});
