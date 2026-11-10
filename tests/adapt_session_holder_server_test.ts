import { assert, assertEquals, assertThrows } from "@std/assert";

import { EMPTY_ANSWERS } from "../lib/adapt/answers.ts";
import { exportText } from "../lib/adapt/bundle.ts";
import {
  handleCreate,
  handleResume,
  handleSave,
} from "../server/adapt_session_api.ts";
import {
  designatedMachine,
  FORCE_INSTANCE_HEADER,
  type Holder,
  HOLDER_VAR,
  MACHINE_VAR,
  REPLAY_HEADER,
  replayToHolder,
  sessionHolder,
  sessionsForPage,
} from "../server/adapt_session_holder.ts";
import {
  openSessionStore,
  SESSIONS_DIR_VAR,
  type SessionStore,
} from "../server/adapt_sessions.ts";

const HOLDER = "abc123def";
const OTHER = "0ff1ce0ff1ce";

/** An environment of exactly these variables. */
function env(vars: Record<string, string>) {
  return (name: string): string | undefined => vars[name];
}

Deno.test("no designation, or a blank one, keeps the sessions here", () => {
  for (const value of [undefined, "", "  "]) {
    const vars: Record<string, string> = { [MACHINE_VAR]: OTHER };
    if (value !== undefined) vars[HOLDER_VAR] = value;
    assertEquals(sessionHolder(env(vars)), { kind: "here" }, String(value));
    assertEquals(designatedMachine(env(vars)), undefined, String(value));
  }
  assertEquals(sessionHolder(env({})), { kind: "here" });
});

Deno.test("the designated machine holds its own sessions", () => {
  const vars = env({ [HOLDER_VAR]: HOLDER, [MACHINE_VAR]: HOLDER });
  assertEquals(sessionHolder(vars), { kind: "here" });
  assertEquals(designatedMachine(vars), HOLDER);
});

Deno.test("any other machine, or one that does not know its id, hands over", () => {
  assertEquals(
    sessionHolder(env({ [HOLDER_VAR]: HOLDER, [MACHINE_VAR]: OTHER })),
    { kind: "elsewhere", machine: HOLDER },
  );
  assertEquals(
    sessionHolder(env({ [HOLDER_VAR]: ` ${HOLDER} ` })),
    { kind: "elsewhere", machine: HOLDER },
  );
});

Deno.test("a designation that is not a machine id throws, naming the variable", () => {
  for (const bad of ["not an id!", "abc12", "g".repeat(8), "a".repeat(33)]) {
    const vars = env({ [HOLDER_VAR]: bad, [MACHINE_VAR]: OTHER });
    assertThrows(() => sessionHolder(vars), TypeError, HOLDER_VAR);
    assertThrows(() => designatedMachine(vars), TypeError, HOLDER_VAR);
  }
});

Deno.test({
  name: "a malformed designation stops main.ts at start-up",
  // A process of its own: the holder is read once per process, and this one
  // has already read an unset variable.
  async fn() {
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["eval", `await import("${import.meta.resolve("../main.ts")}");`],
      env: { [HOLDER_VAR]: "not an id!" },
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(code !== 0);
    const text = new TextDecoder().decode(stderr);
    assert(text.includes(`${HOLDER_VAR} must be a Fly machine id`), text);
  },
});

Deno.test({
  name: "a machine that does not hold the sessions never opens the directory",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "adapt-session-holder-" });
    const dir = `${root}/sessions`;
    try {
      const module = import.meta.resolve("../server/adapt_sessions.ts");
      const { code, stdout } = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `const { sessionStore } = await import("${module}");
           console.log(JSON.stringify(sessionStore()));`,
        ],
        env: {
          [HOLDER_VAR]: HOLDER,
          [MACHINE_VAR]: OTHER,
          [SESSIONS_DIR_VAR]: dir,
        },
        stdout: "piped",
        stderr: "null",
      }).output();
      assertEquals(code, 0);
      const lines = new TextDecoder().decode(stdout).trim().split("\n");
      assertEquals(lines.at(-1), "null");
      assert(
        lines.some((line) => line.includes("held by another machine")),
        lines.join("\n"),
      );
      await assertRejectsNotFound(dir);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

async function assertRejectsNotFound(path: string) {
  try {
    await Deno.stat(path);
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound);
    return;
  }
  throw new Error(`${path} was created`);
}

Deno.test("the page names the designated machine, wherever it is served", async () => {
  const dir = await Deno.makeTempDir({ prefix: "adapt-session-holder-" });
  try {
    const store = openSessionStore(dir);
    assert(store !== null);
    const here: Holder = { kind: "here" };
    // No designation: on when the store opened, and no machine to name.
    assertEquals(sessionsForPage(here, store, undefined), {
      sessions: true,
      machine: null,
    });
    assertEquals(sessionsForPage(here, null, undefined), {
      sessions: false,
      machine: null,
    });
    // The designated machine names itself.
    assertEquals(sessionsForPage(here, store, HOLDER), {
      sessions: true,
      machine: HOLDER,
    });
    // Any other machine cannot see the holder's volume, and names it.
    assertEquals(
      sessionsForPage({ kind: "elsewhere", machine: HOLDER }, null, HOLDER),
      { sessions: true, machine: HOLDER },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the hand-over replays to the holder and reads as failed if nothing consumes it", async () => {
  const response = replayToHolder(HOLDER);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get(REPLAY_HEADER), `instance=${HOLDER}`);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(await response.json(), { error: "failed" });
  assertEquals(FORCE_INSTANCE_HEADER, "fly-force-instance-id");
});

/** A store that fails the test if any handler reaches it. */
const untouchable: SessionStore = {
  create: () => Promise.reject(new Error("create reached the store")),
  save: () => Promise.reject(new Error("save reached the store")),
  load: () => Promise.reject(new Error("load reached the store")),
  sweep: () => Promise.reject(new Error("sweep reached the store")),
};

Deno.test("each handler hands a request over before reading its body", async () => {
  const elsewhere: Holder = { kind: "elsewhere", machine: HOLDER };
  for (
    const [path, handler] of [
      ["create", handleCreate],
      ["save", handleSave],
      ["resume", handleResume],
    ] as const
  ) {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ answers: exportText(EMPTY_ANSWERS) }),
          ),
        );
        controller.close();
      },
      // Nothing queued ahead: pull() runs only when something reads.
    }, { highWaterMark: 0 });
    const req = new Request(`http://localhost/adapt/session/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    for (const store of [untouchable, null]) {
      const response = await handler(req, store, elsewhere);
      assertEquals(response.status, 503, path);
      assertEquals(
        response.headers.get(REPLAY_HEADER),
        `instance=${HOLDER}`,
        path,
      );
      assertEquals(pulled, false, path);
      assertEquals(req.bodyUsed, false, path);
      await response.body?.cancel();
    }
  }
});
