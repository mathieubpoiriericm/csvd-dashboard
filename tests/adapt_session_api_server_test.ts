import { assert, assertEquals, assertMatch } from "@std/assert";

import { EMPTY_ANSWERS } from "../lib/adapt/answers.ts";
import { exportText, parseExport } from "../lib/adapt/bundle.ts";
import { formatCode, SESSION_TTL_MS } from "../lib/adapt/session_code.ts";
import {
  CREATED_HEADER,
  handleCreate,
  handleResume,
  handleSave,
  ownerTag,
  SESSION_BODY_LIMIT,
} from "../server/adapt_session_api.ts";
import {
  openSessionStore,
  SESSION_PER_CLIENT_CAP,
  type SessionStore,
} from "../server/adapt_sessions.ts";

const T0 = 1_800_000_000_000;

const VALID = exportText({
  ...EMPTY_ANSWERS,
  identity: {
    ...EMPTY_ANSWERS.identity,
    disease: { ...EMPTY_ANSWERS.identity.disease, name: "First condition" },
  },
});

type Handler = (req: Request, store: SessionStore | null) => Promise<Response>;

function request(
  path: string,
  body: BodyInit,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/adapt/session/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function post(
  handler: Handler,
  store: SessionStore | null,
  path: string,
  body: unknown,
): Promise<Response> {
  return handler(request(path, JSON.stringify(body)), store);
}

async function withStore(
  fn: (
    store: SessionStore,
    dir: string,
    clock: { now: number },
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "adapt-session-api-" });
  const clock = { now: T0 };
  try {
    const store = openSessionStore(dir, { now: () => clock.now });
    assert(store !== null);
    await fn(store, dir, clock);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function files(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(response.headers.get("cache-control"), "no-store");
  return await response.json();
}

async function createdCode(store: SessionStore): Promise<string> {
  const response = await post(handleCreate, store, "create", {
    answers: VALID,
  });
  assertEquals(response.status, 201);
  return (await json(response)).code as string;
}

Deno.test("every handler answers off when sessions are off", async () => {
  for (
    const [handler, path, body] of [
      [handleCreate, "create", { answers: VALID }],
      [handleSave, "save", {
        code: "0".repeat(20),
        revision: 1,
        answers: VALID,
      }],
      [handleResume, "resume", { code: "0".repeat(20) }],
    ] as const
  ) {
    const response = await post(handler, null, path, body);
    assertEquals(response.status, 404, path);
    assertEquals(await json(response), { error: "off" });
  }
});

Deno.test("create answers 201 with a code, the revision and the time", async () => {
  await withStore(async (store) => {
    const response = await post(handleCreate, store, "create", {
      answers: VALID,
    });
    assertEquals(response.status, 201);
    assertEquals(response.headers.get(CREATED_HEADER), "created");
    const body = await json(response);
    assertMatch(body.code as string, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assertEquals(body.revision, 1);
    assertEquals(body.savedAt, T0);
  });
});

Deno.test("create refuses answers that are not an export", async () => {
  await withStore(async (store, dir) => {
    const response = await post(handleCreate, store, "create", {
      answers: "{}",
    });
    assertEquals(response.status, 400);
    assertEquals(await json(response), {
      error: "invalid",
      message: "That file is not an answers export from this wizard.",
    });
    assertEquals(await files(dir), []);
  });
});

Deno.test("a create or a save parses its export exactly once", async () => {
  const dir = await Deno.makeTempDir({ prefix: "adapt-session-api-" });
  let calls = 0;
  const parse = (text: string) => {
    calls++;
    return parseExport(text);
  };
  try {
    // The same counting parser in the handler and the store: one call
    // between them, so the store took the parsed answers as they were.
    const store = openSessionStore(dir, { now: () => T0, parse });
    assert(store !== null);
    const response = await handleCreate(
      request("create", JSON.stringify({ answers: VALID })),
      store,
      undefined,
      { parse },
    );
    assertEquals(response.status, 201);
    assertEquals(calls, 1);
    const { code } = await json(response);
    const saved = await handleSave(
      request(
        "save",
        JSON.stringify({ code, revision: 1, savedAt: T0, answers: VALID }),
      ),
      store,
      undefined,
      { parse },
    );
    assertEquals(saved.status, 200);
    await saved.body?.cancel();
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("create refuses a body that is not JSON or carries no answers", async () => {
  await withStore(async (store, dir) => {
    for (
      const body of ["not json", "[]", JSON.stringify({}), '{"answers":4}']
    ) {
      const response = await handleCreate(request("create", body), store);
      assertEquals(response.status, 400, body);
      assertEquals((await json(response)).error, "invalid");
    }
    assertEquals(await files(dir), []);
  });
});

/** A create body of exactly `bytes` bytes, the answers padded with spaces. */
function createBody(bytes: number): string {
  const bare = JSON.stringify({ answers: VALID });
  return JSON.stringify({ answers: VALID + " ".repeat(bytes - bare.length) });
}

Deno.test("the session body limit takes two logos at their cap", () => {
  // Two 1 MB logos make an export of about 2.7 MB.
  assertEquals(SESSION_BODY_LIMIT, 4_000_000);
});

Deno.test("a body at the limit is taken and one byte over it is refused", async () => {
  await withStore(async (store, dir) => {
    const atLimit = createBody(SESSION_BODY_LIMIT);
    assertEquals(new TextEncoder().encode(atLimit).byteLength, 4_000_000);
    const taken = await handleCreate(request("create", atLimit), store);
    assertEquals(taken.status, 201);
    await taken.body?.cancel();
    assertEquals((await files(dir)).length, 1);

    const over = createBody(SESSION_BODY_LIMIT + 1);
    assertEquals(new TextEncoder().encode(over).byteLength, 4_000_001);
    const refused = await handleCreate(request("create", over), store);
    assertEquals(refused.status, 413);
    assertEquals(await json(refused), { error: "too-large" });
    assertEquals((await files(dir)).length, 1);
  });
});

Deno.test("create refuses a declared or streamed body above the limit", async () => {
  await withStore(async (store, dir) => {
    const declared = await handleCreate(
      request("create", JSON.stringify({ answers: VALID }), {
        "Content-Length": String(SESSION_BODY_LIMIT + 1),
      }),
      store,
    );
    assertEquals(declared.status, 413);
    assertEquals(await json(declared), { error: "too-large" });

    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1 << 20).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = await handleCreate(request("create", stream), store);
    assertEquals(streamed.status, 413);
    assertEquals(await json(streamed), { error: "too-large" });
    assert(cancelled);
    assert(pulled < SESSION_BODY_LIMIT + 2 * chunk.length);
    assertEquals(await files(dir), []);
  });
});

Deno.test("save answers conflicts, forced overwrites and revivals", async () => {
  await withStore(async (store) => {
    const code = await createdCode(store);

    const malformed = await post(handleSave, store, "save", {
      code: "abc",
      revision: 1,
      answers: VALID,
    });
    assertEquals(malformed.status, 400);
    assertEquals((await json(malformed)).error, "invalid");
    for (
      const body of [
        { code, revision: "1", answers: VALID },
        { code, revision: 1, answers: VALID, force: "yes" },
        { code, revision: 1, savedAt: "yesterday", answers: VALID },
        { code, revision: 1, savedAt: 1.5, answers: VALID },
        { code, revision: 1 },
      ]
    ) {
      const response = await post(handleSave, store, "save", body);
      assertEquals(response.status, 400, JSON.stringify(body));
      await response.body?.cancel();
    }

    // A page loaded before the browser sent savedAt: asked, not let through.
    const unstamped = await post(handleSave, store, "save", {
      code,
      revision: 1,
      answers: VALID,
    });
    assertEquals(unstamped.status, 409);
    assertEquals(await json(unstamped), { error: "conflict", savedAt: T0 });

    const saved = await post(handleSave, store, "save", {
      code,
      revision: 1,
      savedAt: T0,
      answers: VALID,
    });
    assertEquals(saved.status, 200);
    assertEquals(saved.headers.get(CREATED_HEADER), null);
    assertEquals(await json(saved), {
      revision: 2,
      savedAt: T0,
      revived: false,
    });

    const conflict = await post(handleSave, store, "save", {
      code,
      revision: 1,
      savedAt: T0,
      answers: VALID,
    });
    assertEquals(conflict.status, 409);
    assertEquals(await json(conflict), { error: "conflict", savedAt: T0 });

    const forced = await post(handleSave, store, "save", {
      code,
      revision: 1,
      savedAt: T0,
      answers: VALID,
      force: true,
    });
    assertEquals(forced.status, 200);
    assertEquals((await json(forced)).revision, 3);

    // A revival needs no savedAt: there is no copy to compare it with.
    const revived = await post(handleSave, store, "save", {
      code: "ABCDEFGHJKMNPQRSTVWX",
      revision: 7,
      answers: VALID,
    });
    assertEquals(revived.status, 200);
    assertEquals(revived.headers.get(CREATED_HEADER), "created");
    // Past the browser's revision, so no copy it holds can match again.
    assertEquals(await json(revived), {
      revision: 8,
      savedAt: T0,
      revived: true,
    });
  });
});

Deno.test("save refuses answers that are not an export", async () => {
  await withStore(async (store) => {
    const code = await createdCode(store);
    const response = await post(handleSave, store, "save", {
      code,
      revision: 1,
      answers: "{}",
    });
    assertEquals(response.status, 400);
    assertEquals(
      (await json(response)).message,
      "That file is not an answers export from this wizard.",
    );
  });
});

Deno.test("resume reads a code however it is typed", async () => {
  await withStore(async (store) => {
    const code = await createdCode(store);
    const response = await post(handleResume, store, "resume", {
      code: formatCode(code).toLowerCase(),
    });
    assertEquals(response.status, 200);
    const body = await json(response);
    assertEquals(body.revision, 1);
    assertEquals(body.savedAt, T0);
    assertEquals(body.answers, VALID);
  });
});

Deno.test("an unused code and an expired one answer the same 404", async () => {
  await withStore(async (store, _dir, clock) => {
    const code = await createdCode(store);
    const unused = await post(handleResume, store, "resume", {
      code: "ABCDEFGHJKMNPQRSTVWX",
    });
    assertEquals(unused.status, 404);
    const unusedText = await unused.text();
    assertEquals(unusedText, JSON.stringify({ error: "unknown" }));

    clock.now = T0 + SESSION_TTL_MS;
    const expired = await post(handleResume, store, "resume", { code });
    assertEquals(expired.status, 404);
    assertEquals(await expired.text(), unusedText);
  });
});

Deno.test("resume refuses a request without a code", async () => {
  await withStore(async (store) => {
    for (const body of [{}, { code: "abc" }, { code: 4 }]) {
      const response = await post(handleResume, store, "resume", body);
      assertEquals(response.status, 400, JSON.stringify(body));
      assertEquals((await json(response)).error, "invalid");
    }
  });
});

Deno.test("an unreadable session answers 422 with the reason", async () => {
  await withStore(async (store, dir) => {
    const code = await createdCode(store);
    const [name] = await files(dir);
    const path = `${dir}/${name}`;
    const stored = JSON.parse(await Deno.readTextFile(path));
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...stored,
        answers: { ...stored.answers, version: 99 },
      }),
    );
    const response = await post(handleResume, store, "resume", { code });
    assertEquals(response.status, 422);
    assertEquals(await json(response), {
      error: "unreadable",
      message:
        "That file comes from another version of the wizard (version 99) and cannot be imported here.",
    });
  });
});

Deno.test({
  name: "a store that cannot write answers 503",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStore(async (store, dir) => {
      await Deno.chmod(dir, 0o500);
      // The store logs the refused write (tests/adapt_sessions_server_test.ts
      // checks the line); kept out of the test output here.
      const logged: unknown[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args);
      try {
        const response = await post(handleCreate, store, "create", {
          answers: VALID,
        });
        assertEquals(response.status, 503);
        assertEquals(await json(response), { error: "failed" });
        assertEquals(logged.length, 1);
      } finally {
        console.error = original;
        await Deno.chmod(dir, 0o700);
      }
    });
  },
});

Deno.test("a full store answers 503 full", async () => {
  const dir = await Deno.makeTempDir({ prefix: "adapt-session-api-" });
  try {
    const store = openSessionStore(dir, { cap: 1 });
    assert(store !== null);
    await createdCode(store);
    const response = await post(handleCreate, store, "create", {
      answers: VALID,
    });
    assertEquals(response.status, 503);
    assertEquals(await json(response), { error: "full" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const SECRET = "a-session-secret-for-tests";
const CLIENT = "header:198.51.100.7";

Deno.test("an owner tag is 16 hex characters, stable, and keyed by the secret", async () => {
  const tag = await ownerTag(CLIENT, SECRET);
  assertMatch(tag, /^[0-9a-f]{16}$/);
  assertEquals(await ownerTag(CLIENT, SECRET), tag);
  assert((await ownerTag("header:203.0.113.8", SECRET)) !== tag);
  assert((await ownerTag(CLIENT, "another-secret")) !== tag);
});

Deno.test("an owner tag is the HMAC of 'adapt-owner:' and the client key, so it never meets a cookie's signature", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`adapt-owner:${CLIENT}`),
    ),
  );
  const expected = Array.from(
    mac.subarray(0, 8),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  assertEquals(await ownerTag(CLIENT, SECRET), expected);
});

Deno.test("a connection at its cap is answered 429 quota, and never named by address", async () => {
  await withStore(async (store, dir) => {
    const lines: string[] = [];
    const originals = {
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    };
    for (const level of ["error", "info", "log", "warn"] as const) {
      console[level] = (...args: unknown[]) => void lines.push(args.join(" "));
    }
    const options = { clientKey: CLIENT, secret: SECRET };
    const create = (opts: typeof options) =>
      handleCreate(
        request("create", JSON.stringify({ answers: VALID })),
        store,
        undefined,
        opts,
      );
    try {
      for (let i = 0; i < SESSION_PER_CLIENT_CAP; i++) {
        const response = await create(options);
        assertEquals(response.status, 201);
        await response.body?.cancel();
      }
      const refused = await create(options);
      assertEquals(refused.status, 429);
      assertEquals(refused.headers.get(CREATED_HEADER), null);
      assertEquals(refused.headers.get("retry-after"), null);
      assertEquals(await json(refused), { error: "quota" });

      // A revival is refused the same way.
      const revival = await handleSave(
        request(
          "save",
          JSON.stringify({
            code: "ABCDEFGHJKMNPQRSTVWX",
            revision: 1,
            answers: VALID,
          }),
        ),
        store,
        undefined,
        options,
      );
      assertEquals(revival.status, 429);
      assertEquals(await json(revival), { error: "quota" });

      // Another connection still creates.
      const other = await create({
        clientKey: "header:203.0.113.8",
        secret: SECRET,
      });
      assertEquals(other.status, 201);
      await other.body?.cancel();
    } finally {
      Object.assign(console, originals);
    }
    const tag = await ownerTag(CLIENT, SECRET);
    const names = await files(dir);
    assertEquals(
      names.filter((name) => name.endsWith(`.${tag}.own`)).length,
      SESSION_PER_CLIENT_CAP,
    );
    for (const text of [...names, ...lines]) {
      assert(!text.includes("198.51.100.7"), text);
    }
  });
});

Deno.test("without a session secret no owner is applied", async () => {
  await withStore(async (store, dir) => {
    const response = await handleCreate(
      request("create", JSON.stringify({ answers: VALID })),
      store,
      undefined,
      { clientKey: CLIENT, secret: "" },
    );
    assertEquals(response.status, 201);
    await response.body?.cancel();
    assertEquals((await files(dir)).filter((n) => n.endsWith(".own")), []);
  });
});
