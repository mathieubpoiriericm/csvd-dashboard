import { zipSync } from "fflate";

import {
  type Answers,
  DRAFT_VERSION,
  EMPTY_ANSWERS,
  isRecord,
  parseDraftReport,
} from "./answers.ts";
import { BUNDLE_NAME, renderChecklist } from "./checklist.ts";
import { generateManifest, logoPath } from "./generate/manifest.ts";
import { generateOmimCsv } from "./generate/omim_csv.ts";
import { generatePhenogram } from "./generate/phenogram.ts";
import { generatePipeline } from "./generate/pipeline.ts";
import { generatePrompt } from "./generate/prompt.ts";
import { generateReadme } from "./generate/readme.ts";
import { generateRecallCsv } from "./generate/recall_csv.ts";
import { generateTimeline } from "./generate/timeline.ts";
import { generateVocabulary } from "./generate/vocabulary.ts";
import { jsonText } from "./generate/json.ts";
import { STEP_ORDER } from "./validate.ts";

/** The file "Export answers" downloads, and its copy in the archive. */
export const ANSWERS_NAME = "adapt-answers.json";

/**
 * Larger than any export, so that an import can refuse a file before
 * reading it whole. IdentityStep caps a logo at 1 MB, and two logos at
 * that cap, as base64, make an export of about 2.7 MB.
 */
export const IMPORT_BYTE_LIMIT = 8_000_000;

/**
 * The answers as they leave the browser.
 *
 * The NCBI credentials are the researcher's own and belong in no file
 * they hand on: the archive goes into a repository and the export is what
 * people mail each other. Everything else is the interview's answers,
 * which is what re-importing needs.
 */
export function exportableAnswers(answers: Answers): Answers {
  return {
    ...answers,
    search: { ...answers.search, ncbi: { email: "", apiKey: "" } },
  };
}

/**
 * An imported export, with this browser's NCBI credentials kept.
 *
 * An export never carries them, so taking its blank pair as the answer
 * would quietly drop the key the researcher entered here, and every
 * lookup after the import would run at the keyless rate.
 */
export function importedAnswers(imported: Answers, current: Answers): Answers {
  const { email, apiKey } = imported.search.ncbi;
  return email.trim() === "" && apiKey.trim() === ""
    ? {
      ...imported,
      search: { ...imported.search, ncbi: { ...current.search.ncbi } },
    }
    : imported;
}

/**
 * The answers file, as "Export answers" downloads it and the archive holds
 * it. Both go through here, so neither can write the answers as they are
 * and carry the NCBI credentials out with them.
 */
export function exportText(answers: Answers): string {
  return jsonText(exportableAnswers(answers));
}

/**
 * Whether the answers hold anything an import would discard: whether they
 * export as anything but an empty draft does. The NCBI credentials are
 * nothing to lose, since an import keeps them.
 */
export function holdsAnswers(answers: Answers): boolean {
  return exportText(answers) !== exportText(EMPTY_ANSWERS);
}

/**
 * An import's answers, with the path of every answer the file held that
 * could not be read (and was left empty), or why it cannot be imported.
 */
export type Imported = { answers: Answers; dropped: string[] } | {
  error: string;
};

const NOT_AN_EXPORT = "That file is not an answers export from this wizard.";

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * An answers export read back, or why the file is not one.
 *
 * parseDraft() also reads the stored draft, so it is lenient: any record
 * whose version is 1 passes, with every step it lacks empty. An import
 * replaces every answer at once, so that leniency would take a settings
 * file for an export and empty the draft. Every export carries all seven
 * steps, so a file without them is refused; one that carries steps under
 * another version is named as another version's export, not as no export.
 */
export function parseExport(text: string): Imported {
  const raw = readJson(text);
  if (!isRecord(raw)) return { error: NOT_AN_EXPORT };
  const steps = STEP_ORDER.filter((step) => isRecord(raw[step])).length;
  const { version } = raw;
  if (typeof version === "number" && version !== DRAFT_VERSION && steps > 0) {
    return {
      error:
        `That file comes from another version of the wizard (version ${version}) and cannot be imported here.`,
    };
  }
  if (version !== DRAFT_VERSION || steps < STEP_ORDER.length) {
    return { error: NOT_AN_EXPORT };
  }
  // Past these checks, parseDraftReport() has nothing left to refuse.
  return parseDraftReport(text)!;
}

/** An imported file as the answers to hold, or why it cannot be imported. */
export function importText(text: string, current: Answers): Imported {
  const parsed = parseExport(text);
  return "error" in parsed ? parsed : {
    answers: importedAnswers(parsed.answers, current),
    dropped: parsed.dropped,
  };
}

export interface BundleEntry {
  path: string;
  bytes: Uint8Array;
}

export { BUNDLE_NAME };

const encoder = new TextEncoder();
const text = (path: string, body: string): BundleEntry => ({
  path,
  bytes: encoder.encode(body),
});

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Every file the researcher drops into their fork, plus the checklist and the answers. */
export function bundle(answers: Answers): BundleEntry[] {
  const entries: BundleEntry[] = [
    text("disease/manifest.json", generateManifest(answers)),
    text("disease/pipeline.json", generatePipeline(answers)),
    text("disease/vocabulary.json", generateVocabulary(answers)),
    text("disease/timeline.json", generateTimeline(answers)),
    text("disease/phenogram.json", generatePhenogram(answers)),
    text("disease/omim_info.csv", generateOmimCsv(answers)),
    text("disease/prompt.md", generatePrompt(answers)),
    text("disease/recall_gold.csv", generateRecallCsv(answers)),
    text("disease/README.md", generateReadme(answers)),
  ];
  const { logoLight, logoDark } = answers.identity;
  if (logoLight !== null) {
    entries.push({
      path: `static${logoPath(logoLight, "light")}`,
      bytes: fromBase64(logoLight.base64),
    });
  }
  if (logoDark !== null) {
    entries.push({
      path: `static${logoPath(logoDark, "dark")}`,
      bytes: fromBase64(logoDark.base64),
    });
  }
  entries.push(text("ADAPT-CHECKLIST.md", renderChecklist(answers)));
  entries.push(text(ANSWERS_NAME, exportText(answers)));
  return entries;
}

export function zipBytes(entries: BundleEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.path] = entry.bytes;
  return zipSync(files);
}
