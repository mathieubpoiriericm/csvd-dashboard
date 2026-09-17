import { assertEquals } from "@std/assert";

import { countBy, groupBy, indexBy, uniqueCount } from "../lib/collections.ts";

Deno.test("collection helpers group, count, and deduplicate values", () => {
  const rows = [
    { group: "b", value: 1 },
    { group: "a", value: 2 },
    { group: "b", value: 3 },
  ];

  assertEquals(
    groupBy(rows, (row) => row.group),
    new Map([
      ["b", [rows[0], rows[2]]],
      ["a", [rows[1]]],
    ]),
  );
  assertEquals(
    countBy(rows, (row) => row.group),
    new Map([
      ["b", 2],
      ["a", 1],
    ]),
  );
  assertEquals(uniqueCount(rows.map((row) => row.group)), 2);
  assertEquals(
    indexBy(rows, (row) => row.group),
    new Map([
      ["b", rows[2]],
      ["a", rows[1]],
    ]),
  );
  assertEquals(groupBy([], String), new Map());
  assertEquals(countBy([], String), new Map());
  assertEquals(indexBy([], String), new Map());
});
