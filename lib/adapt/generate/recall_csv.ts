import type { Answers } from "../answers.ts";
import { clean, csvLine } from "./json.ts";

export function generateRecallCsv(answers: Answers): string {
  return [
    "pmid,note",
    ...answers.gold.rows.map((r) => csvLine([clean(r.pmid), clean(r.note)])),
  ]
    .join("\n") + "\n";
}
