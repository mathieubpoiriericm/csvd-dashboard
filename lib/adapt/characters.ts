/**
 * What a typed value holds that its field can never accept, found while it
 * is typed.
 *
 * validate() says whether an answer passes; this says which characters stop
 * it, so the field can name and mark them and, where one exists, offer the
 * corrected value. Every rule reads the pattern validate() does, and
 * tests/adapt/characters_test.ts holds the two to one verdict. An offence is
 * final -- nothing typed after it can make the value pass -- so marking it
 * mid-word is never premature. What an incomplete value still needs is a
 * note, not an offence: the next key may well supply it.
 */
import { parseConfidence } from "./edits.ts";
import { clean, textSpan, trim } from "./generate/json.ts";
import {
  ASCII_TEXT,
  BLOCK_SECTION_IDS,
  conditionOk,
  confidenceOk,
  ctgovTermRefused,
  DOI,
  EMAIL_REFUSED,
  emailOk,
  EXAMPLE_TYPE,
  hiddenChar,
  KEY,
  objectKey,
  OPERATOR,
  PMID,
  reserved,
  SLOT,
  TRAIT_LABEL_MAX,
  webUrlOk,
} from "./validate.ts";

export type Rule =
  | "key"
  | "exampleType"
  | "url"
  | "email"
  | "quoteless"
  | "ctgovTerm"
  | "traitKey"
  | "traitLabel"
  | "reservedKey"
  | "plainKey"
  | "condition"
  | "conditions"
  | "symbol"
  | "number"
  | "ascii"
  | "confidence"
  | "doi"
  | "slotless"
  | "plain"
  | "section"
  | "inline"
  | "steps";

/** One offending character, or one offending sequence ("{{", "## "). */
export interface Offence {
  start: number;
  end: number;
  char: string;
}

export interface Diagnosis {
  /** validate()'s format verdict on this text; true for blank text. */
  ok: boolean;
  offences: Offence[];
  /** Names the offences; null when there are none. */
  message: string | null;
  /** What an incomplete value still needs, when there is more to say. */
  note: string | null;
  /** The corrected value, which passes; null when there is none. */
  fix: string | null;
}

const CLEAN: Diagnosis = {
  ok: true,
  offences: [],
  message: null,
  note: null,
  fix: null,
};
const FAILS: Diagnosis = { ...CLEAN, ok: false };

/** Field paths as validate() writes them, to the rule each one follows. */
const RULES: ReadonlyArray<readonly [RegExp, Rule]> = [
  [/^disease\.key$/, "key"],
  [/^disease\.(?:name|abbreviation)$/, "slotless"],
  [/^examples\[\d+\]\.type$/, "exampleType"],
  [/^examples\[\d+\]\.(?:gene|sentence|reasoning)$/, "slotless"],
  [/^institute\.url$/, "url"],
  [/^maintainer\.email$/, "email"],
  [/^(?:diseaseTerms|markerTerms)\[\d+\]$/, "quoteless"],
  [/^searchTerms\[\d+\]$/, "ctgovTerm"],
  [/^traits\[\d+\]\.key$/, "traitKey"],
  [/^traits\[\d+\]\.label$/, "traitLabel"],
  [/^(?:populations\[\d+\]\.key|mechanisms\[\d+\]\.name)$/, "reservedKey"],
  [/^(?:cellTypes\.glossary|aliases)\[\d+\]$/, "plainKey"],
  [/^conditions$/, "conditions"],
  [/^conditionPairs\[\d+\](?:\.1)?$/, "condition"],
  [/^genes\[\d+\]$/, "symbol"],
  [
    /^(?:omimRows\[\d+\]\.omimNum|examples\[\d+\]\.pmid|rows\[\d+\]\.pmid)$/,
    "number",
  ],
  [
    /^omimRows\[\d+\]\.(?:location|phenotype|phenotypeMimNumber|inheritance|phenotypeMappingKey|geneOrLocusMimNumber)$/,
    "ascii",
  ],
  [/^examples\[\d+\]\.confidence$/, "confidence"],
  [/^citationStandard\.doi$/, "doi"],
  [
    /^(?:disease\.(?:short|adjective)|site\.|institute\.(?:name|short|copyright|logoAlt)$|maintainer\.name$|cellTypes\.(?:label|glossary\[\d+\]\.name)$|families\[\d+\](?:\.label)?$|traits\[\d+\]\.(?:name|definition|xrefNote)$|citationStandard\.(?:name|label|linkLabel)$|populations\[\d+\]\.(?:label|lines)$|populationField\.|mechanismFamilies\[\d+\](?:\.label)?$|aliases\[\d+\]\.symbols$|omimRows\[\d+\]\.geneOrLocus$|rows\[\d+\]\.note$)/,
    "plain",
  ],
];

export function ruleFor(field: string): Rule | null {
  if (field.startsWith("sections.")) {
    const id = field.slice("sections.".length);
    return id === "strategy.disease_steps"
      ? "steps"
      : BLOCK_SECTION_IDS.includes(id)
      ? "section"
      : "inline";
  }
  return RULES.find(([pattern]) => pattern.test(field))?.[1] ?? null;
}

const codePoint = (c: string) =>
  `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** A character as the message names it: quoted, or described when unseen. */
export function nameChar(c: string): string {
  switch (c) {
    case " ":
      return "a space";
    case "\u00a0":
      return "a non-breaking space";
    case "\n":
      return "a line break";
    case "\t":
      return "a tab";
  }
  // A combining accent standing alone would be drawn on the quote mark.
  if (/^\p{M}$/u.test(c)) return `a combining mark (${codePoint(c)})`;
  if (/^[\p{Cc}\p{Cf}\p{Z}]$/u.test(c)) return codePoint(c);
  return `"${c}"`;
}

/** The distinct offending characters as one phrase, capitalised. */
function named(offences: Offence[]): string {
  const names = [...new Set(offences.map((o) => o.char))].map(nameChar);
  const text = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Each code point between `from` and `to` that `bad` refuses. */
function scan(
  text: string,
  from: number,
  to: number,
  bad: (c: string, at: number) => boolean,
): Offence[] {
  const out: Offence[] = [];
  for (let i = from; i < to;) {
    const c = String.fromCodePoint(text.codePointAt(i)!);
    if (bad(c, i)) out.push({ start: i, end: i + c.length, char: c });
    i += c.length;
  }
  return out;
}

/** Each invisible character inside the trimmed text (see hiddenChar). */
function invisibles(text: string): Offence[] {
  const [from, to] = textSpan(text);
  return scan(text, from, to, hiddenChar);
}

const hiddenMessage = (offences: Offence[]): string =>
  `${
    named(offences)
  } can't be used: an invisible character would reach the files unseen.`;

/** The text with the offending spans taken out, trimmed. */
function without(text: string, offences: Offence[]): string {
  let out = "";
  let at = 0;
  // Callers pass single characters, which never overlap.
  for (const o of [...offences].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, o.start);
    at = o.end;
  }
  return trim(out + text.slice(at));
}

/** Offences in text order, each once. */
const ordered = (offences: Offence[]): Offence[] =>
  [...new Map(offences.map((o) => [o.start, o])).values()].sort((a, b) =>
    a.start - b.start
  );

/**
 * Letters with no decomposition into a base letter and an accent, as ASCII
 * spells them. NFKD takes "ﬁ" to "fi" and "é" to "e" and an accent; these it
 * leaves whole, and a fold that dropped them would drop the letter.
 */
const TRANSLITERATION: Record<string, string> = {
  "ß": "ss",
  "æ": "ae",
  "Æ": "AE",
  "œ": "oe",
  "Œ": "OE",
  "ø": "o",
  "Ø": "O",
  "ł": "l",
  "Ł": "L",
  "đ": "d",
  "Đ": "D",
  "ı": "i",
  "þ": "th",
  "Þ": "TH",
};
const transliterate = (text: string): string =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").replace(
    /[ßæÆœŒøØłŁđĐıþÞ]/g,
    (c) => TRANSLITERATION[c],
  );

/** A key as validate() would take it: lower case, underscores, a letter first. */
export function toKey(text: string): string | null {
  const key = transliterate(text.toLowerCase())
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return KEY.test(key) ? key : null;
}

/**
 * Text folded to the printable ASCII the OMIM table holds: accents off,
 * typographic quotes and dashes straight, every run of spaces one space,
 * and whatever still has no ASCII form dropped.
 */
export function asciiFold(text: string): string {
  return transliterate(text)
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

function keyLike(
  text: string,
  pattern: RegExp,
  example: string,
  need: string | null,
): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(
    text,
    from,
    to,
    (c, at) => !/^[a-z0-9_]$/.test(c) || (at === from && !/^[a-z]$/.test(c)),
  );
  const outside = offences.filter((o) => !/^[a-z0-9_]$/.test(o.char));
  const lead = offences.find((o) => /^[0-9_]$/.test(o.char));
  const parts: string[] = [];
  if (outside.length > 0) {
    parts.push(
      `${
        named(outside)
      } can't be used here: lower-case letters, digits and underscores only${example}.`,
    );
  }
  if (lead !== undefined) {
    parts.push(`It has to start with a letter, not "${lead.char}".`);
  }
  const ok = pattern.test(t);
  const key = toKey(t);
  return {
    ok,
    offences,
    message: parts.length > 0 ? parts.join(" ") : null,
    note: !ok && offences.length === 0 ? need : null,
    // Only a key the field takes is offered.
    fix: ok || key === null || !pattern.test(key) ? null : key,
  };
}

/** A scheme typed near enough to http or https to be meant as one. */
const NEAR_SCHEME = /^h{0,2}t{1,3}p{1,2}s?$/;

function url(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(text, from, to, (c) => /\s/.test(c) || hiddenChar(c));
  if (offences.length > 0) {
    const hidden = offences.filter((o) => hiddenChar(o.char));
    return {
      ...FAILS,
      offences,
      message: [
        hidden.length < offences.length && "A web address can't hold a space.",
        hidden.length > 0 && hiddenMessage(hidden),
      ].filter(Boolean).join(" "),
    };
  }
  if (webUrlOk(t)) return CLEAN;
  if (/^https?:\/\/$/i.test(t)) {
    return { ...FAILS, note: "Still needed: the address after the scheme." };
  }
  const lowered = t.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase());
  if (lowered !== t && webUrlOk(lowered)) {
    return { ...FAILS, note: "Write the scheme in lower case.", fix: lowered };
  }
  const offer = (candidate: string) => webUrlOk(candidate) ? candidate : null;
  const scheme = /^([a-z]+)(:\/{0,3}|\/{1,3})/i.exec(t);
  if (scheme !== null) {
    const word = scheme[1].toLowerCase();
    const rest = t.slice(scheme[0].length);
    // "https//", "https:/", "https:" and "htps://" are one slip away from a
    // scheme; the fix writes it whole rather than putting another in front.
    if (
      NEAR_SCHEME.test(word) && !(/^https?$/.test(word) && scheme[2] === "://")
    ) {
      return {
        ...FAILS,
        note: "Write the scheme as https://.",
        fix: rest === ""
          ? null
          : offer(`${word.endsWith("s") ? "https" : "http"}://${rest}`),
      };
    }
  }
  const schemed = /^[a-z][a-z0-9+.-]*:/i.test(t) || t.includes("://");
  return {
    ...FAILS,
    note: "Start it with https://, or leave it empty.",
    fix: schemed ? null : offer(`https://${t}`),
  };
}

function email(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  let ats = 0;
  const offences = scan(
    text,
    from,
    to,
    (c) => c === "@" ? ++ats > 1 : EMAIL_REFUSED.test(c),
  );
  const spaces = offences.filter((o) => /\s/.test(o.char));
  const others = offences.filter((o) => !/[\s@]/.test(o.char));
  const parts: string[] = [];
  if (spaces.length > 0) {
    parts.push("A space can't be used in an email address.");
  }
  if (others.length > 0) {
    parts.push(`${named(others)} can't be used in an email address.`);
  }
  if (offences.some((o) => o.char === "@")) {
    parts.push('"@" appears once in an address.');
  }
  const ok = emailOk(t);
  // "Ada Example <ada@example.org>" pasted from a mail client, a mailto:
  // link's address, and one copied with the punctuation after it.
  const candidates = [
    /<\s*([^\s<>]+)\s*>/.exec(t)?.[1] ?? "",
    t.replace(/^mailto:/i, "").replace(/^<(.*)>$/, "$1"),
    t.replace(/[,;.]+$/, ""),
  ];
  let note: string | null = null;
  if (!ok && offences.length === 0) {
    const at = t.indexOf("@");
    note = at === -1
      ? 'Still needed: an "@" and a domain, e.g. name@example.org.'
      : at === 0
      ? 'Still needed: the name before the "@".'
      : at === t.length - 1
      ? 'Still needed: the domain after the "@", e.g. example.org.'
      : "Still needed: the rest of the domain, e.g. example.org.";
  }
  return {
    ok,
    offences,
    message: parts.length > 0 ? parts.join(" ") : null,
    note,
    fix: ok ? null : candidates.find((c) => c !== t && emailOk(c)) ?? null,
  };
}

const PHRASE_NOTE =
  "Put one phrase per row: AND, OR and NOT are the search's own words.";

function quoteless(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  // pipeline/pubmed_search.py quotes every term and tags it itself.
  const offences = scan(
    text,
    from,
    to,
    (c) => c === '"' || c === "[" || c === "]" || hiddenChar(c),
  );
  if (offences.length === 0) {
    return OPERATOR.test(t) ? { ...FAILS, note: PHRASE_NOTE } : CLEAN;
  }
  const parts: string[] = [];
  if (offences.some((o) => o.char === '"')) {
    parts.push(
      "Double quotes can't be used: the search quotes each phrase itself.",
    );
  }
  if (offences.some((o) => o.char === "[" || o.char === "]")) {
    parts.push(
      "Square brackets can't be used: the search tags each phrase itself; remove the [tag].",
    );
  }
  const hidden = offences.filter((o) => hiddenChar(o.char));
  if (hidden.length > 0) parts.push(hiddenMessage(hidden));
  const bare = trim(
    t.replace(/\s*\[[^\]]*\]\s*$/, "").replace(/["[\]]/g, "")
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => hiddenChar(c) ? "" : c),
  ).replace(/\s{2,}/g, " ");
  return {
    ...FAILS,
    offences,
    message: parts.join(" "),
    fix: bare === "" || OPERATOR.test(bare) ? null : bare,
  };
}

function ctgovTerm(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(
    text,
    from,
    to,
    (c) => c === "[" || c === "]" || hiddenChar(c),
  );
  if (offences.length === 0) {
    return ctgovTermRefused(t)
      ? {
        ...FAILS,
        note:
          "Still needed: close every parenthesis and quote, and keep AND, OR and NOT between words.",
      }
      : CLEAN;
  }
  const hidden = offences.filter((o) => hiddenChar(o.char));
  const fixed = trim(
    without(text, hidden).replace(/\[[^\]]*\]/g, " ").replace(/[[\]]/g, " "),
  ).replace(/\s{2,}/g, " ");
  return {
    ...FAILS,
    offences,
    message: [
      hidden.length < offences.length &&
      "Square brackets can't be used: ClinicalTrials.gov cannot parse them.",
      hidden.length > 0 && hiddenMessage(hidden),
    ].filter(Boolean).join(" "),
    fix: fixed === "" || ctgovTermRefused(fixed) ? null : fixed,
  };
}

function slots(text: string): Offence[] {
  const out: Offence[] = [];
  for (let i = text.indexOf(SLOT); i !== -1; i = text.indexOf(SLOT, i + 1)) {
    out.push({ start: i, end: i + SLOT.length, char: SLOT });
  }
  return out;
}

const SLOT_MESSAGE = '"{{" can\'t be used: the prompt reads it as a slot.';

function traitKey(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = ordered([
    ...scan(
      text,
      from,
      to,
      (c) => c === "," || c === "\n" || hiddenChar(c),
    ),
    ...slots(text),
  ]);
  if (offences.length === 0) return reserved(t) ? FAILS : CLEAN;
  const hidden = offences.filter((o) => hiddenChar(o.char));
  const parts = [
    offences.some((o) => o.char === ",") &&
    "A comma can't be used: the filters would read two keys.",
    offences.some((o) => o.char === "\n") &&
    "A line break can't be used: a key is one line.",
    offences.some((o) => o.char === SLOT) && SLOT_MESSAGE,
    hidden.length > 0 && hiddenMessage(hidden),
  ].filter(Boolean);
  const fixed = without(text, hidden);
  return {
    ...FAILS,
    offences,
    message: parts.join(" "),
    fix: hidden.length === offences.length && fixed !== "" && !reserved(fixed)
      ? fixed
      : null,
  };
}

/** Text that only an invisible character can spoil. */
function plain(text: string): Diagnosis {
  if (trim(text) === "") return CLEAN;
  const offences = invisibles(text);
  if (offences.length === 0) return CLEAN;
  const fixed = without(text, offences);
  return {
    ...FAILS,
    offences,
    message: hiddenMessage(offences),
    fix: fixed === "" ? null : fixed,
  };
}

/** A key of a map in the generated files: plain, and no name an object keeps. */
function plainKey(text: string): Diagnosis {
  const d = plain(text);
  if (!d.ok) {
    return d.fix !== null && objectKey(d.fix) ? { ...d, fix: null } : d;
  }
  return objectKey(trim(text)) ? FAILS : CLEAN;
}

function traitLabel(text: string): Diagnosis {
  const d = plain(text);
  if (!d.ok) {
    return d.fix !== null && [...clean(d.fix)].length > TRAIT_LABEL_MAX
      ? { ...d, fix: null }
      : d;
  }
  const length = [...clean(text)].length;
  return length > TRAIT_LABEL_MAX
    ? {
      ...FAILS,
      note:
        `Keep it to ${TRAIT_LABEL_MAX} characters; it has ${length}. The karyogram draws it in a 128px column.`,
    }
    : CLEAN;
}

/** Text spliced into the prompt: no invisible character, and no "{{". */
function slotless(text: string): Diagnosis {
  if (trim(text) === "") return CLEAN;
  const hidden = invisibles(text);
  const offences = ordered([...hidden, ...slots(text)]);
  if (offences.length === 0) return CLEAN;
  const fixed = without(text, hidden);
  return {
    ...FAILS,
    offences,
    message: [
      offences.some((o) => o.char === SLOT) && SLOT_MESSAGE,
      hidden.length > 0 && hiddenMessage(hidden),
    ].filter(Boolean).join(" "),
    fix: hidden.length === offences.length && fixed !== "" ? fixed : null,
  };
}

function reservedKey(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const d = plain(text);
  if (!d.ok) {
    return d.fix !== null && (reserved(d.fix) || objectKey(d.fix))
      ? { ...d, fix: null }
      : d;
  }
  return reserved(t) || objectKey(t) ? FAILS : CLEAN;
}

/** clinical_trials_fetch.py compares a condition lowered, as a-z, 0-9 and spaces. */
const conditionChar = (c: string) => /^[a-z0-9 ]$/.test(c.toLowerCase());
/** The fold, with the accents taken off first, so "behçet" reads "behcet". */
const conditionFix = (word: string) =>
  transliterate(word).toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .replace(/ +/g, " ").trim();
const CONDITION_MESSAGE =
  "can't be used: conditions are compared as unaccented letters, digits and single spaces, so this could never match.";

/** A refused character, or a space after a space. */
const conditionOffence = (text: string) => (c: string, at: number) =>
  !conditionChar(c) || (c === " " && text[at - 1] === " ");

function conditionMessage(offences: Offence[]): string {
  const bad = offences.filter((o) => o.char !== " ");
  return [
    bad.length > 0 && `${named(bad)} ${CONDITION_MESSAGE}`,
    bad.length < offences.length &&
    "Two spaces in a row can't be used: a condition is compared with single spaces, so this could never match.",
  ].filter(Boolean).join(" ");
}

function condition(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(text, from, to, conditionOffence(text));
  if (offences.length === 0) return CLEAN;
  const fixed = conditionFix(t);
  return {
    ...FAILS,
    offences,
    message: conditionMessage(offences),
    fix: fixed === "" || !conditionOk(fixed) ? null : fixed,
  };
}

/** The trimmed spans of a comma list's items, as splitList() keeps them. */
function items(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== ",") continue;
    const part = text.slice(start, i);
    const lead = part.length - part.trimStart().length;
    const end = part.trimEnd().length;
    if (end > lead) out.push([start + lead, start + end]);
    start = i + 1;
  }
  return out;
}

function conditions(text: string): Diagnosis {
  if (trim(text) === "") return CLEAN;
  const spans = items(text);
  if (spans.length === 0) {
    return { ...FAILS, note: "Still needed: at least one condition." };
  }
  const offences = spans.flatMap(([from, to]) =>
    scan(text, from, to, conditionOffence(text))
  );
  if (offences.length === 0) return CLEAN;
  const fixed = spans.map(([from, to]) => conditionFix(text.slice(from, to)))
    .filter((word) => word !== "").join(", ");
  return {
    ...FAILS,
    offences,
    message: conditionMessage(offences),
    // A list typed up to its next separator keeps it: the caret returns to
    // the end, and the next word typed would join the last one otherwise.
    fix: fixed === "" ? null : /,\s*$/.test(text) ? `${fixed}, ` : fixed,
  };
}

function symbol(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = ordered([
    ...scan(text, from, to, (c) => c === "," || /\s/.test(c) || hiddenChar(c)),
    ...slots(text),
  ]);
  if (offences.length === 0) return CLEAN;
  const parts = t.split(",").map(trim).filter((p) => p !== "");
  const hidden = offences.filter((o) => hiddenChar(o.char));
  const fixed = without(parts.length === 1 ? parts[0] : t, []).replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    (c) => hiddenChar(c) ? "" : c,
  );
  return {
    ...FAILS,
    offences,
    message: [
      offences.some((o) => o.char === ",") &&
      "One gene per row: a symbol has no comma.",
      offences.some((o) => o.char !== "," && /\s/.test(o.char)) &&
      "A gene symbol has no space.",
      offences.some((o) => o.char === SLOT) && SLOT_MESSAGE,
      hidden.length > 0 && hiddenMessage(hidden),
    ].filter(Boolean).join(" "),
    fix: /^[^\s,]+$/.test(fixed) && !fixed.includes(SLOT) ? fixed : null,
  };
}

function number(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(
    text,
    from,
    to,
    (c, at) => !/^[0-9]$/.test(c) || (at === from && c === "0"),
  );
  if (offences.length === 0) return CLEAN;
  const others = offences.filter((o) => o.char !== "0");
  const runs = t.match(/[0-9]+/g) ?? [];
  const digits = runs.length === 1 ? runs[0].replace(/^0+/, "") : "";
  return {
    ...FAILS,
    offences,
    message: others.length > 0
      ? `${named(others)} can't be used: digits only, not starting with 0.`
      : "It can't start with 0.",
    fix: PMID.test(digits) ? digits : null,
  };
}

/** tests/pipeline/export/test_omim.py holds the committed OMIM table to ASCII. */
function ascii(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(text, from, to, (c) => !/^[\x20-\x7e]$/.test(c));
  if (offences.length === 0) return CLEAN;
  const folded = asciiFold(t);
  return {
    ...FAILS,
    offences,
    message: `${named(offences)} can't be used: the OMIM table is plain ASCII.`,
    fix: folded !== "" && ASCII_TEXT.test(folded) ? folded : null,
  };
}

/** What Number() can read inside a value from 0 to 1: digits, signs, exponents, radix prefixes. */
const NUMBER_CHAR = /^[0-9.+\-eExXoObB]$/;

function confidence(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(text, from, to, (c) => !NUMBER_CHAR.test(c));
  if (offences.length > 0) {
    const swapped = t.replace(",", ".");
    return {
      ...FAILS,
      offences,
      message: `${
        named(offences)
      } can't be used: a number from 0 to 1, e.g. 0.75.`,
      fix: confidenceOk(parseConfidence(swapped)) ? swapped : null,
    };
  }
  return confidenceOk(parseConfidence(text))
    ? CLEAN
    : { ...FAILS, note: "Still needed: a number from 0 to 1, e.g. 0.75." };
}

/**
 * A DOI written alone, as the link appends it to https://doi.org/: the
 * address a DOI is often copied as, and the "doi:" it is often cited with,
 * come off.
 */
const bareDoi = (text: string): string =>
  trim(
    text.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)\s*/i, "")
      .replace(/%2F/gi, "/"),
  );

function doi(text: string): Diagnosis {
  const t = trim(text);
  if (t === "") return CLEAN;
  const [from, to] = textSpan(text);
  const offences = scan(text, from, to, (c) => /\s/.test(c) || hiddenChar(c));
  const bare = bareDoi(t);
  const fix = bare !== t && DOI.test(bare) && ![...bare].some(hiddenChar)
    ? bare
    : null;
  if (offences.length > 0) {
    const hidden = offences.filter((o) => hiddenChar(o.char));
    return {
      ...FAILS,
      offences,
      message: [
        hidden.length < offences.length && "A DOI can't hold a space.",
        hidden.length > 0 && hiddenMessage(hidden),
      ].filter(Boolean).join(" "),
      fix,
    };
  }
  if (DOI.test(t)) return CLEAN;
  return {
    ...FAILS,
    note: "Write the DOI alone, starting with 10., e.g. 10.1000/xyz123.",
    fix,
  };
}

function sectionMessage(offences: Offence[], breaks: string | null): string {
  const hidden = offences.filter((o) => hiddenChar(o.char));
  return [
    offences.some((o) => o.char === SLOT) && SLOT_MESSAGE,
    offences.some((o) => o.char === "## ") &&
    'A line can\'t start with "## ": it would read as a new section heading.',
    offences.some((o) => o.char === "\n") && breaks,
    hidden.length > 0 && hiddenMessage(hidden),
  ].filter(Boolean).join(" ");
}

/**
 * The faults of a block of prompt text, as the file will hold it: trimmed,
 * so a "## " the trimmed text opens with is a heading, as is one after any
 * line break.
 */
function blockOffences(text: string): Offence[] {
  const [from, to] = textSpan(text);
  const offences = [...slots(text), ...scan(text, from, to, hiddenChar)];
  for (let at = from; at !== -1;) {
    if (text.startsWith("## ", at)) {
      offences.push({ start: at, end: at + 3, char: "## " });
    }
    const next = text.indexOf("\n", at);
    at = next === -1 || next + 1 >= to ? -1 : next + 1;
  }
  return ordered(offences);
}

function section(text: string): Diagnosis {
  if (trim(text) === "") return CLEAN;
  const offences = blockOffences(text);
  return offences.length === 0 ? CLEAN : {
    ...FAILS,
    offences,
    message: sectionMessage(offences, null),
  };
}

/**
 * A section spliced into one line of the template: a block's faults, and
 * every line break, which would reach the model as an unnumbered line.
 */
function inline(text: string): Diagnosis {
  if (trim(text) === "") return CLEAN;
  const [from, to] = textSpan(text);
  const faults = blockOffences(text);
  const offences = ordered([
    ...faults,
    ...scan(text, from, to, (c) => c === "\n"),
  ]);
  if (offences.length === 0) return CLEAN;
  return {
    ...FAILS,
    offences,
    message: sectionMessage(
      offences,
      "A line break can't be used: this text is spliced into one line of the model's instructions.",
    ),
    fix: faults.length === 0 ? trim(text).split(/\s*\n\s*/).join(" ") : null,
  };
}

/**
 * The disease steps as diseaseSteps() reads them: paragraphs split on a
 * blank line, each trimmed. A line break inside a step, and "## " opening a
 * step or a line inside one, are what validate() refuses.
 */
function steps(text: string): Diagnosis {
  if (trim(text) === "") return CLEAN;
  const [start, stop] = textSpan(text);
  const offences = [...slots(text), ...scan(text, start, stop, hiddenChar)];
  const separator = /\n[ \t]*\n/g;
  const paragraphs: Array<[number, number]> = [];
  let from = 0;
  for (let m = separator.exec(text); m !== null; m = separator.exec(text)) {
    paragraphs.push([from, m.index]);
    from = m.index + m[0].length;
  }
  paragraphs.push([from, text.length]);
  for (const [start, end] of paragraphs) {
    const part = text.slice(start, end);
    const first = start + part.length - part.trimStart().length;
    const last = start + part.trimEnd().length;
    if (last <= first) continue;
    if (text.startsWith("## ", first) && first + 3 <= last) {
      offences.push({ start: first, end: first + 3, char: "## " });
    }
    for (let i = first; i < last; i++) {
      if (text[i] !== "\n") continue;
      offences.push({ start: i, end: i + 1, char: "\n" });
      if (text.startsWith("## ", i + 1) && i + 4 <= last) {
        offences.push({ start: i + 1, end: i + 4, char: "## " });
      }
    }
  }
  const all = ordered(offences);
  return all.length === 0 ? CLEAN : {
    ...FAILS,
    offences: all,
    message: sectionMessage(
      all,
      "Each step is one paragraph: join its lines, or leave a blank line between two steps.",
    ),
  };
}

export function diagnose(rule: Rule, text: string): Diagnosis {
  switch (rule) {
    case "key":
      return keyLike(text, KEY, "", null);
    case "exampleType":
      return keyLike(
        text,
        EXAMPLE_TYPE,
        ", e.g. include_validated",
        "Still needed: a type starting with include_, e.g. include_validated; every example shows a gene to extract.",
      );
    case "url":
      return url(text);
    case "email":
      return email(text);
    case "quoteless":
      return quoteless(text);
    case "ctgovTerm":
      return ctgovTerm(text);
    case "traitKey":
      return traitKey(text);
    case "traitLabel":
      return traitLabel(text);
    case "reservedKey":
      return reservedKey(text);
    case "plainKey":
      return plainKey(text);
    case "condition":
      return condition(text);
    case "conditions":
      return conditions(text);
    case "symbol":
      return symbol(text);
    case "number":
      return number(text);
    case "ascii":
      return ascii(text);
    case "confidence":
      return confidence(text);
    case "doi":
      return doi(text);
    case "slotless":
      return slotless(text);
    case "plain":
      return plain(text);
    case "section":
      return section(text);
    case "inline":
      return inline(text);
    case "steps":
      return steps(text);
  }
}
