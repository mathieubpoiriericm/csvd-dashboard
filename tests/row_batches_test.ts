import { assertEquals } from "@std/assert";

import { firstBatchEnd } from "../lib/row_batches.ts";

const ids = (count: number, prefix = "r") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const never = () => false;

Deno.test("a reorder of rows already drawn renders whole", () => {
  const page = ids(87);
  assertEquals(firstBatchEnd(page.toReversed(), new Set(page), 25, never), 87);
});

Deno.test("a larger page draws the rows it had plus the first new batch", () => {
  const page = ids(87);
  assertEquals(firstBatchEnd(page, new Set(page.slice(0, 10)), 25, never), 35);
});

Deno.test("a page of rows not yet drawn starts with one batch", () => {
  assertEquals(
    firstBatchEnd(ids(50, "b"), new Set(ids(50, "a")), 25, never),
    25,
  );
});

Deno.test("as many new rows as a batch render whole", () => {
  assertEquals(firstBatchEnd(ids(35), new Set(ids(10)), 25, never), 35);
  assertEquals(firstBatchEnd([], new Set(), 25, never), 0);
});

// A search cleared back to a full page: its few drawn rows are spread through
// it. The batch stays a prefix with `batch` new rows, so a drawn row past the
// cutoff waits for the second frame rather than pulling every new row before
// it into the first one.
Deno.test("a drawn row past the first new batch waits for the second frame", () => {
  const page = ids(100);
  assertEquals(
    firstBatchEnd(page, new Set(["r50", "r70", "r99"]), 20, never),
    20,
  );
  assertEquals(
    firstBatchEnd(page, new Set(["r3", "r10", "r70"]), 20, never),
    22,
  );
});

// A merged trials block drawn in two halves would leave its rowspan cell
// short for a frame and its covered cells missing.
Deno.test("a batch never ends inside a merged block", () => {
  const covered = new Set([25, 26, 27, 40]);
  assertEquals(
    firstBatchEnd(ids(50), new Set(), 25, (index) => covered.has(index)),
    28,
  );
});
