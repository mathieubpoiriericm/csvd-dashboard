/**
 * The code points a WOFF2 font has glyphs for, read from its `cmap` table.
 *
 * Enough of the WOFF2 container to reach one untransformed table: the
 * 48-byte header, the table directory, and the single Brotli stream the
 * tables are concatenated in, in directory order and without padding (the
 * layout the reference decoder reads). `cmap` is never transformed, so its
 * bytes come back as the font compiler wrote them. A font collection
 * (`ttcf`) is refused rather than half-read.
 */
import { brotliDecompressSync } from "node:zlib";

/** Tag index 0 in the WOFF2 known-tag table. */
const CMAP_INDEX = 0;
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

function cmapTable(font: Uint8Array): Uint8Array {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  if (tag(view, 0) !== "wOF2") throw new Error("not a WOFF2 file");
  if (tag(view, 4) === "ttcf") throw new Error("font collections are not read");
  const numTables = view.getUint16(12);
  const compressedLength = view.getUint32(20);

  let at = 48;
  let offset = 0;
  let cmap: { offset: number; length: number } | null = null;
  for (let t = 0; t < numTables; t++) {
    const flags = font[at++];
    const index = flags & 0x3f;
    const version = flags >> 6;
    let name: string | null = null;
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
    if (transformed) [length, at] = readBase128(font, at);
    if (index === CMAP_INDEX || name === "cmap") cmap = { offset, length };
    offset += length;
  }
  if (cmap === null) throw new Error("no cmap table");
  const tables = brotliDecompressSync(font.subarray(at, at + compressedLength));
  return new Uint8Array(tables).subarray(
    cmap.offset,
    cmap.offset + cmap.length,
  );
}

/** Format 4: segment-mapped 16-bit. */
function format4(view: DataView, at: number, into: Set<number>): void {
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
      if (glyph !== 0) into.add(code);
    }
  }
}

/** Format 12: segmented 32-bit coverage. */
function format12(view: DataView, at: number, into: Set<number>): void {
  const groups = view.getUint32(at + 12);
  for (let g = 0; g < groups; g++) {
    const group = at + 16 + g * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    const firstGlyph = view.getUint32(group + 8);
    for (let code = start; code <= end; code++) {
      if (firstGlyph + (code - start) !== 0) into.add(code);
    }
  }
}

export function woff2Codepoints(font: Uint8Array): Set<number> {
  const cmap = cmapTable(font);
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const codepoints = new Set<number>();
  const records = view.getUint16(2);
  for (let r = 0; r < records; r++) {
    const platform = view.getUint16(4 + r * 8);
    const encoding = view.getUint16(6 + r * 8);
    const unicode = platform === 0 ||
      (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const at = view.getUint32(8 + r * 8);
    const format = view.getUint16(at);
    if (format === 4) format4(view, at, codepoints);
    else if (format === 12) format12(view, at, codepoints);
  }
  return codepoints;
}
