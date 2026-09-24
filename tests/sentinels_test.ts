import { assert, assertEquals } from "@std/assert";
import {
  ABSENT_SENTINELS,
  isAbsent,
  NONE,
  NONE_FOUND,
  NOT_YET_EXTRACTED,
  REFERENCE_NEEDED,
  UNKNOWN,
} from "../lib/sentinels.ts";
import { NONE_FOUND as CONSTANTS_NONE_FOUND } from "../lib/constants.ts";

Deno.test("the absent set is exactly the five named sentinels", () => {
  assertEquals(
    ABSENT_SENTINELS,
    new Set([NONE, NONE_FOUND, UNKNOWN, NOT_YET_EXTRACTED, REFERENCE_NEEDED]),
  );
  for (const s of ABSENT_SENTINELS) assert(isAbsent(s), s);
  // lib/constants.ts re-exports the one sentinel its filter choices name, so
  // the choice value and the absent check cannot drift apart.
  assertEquals(CONSTANTS_NONE_FOUND, NONE_FOUND);
});

Deno.test("isAbsent trims and matches whole values only", () => {
  assert(isAbsent("  (unknown) "));
  assert(!isAbsent("None"));
  assert(!isAbsent("(none) SVS"));
  assertEquals(isAbsent(""), false);
});
