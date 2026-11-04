import { assert, assertEquals, assertThrows } from "@std/assert";

import { family, type Gate, gates } from "../../scripts/adapt_fork_check.ts";

const line = (gate: Gate) => [gate.command, ...gate.args].join(" ");
const lines = (list: Gate[]) => list.map(line);

const PLAYWRIGHT =
  "npx --prefix e2e playwright test -c e2e/playwright.config.ts";

Deno.test("--only names one of the three gate families", () => {
  assertEquals(family("deno"), "deno");
  assertEquals(family("python"), "python");
  assertEquals(family("e2e"), "e2e");
  for (const spec of ["", "go", "Deno", "deno,python"]) {
    assertThrows(
      () => family(spec),
      RangeError,
      "--only takes one of deno, python, e2e",
    );
  }
});

Deno.test("every family runs in turn without --only, and the e2e run is the build", () => {
  assertEquals(lines(gates({ e2e: true, ci: false })), [
    "deno install",
    "deno task check",
    "deno task test:coverage",
    "uv run ruff check .",
    "uv run ty check",
    "uv run pytest -q",
    "uv run pytest -q tests/scripts",
    "npm ci --prefix e2e",
    PLAYWRIGHT,
  ]);
});

Deno.test("without --e2e the deploy build still runs", () => {
  const all = lines(gates({ e2e: false, ci: false }));
  assert(all.includes("deno task build"));
  assert(!all.some((gate) => gate.startsWith("npm") || gate.startsWith("npx")));
});

Deno.test("the deno family checks, tests, and builds only when no e2e run will", () => {
  assertEquals(lines(gates({ only: "deno", e2e: true, ci: true })), [
    "deno install",
    "deno task check",
    "deno task test:coverage",
  ]);
  assertEquals(
    lines(gates({ only: "deno", e2e: false, ci: true })).at(-1),
    "deno task build",
  );
});

Deno.test("the python family spreads the pipeline suite across workers in CI only", () => {
  const ci = gates({ only: "python", e2e: true, ci: true });
  assert(ci.every((gate) => gate.python));
  const pipeline = ci.find((gate) =>
    line(gate).startsWith("uv run pytest -q -n")
  );
  assertEquals(pipeline?.args.slice(-3), ["-n", "auto", "--maxprocesses=4"]);
  const scripts = ci.find((gate) => gate.args.includes("tests/scripts"));
  assertEquals(scripts?.args.includes("-n"), false);
  const local = gates({ only: "python", e2e: true, ci: false });
  assert(local.every((gate) => !gate.args.includes("-n")));
});

Deno.test("the e2e family installs, then runs Playwright, and is refused without --e2e", () => {
  assertEquals(lines(gates({ only: "e2e", e2e: true, ci: true })), [
    "deno install",
    "npm ci --prefix e2e",
    PLAYWRIGHT,
  ]);
  assertThrows(
    () => gates({ only: "e2e", e2e: false, ci: true }),
    RangeError,
    "--only=e2e needs --e2e",
  );
});
