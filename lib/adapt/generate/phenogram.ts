import type { Answers } from "../answers.ts";
import { FAMILY_PALETTE } from "../palette.ts";
import { clean, jsonText } from "./json.ts";

export function generatePhenogram(answers: Answers): string {
  return jsonText({
    $comment:
      "The phenogram's pill families: one per `family` value in disease/vocabulary.json, in legend order, with the hue and tint lib/phenogram.ts and scripts/phenogram_figure.py draw. Appearance that is not the disease's (evidence glyphs, cytoband stains, layout) stays in lib/phenogram_encoding.json.",
    families: answers.vocabulary.families.map((f, i) => ({
      key: clean(f.key),
      label: clean(f.label),
      hue: FAMILY_PALETTE[i % FAMILY_PALETTE.length].hue,
      tint: FAMILY_PALETTE[i % FAMILY_PALETTE.length].tint,
    })),
  });
}
