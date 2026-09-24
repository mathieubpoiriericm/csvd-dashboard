import { assert, assertEquals, assertThrows } from "@std/assert";

import {
  type Answers,
  DRAFT_STORAGE_KEY,
  EMPTY_ANSWERS,
  serialiseDraft,
} from "../../lib/adapt/answers.ts";
import {
  DRAFT_KEYS,
  keepUnreadable,
  LOGO_KEYS,
  mergeDrafts,
  readStoredDraft,
  REPLACED_KEY,
  type Store,
  UNREADABLE_KEY,
  withoutLogos,
  writeDraft,
} from "../../lib/adapt/draft_storage.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

/** A store over a map, which can be told to refuse one key's writes. */
function memory(refuse?: string) {
  const items = new Map<string, string>();
  const store: Store & { items: Map<string, string> } = {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (key === refuse) throw new DOMException("full", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key) => void items.delete(key),
  };
  return store;
}

const PNG = btoa(
  String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1),
);

const withLogos = (): Answers => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.identity.logoDark = { name: "logo-dark.png", base64: PNG };
  return answers;
};

Deno.test("every key the draft uses derives from its storage key", () => {
  for (const key of [...DRAFT_KEYS, UNREADABLE_KEY, REPLACED_KEY]) {
    assert(key.startsWith(DRAFT_STORAGE_KEY), key);
  }
});

Deno.test("the logos are written apart from the draft, and read back into it", () => {
  const store = memory();
  const answers = withLogos();
  writeDraft(store, answers, null);
  // The draft key holds no logo bytes: a keystroke rewrites only the rest.
  const draft = store.getItem(DRAFT_STORAGE_KEY)!;
  assert(!draft.includes(PNG));
  assertEquals(draft, serialiseDraft(withoutLogos(answers)));
  assertEquals(
    JSON.parse(store.getItem(LOGO_KEYS.logoDark)!),
    answers.identity.logoDark,
  );
  assertEquals(readStoredDraft(store), { answers, unreadable: false });
});

Deno.test("a logo is written only when it changes, and removed when it goes", () => {
  const answers = withLogos();
  // A logo key refusing its write would throw if it were written again.
  const store = memory();
  writeDraft(store, answers, null);
  const refusing = memory(LOGO_KEYS.logoLight);
  for (const [key, value] of store.items) refusing.items.set(key, value);
  const typed = structuredClone(answers);
  typed.identity.disease.name = "exampleitis two";
  writeDraft(refusing, typed, answers);
  assertEquals(
    readStoredDraft(refusing).answers!.identity.disease.name,
    "exampleitis two",
  );
  // A changed logo is written, and a refused write is the save's failure.
  const changed = structuredClone(typed);
  changed.identity.logoLight = { name: "other.svg", base64: btoa("<svg/>") };
  assertThrows(() => writeDraft(refusing, changed, typed));
  const gone = structuredClone(typed);
  gone.identity.logoDark = null;
  writeDraft(refusing, gone, typed);
  assertEquals(refusing.getItem(LOGO_KEYS.logoDark), null);
});

Deno.test("a draft saved with its logos inline still loads them", () => {
  const store = memory();
  const answers = withLogos();
  store.setItem(DRAFT_STORAGE_KEY, serialiseDraft(answers));
  assertEquals(readStoredDraft(store).answers, answers);
  // A logo key holding something unreadable is no logo.
  store.setItem(LOGO_KEYS.logoLight, "not json");
  store.setItem(LOGO_KEYS.logoDark, '{"name":"x.png","base64":""}');
  assertEquals(readStoredDraft(store).answers, answers);
});

Deno.test("a stored draft this build cannot read is said, and kept once", () => {
  const store = memory();
  assertEquals(readStoredDraft(store), { answers: null, unreadable: false });
  assertEquals(keepUnreadable(store), null);
  const other = JSON.stringify({ ...EMPTY_ANSWERS, version: 2 });
  store.setItem(DRAFT_STORAGE_KEY, other);
  assertEquals(readStoredDraft(store), { answers: null, unreadable: true });
  assertEquals(keepUnreadable(store), other);
  // A second unreadable draft does not replace the first one kept.
  store.setItem(DRAFT_STORAGE_KEY, '{"version": 1, "iden');
  assertEquals(readStoredDraft(store).unreadable, true);
  assertEquals(keepUnreadable(store), other);
});

Deno.test("two tabs' edits to different answers both survive a merge", () => {
  const base = structuredClone(EXAMPLEITIS);
  const ours = structuredClone(base);
  ours.identity.disease.name = "ours";
  const theirs = structuredClone(base);
  theirs.gold.rows[0].note = "theirs";
  theirs.prompt.sections["rubric.extra"] = "a section only they wrote";
  const merged = mergeDrafts(base, ours, theirs) as Answers;
  assertEquals(merged.identity.disease.name, "ours");
  assertEquals(merged.gold.rows[0].note, "theirs");
  assertEquals(
    merged.prompt.sections["rubric.extra"],
    "a section only they wrote",
  );
  // Where both changed one answer, this tab's wins.
  theirs.identity.disease.name = "theirs";
  assertEquals(
    (mergeDrafts(base, ours, theirs) as Answers).identity.disease.name,
    "ours",
  );
  // A section one side removed stays removed when the other left it.
  const cleared = structuredClone(base);
  delete cleared.prompt.sections["rubric.modifiers"];
  assertEquals(
    "rubric.modifiers" in
      (mergeDrafts(base, cleared, base) as Answers).prompt.sections,
    false,
  );
  // And so when this tab changed another key of the same record.
  const removed = structuredClone(base);
  delete removed.prompt.sections["rubric.modifiers"];
  const edited = structuredClone(base);
  edited.prompt.sections["rubric.cell_types"] = "Pericytes";
  const sections = (mergeDrafts(base, edited, removed) as Answers).prompt
    .sections;
  assertEquals("rubric.modifiers" in sections, false);
  assertEquals(sections["rubric.cell_types"], "Pericytes");
  assertEquals(mergeDrafts(base, base, base), base);
});

Deno.test("a list resized on one side is taken from it, and from theirs when both", () => {
  const base = { rows: ["a", "b"], other: 1 };
  assertEquals(
    mergeDrafts(base, { rows: ["a", "b", "c"], other: 1 }, {
      rows: ["a", "B"],
      other: 2,
    }),
    { rows: ["a", "b", "c"], other: 2 },
  );
  assertEquals(
    mergeDrafts(base, { rows: ["A", "b"], other: 1 }, {
      rows: ["b"],
      other: 1,
    }),
    { rows: ["b"], other: 1 },
  );
  assertEquals(
    mergeDrafts(base, { rows: ["a"], other: 1 }, {
      rows: ["a", "b", "c"],
      other: 1,
    }),
    { rows: ["a", "b", "c"], other: 1 },
  );
  // Same length on every side: merged row by row.
  assertEquals(
    mergeDrafts(base, { rows: ["A", "b"], other: 1 }, {
      rows: ["a", "B"],
      other: 1,
    }),
    { rows: ["A", "B"], other: 1 },
  );
});
