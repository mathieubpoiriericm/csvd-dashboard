import { assert, assertEquals } from "@std/assert";

import {
  announcePreview,
  observePreview,
  PREVIEW_COOKIE,
  PREVIEW_LOAD_FAILED,
  previewCookie,
  previewInvitation,
  previewNote,
  refetchFailedChunks,
  rememberFailedChunks,
} from "../lib/pipeline_preview.ts";

Deno.test("the invitation names the window the report states", () => {
  assertEquals(
    previewInvitation(365),
    "Curious what the pipeline can do? Switch on a technical preview of a real run over the last 365 days of publications.",
  );
  assertEquals(
    previewInvitation(1),
    "Curious what the pipeline can do? Switch on a technical preview of a real run over the last day of publications.",
  );
  assertEquals(
    previewInvitation(null),
    "Curious what the pipeline can do? Switch on a technical preview of a real run.",
  );
  assertEquals(
    previewInvitation(0),
    "Curious what the pipeline can do? Switch on a technical preview of a real run.",
  );
});

Deno.test("the note says the findings are not in the other pages", () => {
  assertEquals(
    previewNote(365),
    "Technical preview: a real pipeline run over the last 365 days of publications. Its findings are not in the other pages.",
  );
  // Grouped as the run card's Search row prints the same window.
  assert(previewNote(1825).includes("over the last 1,825 days"));
  assertEquals(
    previewNote(null),
    "Technical preview: a real pipeline run. Its findings are not in the other pages.",
  );
});

Deno.test("the cookie is set for a year and cleared when off", () => {
  assertEquals(PREVIEW_COOKIE, "pipeline_preview");
  assertEquals(
    previewCookie(true),
    "pipeline_preview=1; Path=/; Max-Age=31536000; SameSite=Lax",
  );
  assertEquals(
    previewCookie(false),
    "pipeline_preview=; Path=/; Max-Age=0; SameSite=Lax",
  );
});

Deno.test("a switch is announced to whoever observes it, until they stop", () => {
  const target = new EventTarget();
  const heard: boolean[] = [];
  const stop = observePreview((on) => heard.push(on), target);
  announcePreview(true, target);
  announcePreview(false, target);
  stop();
  announcePreview(true, target);
  assertEquals(heard, [true, false]);
});

Deno.test("the switch is announced on the page itself by default", () => {
  const heard: boolean[] = [];
  const stop = observePreview((on) => heard.push(on));
  announcePreview(true);
  stop();
  assertEquals(heard, [true]);
});

Deno.test("a failed load asks for a reload, the recovery that works", () => {
  // Another press imports the same dead chunk after a deploy or an expired
  // session, so the sentence must not offer one.
  assertEquals(
    PREVIEW_LOAD_FAILED,
    "The preview could not be loaded. Reload the page to try again.",
  );
});

/** A storage held in a map, as `sessionStorage` is in the island. */
function memoryStore(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    held,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

Deno.test("a failed fetch's chunks are fetched again before the next import, once", async () => {
  const store = memoryStore();
  rememberFailedChunks(
    ["/assets/a.js", "/assets/b.js", "/assets/a.js"],
    () => store,
  );
  const fetched: string[] = [];
  const fetcher = (url: string) => {
    fetched.push(url);
    // One still failing must not stop the others or the import after them.
    return url.endsWith("b.js")
      ? Promise.reject(new TypeError("offline"))
      : Promise.resolve(new Response(""));
  };
  await refetchFailedChunks(() => store, fetcher);
  assertEquals(fetched, ["/assets/a.js", "/assets/b.js"]);
  // Forgotten once tried: the next press fetches nothing twice.
  await refetchFailedChunks(() => store, fetcher);
  assertEquals(fetched.length, 2);
  assertEquals(store.held.size, 0);
});

Deno.test("only this site's own paths are remembered and fetched", async () => {
  const store = memoryStore();
  rememberFailedChunks(
    ["", "//evil.example/x.js", "https://evil.example/x.js", "/assets/a.js"],
    () => store,
  );
  // And a list something else wrote is filtered the same way on the way out.
  const key = [...store.held.keys()][0];
  store.held.set(
    key,
    JSON.stringify(["/assets/a.js", "https://evil.example/x.js", 7]),
  );
  const fetched: string[] = [];
  await refetchFailedChunks(() => store, (url) => {
    fetched.push(url);
    return Promise.resolve(new Response(""));
  });
  assertEquals(fetched, ["/assets/a.js"]);
});

Deno.test("nothing remembered, an unreadable list and a refused storage all fetch nothing", async () => {
  const never = () => {
    throw new Error("fetched");
  };
  const empty = memoryStore();
  rememberFailedChunks([], () => empty);
  assertEquals(empty.held.size, 0);
  await refetchFailedChunks(() => empty, never);

  for (const text of ["{", '{"a":1}']) {
    const damaged = memoryStore();
    rememberFailedChunks(["/assets/a.js"], () => damaged);
    damaged.held.set([...damaged.held.keys()][0], text);
    await refetchFailedChunks(() => damaged, never);
    assertEquals(damaged.held.size, 0);
  }

  // A browser that refuses storage throws on the property itself.
  const refused = () => {
    throw new DOMException("denied", "SecurityError");
  };
  rememberFailedChunks(["/assets/a.js"], refused);
  await refetchFailedChunks(refused, never);
});
