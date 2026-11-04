/**
 * `deno test --parallel` runs test modules as threads of one process, so the
 * process environment is shared between them: a file that sets and deletes
 * `DASHBOARD_PASSPHRASE` can clear it in the middle of another file's test,
 * which then answers 503 where it expected a redirect. Deno does not retry a
 * failed test, so that is a red `check` job -- reproduced 4 times in 41 runs
 * of the three auth test files alone. Those files exist to prove the login
 * gate reads the real environment, so they cannot stop mutating it.
 *
 * Excluding them from a parallel pass does not work either: a command-line
 * `--ignore` replaces deno.json's top-level `exclude` (it pulled
 * `e2e/perf/*.test.mjs` into the run, and would pull `.claude/worktrees/`),
 * and a `test.exclude` also refuses the files when named explicitly. Nor
 * would it buy anything a pull request waits for: the Deno jobs finish well
 * before the e2e jobs that set CI's pace. So `test:coverage` stays serial
 * while any test file changes the process state, and this test says so.
 */
import { assert } from "@std/assert";
import { walk } from "@std/fs";

const MUTATES_PROCESS = new RegExp(
  ["Deno\\.env\\.(set|delete)\\(", "Deno\\.chdir\\("].join("|"),
);

async function processMutatingTests(): Promise<string[]> {
  const found: string[] = [];
  for await (
    const entry of walk("tests", {
      exts: [".ts", ".tsx"],
      skip: [/tests\/pipeline\//, /tests\/scripts\//],
    })
  ) {
    if (!/_test\.tsx?$/.test(entry.path)) continue;
    if (MUTATES_PROCESS.test(await Deno.readTextFile(entry.path))) {
      found.push(entry.path);
    }
  }
  return found.sort();
}

Deno.test("deno test runs serially while a test file changes the process environment", async () => {
  const mutating = await processMutatingTests();
  const task = String(
    JSON.parse(Deno.readTextFileSync("deno.json")).tasks["test:coverage"],
  );
  assert(
    mutating.length === 0 || !task.includes("--parallel"),
    `test:coverage runs --parallel, but these share the process environment: ${
      mutating.join(", ")
    }`,
  );
});
