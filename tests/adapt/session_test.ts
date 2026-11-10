import { assert, assertEquals } from "@std/assert";

import { type Answers, EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { exportText } from "../../lib/adapt/bundle.ts";
import type { Store } from "../../lib/adapt/draft_storage.ts";
import {
  formatClock,
  formatDay,
  keptUntil,
  overview,
  readLink,
  SESSION_COPY,
  SESSION_KEY,
  sessionClient,
  type SessionLink,
  writeLink,
} from "../../lib/adapt/session.ts";
import { formatCode } from "../../lib/adapt/session_code.ts";
import {
  issuesFor,
  STEP_LABELS,
  STEP_ORDER,
  validate,
} from "../../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

const CODE = "ABCDEFGHJKMNPQRSTVWX";

function memory() {
  const items = new Map<string, string>();
  const store: Store & { items: Map<string, string> } = {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
  return store;
}

const link: SessionLink = {
  code: CODE,
  revision: 3,
  savedAt: 1000,
  dirty: true,
};

Deno.test("readLink reads back what writeLink wrote and nothing else", () => {
  const store = memory();
  assertEquals(readLink(store), null);
  writeLink(store, link);
  assertEquals(readLink(store), link);
  for (
    const bad of [
      "{",
      "null",
      JSON.stringify({ ...link, code: "short" }),
      JSON.stringify({ ...link, revision: "3" }),
      JSON.stringify({ ...link, savedAt: "x" }),
      JSON.stringify({ ...link, dirty: "yes" }),
    ]
  ) {
    store.items.set(SESSION_KEY, bad);
    assertEquals(readLink(store), null, bad);
  }
  writeLink(store, link);
  writeLink(store, null);
  assertEquals(store.items.has(SESSION_KEY), false);
});

Deno.test("a store that throws neither breaks a read nor a write", () => {
  const broken: Store = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
  assertEquals(readLink(broken), null);
  writeLink(broken, link);
  writeLink(broken, null);
});

interface Call {
  url: string;
  init: RequestInit;
}

function stub(respond: () => Response | object | Error) {
  const calls: Call[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = respond();
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }) as unknown as typeof globalThis.fetch;
  return { calls, client: sessionClient(fetch) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

const withKey = (): Answers => {
  const a = structuredClone(EXAMPLEITIS);
  a.search.ncbi.apiKey = "k";
  return a;
};

Deno.test("create posts the export, not the credentials", async () => {
  const answers = withKey();
  const { calls, client } = stub(() =>
    json(201, { code: CODE, revision: 1, savedAt: 5 })
  );
  const result = await client.create(answers);
  assertEquals(result, {
    ok: true,
    link: { code: CODE, revision: 1, savedAt: 5, dirty: false },
  });
  const [{ url, init }] = calls;
  assertEquals(url, "/adapt/session/create");
  assertEquals(init.method, "POST");
  assertEquals(init.redirect, "manual");
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
  const body = JSON.parse(init.body as string);
  assertEquals(body.answers, exportText(answers));
  assert(!(init.body as string).includes('"k"'));
});

Deno.test("create reports a 201 it cannot read as a failure", async () => {
  const { client } = stub(() => json(201, { code: "no" }));
  const result = await client.create(EXAMPLEITIS);
  assert(!result.ok && result.reason === "failed");
});

Deno.test("save sends the code, revision and force, and passes revived on", async () => {
  const { calls, client } = stub(() =>
    json(200, { revision: 4, savedAt: 9, revived: true })
  );
  const result = await client.save(link, EXAMPLEITIS, true);
  assertEquals(result, {
    ok: true,
    link: { code: CODE, revision: 4, savedAt: 9, dirty: false },
    revived: true,
  });
  assertEquals(calls[0].url, "/adapt/session/save");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.code, CODE);
  assertEquals(body.revision, 3);
  assertEquals(body.force, true);
  assertEquals(body.answers, exportText(EXAMPLEITIS));
});

Deno.test("save answers a 200 without numbers as a failure", async () => {
  const { client } = stub(() => json(200, { revision: 4 }));
  const result = await client.save(link, EXAMPLEITIS, false);
  assert(!result.ok && result.reason === "failed");
});

Deno.test("a conflict carries when the other copy was saved", async () => {
  const at = Date.UTC(2026, 10, 24, 16, 42);
  const { client } = stub(() => json(409, { error: "conflict", savedAt: at }));
  const result = await client.save(link, EXAMPLEITIS, false);
  assert(!result.ok);
  assertEquals(result.reason, "conflict");
  assertEquals(result.savedAt, at);
  assertEquals(
    result.message,
    SESSION_COPY.conflict(formatDay(at), formatClock(at)),
  );
});

Deno.test("a 409 without a time is a failure", async () => {
  const { client } = stub(() => json(409, { error: "conflict" }));
  const result = await client.save(link, EXAMPLEITIS, false);
  assert(!result.ok && result.reason === "failed");
});

Deno.test("resume reads the answers back and keeps this browser's credentials", async () => {
  const saved = structuredClone(EXAMPLEITIS);
  const { calls, client } = stub(() =>
    json(200, { answers: exportText(saved), revision: 2, savedAt: 7 })
  );
  const result = await client.resume(formatCode(CODE).toLowerCase(), withKey());
  assert(result.ok);
  assertEquals(result.answers.search.ncbi.apiKey, "k");
  assertEquals(result.dropped, []);
  assertEquals(result.link, {
    code: CODE,
    revision: 2,
    savedAt: 7,
    dirty: false,
  });
  assertEquals(calls[0].url, "/adapt/session/resume");
  assertEquals(JSON.parse(calls[0].init.body as string), { code: CODE });
});

Deno.test("resume of a text that is no code never calls fetch", async () => {
  const { calls, client } = stub(() => json(200, {}));
  const result = await client.resume("not a code", EMPTY_ANSWERS);
  assert(!result.ok);
  assertEquals(result.reason, "unknown");
  assertEquals(result.message, SESSION_COPY.unknown);
  assertEquals(calls.length, 0);
});

Deno.test("resume of an answers text this version cannot read is unreadable", async () => {
  const { client } = stub(() =>
    json(200, { answers: "{}", revision: 2, savedAt: 7 })
  );
  const result = await client.resume(CODE, EMPTY_ANSWERS);
  assert(!result.ok);
  assertEquals(result.reason, "unreadable");
  assert(result.message.length > 0);
});

Deno.test("resume of a 200 without its fields is a failure", async () => {
  const { client } = stub(() => json(200, { answers: 5 }));
  const result = await client.resume(CODE, EMPTY_ANSWERS);
  assert(!result.ok && result.reason === "failed");
});

Deno.test("failures map to a reason and a message", async () => {
  type Case = [() => Response | object | Error, string, string];
  const cases: Case[] = [
    [
      () => ({ type: "opaqueredirect", status: 0 }),
      "signed-out",
      SESSION_COPY.signedOut,
    ],
    [() => json(429, {}), "limited", SESSION_COPY.limited],
    [() => json(503, { error: "full" }), "full", SESSION_COPY.full],
    [() => json(503, { error: "failed" }), "failed", SESSION_COPY.failed],
    [
      () => json(413, { error: "too-large" }),
      "too-large",
      SESSION_COPY.tooLarge,
    ],
    [() => json(404, { error: "off" }), "off", SESSION_COPY.off],
    [() => json(404, { error: "unknown" }), "unknown", SESSION_COPY.unknown],
    [() => json(404, { error: "other" }), "failed", SESSION_COPY.failed],
    [
      () => json(400, { error: "invalid", message: "Bad." }),
      "invalid",
      "Bad.",
    ],
    [() => json(400, { error: "invalid" }), "invalid", SESSION_COPY.invalid],
    [
      () => json(422, { error: "unreadable", message: "Odd." }),
      "unreadable",
      "Odd.",
    ],
    [
      () => json(422, { error: "unreadable" }),
      "unreadable",
      SESSION_COPY.unreadable,
    ],
    [() => new Error("offline"), "failed", SESSION_COPY.failed],
    [
      () => new Response("<html></html>", { status: 200 }),
      "failed",
      SESSION_COPY.failed,
    ],
    [() => json(500, {}), "failed", SESSION_COPY.failed],
  ];
  for (const [respond, reason, message] of cases) {
    const { client } = stub(respond);
    const result = await client.save(link, EXAMPLEITIS, false);
    assert(!result.ok);
    assertEquals([result.reason, result.message], [reason, message]);
  }
});

Deno.test("overview of the empty answers lists every step that asks something", () => {
  const o = overview(EMPTY_ANSWERS);
  const issues = validate(EMPTY_ANSWERS);
  assertEquals(o.completed, []);
  assertEquals(
    o.remaining.map((r) => r.step),
    STEP_ORDER.filter((s) => issuesFor(issues, s).length > 0),
  );
  for (const r of o.remaining) {
    assertEquals(r.started, false);
    assertEquals(r.label, STEP_LABELS[r.step]);
    assertEquals(r.count, r.items.length);
  }
  assertEquals(o.first, "identity");
});

Deno.test("overview of complete answers has nothing remaining", () => {
  const o = overview(EXAMPLEITIS);
  assertEquals(o.remaining, []);
  assertEquals(o.completed.length, STEP_ORDER.length);
  assertEquals(o.first, null);
});

Deno.test("overview names the one thing a started step still lacks", () => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.gold.rows[0].pmid = "";
  const o = overview(answers);
  assertEquals(o.remaining.map((r) => r.step), ["gold"]);
  const [gold] = o.remaining;
  assertEquals(gold.count, 1);
  assertEquals(gold.started, true);
  assertEquals(
    gold.items[0].message,
    issuesFor(validate(answers), "gold")[0].message,
  );
  assert(!o.completed.some((c) => c.step === "gold"));
  assertEquals(o.first, "gold");
});

Deno.test("dates read in the given time zone", () => {
  assertEquals(formatDay(Date.UTC(2026, 10, 24), "UTC"), "24 Nov 2026");
  assertEquals(formatClock(Date.UTC(2026, 10, 24, 16, 42), "UTC"), "16:42");
  assertEquals(
    keptUntil(Date.UTC(2026, 10, 10), "UTC"),
    "kept until 24 Nov 2026",
  );
  // Without a zone the viewer's own is used.
  assert(formatDay(Date.UTC(2026, 10, 24, 12)).length > 0);
  assert(/^\d\d:\d\d$/.test(formatClock(Date.UTC(2026, 10, 24, 12))));
});

Deno.test("the copy functions fill their dates in", () => {
  assertEquals(
    SESSION_COPY.revived("24 Nov 2026"),
    "The saved copy had expired; it has been saved again, and is kept until 24 Nov 2026.",
  );
  assertEquals(
    SESSION_COPY.conflict("24 Nov 2026", "16:42"),
    "This session was saved from somewhere else on 24 Nov 2026 at 16:42. Overwrite that copy with the answers here?",
  );
});

Deno.test("every call hands a failure on, and a body that is no object is one", async () => {
  const { client } = stub(() => json(429, {}));
  const created = await client.create(EXAMPLEITIS);
  assert(!created.ok && created.reason === "limited");
  const resumed = await client.resume(CODE, EMPTY_ANSWERS);
  assert(!resumed.ok && resumed.reason === "limited");
  const bare = stub(() => json(200, null));
  const saved = await bare.client.save(link, EXAMPLEITIS, false);
  assert(!saved.ok && saved.reason === "failed");
});
