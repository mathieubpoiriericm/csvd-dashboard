/**
 * Runs a fork's checks on the fork the adapt wizard starts.
 *
 * The empty-data CI job keeps this repository's own disease/, so a failure
 * only a fork can meet -- a manifest string the renderer escapes, a test
 * pinning one disease's glossary, a literal scan tripping on a two-letter
 * abbreviation, one trial population -- never surfaced upstream. This copies
 * the tree, unpacks a wizard bundle over it and follows the adaptation
 * checklist's steps 2 to 4 (lib/adapt/checklist.ts): the upstream logos go,
 * the data is emptied, the four cSVD test trees and the recall cassettes are
 * deleted and `_ADMITTED_UNASKED` is emptied. Then it runs step 5's checks
 * and the production build.
 *
 *   deno run -A scripts/adapt_fork_check.ts [exampleitis] [hard] [--e2e] [--keep]
 *                                            [--shard=K/N] [--only=FAMILY]
 *
 * With no answer set named, both run. `--shard=K/N` keeps every N-th of the
 * sets that would run, from the K-th, and `--only=deno|python|e2e` runs one
 * family of checks, which together are how CI runs them as parallel jobs (see
 * `shard` and `gates`). With `--e2e` the Playwright run builds the fork, so the
 * separate production build is skipped. The Python checks use the checkout's
 * virtual environment (or UV_PROJECT_ENVIRONMENT's) without syncing it, and
 * the database tests reach PostgreSQL the way the checkout's do.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Answers } from "../lib/adapt/answers.ts";
import { bundle } from "../lib/adapt/bundle.ts";
import { validate } from "../lib/adapt/validate.ts";
import { EXAMPLEITIS } from "../tests/adapt/fixtures/exampleitis.ts";
import { FORK_HARD } from "../tests/adapt/fixtures/fork_hard.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ANSWER_SETS: Readonly<Record<string, Answers>> = {
  exampleitis: EXAMPLEITIS,
  hard: FORK_HARD,
};

/**
 * The answer sets one leg of `--shard=K/N` runs: every N-th of `names`, from
 * the K-th. It splits by position rather than by name so that a set added to
 * `ANSWER_SETS` lands in some leg of the CI matrix without the matrix
 * changing -- a matrix listing the names would quietly never run it.
 */
export function shard(names: readonly string[], spec: string): string[] {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const k = Number(match?.[1]);
  const n = Number(match?.[2]);
  if (match === null || k < 1 || k > n) {
    throw new RangeError(
      `--shard takes K/N with 1 <= K <= N, as in --shard=1/2; got "${spec}".`,
    );
  }
  return names.filter((_, i) => i % n === k - 1);
}

/** The trees and the cassettes checklist step 3 deletes. */
const UPSTREAM_TESTS = [
  "tests/csvd",
  "e2e/tests/csvd",
  "tests/pipeline/csvd",
  "tests/scripts/csvd",
  "tests/pipeline/cassettes/test_query_recall_gold",
];

const PYTHON_ENV = {
  UV_PROJECT_ENVIRONMENT: Deno.env.get("UV_PROJECT_ENVIRONMENT") ??
    join(ROOT, ".venv"),
  // The fork shares the checkout's environment; a sync would rebuild it.
  UV_NO_SYNC: "1",
};

async function run(
  cwd: string,
  command: string,
  args: string[],
  env: Record<string, string> = {},
) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const { code } = await new Deno.Command(command, {
    args,
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    throw new Error(`${[command, ...args].join(" ")} exited ${code}`);
  }
}

async function output(cwd: string, command: string, args: string[]) {
  const { code, stdout } = await new Deno.Command(command, { args, cwd })
    .output();
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return new TextDecoder().decode(stdout);
}

/** The checkout as a clone holds it: tracked files and new, unignored ones. */
async function copyTree(into: string) {
  const listed = await output(ROOT, "git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  for (const path of listed.split("\0").filter(Boolean)) {
    const from = join(ROOT, path);
    // A file deleted in the working tree is still in the index.
    const info = await Deno.lstat(from).catch(() => null);
    if (info === null || !info.isFile) continue;
    await Deno.mkdir(dirname(join(into, path)), { recursive: true });
    await Deno.copyFile(from, join(into, path));
  }
}

/** Checklist steps 2 to 4, on the copy at `fork`. */
async function adapt(fork: string, answers: Answers) {
  for (const logo of ["logo-light.svg", "logo-dark.svg"]) {
    await Deno.remove(join(fork, "static/institute", logo)).catch(() => {});
  }
  for (const entry of bundle(answers)) {
    if (!/^(disease|static)\//.test(entry.path)) continue;
    await Deno.mkdir(dirname(join(fork, entry.path)), { recursive: true });
    await Deno.writeFile(join(fork, entry.path), entry.bytes);
  }
  await Deno.remove(join(fork, "disease/recall_baseline.json"));
  await run(fork, "deno", ["fmt", "disease/", "static/institute/"]);

  await run(fork, "deno", ["task", "data:empty"], PYTHON_ENV);
  for (const tree of UPSTREAM_TESTS) {
    await Deno.remove(join(fork, tree), { recursive: true });
  }

  const vocabularyTest = join(fork, "tests/pipeline/test_prompt_vocabulary.py");
  const text = await Deno.readTextFile(vocabularyTest);
  const emptied = text.replace(
    /^(_ADMITTED_UNASKED: Final\[dict\[str, str\]\] = )\{\n[\s\S]*?^\}$/m,
    "$1{}",
  );
  if (emptied === text) throw new Error("_ADMITTED_UNASKED was not found");
  await Deno.writeTextFile(vocabularyTest, emptied);

  const packageJson = join(fork, "e2e/package.json");
  const pkg = JSON.parse(await Deno.readTextFile(packageJson));
  const { key, short } = answers.identity.disease;
  pkg.name = `${key.replaceAll("_", "-")}-dashboard-e2e`;
  pkg.description = `Playwright end-to-end suite for the ${short} dashboard.`;
  await Deno.writeTextFile(packageJson, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** The gate families `--only` picks between. */
export const FAMILIES = ["deno", "python", "e2e"] as const;
export type Family = typeof FAMILIES[number];

/** The family `--only=<spec>` names. */
export function family(spec: string): Family {
  const match = FAMILIES.find((name) => name === spec);
  if (match === undefined) {
    throw new RangeError(
      `--only takes one of ${FAMILIES.join(", ")}; got "${spec}".`,
    );
  }
  return match;
}

/** One command of the checks, and whether it needs the Python environment. */
export interface Gate {
  command: string;
  args: string[];
  python: boolean;
}

const deno = (...args: string[]): Gate => ({
  command: "deno",
  args,
  python: false,
});
const uv = (...args: string[]): Gate => ({ command: "uv", args, python: true });

/**
 * Checklist step 5, and the build a deploy runs, as the commands to run in
 * order. `only` keeps one family, which is how CI runs each as a job of its
 * own. With `e2e`, Playwright's web server builds the same fork, so the
 * separate build is left out; without it the build still runs, and the
 * deploy build is never left unchecked. In CI the pipeline suite spreads
 * across xdist workers, each with a database of its own
 * (tests/xdist_databases.py); a developer's run stays serial and starts one
 * container.
 */
export function gates(
  { only, e2e, ci }: { only?: Family; e2e: boolean; ci: boolean },
): Gate[] {
  if (only === "e2e" && !e2e) {
    // A run that checks nothing must not end in "every check passed".
    throw new RangeError(
      "--only=e2e needs --e2e: without it the e2e family has nothing to run.",
    );
  }
  const want = (name: Family) => only === undefined || only === name;
  const list: Gate[] = [];
  if (want("deno") || (e2e && want("e2e"))) list.push(deno("install"));
  if (want("deno")) {
    list.push(deno("task", "check"), deno("task", "test:coverage"));
    if (!e2e) list.push(deno("task", "build"));
  }
  if (want("python")) {
    const workers = ci ? ["-n", "auto", "--maxprocesses=4"] : [];
    list.push(
      uv("run", "ruff", "check", "."),
      uv("run", "ty", "check"),
      uv("run", "pytest", "-q", ...workers),
      uv("run", "pytest", "-q", "tests/scripts"),
    );
  }
  if (e2e && want("e2e")) {
    list.push(
      { command: "npm", args: ["ci", "--prefix", "e2e"], python: false },
      {
        command: "npx",
        args: [
          "--prefix",
          "e2e",
          "playwright",
          "test",
          "-c",
          "e2e/playwright.config.ts",
        ],
        python: false,
      },
    );
  }
  return list;
}

async function check(
  fork: string,
  options: { only?: Family; e2e: boolean; ci: boolean },
) {
  for (const gate of gates(options)) {
    await run(fork, gate.command, gate.args, gate.python ? PYTHON_ENV : {});
  }
}

if (import.meta.main) {
  const flags = new Set(Deno.args.filter((arg) => arg.startsWith("--")));
  const named = Deno.args.filter((arg) => !arg.startsWith("--"));
  const unknown = named.filter((name) => !(name in ANSWER_SETS));
  if (unknown.length > 0) {
    console.error(
      `No answer set ${unknown.join(", ")}; the sets are ${
        Object.keys(ANSWER_SETS).join(", ")
      }.`,
    );
    Deno.exit(2);
  }
  let names = named.length > 0 ? named : Object.keys(ANSWER_SETS);
  const shardArg = Deno.args.find((arg) => /^--shard(=|$)/.test(arg));
  if (shardArg !== undefined) {
    try {
      names = shard(names, shardArg.slice("--shard=".length));
    } catch (error) {
      console.error((error as Error).message);
      Deno.exit(2);
    }
    if (names.length === 0) {
      console.log(`${shardArg}: no answer set falls here`);
    }
  }
  let only: Family | undefined;
  const onlyArg = Deno.args.find((arg) => /^--only(=|$)/.test(arg));
  const options = {
    e2e: flags.has("--e2e"),
    ci: Deno.env.get("CI") === "true",
  };
  try {
    if (onlyArg !== undefined) only = family(onlyArg.slice("--only=".length));
    // Refused here, before any fork is copied, rather than per fork.
    gates({ only, ...options });
  } catch (error) {
    console.error((error as Error).message);
    Deno.exit(2);
  }
  const failed: string[] = [];
  for (const name of names) {
    const answers = ANSWER_SETS[name];
    // A set the wizard would not let through proves nothing about a fork.
    const issues = validate(answers);
    if (issues.length > 0) {
      console.error(`${name}: the answers do not validate`, issues);
      failed.push(name);
      continue;
    }
    const fork = await Deno.makeTempDir({ prefix: `adapt-fork-${name}-` });
    console.log(`\n== ${name}: ${fork}`);
    try {
      await copyTree(fork);
      await adapt(fork, answers);
      await check(fork, { only, ...options });
      console.log(`\n== ${name}: every check passed`);
      if (!flags.has("--keep")) await Deno.remove(fork, { recursive: true });
    } catch (error) {
      console.error(`\n== ${name}: ${(error as Error).message}; kept ${fork}`);
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    console.error(`\nFailed: ${failed.join(", ")}`);
    Deno.exit(1);
  }
}
