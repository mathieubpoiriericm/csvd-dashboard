/** The export palette must track the light tokens in assets/app.css. */
import { assert, assertEquals } from "@std/assert";

import { SVG_PALETTE } from "../lib/phenogram_svg.ts";

const css = await Deno.readTextFile(
  new URL("../assets/app.css", import.meta.url),
);
// The light theme is the first `:root` block, ending before the dark query.
const light = css.slice(
  css.indexOf(":root {"),
  css.indexOf("@media (prefers-color-scheme: dark)"),
);
const lines = light.split("\n").map((l) => l.trim());

function declaration(name: string): string {
  const line = lines.find((l) => l.startsWith(`--svd-${name}:`));
  assert(line, `--svd-${name} is not defined in the light block`);
  return line;
}

function primitiveHex(name: string): string {
  const hex = declaration(name).match(/\/\*\s*(#[0-9a-f]{6})/i)?.[1];
  assert(hex, `--svd-${name} has no hex comment`);
  return hex.toLowerCase();
}

function value(name: string): string {
  return declaration(name).match(/:\s*([^;]+);/)![1].trim();
}

Deno.test("SVG_PALETTE matches the light tokens in app.css", () => {
  assertEquals(SVG_PALETTE.ink, primitiveHex("slate-950"));
  assertEquals(SVG_PALETTE.inkMuted, primitiveHex("slate-700"));
  assertEquals(SVG_PALETTE.lineStrong, primitiveHex("slate-400"));
  assertEquals(value("white"), "#fff");
  assertEquals(SVG_PALETTE.plate, "#ffffff");
  assertEquals(value("ink"), "var(--svd-slate-950)");
  assertEquals(value("figure-ink"), "var(--svd-slate-950)");
  assertEquals(value("ink-muted"), "var(--svd-slate-700)");
  assertEquals(value("line-strong"), "var(--svd-slate-400)");
  assertEquals(value("figure-plate"), "var(--svd-white)");
});
