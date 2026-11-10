/**
 * The draft as localStorage holds it: the answers under DRAFT_STORAGE_KEY,
 * each logo under a key of its own, and how two tabs' writes are merged.
 *
 * Every edit saves at once -- the refused-save alert and the adoption of a
 * second tab's save both rely on it -- so what an edit writes is kept
 * small: a logo can be a megabyte of base64, and it is written only when
 * it changes, not with every keystroke. Every key here derives from
 * DRAFT_STORAGE_KEY, so no new storage literal joins the allow-list in
 * tests/no_disease_literals_test.ts.
 */
import {
  type Answers,
  DRAFT_STORAGE_KEY,
  EMPTY_ANSWERS,
  isRecord,
  LOGO_BYTE_LIMIT,
  type LogoFile,
  parseDraft,
  serialiseDraft,
} from "./answers.ts";
import { file, rebuild } from "./draft_shape.ts";

/**
 * Where a stored draft this build cannot read is kept, untouched, before
 * anything is saved over it: another version's draft (a rollback, or a
 * DRAFT_VERSION bump) or damaged JSON would otherwise be overwritten by the
 * first keystroke. A later one is kept beside it, under this key numbered
 * (keptDrafts()).
 */
export const UNREADABLE_KEY = `${DRAFT_STORAGE_KEY}-unreadable`;

/**
 * Written by a Start over or an import. Another tab seeing it knows its
 * draft was replaced wholesale, and that what it had revealed no longer
 * applies.
 */
export const REPLACED_KEY = `${DRAFT_STORAGE_KEY}-replaced`;

export type LogoSlot = "logoLight" | "logoDark";
export const LOGO_KEYS: Readonly<Record<LogoSlot, string>> = {
  logoLight: `${DRAFT_STORAGE_KEY}-logo-light`,
  logoDark: `${DRAFT_STORAGE_KEY}-logo-dark`,
};
const SLOTS: readonly LogoSlot[] = ["logoLight", "logoDark"];

/** Every key the draft occupies, for a storage event to recognise. */
export const DRAFT_KEYS: readonly string[] = [
  DRAFT_STORAGE_KEY,
  ...Object.values(LOGO_KEYS),
];

/** What a storage holds; localStorage in the island, a map in the tests. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The answers with both logos taken out, as the draft key holds them. */
export function withoutLogos(answers: Answers): Answers {
  return {
    ...answers,
    identity: { ...answers.identity, logoLight: null, logoDark: null },
  };
}

/** A logo stored under its own key, read as a draft reads one. */
export function readLogo(text: string | null): LogoFile | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return rebuild(file(LOGO_BYTE_LIMIT), raw).value as LogoFile | null;
}

/**
 * The stored draft, and whether a draft is stored that this build cannot
 * read. A draft saved before the logos had keys of their own holds them
 * inline, and they are kept until the next save moves them out.
 */
export function readStoredDraft(
  store: Store,
): { answers: Answers | null; unreadable: boolean } {
  const stored = store.getItem(DRAFT_STORAGE_KEY);
  if (stored === null) return { answers: null, unreadable: false };
  const draft = parseDraft(stored);
  if (draft === null) return { answers: null, unreadable: true };
  for (const slot of SLOTS) {
    const logo = readLogo(store.getItem(LOGO_KEYS[slot]));
    if (logo !== null) draft.identity[slot] = logo;
  }
  return { answers: draft, unreadable: false };
}

/** The nth draft kept aside: UNREADABLE_KEY, then `-2`, `-3` after it. */
const keptKey = (n: number) =>
  n === 1 ? UNREADABLE_KEY : `${UNREADABLE_KEY}-${n}`;

/**
 * Every unreadable draft kept aside, oldest first. They stay until the
 * researcher discards them, so the island reads them on every load, not
 * only on the one that found a draft unreadable: after the first save the
 * draft key reads again, and a copy offered on that one visit alone was
 * megabytes of the quota nothing on the page could reach or free.
 */
export function keptDrafts(store: Store): string[] {
  const kept: string[] = [];
  for (
    let text = store.getItem(keptKey(1));
    text !== null;
    text = store.getItem(keptKey(kept.length + 1))
  ) kept.push(text);
  return kept;
}

/**
 * Keep the stored draft, unreadable as it is, under the first free kept
 * key, and return it. A draft already kept is not kept twice, so a reload
 * before the first save adds nothing, and a draft kept earlier is never
 * replaced: kept "once" under UNREADABLE_KEY alone, the second unreadable
 * draft in one browser -- a rollback after a DRAFT_VERSION bump -- was
 * saved over while the notice offered the first. Throws what the store
 * throws, so the island knows the stored draft is still the only copy.
 */
export function keepUnreadable(store: Store): string | null {
  const stored = store.getItem(DRAFT_STORAGE_KEY);
  if (stored === null) return null;
  const kept = keptDrafts(store);
  if (!kept.includes(stored)) store.setItem(keptKey(kept.length + 1), stored);
  return stored;
}

/**
 * Drop every draft kept aside, once the researcher says they may go. The
 * stored draft goes with them while it is still one of them: until the
 * first save the draft key holds the very text that was kept, and left
 * there the next load found it unreadable and kept it again, so a discard
 * with nothing typed lasted until the reload. A stored draft this build
 * reads is the researcher's answers, and one that was never kept is still
 * its only copy; both stay.
 */
export function discardKept(store: Store) {
  const kept = keptDrafts(store);
  const stored = store.getItem(DRAFT_STORAGE_KEY);
  if (
    stored !== null && kept.includes(stored) && parseDraft(stored) === null
  ) store.removeItem(DRAFT_STORAGE_KEY);
  for (let n = kept.length; n > 0; n--) store.removeItem(keptKey(n));
}

const TEXT = String.raw`"(?:[^"\\]|\\.)*`;
const NCBI_OPENING = /"ncbi"\s*:\s*\{/g;
const CREDENTIAL = new RegExp(
  String.raw`("(?:email|apiKey)"\s*:\s*)${TEXT}"?`,
  "g",
);

/**
 * Where the record opened just before `from` ends in a text that does not
 * parse: past the brace that closes it, or the end of the text when it was
 * cut short. Braces inside a string open and close nothing.
 */
function recordEnd(text: string, from: number): number {
  let depth = 1;
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * `value` with the e-mail and the key blanked in every `ncbi` record, and
 * in whatever it nests: a version that files them a level down still has
 * them under `ncbi`.
 */
function withoutCredentials(value: unknown, ncbi = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutCredentials(entry, ncbi));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      ncbi && (key === "email" || key === "apiKey")
        ? ""
        : withoutCredentials(entry, ncbi || key === "ncbi"),
    ]),
  );
}

/**
 * A kept draft as its download writes it: without the NCBI e-mail and API
 * key. The file is what a researcher mails a maintainer to get their
 * answers back, and the copy in storage, which stays as it was stored,
 * holds both in clear. Another version may file them elsewhere, so every
 * `ncbi` record is blanked wherever it sits; a draft holding neither is
 * returned byte for byte. Damaged JSON cannot be walked, so each `ncbi`
 * record is blanked in the text, from its opening brace to the one that
 * closes it (recordEnd): read pair by pair instead, a value that was no
 * string -- a null e-mail -- ended the record early and the key after it
 * was written out.
 */
export function unreadableDownload(text: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    let blanked = "";
    let done = 0;
    for (const opening of text.matchAll(NCBI_OPENING)) {
      const start = opening.index + opening[0].length;
      // A record inside one already blanked was blanked with it.
      if (start < done) continue;
      const end = recordEnd(text, start);
      blanked += text.slice(done, start) +
        text.slice(start, end).replace(CREDENTIAL, '$1""');
      done = end;
    }
    return blanked + text.slice(done);
  }
  const blanked = JSON.stringify(withoutCredentials(raw));
  return blanked === JSON.stringify(raw) ? text : blanked;
}

/**
 * Each logo whose bytes differ from `previous`'s, under its own key
 * (removed when it is gone).
 */
function writeLogos(store: Store, answers: Answers, previous: Answers | null) {
  for (const slot of SLOTS) {
    const logo = answers.identity[slot];
    const before = previous?.identity[slot] ?? null;
    if (
      previous !== null && logo?.base64 === before?.base64 &&
      logo?.name === before?.name
    ) continue;
    if (logo === null) store.removeItem(LOGO_KEYS[slot]);
    else store.setItem(LOGO_KEYS[slot], JSON.stringify(logo));
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The three-way merge of two tabs' drafts: what each changed since the
 * draft both last agreed on (`base`) is kept, leaf by leaf, and where both
 * changed one leaf this tab's (`ours`) wins. A list both lengthened or
 * shortened is taken whole from `theirs`, since a removal shifts every row
 * after it and rows cannot be matched by index; a list only one side
 * resized is taken from that side.
 */
export function mergeDrafts(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): unknown {
  if (same(ours, theirs) || same(base, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    if (ours.length !== base.length) {
      return theirs.length !== base.length ? theirs : ours;
    }
    if (theirs.length !== base.length) return theirs;
    return ours.map((entry, i) => mergeDrafts(base[i], entry, theirs[i]));
  }
  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    // Every key either side holds: the prompt's sections are keyed, and a
    // section only one side has written is still that side's answer.
    const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
    return Object.fromEntries(
      [...keys].flatMap((key) => {
        const merged = mergeDrafts(base[key], ours[key], theirs[key]);
        return merged === undefined ? [] : [[key, merged]];
      }),
    );
  }
  return ours;
}

/**
 * This tab's answers merged with another tab's draft, against the draft
 * both last agreed on (`synced`, as the draft key held it). The logos stay
 * this tab's: each travels under its own key, by an event of its own.
 */
function merged(synced: string | null, ours: Answers, theirs: Answers) {
  const base = (synced === null ? null : parseDraft(synced)) ?? EMPTY_ANSWERS;
  const draft = mergeDrafts(
    withoutLogos(base),
    withoutLogos(ours),
    withoutLogos(theirs),
  ) as Answers;
  draft.identity.logoLight = ours.identity.logoLight;
  draft.identity.logoDark = ours.identity.logoDark;
  return draft;
}

/** What a save leaves a tab holding. */
export interface Saved {
  /** The answers that are now this tab's. */
  answers: Answers;
  /** The draft key's text as this tab last wrote or adopted it. */
  synced: string | null;
  /** False when the store refused the draft or a logo. */
  saved: boolean;
}

/**
 * Write `next`, merging first when another tab has written since this one
 * last synced (`synced`): the other tab's edits survive, and where both
 * changed one answer this tab's wins. `logosStored` is whether storage
 * holds the logos `previous` carries; when it does not, both are written
 * whether they changed or not.
 *
 * The draft key is written before the logos, and a logo can be refused
 * after it has taken the draft. What the tab holds follows the draft key,
 * not the save as a whole: once that key is written, `synced` is its text
 * and the answers are the ones written there. Left on the draft before it,
 * the tab read its own write as another tab's on every later save, and an
 * edit put back to what it had been -- a character deleted again, a row
 * removed again -- came back from that write as the other tab's change.
 */
export function saveDraft(
  store: Store,
  next: Answers,
  previous: Answers | null,
  synced: string | null,
  logosStored: boolean,
): Saved {
  let written = next;
  let text: string;
  try {
    const stored = store.getItem(DRAFT_STORAGE_KEY);
    const theirs = stored === null || stored === synced
      ? null
      : parseDraft(stored);
    if (theirs !== null) written = merged(synced, next, theirs);
    text = serialiseDraft(withoutLogos(written));
    store.setItem(DRAFT_STORAGE_KEY, text);
  } catch {
    // Nothing was written: the tab keeps its own answers, and the other
    // tab's write is still there to merge on the save that lands.
    return { answers: next, synced, saved: false };
  }
  try {
    writeLogos(store, written, logosStored ? previous : null);
  } catch {
    return { answers: written, synced: text, saved: false };
  }
  return { answers: written, synced: text, saved: true };
}

/**
 * Another tab's save, as its storage event carries it (`incoming`), merged
 * into this tab's answers; null when there is nothing to adopt. An event is
 * news only while storage still holds what it carries. One that storage
 * has moved past is either followed by the event for the newer write, or
 * was merged already by this tab's own save, which found the write in
 * storage before its event was delivered; adopted then, against the merge
 * as the draft both tabs agree on, it read as the other tab undoing this
 * one's edit and took a keystroke back off the screen.
 */
export function adoptDraft(
  store: Store,
  incoming: string,
  previous: Answers,
  synced: string | null,
): { answers: Answers; synced: string } | null {
  const theirs = parseDraft(incoming);
  if (theirs === null) return null;
  let stored: string | null;
  try {
    stored = store.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (stored !== incoming) return null;
  return { answers: merged(synced, previous, theirs), synced: incoming };
}
