import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";

import { EMPTY_ANSWERS } from "../lib/adapt/answers.ts";
import type { Answers } from "../lib/adapt/answers.ts";
import { exportText, parseExport } from "../lib/adapt/bundle.ts";
import { formatCode, SESSION_TTL_MS } from "../lib/adapt/session_code.ts";
import {
  openSessionStore,
  SESSION_BYTES_BUDGET,
  SESSION_CAP,
  SESSION_PER_CLIENT_CAP,
  type SessionStore,
  SWEEP_INTERVAL_MS,
} from "../server/adapt_sessions.ts";

const DAY = 24 * 60 * 60 * 1000;

function join(dir: string, name: string): string {
  return `${dir}/${name}`;
}
const T0 = 1_800_000_000_000;

function named(name: string): Answers {
  return {
    ...EMPTY_ANSWERS,
    identity: {
      ...EMPTY_ANSWERS.identity,
      disease: { ...EMPTY_ANSWERS.identity.disease, name },
    },
  };
}

const VALID = exportText(named("First condition"));
const VALID2 = exportText(named("Second condition"));

/** A clock the test moves, and a store on a fresh directory reading it. */
async function withStore(
  fn: (
    store: SessionStore,
    dir: string,
    clock: { now: number },
  ) => Promise<void>,
  options: { cap?: number; start?: number } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "adapt-sessions-" });
  const clock = { now: options.start ?? T0 };
  try {
    const store = openSessionStore(dir, {
      now: () => clock.now,
      cap: options.cap,
    });
    assert(store !== null);
    await fn(store, dir, clock);
  } finally {
    await Deno.chmod(dir, 0o700).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

async function files(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

async function onlyFile(dir: string): Promise<string> {
  const names = await files(dir);
  assertEquals(names.length, 1, names.join(", "));
  return join(dir, names[0]);
}

function created(
  result: Awaited<ReturnType<SessionStore["create"]>>,
): string {
  assert("code" in result, JSON.stringify(result));
  return result.code;
}

Deno.test("no directory, an empty one, or one under a file turns sessions off", async () => {
  assertEquals(openSessionStore(undefined), null);
  assertEquals(openSessionStore(""), null);
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "plain");
    await Deno.writeTextFile(file, "x");
    assertEquals(openSessionStore(join(file, "sessions")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the cap leaves a 1 GB volume room for typical sessions", () => {
  assertEquals(SESSION_CAP, 500);
});

Deno.test("create writes one file named by a hash, never by the code", async () => {
  await withStore(async (store, dir) => {
    const result = await store.create(VALID);
    const code = created(result);
    assertMatch(code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assertEquals(result, { code, revision: 1, savedAt: T0 });
    const path = await onlyFile(dir);
    const name = path.slice(dir.length + 1);
    assertMatch(name, /^[0-9a-f]{64}\.json$/);
    assert(!name.includes(code));
    assert(!(await Deno.readTextFile(path)).includes(code));
  });
});

Deno.test("the NCBI credentials never reach the disk", async () => {
  await withStore(async (store, dir) => {
    const answers = named("First condition");
    const text = JSON.stringify({
      ...answers,
      search: {
        ...answers.search,
        ncbi: { email: "someone@example.org", apiKey: "secret" },
      },
    });
    created(await store.create(text));
    const written = await Deno.readTextFile(await onlyFile(dir));
    assert(!written.includes("secret"));
    assert(!written.includes("someone@example.org"));
  });
});

Deno.test("parsed answers are stored as their text would be, NCBI pair blanked", async () => {
  const answers = named("First condition");
  const withCredentials: Answers = {
    ...answers,
    search: {
      ...answers.search,
      ncbi: { email: "someone@example.org", apiKey: "secret" },
    },
  };
  let fromText = "";
  await withStore(async (store, dir) => {
    created(await store.create(JSON.stringify(withCredentials)));
    fromText = await Deno.readTextFile(await onlyFile(dir));
  });
  await withStore(async (store, dir) => {
    created(await store.create(withCredentials));
    const written = await Deno.readTextFile(await onlyFile(dir));
    assert(!written.includes("secret"));
    assert(!written.includes("someone@example.org"));
    // Byte for byte what the text gives, so the byte budget counts the same.
    assertEquals(written, fromText);
    assertEquals(
      JSON.parse(written).answers,
      JSON.parse(exportText(withCredentials)),
    );
  });
});

Deno.test("create refuses a text that is not an export", async () => {
  await withStore(async (store, dir) => {
    assertEquals(await store.create("{}"), { error: "failed" });
    assertEquals(await files(dir), []);
  });
});

Deno.test("load reads back what was saved, and nothing for an unused code", async () => {
  await withStore(async (store) => {
    const code = created(await store.create(VALID));
    const loaded = await store.load(code);
    assert("text" in loaded);
    assertEquals(loaded.revision, 1);
    assertEquals(loaded.savedAt, T0);
    const parsed = parseExport(loaded.text);
    assert("answers" in parsed);
    assertEquals(parsed.answers.identity.disease.name, "First condition");

    assertEquals(await store.load("0".repeat(20)), { error: "unknown" });
  });
});

Deno.test("a save on a stale revision is a conflict unless forced", async () => {
  await withStore(async (store, dir, clock) => {
    const code = created(await store.create(VALID));
    clock.now = T0 + 1000;
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
      {
        revision: 2,
        savedAt: T0 + 1000,
        revived: false,
      },
    );
    const path = await onlyFile(dir);
    const before = await Deno.readTextFile(path);

    clock.now = T0 + 2000;
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID, false),
      {
        error: "conflict",
        savedAt: T0 + 1000,
      },
    );
    assertEquals(await Deno.readTextFile(path), before);

    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID, true),
      {
        revision: 3,
        savedAt: T0 + 2000,
        revived: false,
      },
    );
    const loaded = await store.load(code);
    assert("text" in loaded);
    const parsed = parseExport(loaded.text);
    assert("answers" in parsed);
    assertEquals(parsed.answers.identity.disease.name, "First condition");
  });
});

Deno.test("a save on the right revision but another savedAt is a conflict", async () => {
  await withStore(async (store, dir) => {
    const code = created(await store.create(VALID));
    const before = await Deno.readTextFile(await onlyFile(dir));
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 - 1 }, VALID2, false),
      { error: "conflict", savedAt: T0 },
    );
    // A page loaded before the browser sent savedAt sends none: over an
    // existing file it is asked, never let through on the revision alone.
    assertEquals(
      await store.save(code, { revision: 1 }, VALID2, false),
      { error: "conflict", savedAt: T0 },
    );
    assertEquals(await Deno.readTextFile(await onlyFile(dir)), before);
    assertEquals(await store.save(code, { revision: 1 }, VALID2, true), {
      revision: 2,
      savedAt: T0,
      revived: false,
    });
  });
});

Deno.test("after a revival, a browser holding the old copy's revision is asked", async () => {
  await withStore(async (store, _dir, clock) => {
    // B resumed at revision 1; A saved on to revision 3, at `third`.
    const code = created(await store.create(VALID));
    clock.now = T0 + 1000;
    assert(
      "revision" in
        await store.save(code, { revision: 1, savedAt: T0 }, VALID, false),
    );
    clock.now = T0 + 2000;
    assert(
      "revision" in
        await store.save(
          code,
          { revision: 2, savedAt: T0 + 1000 },
          VALID,
          false,
        ),
    );
    const third = T0 + 2000;

    // The session expires and is swept, so its revision is gone with it.
    // B saves twice and reaches revision 3, the number A holds.
    clock.now = third + SESSION_TTL_MS;
    assertEquals(await store.sweep(), 1);
    const revived = await store.save(
      code,
      { revision: 1, savedAt: T0 },
      VALID2,
      false,
    );
    assert("revived" in revived && revived.revived);
    assertEquals(revived.revision, 2);
    clock.now = third + SESSION_TTL_MS + 1;
    const b = await store.save(
      code,
      { revision: revived.revision, savedAt: revived.savedAt },
      VALID2,
      false,
    );
    assert("revision" in b);
    assertEquals(b.revision, 3);

    // A saves on its own revision 3 and its old savedAt: asked, not let through.
    clock.now = third + SESSION_TTL_MS + 3;
    assertEquals(
      await store.save(code, { revision: 3, savedAt: third }, VALID, false),
      { error: "conflict", savedAt: b.savedAt },
    );
    const loaded = await store.load(code);
    assert("text" in loaded);
    const parsed = parseExport(loaded.text);
    assert("answers" in parsed);
    assertEquals(parsed.answers.identity.disease.name, "Second condition");
  });
});

Deno.test("a revival never reissues a revision another browser may hold", async () => {
  await withStore(async (store, _dir, clock) => {
    // The first browser creates; the second resumes at revision 1.
    const code = created(await store.create(VALID));
    const second = await store.load(code);
    assert("text" in second);
    assertEquals(second.revision, 1);

    // The first saves on to revision 5.
    let first = { revision: 1, savedAt: T0 };
    for (let step = 1; step <= 4; step++) {
      clock.now = T0 + step;
      const saved = await store.save(code, first, VALID, false);
      assert("revision" in saved);
      first = { revision: saved.revision, savedAt: saved.savedAt };
    }
    assertEquals(first.revision, 5);

    // The session expires, unswept; the first saves again.
    clock.now = first.savedAt + SESSION_TTL_MS;
    const revived = await store.save(code, first, VALID2, false);
    assertEquals(revived, {
      revision: 6,
      savedAt: first.savedAt + SESSION_TTL_MS,
      revived: true,
    });

    // The second's save on its revision 1 is asked, not let through.
    assertEquals(
      await store.save(
        code,
        { revision: second.revision, savedAt: second.savedAt },
        VALID,
        false,
      ),
      { error: "conflict", savedAt: first.savedAt + SESSION_TTL_MS },
    );
  });
});

Deno.test("a revision near the safe-integer limit stays a safe integer", async () => {
  await withStore(async (store) => {
    const code = "ABCDEFGHJKMNPQRSTVWX";
    const max = Number.MAX_SAFE_INTEGER;
    const revived = await store.save(
      code,
      { revision: max, savedAt: T0 },
      VALID,
      false,
    );
    assertEquals(revived, { revision: max, savedAt: T0, revived: true });
    // The file still reads as a session, and a save on it stays at the limit.
    const loaded = await store.load(code);
    assert("text" in loaded);
    assertEquals(loaded.revision, max);
    assertEquals(
      await store.save(code, { revision: max, savedAt: T0 }, VALID2, false),
      { revision: max, savedAt: T0, revived: false },
    );
  });
});

Deno.test("a revival with no revision known on either side starts at 1", async () => {
  await withStore(async (store) => {
    for (
      const [code, revision] of [["ABCDEFGHJKMNPQRSTVWX", 0], [
        "ABCDEFGHJKMNPQRSTVW0",
        -3,
      ]] as const
    ) {
      assertEquals(
        await store.save(code, { revision, savedAt: T0 }, VALID, false),
        { revision: 1, savedAt: T0, revived: true },
      );
    }
  });
});

Deno.test("two saves on the same revision: one wins, one conflicts", async () => {
  await withStore(async (store) => {
    const code = created(await store.create(VALID));
    const results = await Promise.all([
      store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
      store.save(code, { revision: 1, savedAt: T0 }, VALID, false),
    ]);
    assertEquals(results.filter((r) => "revision" in r).length, 1);
    assertEquals(
      results.filter((r) => "error" in r && r.error === "conflict").length,
      1,
    );
  });
});

Deno.test("a session expires 14 days after its last save", async () => {
  await withStore(async (store, dir, clock) => {
    const code = created(await store.create(VALID));
    clock.now = T0 + SESSION_TTL_MS - 1;
    assert("text" in await store.load(code));
    clock.now = T0 + SESSION_TTL_MS;
    assertEquals(await store.load(code), { error: "unknown" });
    assertEquals(await store.sweep(), 1);
    assertEquals(await files(dir), []);
    assertEquals(await store.load(code), { error: "unknown" });
  });
});

Deno.test("saving to a code with no file revives it past the browser's revision", async () => {
  await withStore(async (store, dir) => {
    const code = "ABCDEFGHJKMNPQRSTVWX";
    assertEquals(
      await store.save(code, { revision: 4, savedAt: T0 }, VALID, false),
      {
        revision: 5,
        savedAt: T0,
        revived: true,
      },
    );
    await onlyFile(dir);
    assert("text" in await store.load(code));
  });
});

Deno.test("saving to an expired file the sweep has not reached revives it", async () => {
  await withStore(async (store, dir, clock) => {
    const code = created(await store.create(VALID));
    // A load just before the expiry runs the hourly sweep, so the save
    // after it finds the expired file still there.
    clock.now = T0 + SESSION_TTL_MS - 1;
    assert("text" in await store.load(code));
    clock.now = T0 + SESSION_TTL_MS;
    assertEquals((await files(dir)).length, 1);
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
      {
        revision: 2,
        savedAt: T0 + SESSION_TTL_MS,
        revived: true,
      },
    );
  });
});

Deno.test("each save restarts the clock", async () => {
  await withStore(async (store, _dir, clock) => {
    const code = created(await store.create(VALID));
    clock.now = T0 + 13 * DAY;
    assert(
      "revision" in
        await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
    );
    clock.now = T0 + 20 * DAY;
    assert("text" in await store.load(code));
    assertEquals(await store.sweep(), 0);
  });
});

Deno.test("at the cap new sessions are refused and existing ones still save", async () => {
  await withStore(async (store, dir) => {
    const first = created(await store.create(VALID));
    created(await store.create(VALID));
    assertEquals(await store.create(VALID), { error: "full" });
    assert(
      "revision" in
        await store.save(first, { revision: 1, savedAt: T0 }, VALID2, false),
    );
    assertEquals(
      await store.save(
        "ABCDEFGHJKMNPQRSTVWX",
        { revision: 1, savedAt: T0 },
        VALID,
        false,
      ),
      { error: "full" },
    );
    assertEquals((await files(dir)).length, 2);
  }, { cap: 2 });
});

Deno.test("an expired file stops counting against the cap once swept", async () => {
  await withStore(async (store, dir, clock) => {
    created(await store.create(VALID));
    clock.now = T0 + SESSION_TTL_MS;
    created(await store.create(VALID));
    assertEquals((await files(dir)).length, 1);
  }, { cap: 1 });
});

Deno.test("a damaged file, or one from another version, is unreadable", async () => {
  await withStore(async (store, dir) => {
    const code = created(await store.create(VALID));
    const path = await onlyFile(dir);
    const stored = JSON.parse(await Deno.readTextFile(path));

    await Deno.writeTextFile(path, "{");
    const damaged = await store.load(code);
    assert("error" in damaged);
    assertEquals(damaged.error, "unreadable");

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...stored,
        answers: { ...stored.answers, version: 99 },
      }),
    );
    assertEquals(await store.load(code), {
      error: "unreadable",
      message:
        "That file comes from another version of the wizard (version 99) and cannot be imported here.",
    });
  });
});

Deno.test("a save over a damaged file asks before overwriting it", async () => {
  await withStore(async (store, dir) => {
    const code = created(await store.create(VALID));
    const path = await onlyFile(dir);
    await Deno.writeTextFile(path, "{");
    const refused = await store.save(
      code,
      { revision: 1, savedAt: T0 },
      VALID2,
      false,
    );
    assert("error" in refused);
    assertEquals(refused.error, "conflict");
    // Nothing in "{" names a revision, so the browser's own is the floor.
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID2, true),
      {
        revision: 2,
        savedAt: T0,
        revived: false,
      },
    );
    assert("text" in await store.load(code));
  });
});

Deno.test("a forced save over a damaged file passes the revision it still names", async () => {
  await withStore(async (store, dir) => {
    const code = created(await store.create(VALID));
    const path = await onlyFile(dir);
    const stored = JSON.parse(await Deno.readTextFile(path));
    // The envelope is whole and names revision 7; the answers are not.
    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...stored, revision: 7, answers: "damaged" }),
    );
    assertEquals(
      await store.save(code, { revision: 2, savedAt: T0 }, VALID2, true),
      { revision: 8, savedAt: T0, revived: false },
    );
  });
});

/** Runs `fn` with console.error captured, and the lines it was given. */
async function loggedErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Neither the code nor any spelling of it a person would type. */
function assertNoCode(line: string, code: string): void {
  for (const spelling of [code, formatCode(code), code.toLowerCase()]) {
    assert(!line.includes(spelling), line);
  }
  // Nor its first or last half, which would narrow a guess.
  assert(!line.includes(code.slice(0, 10)), line);
  assert(!line.includes(code.slice(10)), line);
}

/** The file's hash as the log names it: the first 12 hex characters. */
function shortHash(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).slice(0, 12);
}

Deno.test({
  name: "a failed write is logged by operation, error and hash, never by code",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStore(async (store, dir) => {
      const code = created(await store.create(VALID));
      const path = await onlyFile(dir);
      await Deno.chmod(dir, 0o500);
      const lines = await loggedErrors(async () => {
        assertEquals(
          await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
          { error: "failed" },
        );
      });
      assertEquals(lines.length, 1, lines.join("\n"));
      const [line] = lines;
      assertMatch(line, /\bwrite\b/);
      assertMatch(line, /PermissionDenied/);
      assert(line.includes(shortHash(path)), line);
      // Neither the full hash nor anything of the code or the answers.
      assert(!line.includes(path.slice(dir.length + 1, -5)), line);
      assertNoCode(line, code);
      assert(!line.includes("condition"), line);
    });
  },
});

Deno.test({
  name: "a file that cannot be read is logged by operation, error and hash",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStore(async (store, dir) => {
      const code = created(await store.create(VALID));
      const path = await onlyFile(dir);
      await Deno.chmod(path, 0o000);
      try {
        const lines = await loggedErrors(async () => {
          assertEquals(await store.load(code), { error: "unreadable" });
        });
        assertEquals(lines.length, 1, lines.join("\n"));
        const [line] = lines;
        assertMatch(line, /\bread\b/);
        assertMatch(line, /PermissionDenied/);
        assert(line.includes(shortHash(path)), line);
        assert(!line.includes(path.slice(dir.length + 1, -5)), line);
        assertNoCode(line, code);
      } finally {
        await Deno.chmod(path, 0o600);
      }
    });
  },
});

Deno.test("the byte budget leaves a 1 GB volume room for temporary files", () => {
  assertEquals(SESSION_BYTES_BUDGET, 750_000_000);
});

/** A store over `dir` whose byte budget is exactly what `dir` holds now. */
async function atBudget(
  dir: string,
  clock: { now: number },
): Promise<SessionStore> {
  let total = 0;
  for (const name of await files(dir)) {
    total += (await Deno.stat(join(dir, name))).size;
  }
  const store = openSessionStore(dir, { now: () => clock.now, budget: total });
  assert(store !== null);
  return store;
}

Deno.test("once the byte budget is reached a new session is refused", async () => {
  await withStore(async (first, dir, clock) => {
    created(await first.create(VALID));
    const store = await atBudget(dir, clock);
    assertEquals(await store.create(VALID), { error: "full" });
    assertEquals(
      await store.save(
        "ABCDEFGHJKMNPQRSTVWX",
        { revision: 1, savedAt: T0 },
        VALID,
        false,
      ),
      { error: "full" },
    );
    assertEquals((await files(dir)).length, 1);
  });
});

Deno.test("at the byte budget a save that keeps or shrinks the size still passes", async () => {
  await withStore(async (first, dir, clock) => {
    const code = created(await first.create(VALID2));
    const store = await atBudget(dir, clock);
    // The same text at revision 2: the same number of bytes.
    assert(
      "revision" in
        await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
    );
    // "First condition" is one character shorter than "Second condition".
    assert(
      "revision" in
        await store.save(code, { revision: 2, savedAt: T0 }, VALID, false),
    );
  });
});

Deno.test("at the byte budget a save that grows the session is refused", async () => {
  await withStore(async (first, dir, clock) => {
    const code = created(await first.create(VALID));
    const path = await onlyFile(dir);
    const before = await Deno.readTextFile(path);
    const store = await atBudget(dir, clock);
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
      { error: "full" },
    );
    assertEquals(await Deno.readTextFile(path), before);
  });
});

Deno.test({
  name: "a directory that stops taking writes fails the write, not the server",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStore(async (store, dir) => {
      const code = created(await store.create(VALID));
      await Deno.chmod(dir, 0o500);
      const lines = await loggedErrors(async () => {
        assertEquals(await store.create(VALID), { error: "failed" });
        assertEquals(
          await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
          { error: "failed" },
        );
        assertEquals(
          await store.save(
            "ABCDEFGHJKMNPQRSTVWX",
            { revision: 1, savedAt: T0 },
            VALID,
            false,
          ),
          { error: "failed" },
        );
      });
      // One line for each refused write.
      assertEquals(lines.length, 3, lines.join("\n"));
      assertEquals((await files(dir)).length, 1);
    });
  },
});

Deno.test("a sweep runs on its own once the interval has passed", async () => {
  const start = T0 - SESSION_TTL_MS;
  await withStore(async (store, dir, clock) => {
    const old = created(await store.create(VALID));
    const oldPath = await onlyFile(dir);
    clock.now = T0 + SWEEP_INTERVAL_MS + 1;
    const fresh = created(await store.create(VALID2));
    assertNotEquals(old, fresh);
    const names = await files(dir);
    assertEquals(names.length, 1);
    assertNotEquals(join(dir, names[0]), oldPath);
  }, { start });
});

Deno.test("a sweep at open removes expired sessions and stale temporary files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "adapt-sessions-" });
  try {
    let now = T0;
    const first = openSessionStore(dir, { now: () => now });
    assert(first !== null);
    created(await first.create(VALID));
    const stale = join(dir, `${"a".repeat(64)}.json.tmp-1`);
    const pending = join(dir, `${"b".repeat(64)}.json.tmp-2`);
    await Deno.writeTextFile(stale, "x");
    await Deno.writeTextFile(pending, "x");
    await Deno.utime(stale, new Date(T0), new Date(T0));
    now = T0 + SESSION_TTL_MS;
    await Deno.utime(pending, new Date(now), new Date(now));
    await Deno.writeTextFile(join(dir, "README"), "kept");

    openSessionStore(dir, { now: () => now });
    assertEquals(await files(dir), ["README", pending.slice(dir.length + 1)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const OWNER = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const UNUSED = "ABCDEFGHJKMNPQRSTVWX";

/** The markers in `dir`, each as its session's hash and its owner tag. */
async function markers(dir: string): Promise<[string, string][]> {
  return (await files(dir))
    .filter((name) => name.endsWith(".own"))
    .map((name) => {
      const [hash, tag] = name.split(".");
      return [hash, tag];
    });
}

/** `count` sessions created by `owner`, their codes in order. */
async function createMany(
  store: SessionStore,
  owner: string,
  count: number,
): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(created(await store.create(VALID, owner)));
  }
  return codes;
}

Deno.test("one connection holds at most fifty sessions", () => {
  assertEquals(SESSION_PER_CLIENT_CAP, 50);
});

Deno.test("a create writes an empty marker named by the session and its owner", async () => {
  await withStore(async (store, dir) => {
    created(await store.create(VALID, OWNER));
    const names = await files(dir);
    assertEquals(names.length, 2, names.join(", "));
    const session = names.find((name) => name.endsWith(".json"))!;
    const marker = names.find((name) => name.endsWith(".own"))!;
    assertEquals(marker, `${session.slice(0, 64)}.${OWNER}.own`);
    assertEquals(await Deno.readTextFile(join(dir, marker)), "");
    // With no owner there is nothing to mark.
    created(await store.create(VALID));
    assertEquals((await markers(dir)).length, 1);
  });
});

Deno.test("the 51st create from one connection is refused, another's passes", async () => {
  await withStore(async (store, dir) => {
    await createMany(store, OWNER, SESSION_PER_CLIENT_CAP);
    assertEquals(await store.create(VALID, OWNER), { error: "quota" });
    assertEquals(
      (await files(dir)).filter((name) => name.endsWith(".json")).length,
      SESSION_PER_CLIENT_CAP,
    );
    created(await store.create(VALID, OTHER));
    // A caller with no connection is not held to the rule.
    created(await store.create(VALID));
  });
});

Deno.test("at its cap a connection still saves an existing session, and is refused a revival", async () => {
  await withStore(async (store, dir) => {
    const [first] = await createMany(store, OWNER, SESSION_PER_CLIENT_CAP);
    const saved = await store.save(
      first,
      { revision: 1, savedAt: T0 },
      VALID2,
      false,
      OWNER,
    );
    assert("revision" in saved && !saved.revived, JSON.stringify(saved));
    const before = await files(dir);
    assertEquals(
      await store.save(
        UNUSED,
        { revision: 1, savedAt: T0 },
        VALID,
        false,
        OWNER,
      ),
      { error: "quota" },
    );
    assertEquals(await files(dir), before);
  });
});

Deno.test("a revival replaces the session's marker with the reviver's", async () => {
  await withStore(async (store, dir, clock) => {
    const code = created(await store.create(VALID, OWNER));
    // Expired, unswept: the save after the load finds the file still there.
    clock.now = T0 + SESSION_TTL_MS - 1;
    assert("text" in await store.load(code));
    clock.now = T0 + SESSION_TTL_MS;
    const revived = await store.save(
      code,
      { revision: 1, savedAt: T0 },
      VALID2,
      false,
      OTHER,
    );
    assert("revived" in revived && revived.revived);
    assertEquals((await markers(dir)).map(([, tag]) => tag), [OTHER]);
    // A revival with no owner leaves the session marked for nobody.
    const absent = await store.save(
      UNUSED,
      { revision: 1, savedAt: T0 },
      VALID,
      false,
    );
    assert("revived" in absent && absent.revived);
    assertEquals((await markers(dir)).length, 1);
  });
});

Deno.test("an expired session's marker goes with it, and frees the slot", async () => {
  await withStore(async (store, dir, clock) => {
    await createMany(store, OWNER, SESSION_PER_CLIENT_CAP);
    clock.now = T0 + SESSION_TTL_MS;
    // The create runs the overdue sweep first, which removes all fifty.
    created(await store.create(VALID, OWNER));
    assertEquals((await files(dir)).length, 2);
    assertEquals((await markers(dir)).length, 1);
  });
});

Deno.test("a marker whose session is gone is swept, at open and on the hour", async () => {
  await withStore(async (store, dir) => {
    const orphan = `${"c".repeat(64)}.${OWNER}.own`;
    await Deno.writeTextFile(join(dir, orphan), "");
    created(await store.create(VALID, OWNER));
    assertEquals((await markers(dir)).length, 2);
    await store.sweep();
    assertEquals((await markers(dir)).length, 1);
    assert(!(await files(dir)).includes(orphan));

    await Deno.writeTextFile(join(dir, orphan), "");
    openSessionStore(dir, { now: () => T0 });
    assertEquals((await markers(dir)).length, 1);
    assert(!(await files(dir)).includes(orphan));
  });
});

Deno.test("a session with no marker counts toward nobody's cap", async () => {
  await withStore(async (store, dir) => {
    await createMany(store, OWNER, SESSION_PER_CLIENT_CAP);
    const [hash] = (await markers(dir))[0];
    await Deno.remove(join(dir, `${hash}.${OWNER}.own`));
    created(await store.create(VALID, OWNER));
    assertEquals(await store.create(VALID, OWNER), { error: "quota" });
    // The session the marker left is kept, and a sweep leaves it alone.
    assert((await files(dir)).includes(`${hash}.json`));
    await store.sweep();
    assert((await files(dir)).includes(`${hash}.json`));
  });
});

Deno.test("markers do not count toward the file cap", async () => {
  await withStore(async (store, dir) => {
    // With its marker counted, the second create would already be refused.
    created(await store.create(VALID, OWNER));
    created(await store.create(VALID, OWNER));
    assertEquals(await store.create(VALID, OWNER), { error: "full" });
    assertEquals((await files(dir)).length, 4);
  }, { cap: 2 });
});
