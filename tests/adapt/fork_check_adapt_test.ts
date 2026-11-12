import { assert, assertEquals, assertThrows } from "@std/assert";
import { walk } from "@std/fs";
import { dirname, join, relative } from "node:path";

import {
  edit,
  emptyAdmittedUnasked,
  switchGoldOnlyOff,
  unpack,
  UPSTREAM_TESTS,
} from "../../scripts/adapt_fork_check.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

const ADMITTED = "_ADMITTED_UNASKED: Final[dict[str, str]] = ";

Deno.test("the admitted-unasked dict is emptied, and one already empty is left as it is", () => {
  const upstream = [
    "# Why each is admitted.",
    `${ADMITTED}{`,
    '    "KEY": (',
    '        "A reason, over "',
    '        "two lines."',
    "    ),",
    "}",
    "",
    "def test_it() -> None: ...",
    "",
  ].join("\n");
  const emptied = emptyAdmittedUnasked(upstream);
  assertEquals(
    emptied,
    `# Why each is admitted.\n${ADMITTED}{}\n\ndef test_it() -> None: ...\n`,
  );
  // The fork's own checkout holds it emptied already (checklist step 4).
  assertEquals(emptyAdmittedUnasked(emptied), emptied);
});

Deno.test("a vocabulary test that no longer declares the dict is refused", () => {
  assertThrows(
    () => emptyAdmittedUnasked("_ADMITTED: Final[dict[str, str]] = {}\n"),
    Error,
    "_ADMITTED_UNASKED was not found",
  );
});

Deno.test("the gold-only switch is turned off, and one already off is left as it is", () => {
  const on =
    '/** The switch. */\nexport const GOLD_ONLY = true;\nexport const D = "x";\n';
  const off = switchGoldOnlyOff(on);
  assertEquals(
    off,
    '/** The switch. */\nexport const GOLD_ONLY = false;\nexport const D = "x";\n',
  );
  // The fork's own checkout holds it off already (checklist step 3).
  assertEquals(switchGoldOnlyOff(off), off);
});

Deno.test("a switch that is not a bare boolean on a line of its own is refused", () => {
  // The forms pipeline/gold_only.py refuses to read.
  for (
    const text of [
      "export const GOLD_ONLY = Deno.env.has('GOLD');\n",
      "export let GOLD_ONLY = true;\n",
      "// export const GOLD_ONLY = true;\n",
      "",
    ]
  ) {
    assertThrows(
      () => switchGoldOnlyOff(text),
      Error,
      "GOLD_ONLY was not found",
    );
  }
});

/** Every file under `root`, by path, with its text. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of walk(root, { includeDirs: false })) {
    files[relative(root, entry.path)] = await Deno.readTextFile(entry.path);
  }
  return files;
}

Deno.test("the fork's file edits apply to the checkout, and again to a tree that carries them", async () => {
  const fork = await Deno.makeTempDir({ prefix: "fork-check-adapt-" });
  try {
    // The three files the edits rewrite, as the checkout holds them: in
    // upstream's form here, and already edited where this runs in a fork.
    for (
      const path of [
        "tests/pipeline/test_prompt_vocabulary.py",
        "lib/gold_only.ts",
        "e2e/package.json",
      ]
    ) {
      await Deno.mkdir(dirname(join(fork, path)), { recursive: true });
      await Deno.copyFile(path, join(fork, path));
    }
    // And what the checklist deletes, which a fork's checkout no longer has.
    const deleted = [
      "static/institute/logo-dark.svg",
      "disease/recall_baseline.json",
      ...UPSTREAM_TESTS.map((tree) => `${tree}/pinned.txt`),
    ];
    const lightLogo = "static/institute/logo-light.svg";
    for (const path of [...deleted, lightLogo]) {
      await Deno.mkdir(dirname(join(fork, path)), { recursive: true });
      await Deno.writeTextFile(join(fork, path), "upstream's\n");
    }

    await unpack(fork, EXAMPLEITIS);
    await edit(fork, EXAMPLEITIS);
    const adapted = await snapshot(fork);
    for (const path of deleted) assert(!(path in adapted), path);
    assert("disease/manifest.json" in adapted);
    // The answer set brings one logo, in the upstream light one's place.
    assert(adapted[lightLogo] !== "upstream's\n");
    assert(
      adapted["tests/pipeline/test_prompt_vocabulary.py"].includes(
        `\n${ADMITTED}{}\n`,
      ),
    );
    // The switch reads as pipeline/gold_only.py reads it: off, so the fork's
    // gates run in the state its pipeline runs in.
    assert(
      /^export const GOLD_ONLY = false;$/m.test(adapted["lib/gold_only.ts"]),
    );
    assertEquals(
      JSON.parse(adapted["e2e/package.json"]).name,
      "exampleitis-dashboard-e2e",
    );

    // The second pass is the fork's own CI: its adapt-fork job runs the
    // script on a checkout that followed the checklist long ago.
    await unpack(fork, EXAMPLEITIS);
    await edit(fork, EXAMPLEITIS);
    assertEquals(await snapshot(fork), adapted);
  } finally {
    await Deno.remove(fork, { recursive: true });
  }
});

Deno.test("on upstream's tree a path the checklist deletes must still be there", async () => {
  const fork = await Deno.makeTempDir({ prefix: "fork-check-adapt-" });
  try {
    // Upstream's tree, told by its own disease tests, with one checklist path
    // renamed away: the checklist's own `rm` would fail for the next fork,
    // and a removal that shrugged at absence kept this check green over it.
    for (
      const path of [
        "static/institute/logo-light.svg",
        "static/institute/logo-dark.svg",
        ...UPSTREAM_TESTS.map((tree) => `${tree}/pinned.txt`),
      ]
    ) {
      await Deno.mkdir(dirname(join(fork, path)), { recursive: true });
      await Deno.writeTextFile(join(fork, path), "upstream's\n");
    }
    let refused: unknown;
    try {
      await unpack(fork, EXAMPLEITIS);
    } catch (error) {
      refused = error;
    }
    assert(refused instanceof Deno.errors.NotFound, String(refused));
    assert(refused.message.includes("recall_baseline.json"), refused.message);

    // The same for a tree step 3 deletes.
    await Deno.remove(join(fork, UPSTREAM_TESTS[1]), { recursive: true });
    refused = undefined;
    try {
      await edit(fork, EXAMPLEITIS);
    } catch (error) {
      refused = error;
    }
    assert(refused instanceof Deno.errors.NotFound, String(refused));
  } finally {
    await Deno.remove(fork, { recursive: true });
  }
});

Deno.test("a removal that fails for any reason but absence still stops the run", async () => {
  const fork = await Deno.makeTempDir({ prefix: "fork-check-adapt-" });
  try {
    // A file where the logos' directory should be: nothing to remove, and
    // not because the checklist already removed it.
    await Deno.mkdir(join(fork, "static"));
    await Deno.writeTextFile(join(fork, "static/institute"), "a file\n");
    let refused: unknown;
    try {
      await unpack(fork, EXAMPLEITIS);
    } catch (error) {
      refused = error;
    }
    assert(refused instanceof Error, "the removal was let through");
    assert(!(refused instanceof Deno.errors.NotFound));
  } finally {
    await Deno.remove(fork, { recursive: true });
  }
});
