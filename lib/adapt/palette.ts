/**
 * Colours a generated disease/ starts with. They are appearance, not
 * disease terms: the family pairs are the seven that pass the lightness
 * band, the tint floor and the adjacent-ΔE check in
 * tests/phenogram_encoding_test.ts, in the order that passes; the wizard
 * caps families, populations and mechanisms at these lengths so a fork's
 * first `deno test` is green.
 */
export const FAMILY_PALETTE: ReadonlyArray<{ hue: string; tint: string }> = [
  { hue: "#2a78d6", tint: "#d8edff" },
  { hue: "#eb6834", tint: "#ffe2d5" },
  { hue: "#1baf7a", tint: "#d2f5e2" },
  { hue: "#008300", tint: "#dbf3d8" },
  { hue: "#e87ba4", tint: "#ffdfeb" },
  { hue: "#4a3aa7", tint: "#e7e8ff" },
  { hue: "#e34948", tint: "#ffe0dc" },
];

export const POPULATION_PALETTE: ReadonlyArray<
  { color: string; band: string }
> = [
  { color: "#bf68ae", band: "#913f82" },
  { color: "#1a95d8", band: "#006a9e" },
  { color: "#16a56e", band: "#00774c" },
  { color: "#c5770f", band: "#8d5406" },
  { color: "#5b6ee1", band: "#3846a8" },
  { color: "#c94a4a", band: "#8f2f2f" },
];

export const UNKNOWN_MECHANISM = "#888888";

export const MECHANISM_PALETTE: readonly string[] = [
  "#472c6d",
  "#67409d",
  "#8a5fc7",
  "#1f4e79",
  "#2f6fae",
  "#4d93d8",
  "#0b5d4a",
  "#178a6c",
  "#3fb08f",
  "#7a4b00",
  "#b06f0a",
  "#d9962c",
  "#7a1f2b",
  "#b03a48",
  "#d8636f",
  "#3d3d3d",
  "#5c5c7a",
  "#7d7da3",
  "#274e13",
  "#4c8a2a",
  "#79b04d",
  "#5a2a6b",
  "#8c4a9e",
  "#b57ac4",
];
