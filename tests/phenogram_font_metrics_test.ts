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

interface Table {
  /** WOFF2 known-tag index (0 cmap, 1 head, 2 hhea, 3 hmtx). */
  index: number;
  bytes: Uint8Array;
  /** Set the version-1 transform flag, as a transformed `hmtx` carries it. */
  transformed?: boolean;
}

/**
 * A minimal WOFF2 around `tables`, in the layout `tests/helpers/woff2.ts`
 * reads: header, directory, one Brotli stream. Every length is under 128, so
 * each UIntBase128 is a single byte.
 */
function woff2(tables: Table[]): Uint8Array {
  const directory: number[] = [];
  for (const table of tables) {
    directory.push(table.index | (table.transformed ? 0x40 : 0));
    directory.push(table.bytes.length);
    // A transformed table also states its transformed length.
    if (table.transformed) directory.push(table.bytes.length);
  }
  const stream = new Uint8Array(
    tables.reduce((n, t) => n + t.bytes.length, 0),
  );
  let at = 0;
  for (const table of tables) {
    stream.set(table.bytes, at);
    at += table.bytes.length;
  }
  const compressed = new Uint8Array(brotliCompressSync(stream));
  const font = new Uint8Array(48 + directory.length + compressed.length);
  const view = new DataView(font.buffer);
  font.set([..."wOF2"].map((c) => c.charCodeAt(0)), 0);
  font.set([0, 1, 0, 0], 4);
  view.setUint16(12, tables.length);
  view.setUint32(20, compressed.length);
  font.set(directory, 48);
  font.set(compressed, 48 + directory.length);
  return font;
}

/** Big-endian 16-bit words, as every field below is. */
function words(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v & 0xffff));
  return bytes;
}

/**
 * A format-4 cmap over three segments: `A`-`C` by delta (glyphs 1-3), `a`-`b`
 * through the glyph id array (idRangeOffset != 0: glyphs 2 and 7), and the
 * 0xFFFF terminator.
 */
const CMAP = words([
  0, // version
  1, // one encoding record
  3, // platform: Windows
  1, // encoding: Unicode BMP
  0, // offset, high word
  12, // offset, low word
  4, // format
  44, // subtable length
  0, // language
  6, // segCountX2
  4, // searchRange
  1, // entrySelector
  2, // rangeShift
  0x43, // endCode: C
  0x62, // endCode: b
  0xffff, // endCode: terminator
  0, // reservedPad
  0x41, // startCode: A
  0x61, // startCode: a
  0xffff, // startCode: terminator
  -0x40, // idDelta: A -> 1
  0, // idDelta
  1, // idDelta: terminator
  0, // idRangeOffset: by delta
  4, // idRangeOffset: from itself to glyphIdArray[0]
  0, // idRangeOffset: terminator
  2, // glyphIdArray: a -> 2
  7, // glyphIdArray: b -> 7
]);

const HEAD = new Uint8Array(54);
new DataView(HEAD.buffer).setUint16(18, 1000);
const HHEA = new Uint8Array(36);
/** Five long metrics; glyphs 5 and up repeat the last advance. */
new DataView(HHEA.buffer).setUint16(34, 5);
const HMTX = words([100, 0, 200, 0, 300, 0, 400, 0, 500, 0, 0, 0, 0]);

Deno.test("advances follow the cmap through deltas, the glyph id array and the hmtx tail", () => {
  const font = woff2([
    { index: 0, bytes: CMAP },
    { index: 1, bytes: HEAD },
    { index: 2, bytes: HHEA },
    { index: 3, bytes: HMTX },
  ]);
  const { unitsPerEm, advances } = woff2Metrics(font);
  assertEquals(unitsPerEm, 1000);
  assertEquals(
    Object.fromEntries(
      [...advances].map(([code, advance]) => [
        String.fromCodePoint(code),
        advance,
      ]),
    ),
    // A-C are glyphs 1-3 by delta; a is glyph 2 through the array; b is
    // glyph 7, past the five long metrics, so it repeats glyph 4's advance.
    { A: 200, B: 300, C: 400, a: 300, b: 500 },
  );
  assertEquals(woff2Codepoints(font), new Set([0x41, 0x42, 0x43, 0x61, 0x62]));
});

Deno.test("a transformed hmtx, a collection, a missing table and a non-WOFF2 are refused", () => {
  const transformed = () =>
    woff2([
      { index: 0, bytes: CMAP },
      { index: 1, bytes: HEAD },
      { index: 2, bytes: HHEA },
      { index: 3, bytes: HMTX, transformed: true },
    ]);
  assertThrows(
    () => woff2Metrics(transformed()),
    Error,
    "hmtx table is transformed",
  );
  const collection = transformed();
  collection.set([..."ttcf"].map((c) => c.charCodeAt(0)), 4);
  assertThrows(() => woff2Metrics(collection), Error, "font collections");
  assertThrows(
    () =>
      woff2Metrics(woff2([
        { index: 0, bytes: CMAP },
        { index: 1, bytes: HEAD },
        { index: 3, bytes: HMTX },
      ])),
    Error,
    "no hhea table",
  );
  assertThrows(
    () => woff2Metrics(new Uint8Array(48)),
    Error,
    "not a WOFF2 file",
  );
});
