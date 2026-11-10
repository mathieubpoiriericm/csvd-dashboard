/**
 * `lib/phenogram_font_metrics.json` is what the shipped Barlow files give,
 * and the WOFF2 reader behind it refuses what it cannot read faithfully.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { brotliCompressSync } from "node:zlib";

import committed from "../lib/phenogram_font_metrics.json" with {
  type: "json",
};
import { fontMetricsTable } from "../scripts/phenogram_font_metrics.ts";
import { woff2Codepoints, woff2Metrics } from "./helpers/woff2.ts";

Deno.test("the committed font metrics are the shipped fonts' own", () => {
  assertEquals(
    committed,
    fontMetricsTable(),
    "lib/phenogram_font_metrics.json is stale: run `deno task phenogram:metrics`",
  );
});

Deno.test("every code point a face maps has an advance, and the latin letters are there", () => {
  for (const weight of ["400", "600"] as const) {
    const font = Deno.readFileSync(
      new URL(`../assets/fonts/Barlow-${weight}-latin.woff2`, import.meta.url),
    );
    const advances = committed.advances[weight] as Record<string, number>;
    assertEquals(
      new Set(Object.keys(advances).map(Number)),
      woff2Codepoints(font),
    );
    for (const ch of "AZaz09 ()-/,") {
      assert(advances[String(ch.codePointAt(0))] > 0, `${weight} ${ch}`);
    }
  }
  // Semibold sets lowercase wider than regular, so the weights were not swapped.
  const lowercase = (weight: "400" | "600") =>
    [..."abcdefghijklmnopqrstuvwxyz"].reduce(
      (sum, ch) =>
        sum +
        (committed.advances[weight] as Record<string, number>)[
          String(ch.codePointAt(0))
        ],
      0,
    );
  assert(lowercase("600") > lowercase("400"));
});

/** A four-table WOFF2 whose `hmtx` carries the version-1 transform. */
function transformedHmtx(): Uint8Array {
  const sizes = [4, 54, 36, 8];
  const stream = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  const compressed = new Uint8Array(brotliCompressSync(stream));
  const directory = [0x00, 4, 0x01, 54, 0x02, 36, 0x43, 12, 8];
  const font = new Uint8Array(48 + directory.length + compressed.length);
  const view = new DataView(font.buffer);
  font.set([..."wOF2"].map((c) => c.charCodeAt(0)), 0);
  font.set([0, 1, 0, 0], 4);
  view.setUint16(12, 4);
  view.setUint32(20, compressed.length);
  font.set(directory, 48);
  font.set(compressed, 48 + directory.length);
  return font;
}

Deno.test("a transformed hmtx, a collection and a missing table are refused", () => {
  assertThrows(
    () => woff2Metrics(transformedHmtx()),
    Error,
    "hmtx table is transformed",
  );
  const collection = transformedHmtx();
  collection.set([..."ttcf"].map((c) => c.charCodeAt(0)), 4);
  assertThrows(() => woff2Metrics(collection), Error, "font collections");
  assertThrows(
    () => woff2Metrics(new Uint8Array(48)),
    Error,
    "not a WOFF2 file",
  );
});
