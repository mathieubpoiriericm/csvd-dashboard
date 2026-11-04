/**
 * Every @font-face in `assets/app.css` draws the characters it claims.
 *
 * A face can load cleanly and still draw nothing: `document.fonts` reports it
 * `loaded`, and the browser quietly falls back, glyph by glyph, to the system
 * font. That is how the six `*-latin.woff2` files shipped from the initial
 * commit until November 2026 — they were Google's latin-ext subset under latin
 * names, with no a-z at all, so Barlow drew only the spaces. These tests read
 * each file's own character map instead of trusting its name.
 */
import { assert, assertEquals } from "@std/assert";
import { woff2Codepoints } from "./helpers/woff2.ts";

const css = Deno.readTextFileSync(
  new URL("../assets/app.css", import.meta.url),
);

/** `U+0000-00FF,U+0131` as inclusive [start, end] pairs. */
function parseUnicodeRange(value: string): Array<[number, number]> {
  return value.split(",").map((part) => {
    const [start, end] = part.trim().replace(/^U\+/i, "").split("-");
    return [parseInt(start, 16), parseInt(end ?? start, 16)];
  });
}

interface Face {
  label: string;
  file: string;
  /** Null when the face declares no unicode-range: it claims everything. */
  ranges: Array<[number, number]> | null;
  codepoints: Set<number>;
}

const FACES: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
  ([, body]) => {
    const family = body.match(/font-family:\s*'([^']+)'/)?.[1];
    const weight = body.match(/font-weight:\s*(\d+)/)?.[1];
    const file = body.match(/url\('\.\/([^']+\.woff2)'\)/)?.[1];
    assert(family && weight && file, `unreadable @font-face: ${body}`);
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1];
    return {
      label: `${family} ${weight} (${file})`,
      file,
      ranges: range ? parseUnicodeRange(range) : null,
      codepoints: woff2Codepoints(
        Deno.readFileSync(new URL(`../assets/${file}`, import.meta.url)),
      ),
    };
  },
);

function claims(face: Face, code: number): boolean {
  return face.ranges === null ||
    face.ranges.some(([start, end]) => code >= start && code <= end);
}

function missing(face: Face, codes: Iterable<number>): string[] {
  return [...codes]
    .filter((code) => claims(face, code) && !face.codepoints.has(code))
    .map((code) =>
      `U+${code.toString(16).toUpperCase().padStart(4, "0")} ` +
      JSON.stringify(String.fromCodePoint(code))
    );
}

Deno.test("app.css declares web fonts to check", () => {
  assert(FACES.length > 0, "no @font-face in assets/app.css");
});

Deno.test("every face that claims basic Latin draws printable ASCII", () => {
  const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i);
  for (const face of FACES) {
    assertEquals(missing(face, ascii), [], face.label);
  }
});

/** Every string in a JSON value, at any depth. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) {
    for (const item of value) yield* strings(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* strings(item);
  }
}

Deno.test("every letter the site renders is drawn by the face that claims it", () => {
  // The committed data and the web-facing manifest are what the pages print.
  // Derived, not pinned: under `deno task data:empty` only the manifest is
  // left, and that still has letters.
  const sources = [
    new URL("../disease/manifest.json", import.meta.url),
    ...[...Deno.readDirSync(new URL("../data/", import.meta.url))]
      .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
      .map((entry) => new URL(`../data/${entry.name}`, import.meta.url)),
  ];
  const letters = new Set<number>();
  for (const source of sources) {
    for (const text of strings(JSON.parse(Deno.readTextFileSync(source)))) {
      for (const char of text.matchAll(/\p{L}/gu)) {
        letters.add(char[0].codePointAt(0)!);
      }
    }
  }
  assert(letters.size > 0, "no letters found to check");
  // The faces of one family and weight form a single composite font: for a
  // character, the browser tries each face whose unicode-range claims it and
  // takes the first that has the glyph. So a letter two ranges both list
  // (U+0131 is in latin and latin-ext) needs a glyph in one of them, not both.
  const composites = Map.groupBy(FACES, (face) => face.label.split(" (")[0]);
  for (const [name, faces] of composites) {
    const undrawn = [...letters]
      .filter((code) => faces.some((face) => claims(face, code)))
      .filter((code) => !faces.some((face) => face.codepoints.has(code)))
      .map((code) =>
        `U+${code.toString(16).toUpperCase().padStart(4, "0")} ` +
        JSON.stringify(String.fromCodePoint(code))
      );
    assertEquals(undrawn, [], name);
  }
});
