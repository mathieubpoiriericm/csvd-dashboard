/**
 * The pipeline widget's encoding contract.
 *
 * `lib/pipeline_encoding.json` is the only place a label, glyph or tint
 * for the widget is defined. These tests fail when the pipeline can emit
 * a value the file does not cover, and when a glyph it names does not
 * resolve in `components/Icon.tsx`. Add the entry; do not widen the test.
 *
 * The vocabularies are read out of the Python source rather than
 * restated here. Restating them is exactly how `PVWMH` -- the second
 * most extracted GWAS trait -- ended up with no filter choice and no
 * phenogram entry, and the same failure is available here: a new error
 * kind would render with a fallback glyph and no hint, and nothing would
 * say so.
 */

import { assert, assertEquals } from "@std/assert";

import encoding from "../lib/pipeline_encoding.json" with { type: "json" };

const ROOT = new URL("..", import.meta.url);

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

/** Every member of a `Literal[...]` alias in a Python module. */
function literalMembers(text: string, alias: string): string[] {
  const match = new RegExp(`${alias}\\s*=\\s*Literal\\[([^\\]]*)\\]`, "s")
    .exec(text);
  assert(match !== null, `${alias} not found; has it been renamed?`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

const ICON_NAMES = new Set(
  [...(await source("components/Icon.tsx")).matchAll(
    /^\s{2}(?:\/\*\*[\s\S]*?\*\/\s*)?([A-Za-z][A-Za-z0-9]*):/gm,
  )].map((entry) => entry[1]),
);

/** Every `"icon"` value anywhere in the encoding file. */
function iconsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) iconsIn(entry, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "icon" && typeof entry === "string") found.push(entry);
      else iconsIn(entry, found);
    }
  }
  return found;
}

Deno.test("every glyph the encoding names resolves in Icon.tsx", () => {
  const missing = iconsIn(encoding).filter((name) => !ICON_NAMES.has(name));
  assertEquals(
    [...new Set(missing)],
    [],
    "encoding names a glyph components/Icon.tsx does not draw",
  );
});

Deno.test("Icon.tsx parses into a non-trivial glyph set", () => {
  // Guards the regex above: if it stopped matching, every icon check
  // would pass vacuously.
  assert(ICON_NAMES.size > 20, `only found ${ICON_NAMES.size} glyphs`);
  assert(ICON_NAMES.has("dna"));
  assert(ICON_NAMES.has("checkCircle"));
  assert(ICON_NAMES.has("chatQuote"));
});

Deno.test("every run status the pipeline can emit has a badge", async () => {
  const statuses = literalMembers(
    await source("pipeline/run_report.py"),
    "RunStatus",
  );
  assert(statuses.length > 0);
  for (const status of statuses) {
    assert(
      status in encoding.runStatus,
      `run status "${status}" has no badge in pipeline_encoding.json`,
    );
  }
});

Deno.test("every step status the recorder can emit has a badge", async () => {
  const statuses = literalMembers(
    await source("pipeline/steps.py"),
    "StepStatus",
  );
  assert(statuses.length > 0);
  for (const status of statuses) {
    assert(
      status in encoding.stepStatus,
      `step status "${status}" has no badge in pipeline_encoding.json`,
    );
  }
});

Deno.test("every error kind classify() can produce has a hint", async () => {
  const kinds = literalMembers(
    await source("pipeline/run_errors.py"),
    "ErrorKind",
  );
  assert(kinds.length > 0);
  for (const kind of kinds) {
    assert(
      kind in encoding.errorKinds,
      `error kind "${kind}" has no hint in pipeline_encoding.json`,
    );
  }
  assertEquals(
    Object.keys(encoding.errorKinds).sort(),
    [...kinds].sort(),
    "pipeline_encoding.json has an error kind outside the Python vocabulary",
  );
});

Deno.test("every warning kind the pipeline can raise has a glyph", async () => {
  const kinds = literalMembers(
    await source("pipeline/run_errors.py"),
    "WarningKind",
  );
  assert(kinds.length > 0);
  for (const kind of kinds) {
    assert(
      kind in encoding.warningKinds,
      `warning kind "${kind}" has no glyph in pipeline_encoding.json`,
    );
  }
  assertEquals(
    Object.keys(encoding.warningKinds).sort(),
    [...kinds].sort(),
    "pipeline_encoding.json has a warning kind outside the Python vocabulary",
  );
});

Deno.test("every pipeline step has a glyph, in the pipeline's own order", async () => {
  const text = await source("pipeline/steps.py");
  const keys = [...text.matchAll(/PipelineStep\("([^"]+)"/g)].map((m) => m[1]);
  assertEquals(keys.length, 6, "the step list changed size");
  for (const key of keys) {
    assert(
      key in encoding.steps,
      `step "${key}" has no glyph in pipeline_encoding.json`,
    );
  }
  // The file may not add steps the pipeline does not run: a row that
  // never renders is a claim about a pipeline that does not exist.
  assertEquals(Object.keys(encoding.steps).sort(), [...keys].sort());
});

Deno.test("every run mode the database accepts has a label", async () => {
  // Read from the RUN_MODES constant rather than from a docstring: this
  // used to parse `run_mode: One of '...'` out of prose, and rewording
  // that sentence silently broke the check.
  const text = await source("pipeline/steps.py");
  const match = /RUN_MODES:[^=]*=\s*\(([^)]*)\)/s.exec(text);
  assert(match !== null, "RUN_MODES not found; has it been renamed?");
  const modes = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assertEquals(modes.length, 3);
  for (const mode of modes) {
    assert(
      mode in encoding.runModes,
      `run mode "${mode}" has no label in pipeline_encoding.json`,
    );
  }
});

Deno.test("every reference-data refresh mode has a label", async () => {
  // Read from SYNC_MODES for the reason the run modes are read from
  // RUN_MODES: a vocabulary restated here is one that can drift silently.
  const text = await source("pipeline/steps.py");
  const match = /SYNC_MODES:[^=]*=\s*\(([^)]*)\)/s.exec(text);
  assert(match !== null, "SYNC_MODES not found; has it been renamed?");
  const modes = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assertEquals(modes.length, 3);
  for (const mode of modes) {
    assert(
      mode in encoding.syncModes,
      `sync mode "${mode}" has no label in pipeline_encoding.json`,
    );
  }
  // And no label for a refresh the pipeline cannot run, which would be a
  // claim about a mode that does not exist.
  const labelled = Object.keys(encoding.syncModes).filter((k) =>
    !k.startsWith("$")
  );
  assertEquals(labelled.sort(), [...modes].sort());
});

Deno.test("run modes and sync modes stay distinct vocabularies", () => {
  // A refresh is not a run: it has no papers, genes or steps, and it is
  // stored in its own table so that no query feeding the run widget or
  // the About page's date badge can mistake one for the other. A key in
  // both would be the first step back towards merging them.
  const runModes = Object.keys(encoding.runModes).filter((k) =>
    !k.startsWith("$")
  );
  const syncModes = Object.keys(encoding.syncModes).filter((k) =>
    !k.startsWith("$")
  );
  assertEquals(runModes.filter((mode) => syncModes.includes(mode)), []);
});

Deno.test("every paper source the pipeline records has a label", async () => {
  // `PaperResult.source` is set from literals in the retrieval module
  // and the three processing paths; read them rather than restate them.
  const sources = new Set<string>();
  for (const path of ["pipeline/pdf_retrieval.py", "pipeline/main.py"]) {
    const text = await source(path);
    for (
      const match of text.matchAll(
        /\bsource(?:"\s*:|\s*=|:\s*str\s*=)\s*"([a-z_]+)"/g,
      )
    ) {
      sources.add(match[1]);
    }
  }
  assert(
    sources.has("none") && sources.has("abstract"),
    "regex stopped matching",
  );
  for (const key of sources) {
    assert(
      key in encoding.paperSources,
      `paper source "${key}" has no label in pipeline_encoding.json`,
    );
  }
});

Deno.test("every field entry carries both a label and a glyph", () => {
  for (const [key, entry] of Object.entries(encoding.fields)) {
    assert(entry.label.length > 0, `field "${key}" has no label`);
    assert(entry.icon.length > 0, `field "${key}" has no glyph`);
    // The label is what a screen reader and a colour-vision check rely
    // on, so it must not be the raw key.
    assert(entry.label !== key, `field "${key}" label is just its key`);
  }
});

Deno.test("badge tints stay within the semantic set", () => {
  // Data colours never enter the theme; these name semantic tokens the
  // dark blocks already override, so a raw colour here would be a
  // styling contract violation the CSS test cannot see.
  // `highlight` is the one tint that is not a status: a flat amber wash
  // under the page's own ink, for a rejection that is routine rather than
  // alarming.
  const allowed = new Set(["ok", "ember", "danger", "muted", "highlight"]);
  const groups = [encoding.runStatus, encoding.stepStatus];
  for (const group of groups) {
    for (const [key, badge] of Object.entries(group)) {
      assert(
        allowed.has(badge.tint),
        `"${key}" uses tint "${badge.tint}", which is not a semantic name`,
      );
    }
  }
  for (const kind of encoding.rejectionReasons.kinds) {
    assert(
      allowed.has(kind.tint),
      `"${kind.kind}" uses tint "${kind.tint}", which is not a semantic name`,
    );
  }
  assert(allowed.has(encoding.rejectionReasons.fallback.tint));
});

/**
 * The rejection vocabulary, reconciled in both directions.
 *
 * A reason is a finished English sentence built in Python, and the run report
 * is written by a live run -- so unlike every other vocabulary here it cannot
 * be re-cut into fields without re-running the pipeline. The classification
 * lives in the encoding instead, which puts it one edit away from silently
 * drifting from the sentence it classifies. These two tests are what stop that:
 * a prefix reworded in Python fails the first, and a reason shape nothing
 * matches fails the second.
 */
Deno.test("every rejection kind matches a string the pipeline builds", async () => {
  const python = (await Promise.all([
    source("pipeline/validation.py"),
    source("pipeline/main.py"),
    source("pipeline/run_report.py"),
  ])).join("\n");
  for (const kind of encoding.rejectionReasons.kinds) {
    assert(
      python.includes(kind.match),
      `no pipeline source builds "${kind.match}"; has the wording changed?`,
    );
  }
});

Deno.test("every recorded rejection reason classifies", async () => {
  const run = JSON.parse(
    await Deno.readTextFile(
      new URL("data/pipeline_run.json", ROOT),
    ),
  ) as { rejectedGenes?: { items?: { reasons?: string[] }[] } } | null;
  const reasons = (run?.rejectedGenes?.items ?? [])
    .flatMap((gene) => gene.reasons ?? []);
  for (const reason of reasons) {
    assert(
      encoding.rejectionReasons.kinds.some((kind) =>
        reason.includes(kind.match)
      ),
      `recorded reason "${reason}" falls through to the fallback badge`,
    );
  }
});
