import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";

import { EMPTY_ANSWERS } from "../lib/adapt/answers.ts";
import type { Answers } from "../lib/adapt/answers.ts";
import { exportText, parseExport } from "../lib/adapt/bundle.ts";
import { SESSION_TTL_MS } from "../lib/adapt/session_code.ts";
import {
  openSessionStore,
  SESSION_CAP,
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
    // A and B both hold revision 3, saved at `third`.
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

    // The session expires; B saves three times and is back at revision 3.
    clock.now = third + SESSION_TTL_MS;
    let b = await store.save(
      code,
      { revision: 3, savedAt: third },
      VALID2,
      false,
    );
    assert("revived" in b && b.revived && b.revision === 1);
    for (const step of [1, 2]) {
      clock.now = third + SESSION_TTL_MS + step;
      b = await store.save(
        code,
        { revision: b.revision, savedAt: b.savedAt },
        VALID2,
        false,
      );
      assert("revision" in b);
    }
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

Deno.test("saving to a code with no file revives it at revision 1", async () => {
  await withStore(async (store, dir) => {
    const code = "ABCDEFGHJKMNPQRSTVWX";
    assertEquals(
      await store.save(code, { revision: 4, savedAt: T0 }, VALID, false),
      {
        revision: 1,
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
        revision: 1,
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
    assertEquals(
      await store.save(code, { revision: 1, savedAt: T0 }, VALID2, true),
      {
        revision: 1,
        savedAt: T0,
        revived: false,
      },
    );
    assert("text" in await store.load(code));
  });
});

Deno.test({
  name: "a directory that stops taking writes fails the write, not the server",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStore(async (store, dir) => {
      const code = created(await store.create(VALID));
      await Deno.chmod(dir, 0o500);
      assertEquals(await store.create(VALID), { error: "failed" });
      assertEquals(
        await store.save(code, { revision: 1, savedAt: T0 }, VALID2, false),
        {
          error: "failed",
        },
      );
      assertEquals(
        await store.save(
          "ABCDEFGHJKMNPQRSTVWX",
          { revision: 1, savedAt: T0 },
          VALID,
          false,
        ),
        {
          error: "failed",
        },
      );
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
