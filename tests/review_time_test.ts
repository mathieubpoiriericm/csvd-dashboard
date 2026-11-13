import { assertEquals } from "@std/assert";

import { simulatedTime } from "../lib/review/time.ts";

Deno.test("simulated time counts days from the run", () => {
  assertEquals(
    simulatedTime("2026-01-08T09:12:00+00:00", "2026-01-05T19:58:24+00:00"),
    "Day 3, 09:12",
  );
  assertEquals(
    simulatedTime("2026-01-05T19:58:24+00:00", "2026-01-05T19:58:24+00:00"),
    "Day 0, 19:58",
  );
});

Deno.test("days are UTC calendar days, not elapsed hours", () => {
  assertEquals(
    simulatedTime("2026-01-06T00:05:00+00:00", "2026-01-05T23:59:00+00:00"),
    "Day 1, 00:05",
  );
  assertEquals(
    simulatedTime("2026-01-06T01:00:00+02:00", "2026-01-05T10:00:00+00:00"),
    "Day 0, 23:00",
  );
});
