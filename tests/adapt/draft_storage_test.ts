import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";

import {
  type Answers,
  DRAFT_STORAGE_KEY,
  EMPTY_ANSWERS,
  serialiseDraft,
} from "../../lib/adapt/answers.ts";
import {
  adoptDraft,
  discardKept,
  DRAFT_KEYS,
  keepUnreadable,
  keptDrafts,
  LOGO_KEYS,
  mergeDrafts,
  readStoredDraft,
  REPLACED_KEY,
  saveDraft,
  type Store,
  UNREADABLE_KEY,
  unreadableDownload,
  withoutLogos,
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

/**
 * A save as the island makes one with nothing to merge: the store's own
 * draft is the one the tab last synced, and it holds the logos `previous`
 * carries. A refused write throws, as the store did.
 */
function writeDraft(store: Store, answers: Answers, previous: Answers | null) {
  const synced = store.getItem(DRAFT_STORAGE_KEY);
  if (!saveDraft(store, answers, previous, synced, true).saved) {
    throw new DOMException("full", "QuotaExceededError");
  }
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

Deno.test("a stored draft this build cannot read is said, and each one is kept", () => {
  const store = memory();
  assertEquals(readStoredDraft(store), { answers: null, unreadable: false });
  assertEquals(keepUnreadable(store), null);
  assertEquals(keptDrafts(store), []);
  const other = JSON.stringify({ ...EMPTY_ANSWERS, version: 2 });
  store.setItem(DRAFT_STORAGE_KEY, other);
  assertEquals(readStoredDraft(store), { answers: null, unreadable: true });
  assertEquals(keepUnreadable(store), other);
  assertEquals(store.getItem(UNREADABLE_KEY), other);
  // A reload before the first keystroke finds the same draft: one copy.
  assertEquals(keepUnreadable(store), other);
  assertEquals(keptDrafts(store), [other]);
  // This version's draft is saved over it, and then a second unreadable
  // one arrives -- a rollback after a DRAFT_VERSION bump. It is the one
  // kept now, and the one the notice offers, beside the first.
  writeDraft(store, EXAMPLEITIS, null);
  const damaged = '{"version": 1, "iden';
  store.setItem(DRAFT_STORAGE_KEY, damaged);
  assertEquals(readStoredDraft(store).unreadable, true);
  assertEquals(keepUnreadable(store), damaged);
  assertEquals(keepUnreadable(store), damaged);
  assertEquals(keptDrafts(store), [other, damaged]);
  // The first keystroke's save leaves both where they are.
  writeDraft(store, EXAMPLEITIS, null);
  assertEquals(keptDrafts(store), [other, damaged]);
  assertEquals(store.getItem(UNREADABLE_KEY), other);
  // Kept until the researcher discards them, which frees every key.
  const draft = store.getItem(DRAFT_STORAGE_KEY);
  discardKept(store);
  assertEquals(keptDrafts(store), []);
  assertEquals(
    [...store.items.keys()].filter((key) => key.startsWith(UNREADABLE_KEY)),
    [],
  );
  assertEquals(store.getItem(DRAFT_STORAGE_KEY), draft);
});

Deno.test("a discard before the first save takes the stored draft with its copy", () => {
  const store = memory();
  const other = JSON.stringify({ ...EMPTY_ANSWERS, version: 2 });
  store.setItem(DRAFT_STORAGE_KEY, other);
  keepUnreadable(store);
  discardKept(store);
  // Left under the draft key, the next load found it unreadable and kept
  // it again: the discard lasted until the reload.
  assertEquals(store.getItem(DRAFT_STORAGE_KEY), null);
  assertEquals(keepUnreadable(store), null);
  assertEquals(keptDrafts(store), []);
  // A stored draft that could not be kept is still its only copy, and
  // discarding an older one does not take it.
  store.setItem(DRAFT_STORAGE_KEY, '{"version": 98}');
  keepUnreadable(store);
  store.setItem(DRAFT_STORAGE_KEY, "not json");
  discardKept(store);
  assertEquals(store.getItem(DRAFT_STORAGE_KEY), "not json");
  assertEquals(keptDrafts(store), []);
  // Nor does a discard take a draft this build reads, though a build that
  // could not read it kept a copy: a rollback, then the version it wrote.
  const readable = serialiseDraft(withoutLogos(EXAMPLEITIS));
  store.setItem(DRAFT_STORAGE_KEY, readable);
  store.setItem(UNREADABLE_KEY, readable);
  discardKept(store);
  assertEquals(store.getItem(DRAFT_STORAGE_KEY), readable);
  assertEquals(keptDrafts(store), []);
});

Deno.test("a kept draft that finds no room is the keeper's failure, not a silent loss", () => {
  const store = memory(UNREADABLE_KEY);
  store.setItem(DRAFT_STORAGE_KEY, "not json");
  assertThrows(() => keepUnreadable(store));
  assertEquals(keptDrafts(store), []);
});

Deno.test("the download of an unreadable draft leaves the NCBI credentials out", () => {
  const keyed = structuredClone(EXAMPLEITIS);
  keyed.search.ncbi = { email: "ada@example.org", apiKey: "0123456789abcdef" };
  // Another version's draft: the path every returning researcher takes
  // after a DRAFT_VERSION bump, and the file they would mail a maintainer.
  const stored = JSON.stringify({ ...keyed, version: 2 });
  const download = unreadableDownload(stored);
  assert(!download.includes("0123456789abcdef"));
  assertEquals(JSON.parse(download), { ...EXAMPLEITIS, version: 2 });
  // The maintainer's address is an answer, not a credential.
  assertEquals(
    JSON.parse(download).identity.maintainer.email,
    "ada@example.org",
  );
  // A draft holding none is handed over as stored, byte for byte.
  for (
    const text of [
      '{"version": 99, "identity": {}}',
      '{"version": 99, "search": {"ncbi": {"email": "", "apiKey": ""}}}',
      '"a string"',
      "[1, null]",
    ]
  ) {
    assertEquals(unreadableDownload(text), text);
  }
  // Another version may keep them elsewhere, and as something else.
  assertEquals(
    JSON.parse(unreadableDownload(
      '{"version":3,"lookups":[{"ncbi":{"apiKey":{"value":"k"},"email":"e","tool":7}}],"email":"kept"}',
    )),
    {
      version: 3,
      lookups: [{ ncbi: { apiKey: "", email: "", tool: 7 } }],
      email: "kept",
    },
  );
  // Or a level down, in a record or a list of them: still under `ncbi`.
  assertEquals(
    JSON.parse(unreadableDownload(
      '{"ncbi":{"auth":{"apiKey":"k"},"accounts":[{"email":"e","n":1}]}}',
    )),
    { ncbi: { auth: { apiKey: "" }, accounts: [{ email: "", n: 1 }] } },
  );
});

Deno.test("a damaged draft's download leaves the NCBI credentials out too", () => {
  const keyed = structuredClone(EXAMPLEITIS);
  keyed.search.ncbi = { email: "ada@example.org", apiKey: 'abc"\\def' };
  const stored = serialiseDraft(keyed);
  const blank = structuredClone(EXAMPLEITIS);
  const expected = serialiseDraft(blank);
  // Cut short anywhere after the credentials, they are gone and everything
  // else is as stored.
  const after = stored.indexOf('"apiKey"') + 40;
  for (const end of [after, stored.length - 1]) {
    assertEquals(
      unreadableDownload(stored.slice(0, end)),
      expected.slice(0, end - (stored.length - expected.length)),
    );
  }
  // Cut short inside the key, what was stored of it goes.
  const inside = stored.indexOf('"apiKey"') + '"apiKey":"abc'.length;
  const cut = unreadableDownload(stored.slice(0, inside));
  assert(cut.endsWith('"ncbi":{"email":"","apiKey":""'), cut);
  assertStringIncludes(cut, '"email":"ada@example.org"');
  // Spaced as a hand-edited file is, and with nothing to blank.
  assertEquals(
    unreadableDownload('{"ncbi" : { "apiKey" : "k" , "email" : "e", "n": 1'),
    '{"ncbi" : { "apiKey" : "" , "email" : "", "n": 1',
  );
  assertEquals(
    unreadableDownload('{"version": 1, "iden'),
    '{"version": 1, "iden',
  );
  // A value that is no string does not end the record before the key: read
  // pair by pair, the null e-mail did, and the key was written out.
  assertEquals(
    unreadableDownload('{"search":{"ncbi":{"email":null,"apiKey":"SECRET"}'),
    '{"search":{"ncbi":{"email":null,"apiKey":""}',
  );
  // The record runs to its own closing brace, whatever it nests and
  // whatever a string in it holds, and no further.
  assertEquals(
    unreadableDownload(
      '{"ncbi":{"n":1,"auth":{"apiKey":"K"},"note":"a } brace"},"email":"kept","x',
    ),
    '{"ncbi":{"n":1,"auth":{"apiKey":""},"note":"a } brace"},"email":"kept","x',
  );
  assertEquals(
    unreadableDownload(
      '{"ncbi":{"ncbi":{"apiKey":"a"},"apiKey":"b"},"apiKey":"k',
    ),
    '{"ncbi":{"ncbi":{"apiKey":""},"apiKey":""},"apiKey":"k',
  );
});

/**
 * A tab as the island keeps one: its answers, and what it knows of the
 * storage it shares with the other tabs.
 */
function tab(store: Store, answers: Answers = EMPTY_ANSWERS) {
  const state = {
    answers,
    synced: null as string | null,
    logosStored: true,
  };
  return {
    state,
    save(next: Answers) {
      const saved = saveDraft(
        store,
        next,
        state.answers,
        state.synced,
        state.logosStored,
      );
      state.answers = saved.answers;
      state.synced = saved.synced;
      state.logosStored = saved.saved;
      return saved.saved;
    },
    edit(change: (draft: Answers) => void) {
      const next = structuredClone(state.answers);
      change(next);
      return this.save(next);
    },
    hear(incoming: string) {
      const adopted = adoptDraft(store, incoming, state.answers, state.synced);
      if (adopted !== null) Object.assign(state, adopted);
      return adopted !== null;
    },
  };
}

/**
 * The fixture as the draft key holds it. A logo reaches another tab under
 * its own key, by an event of its own, which these tabs do not model.
 */
const PLAIN = withoutLogos(EXAMPLEITIS);

Deno.test("a save whose logo is refused still syncs with the draft it wrote", () => {
  const store = memory(LOGO_KEYS.logoDark);
  const mine = tab(store);
  assertEquals(mine.save(structuredClone(EXAMPLEITIS)), true);
  /** The draft key holds what this tab shows, refused logo or not. */
  const agrees = () =>
    assertEquals(
      store.getItem(DRAFT_STORAGE_KEY),
      serialiseDraft(withoutLogos(mine.state.answers)),
    );
  // The logo's own key is full; the draft key has already been written.
  assertEquals(mine.save(withLogos()), false);
  agrees();
  assertEquals(mine.state.synced, store.getItem(DRAFT_STORAGE_KEY));
  // Each of these is made and then undone while the refusal lasts. Merged
  // against a draft older than this tab's own last write, the undoing read
  // as "unchanged here" and the write it undid came back as another tab's.
  const edits: Array<[(draft: Answers) => void, (draft: Answers) => void]> = [
    [
      (draft) => draft.identity.disease.name += "x",
      (draft) =>
        draft.identity.disease.name = EXAMPLEITIS.identity.disease.name,
    ],
    [
      (draft) =>
        draft.gold.rows.push({
          pmid: "99999999",
          note: "typo row",
          title: null,
          exists: null,
        }),
      (draft) => draft.gold.rows.pop(),
    ],
  ];
  for (const [make, undo] of edits) {
    assertEquals(mine.edit(make), false);
    agrees();
    assertEquals(mine.edit(undo), false);
    agrees();
  }
  assertEquals(mine.state.answers, withLogos());
  // The logo goes, the save lands, and nothing undone comes back.
  assertEquals(mine.edit((draft) => draft.identity.logoDark = null), true);
  assertEquals(mine.state.answers, EXAMPLEITIS);
  assertEquals(readStoredDraft(store).answers, EXAMPLEITIS);
});

Deno.test("a refused logo does not cost the other tab's edit this save merged", () => {
  const store = memory(LOGO_KEYS.logoDark);
  const mine = tab(store);
  mine.save(structuredClone(EXAMPLEITIS));
  const theirs = structuredClone(EXAMPLEITIS);
  theirs.identity.maintainer.name = "Grace Example";
  store.setItem(DRAFT_STORAGE_KEY, serialiseDraft(theirs));
  // The draft key now holds the merge, so the merge is what this tab shows:
  // keeping its own answers instead, its next save would find storage as it
  // left it and write the other tab's edit away.
  assertEquals(mine.save(withLogos()), false);
  assertEquals(mine.state.answers.identity.maintainer.name, "Grace Example");
  assertEquals(
    mine.state.answers.identity.logoDark,
    withLogos().identity.logoDark,
  );
  assertEquals(
    mine.edit((draft) => draft.identity.disease.name = "mine"),
    false,
  );
  const stored = JSON.parse(store.getItem(DRAFT_STORAGE_KEY)!);
  assertEquals(stored.identity.maintainer.name, "Grace Example");
  assertEquals(stored.identity.disease.name, "mine");
});

Deno.test("a refused draft write keeps this tab's answers and merges on the save that lands", () => {
  const items = memory();
  let refuse = true;
  const store: Store = {
    ...items,
    setItem: (key, value) => {
      if (refuse && key === DRAFT_STORAGE_KEY) {
        throw new DOMException("full", "QuotaExceededError");
      }
      items.setItem(key, value);
    },
  };
  const mine = tab(store);
  const theirs = structuredClone(PLAIN);
  items.setItem(DRAFT_STORAGE_KEY, serialiseDraft(theirs));
  const typed = structuredClone(EMPTY_ANSWERS);
  typed.identity.disease.name = "mine";
  assertEquals(mine.save(typed), false);
  // Nothing was written, so nothing changed hands.
  assertEquals(mine.state.answers, typed);
  assertEquals(mine.state.synced, null);
  assertEquals(items.getItem(DRAFT_STORAGE_KEY), serialiseDraft(theirs));
  refuse = false;
  assertEquals(mine.edit((draft) => draft.identity.disease.short = "MN"), true);
  const merged = structuredClone(PLAIN);
  merged.identity.disease.name = "mine";
  merged.identity.disease.short = "MN";
  assertEquals(mine.state.answers, merged);
  assertEquals(readStoredDraft(items).answers, merged);
  assertEquals(mine.state.synced, items.getItem(DRAFT_STORAGE_KEY));
});

Deno.test("a storage event that storage has moved past is not adopted", () => {
  const store = memory();
  const a = tab(store);
  const b = tab(store);
  a.save(structuredClone(PLAIN));
  assertEquals(b.hear(store.getItem(DRAFT_STORAGE_KEY)!), true);
  assertEquals(b.state.answers, PLAIN);
  // A saves again, and B types before A's event reaches it: B's save finds
  // A's write in storage and merges it.
  a.edit((draft) => draft.gold.rows[0].title = "A looked this up");
  const event = store.getItem(DRAFT_STORAGE_KEY)!;
  b.edit((draft) => draft.identity.maintainer.name += "-L");
  const merged = structuredClone(PLAIN);
  merged.gold.rows[0].title = "A looked this up";
  merged.identity.maintainer.name = "Ada Example-L";
  assertEquals(b.state.answers, merged);
  // A's event arrives now, older than what storage holds. Adopted, it took
  // B's own keystroke back off the screen.
  const synced = b.state.synced;
  assertEquals(b.hear(event), false);
  assertEquals(b.state.answers, merged);
  assertEquals(b.state.synced, synced);
  // B's own write reaches A as the stored draft, and is adopted.
  assertEquals(a.hear(store.getItem(DRAFT_STORAGE_KEY)!), true);
  assertEquals(a.state.answers, merged);
  assertEquals(a.state.synced, store.getItem(DRAFT_STORAGE_KEY));
});

Deno.test("an event this build cannot read, or storage cannot confirm, is left alone", () => {
  const store = memory();
  const mine = tab(store, structuredClone(EXAMPLEITIS));
  const foreign = JSON.stringify({ ...EMPTY_ANSWERS, version: 2 });
  store.setItem(DRAFT_STORAGE_KEY, foreign);
  assertEquals(mine.hear(foreign), false);
  const text = serialiseDraft(EMPTY_ANSWERS);
  const closed: Store = {
    ...store,
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
  assertEquals(
    adoptDraft(closed, text, mine.state.answers, mine.state.synced),
    null,
  );
  assertEquals(mine.state.answers, EXAMPLEITIS);
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
