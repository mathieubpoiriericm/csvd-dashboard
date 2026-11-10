/**
 * What a WOFF2 font draws, read from its own tables: the code points its
 * `cmap` maps, and the horizontal advance of each (`head`, `hhea`, `hmtx`).
 *
 * Enough of the WOFF2 container to reach untransformed tables: the 48-byte
 * header, the table directory, and the single Brotli stream the tables are
 * concatenated in, in directory order and without padding (the layout the
 * reference decoder reads). `cmap`, `head` and `hhea` are never transformed,
 * so their bytes come back as the font compiler wrote them. `hmtx` may be
 * (WOFF2's version-1 transform drops the left side bearings), and a
 * transformed table is refused rather than guessed at, as is a font
 * collection (`ttcf`).
 */
import { brotliDecompressSync } from "node:zlib";

/** The WOFF2 known-tag table, as far as the tables read here and their transformed neighbours. */
const KNOWN_TAGS: Record<number, string> = {
  0: "cmap",
  1: "head",
  2: "hhea",
  3: "hmtx",
  4: "maxp",
  5: "name",
  6: "OS/2",
  7: "post",
  10: "glyf",
  11: "loca",
};
const GLYF_INDEX = 10;
const LOCA_INDEX = 11;

function readBase128(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = bytes[at + i];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error("UIntBase128 longer than five bytes");
}

function tag(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );
}

interface Entry {
  offset: number;
  length: number;
  transformed: boolean;
}

/** The named tables' bytes; throws for a missing or transformed one. */
function tables(font: Uint8Array, wanted: readonly string[]): DataView[] {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  if (tag(view, 0) !== "wOF2") throw new Error("not a WOFF2 file");
  if (tag(view, 4) === "ttcf") throw new Error("font collections are not read");
  const numTables = view.getUint16(12);
  const compressedLength = view.getUint32(20);

  let at = 48;
  let offset = 0;
  const entries = new Map<string, Entry>();
  for (let t = 0; t < numTables; t++) {
    const flags = font[at++];
    const index = flags & 0x3f;
    const version = flags >> 6;
    let name = KNOWN_TAGS[index] ?? `#${index}`;
    if (index === 63) {
      name = tag(view, at);
      at += 4;
    }
    let length: number;
    [length, at] = readBase128(font, at);
    // glyf and loca are transformed at version 0; every other table at any
    // version but 0.
    const transformed = index === GLYF_INDEX || index === LOCA_INDEX
      ? version === 0
      : version !== 0;
    // A transformed table's stored length is the second number, and it is
    // that many bytes the stream holds.
    if (transformed) [length, at] = readBase128(font, at);
    entries.set(name, { offset, length, transformed });
    offset += length;
  }
  const stream = new Uint8Array(
    brotliDecompressSync(font.subarray(at, at + compressedLength)),
  );
  return wanted.map((name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`no ${name} table`);
    if (entry.transformed) {
      throw new Error(`the ${name} table is transformed; it is not read`);
    }
    return new DataView(
      stream.buffer,
      stream.byteOffset + entry.offset,
      entry.length,
    );
  });
}

/** Format 4: segment-mapped 16-bit. */
function format4(view: DataView, at: number, into: Map<number, number>): void {
  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let s = 0; s < segments; s++) {
    const end = view.getUint16(ends + s * 2);
    const start = view.getUint16(starts + s * 2);
    const delta = view.getInt16(deltas + s * 2);
    const rangeAt = rangeOffsets + s * 2;
    const rangeOffset = view.getUint16(rangeAt);
    for (let code = start; code <= end && code !== 0xffff; code++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        glyph = view.getUint16(rangeAt + rangeOffset + (code - start) * 2);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) into.set(code, glyph);
    }
  }
}

/** Format 12: segmented 32-bit coverage. */
function format12(
  view: DataView,
  at: number,
  into: Map<number, number>,
): void {
  const groups = view.getUint32(at + 12);
  for (let g = 0; g < groups; g++) {
    const group = at + 16 + g * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    const firstGlyph = view.getUint32(group + 8);
    for (let code = start; code <= end; code++) {
      const glyph = firstGlyph + (code - start);
      if (glyph !== 0) into.set(code, glyph);
    }
  }
}

/** Code point to glyph id, over every Unicode subtable of `cmap`. */
function glyphMap(view: DataView): Map<number, number> {
  const glyphs = new Map<number, number>();
  const records = view.getUint16(2);
  for (let r = 0; r < records; r++) {
    const platform = view.getUint16(4 + r * 8);
    const encoding = view.getUint16(6 + r * 8);
    const unicode = platform === 0 ||
      (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const at = view.getUint32(8 + r * 8);
    const format = view.getUint16(at);
    if (format === 4) format4(view, at, glyphs);
    else if (format === 12) format12(view, at, glyphs);
  }
  return glyphs;
}

export function woff2Codepoints(font: Uint8Array): Set<number> {
  const [cmap] = tables(font, ["cmap"]);
  return new Set(glyphMap(cmap).keys());
}

export interface FontMetrics {
  unitsPerEm: number;
  /** Advance width in font units of every code point the `cmap` maps. */
  advances: Map<number, number>;
}

/**
 * Advance widths from `hmtx`: one long metric per glyph up to `hhea`'s
 * `numberOfHMetrics`, after which every glyph repeats the last advance.
 */
export function woff2Metrics(font: Uint8Array): FontMetrics {
  const [cmap, head, hhea, hmtx] = tables(font, [
    "cmap",
    "head",
    "hhea",
    "hmtx",
  ]);
  const unitsPerEm = head.getUint16(18);
  const longMetrics = hhea.getUint16(34);
  const advanceOf = (glyph: number) =>
    hmtx.getUint16(Math.min(glyph, longMetrics - 1) * 4);
  const advances = new Map<number, number>();
  for (const [code, glyph] of glyphMap(cmap)) {
    advances.set(code, advanceOf(glyph));
  }
  return { unitsPerEm, advances };
}
