import { assert, assertEquals } from "@std/assert";
import { unzipSync } from "fflate";

import {
  EMPTY_ANSWERS,
  parseDraft,
  serialiseDraft,
} from "../../lib/adapt/answers.ts";
import {
  ANSWERS_NAME,
  bundle,
  BUNDLE_NAME,
  exportableAnswers,
  exportText,
  holdsAnswers,
  IMPORT_BYTE_LIMIT,
  importedAnswers,
  importText,
  parseExport,
  zipBytes,
} from "../../lib/adapt/bundle.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

Deno.test("the bundle holds the nine disease files, the logo, the checklist and the answers", () => {
  const entries = bundle(EXAMPLEITIS);
  assertEquals(entries.map((e) => e.path), [
    "disease/manifest.json",
    "disease/pipeline.json",
    "disease/vocabulary.json",
    "disease/timeline.json",
    "disease/phenogram.json",
    "disease/omim_info.csv",
    "disease/prompt.md",
    "disease/recall_gold.csv",
    "disease/README.md",
    "static/institute/logo-light.svg",
    "ADAPT-CHECKLIST.md",
    "adapt-answers.json",
  ]);
  const logo = entries.find((e) =>
    e.path === "static/institute/logo-light.svg"
  )!;
  assertEquals(
    decode(logo.bytes),
    atob(EXAMPLEITIS.identity.logoLight!.base64),
  );
  const answers = entries.find((e) => e.path === "adapt-answers.json")!;
  assertEquals(
    JSON.parse(decode(answers.bytes)).identity.disease.key,
    "exampleitis",
  );
  assertEquals(BUNDLE_NAME, "disease-adaptation.zip");
});

Deno.test("a dark logo is added and a missing light logo is skipped", () => {
  const withDark = structuredClone(EXAMPLEITIS);
  withDark.identity.logoDark = { name: "dark.png", base64: btoa("PNG") };
  const paths = bundle(withDark).map((e) => e.path);
  assertEquals(paths.includes("static/institute/logo-dark.png"), true);
  const noLogo = structuredClone(EXAMPLEITIS);
  noLogo.identity.logoLight = null;
  assertEquals(bundle(noLogo).some((e) => e.path.startsWith("static/")), false);
});

Deno.test("zipBytes produces an archive fflate reads back", () => {
  const entries = bundle(EXAMPLEITIS);
  const unzipped = unzipSync(zipBytes(entries));
  assertEquals(Object.keys(unzipped).sort(), entries.map((e) => e.path).sort());
  assertEquals(
    decode(unzipped["disease/recall_gold.csv"]).split("\n")[0],
    "pmid,note",
  );
});

Deno.test("the NCBI credentials reach neither the archive nor the export", () => {
  // The archive is committed to a repository and the export is what gets
  // mailed around; an API key in either is one the researcher has to
  // revoke. Everything else is kept, so re-importing loses no answer.
  const keyed = structuredClone(EXAMPLEITIS);
  keyed.search.ncbi = {
    email: "ncbi-account@example.org",
    apiKey: "secret-key",
  };
  const exported = exportableAnswers(keyed);
  assertEquals(exported.search.ncbi, { email: "", apiKey: "" });
  assertEquals(exported.search.diseaseTerms, keyed.search.diseaseTerms);
  assertEquals(exported.identity, keyed.identity);
  // The answers the wizard holds are untouched: the lookups still use them.
  assertEquals(keyed.search.ncbi.apiKey, "secret-key");

  const entry = bundle(keyed).find((e) => e.path === "adapt-answers.json")!;
  const text = decode(entry.bytes);
  assertEquals(text.includes("secret-key"), false);
  assertEquals(text.includes("ncbi-account@example.org"), false);
  assertEquals(JSON.parse(text).search.ncbi, { email: "", apiKey: "" });
});

Deno.test("an import keeps this browser's NCBI credentials", () => {
  // The export blanks them, so reading its pair back as the answer would
  // drop the key the researcher entered here.
  const current = structuredClone(EXAMPLEITIS);
  current.search.ncbi = { email: "me@example.org", apiKey: "k" };
  const imported = exportableAnswers(structuredClone(EXAMPLEITIS));
  imported.identity.disease.name = "exampleosis";
  const merged = importedAnswers(imported, current);
  assertEquals(merged.search.ncbi, { email: "me@example.org", apiKey: "k" });
  assertEquals(merged.identity.disease.name, "exampleosis");
  // A file that does carry credentials is taken as it is.
  imported.search.ncbi = { email: "", apiKey: "other" };
  assertEquals(importedAnswers(imported, current).search.ncbi, {
    email: "",
    apiKey: "other",
  });
});

const NOT_AN_EXPORT = {
  error: "That file is not an answers export from this wizard.",
};

Deno.test("Export answers writes the archive's answers file, without the NCBI credentials", () => {
  // The island's button and bundle() both call exportText(), so no
  // handler builds the export on its own and can leave the key in it.
  const keyed = structuredClone(EXAMPLEITIS);
  keyed.search.ncbi = {
    email: "ncbi-account@example.org",
    apiKey: "secret-key",
  };
  const text = exportText(keyed);
  assertEquals(text.includes("secret-key"), false);
  assertEquals(text.includes("ncbi-account@example.org"), false);
  const entry = bundle(keyed).find((e) => e.path === ANSWERS_NAME)!;
  assertEquals(decode(entry.bytes), text);
});

Deno.test("an export reads back as the answers it was written from", () => {
  assertEquals(parseExport(exportText(EXAMPLEITIS)), {
    answers: exportableAnswers(EXAMPLEITIS),
    dropped: [],
  });
});

Deno.test("an import names what it could not read", () => {
  const exported = JSON.parse(exportText(EXAMPLEITIS));
  exported.gold.rows[0].pmid = 10000001;
  exported.trials.conditions = ["ok", 7];
  const imported = importText(JSON.stringify(exported), EXAMPLEITIS);
  assertEquals(
    "dropped" in imported ? imported.dropped : null,
    ["trials.conditions[1]", "gold.rows[0].pmid"],
  );
});

Deno.test("a file that is not an export is refused, even with version 1", () => {
  // parseDraft() also reads the stored draft, so any record whose version
  // is 1 passes it with every missing step empty; an import replaces every
  // answer, so it asks for the seven steps each export carries.
  const exported = JSON.parse(exportText(EXAMPLEITIS));
  for (
    const text of [
      '{"version":1,"theme":"dark"}',
      '{"version":1,"theme":"dark","recent":["a","b"]}',
      '{"name":"exampleitis","version":"1.0.0"}',
      '{"version":2}',
      "[]",
      "null",
      '"adapt-answers"',
      "{",
      "",
      JSON.stringify({ ...exported, gold: undefined }),
      JSON.stringify({ ...exported, gold: [] }),
      JSON.stringify({ ...exported, version: "1" }),
    ]
  ) {
    assertEquals(parseExport(text), NOT_AN_EXPORT, text);
  }
});

Deno.test("an export from another version of the wizard is named as one", () => {
  const exported = JSON.parse(exportText(EXAMPLEITIS));
  assertEquals(parseExport(JSON.stringify({ ...exported, version: 2 })), {
    error:
      "That file comes from another version of the wizard (version 2) and cannot be imported here.",
  });
});

Deno.test("importText keeps this browser's NCBI credentials, and passes a refusal on", () => {
  const current = structuredClone(EMPTY_ANSWERS);
  current.search.ncbi = { email: "me@example.org", apiKey: "k" };
  assertEquals(importText(exportText(EXAMPLEITIS), current), {
    answers: {
      ...EXAMPLEITIS,
      search: { ...EXAMPLEITIS.search, ncbi: current.search.ncbi },
    },
    dropped: [],
  });
  assertEquals(importText('{"version":1}', current), NOT_AN_EXPORT);
});

Deno.test("holdsAnswers is false only for a draft an import replaces without loss", () => {
  assertEquals(holdsAnswers(EMPTY_ANSWERS), false);
  // A stored empty draft comes back through parseDraft(), in its order.
  assertEquals(holdsAnswers(parseDraft(serialiseDraft(EMPTY_ANSWERS))!), false);
  // An import keeps the NCBI credentials, so they are nothing to lose.
  const keyed = structuredClone(EMPTY_ANSWERS);
  keyed.search.ncbi = { email: "me@example.org", apiKey: "k" };
  assertEquals(holdsAnswers(keyed), false);
  const typed = structuredClone(EMPTY_ANSWERS);
  typed.identity.disease.name = "e";
  assertEquals(holdsAnswers(typed), true);
  const added = structuredClone(EMPTY_ANSWERS);
  added.gold.rows.push({ pmid: "", note: "", title: null, exists: null });
  assertEquals(holdsAnswers(added), true);
  assertEquals(holdsAnswers(EXAMPLEITIS), true);
});

Deno.test("the import's size cap sits above the largest export", () => {
  // IdentityStep refuses a logo over 1 MB, so two logos at that cap are
  // the most an export can carry.
  const largest = structuredClone(EXAMPLEITIS);
  const logo = { name: "logo.png", base64: btoa("x".repeat(1_000_000)) };
  largest.identity.logoLight = logo;
  largest.identity.logoDark = { ...logo, name: "logo-dark.png" };
  const bytes = new TextEncoder().encode(exportText(largest)).length;
  assert(bytes > 2_600_000, `${bytes}`);
  assert(bytes < IMPORT_BYTE_LIMIT, `${bytes}`);
});
