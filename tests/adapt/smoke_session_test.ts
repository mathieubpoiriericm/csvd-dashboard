import { assert, assertEquals } from "@std/assert";

import { EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { exportText, parseExport } from "../../lib/adapt/bundle.ts";

// scripts/smoke_deploy.sh posts this file to /adapt/session/create after
// every deploy. Pinned here, a change to the answers' shape fails a test
// instead of the deploy that would first send the stale body.
Deno.test("the deploy smoke test's session body is an empty answers export", async () => {
  const body = JSON.parse(
    await Deno.readTextFile("scripts/smoke_session.json"),
  );
  assertEquals(Object.keys(body), ["answers"]);
  assertEquals(body.answers, exportText(EMPTY_ANSWERS));
  const parsed = parseExport(body.answers);
  assert(!("error" in parsed), "error" in parsed ? parsed.error : "");
});
