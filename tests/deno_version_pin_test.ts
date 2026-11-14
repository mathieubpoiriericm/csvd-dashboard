// The image's Deno is an exact 2.9 LTS patch, and CI must test that same
// runtime: a floating `v2.x` would run fmt, lint, the unit tests and the
// Playwright suite on a newer Deno than production serves.
import { assert, assertEquals } from "@std/assert";

const root = new URL("../", import.meta.url);

Deno.test("every setup-deno step in CI pins the Dockerfile's Deno", async () => {
  const dockerfile = await Deno.readTextFile(new URL("Dockerfile", root));
  const from = dockerfile.match(/^FROM denoland\/deno:(\d+\.\d+\.\d+)\s*$/m);
  assert(from, "the Dockerfile has no exact `FROM denoland/deno:X.Y.Z` line");

  const ci = await Deno.readTextFile(
    new URL(".github/workflows/ci.yml", root),
  );
  const pins = [...ci.matchAll(/^\s*deno-version:\s*(\S+)\s*$/gm)].map((m) =>
    m[1]
  );
  assert(pins.length > 0, "ci.yml names no deno-version");
  for (const pin of pins) assertEquals(pin, `v${from[1]}`);
});
