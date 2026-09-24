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
 * first keystroke.
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

/**
 * Keep an unreadable draft under UNREADABLE_KEY, once: a second unreadable
 * draft does not replace the first one kept. Returns the text kept.
 */
export function keepUnreadable(store: Store): string | null {
  const stored = store.getItem(DRAFT_STORAGE_KEY);
  if (stored !== null && store.getItem(UNREADABLE_KEY) === null) {
    store.setItem(UNREADABLE_KEY, stored);
  }
  return store.getItem(UNREADABLE_KEY);
}

/**
 * Write the answers: the draft without its logos, and each logo whose
 * bytes differ from `previous`'s under its own key (removed when it is
 * gone). Throws what the store throws, so the island can say a save was
 * refused.
 */
export function writeDraft(
  store: Store,
  answers: Answers,
  previous: Answers | null,
) {
  store.setItem(DRAFT_STORAGE_KEY, serialiseDraft(withoutLogos(answers)));
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
