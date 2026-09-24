import type { Answers } from "../answers.ts";
import {
  MECHANISM_PALETTE,
  POPULATION_PALETTE,
  UNKNOWN_MECHANISM,
} from "../palette.ts";
import { clean, jsonText } from "./json.ts";

export function generateTimeline(answers: Answers): string {
  const { populations, mechanisms, mechanismFamilies } = answers.trials;
  // Built from entries, so no mechanism name can set the object's prototype.
  const colours = Object.fromEntries(
    mechanisms.map((m, i) => [
      clean(m.name),
      MECHANISM_PALETTE[i % MECHANISM_PALETTE.length],
    ]),
  );
  return jsonText({
    $comment:
      "The radar's disease content: the sectors (populations, in the manifest's order, with label lines and colours), the curated mechanism strings with their colours, the fallback colour, and the mechanism families. Rings, rim band, evidence states and the record flag are registry facts and stay in lib/timeline_encoding.json.",
    populations: populations.map((p, i) => ({
      key: clean(p.key),
      label: p.lines.map(clean),
      color: POPULATION_PALETTE[i % POPULATION_PALETTE.length].color,
      band: POPULATION_PALETTE[i % POPULATION_PALETTE.length].band,
    })),
    mechanisms: colours,
    unknownMechanism: UNKNOWN_MECHANISM,
    families: mechanismFamilies.map((f) => ({
      key: clean(f.key),
      label: clean(f.label),
      mechanisms: mechanisms.filter((m) => clean(m.family) === clean(f.key))
        .map((m) => clean(m.name)),
    })),
  });
}
