import { assertEquals } from "@std/assert";

import { formatLongDate, formatMonthYear } from "../lib/constants.ts";

Deno.test("formatLongDate formats valid timestamps in UTC", () => {
  assertEquals(formatLongDate("2026-08-28T23:30:00-04:00"), "August 29, 2026");
});

Deno.test("formatLongDate rejects absent and invalid dates", () => {
  assertEquals(formatLongDate(null), null);
  assertEquals(formatLongDate(undefined), null);
  assertEquals(formatLongDate(""), null);
  assertEquals(formatLongDate("not a date"), null);
});

Deno.test("formatMonthYear renders M/YYYY as Mon YYYY and leaves anything else alone", () => {
  assertEquals(formatMonthYear("7/2028"), "Jul 2028");
  assertEquals(formatMonthYear("12/2026"), "Dec 2026");
  assertEquals(formatMonthYear(" 01/2027 "), "Jan 2027");
  assertEquals(formatMonthYear("(unknown)"), "(unknown)");
  assertEquals(formatMonthYear("13/2028"), "13/2028");
});
