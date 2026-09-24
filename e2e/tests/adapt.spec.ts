import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";

/**
 * The wizard walked end to end with a fictitious disease. Every external
 * host is stubbed at the network layer, so the spec is deterministic and
 * offline; the shapes match what lib/adapt/lookups.ts parses. The page
 * embeds no data, so this runs unchanged on the empty export.
 */

// A stalled action or a page that never hydrates fails within seconds,
// naming what it waited on, rather than at the test's deadline.
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

/** lib/adapt/answers.ts's DRAFT_STORAGE_KEY. */
const DRAFT_KEY = "svd-adapt-draft";

const ESEARCH = (count: string, ids: string[] = []) => ({
  esearchresult: { count, idlist: ids },
});

const ABSTRACT = "1. J. 2020. GENEC reached genome-wide significance for T1.";

async function stubLookups(page: Page) {
  await page.route("https://eutils.ncbi.nlm.nih.gov/**", (route) => {
    const url = new URL(route.request().url());
    const db = url.searchParams.get("db");
    const path = url.pathname;
    if (path.endsWith("efetch.fcgi")) {
      return route.fulfill({ contentType: "text/plain", body: ABSTRACT });
    }
    let json: unknown = {};
    if (path.endsWith("esearch.fcgi")) {
      if (db === "mesh") json = ESEARCH("1", ["68001"]);
      else if (db === "pubmed") json = ESEARCH("321");
      else if (db === "gene") json = ESEARCH("1", ["7"]);
      else if (db === "clinvar") json = ESEARCH("3", ["9", "10", "11"]);
    } else if (path.endsWith("esummary.fcgi")) {
      if (db === "mesh") {
        json = {
          result: {
            "68001": {
              ds_meshterms: ["Exampleitis"],
              ds_scopenote: "A made-up disease.",
            },
          },
        };
      } else if (db === "gene") {
        json = { result: { "7": { name: "GENEA", status: "" } } };
      } else if (db === "clinvar") {
        // Live ClinVar also answers a gene with records spanning a region
        // of many genes, and with traits that carry no identifier; the
        // lookup offers neither as the gene's own disease.
        json = {
          result: {
            uids: ["9", "10", "11"],
            "9": {
              genes: [{ symbol: "GENEA" }],
              germline_classification: {
                trait_set: [{
                  trait_name: "Syndrome one",
                  trait_xrefs: [{ db_source: "OMIM", db_id: "100001" }],
                }],
              },
            },
            "10": {
              genes: ["GENEA", "G2", "G3", "G4", "G5", "G6"].map((symbol) => ({
                symbol,
              })),
              germline_classification: {
                trait_set: [{
                  trait_name: "Region syndrome",
                  trait_xrefs: [{ db_source: "OMIM", db_id: "100009" }],
                }],
              },
            },
            "11": {
              genes: [{ symbol: "GENEA" }],
              germline_classification: {
                trait_set: [{ trait_name: "not provided", trait_xrefs: [] }],
              },
            },
          },
        };
      } else if (db === "pubmed") {
        const ids = (url.searchParams.get("id") ?? "").split(",");
        const result: Record<string, unknown> = { uids: ids };
        for (const id of ids) result[id] = { title: `Paper ${id}` };
        json = { result };
      }
    }
    return route.fulfill({ json });
  });
  await page.route(
    "https://www.ebi.ac.uk/**",
    (route) =>
      route.fulfill({
        json: {
          response: {
            docs: [{ obo_id: "HP:0000001", label: "Trait one term" }],
          },
        },
      }),
  );
  await page.route("https://clinicaltrials.gov/**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("countTotal") === "true") {
      return route.fulfill({ json: { totalCount: 12 } });
    }
    return route.fulfill({
      json: {
        studies: [{
          protocolSection: {
            conditionsModule: { conditions: ["Exampleitis"] },
            armsInterventionsModule: {
              interventions: [{ name: "examplumab" }],
            },
          },
        }],
      },
    });
  });
}

/**
 * Open the card holding `target` when it is folded. A folded card's body
 * stays in the page with `hidden`, so its controls can be found by label;
 * they cannot be filled or clicked until it opens. Whether it is folded is
 * asked in one round trip: this runs before every field the walk-through
 * fills, and two per field were half the spec's calls.
 */
async function openCardOf(target: Locator) {
  const folded = await target.evaluate((el) =>
    el.closest("section[data-card]")
      ?.querySelector(":scope > h3 > button")
      ?.getAttribute("aria-expanded") === "false"
  );
  if (folded) {
    await target.locator("xpath=ancestor::section[@data-card][1]/h3/button")
      .click();
  }
}

/** Fill the labelled field inside `scope`; index picks among same-named fields. */
async function fill(scope: Page, label: string, value: string, index = 0) {
  const field = scope.getByLabel(label, { exact: true }).nth(index);
  await openCardOf(field);
  await field.fill(value);
}

/** Press a button that may sit in a folded card. */
async function press(
  page: Page,
  name: string,
  { exact = false, nth = 0 }: { exact?: boolean; nth?: number } = {},
) {
  const button = page.getByRole("button", { name, exact, includeHidden: true })
    .nth(nth);
  await openCardOf(button);
  await button.click();
}

/**
 * Press the open card's Continue. Every card renders one, folded or not, so
 * the page-wide first "Continue" belongs to the first card whichever is
 * open; pressing that one would open its card first and hide a regression
 * in which card the wizard itself left open.
 */
async function continueOpenCard(page: Page) {
  await page.locator(".adapt-card.is-open").getByRole("button", {
    name: "Continue",
    exact: true,
  }).click();
}

/**
 * A family <select>, on the traits step or the mechanisms one. getByLabel
 * reads a wrapping label's whole text, and for a select that swallows every
 * option, so these are addressed by accessible name -- which is the label
 * span alone -- rather than by label.
 */
const familySelect = (page: Page) =>
  page.getByRole("combobox", { name: "Family", exact: true });

/** The wizard's one status line, where the lookups and the import report. */
const statusLine = (page: Page) =>
  page.locator('.adapt-messages > [role="status"]');

/**
 * The island's chunk loads after the document, and a fill that lands before
 * its listeners do writes the DOM value with nothing to record it -- the
 * field looks filled and the answer is empty. The server renders the form's
 * fieldset disabled and only the hydrated island enables it, once it has
 * read the stored draft, so that is the island's own signal. It is read off
 * the attribute: Playwright's toBeEnabled() never counts a fieldset as
 * disabled, only the controls inside one.
 */
async function waitForHydration(page: Page) {
  await expect(page.locator("fieldset.adapt")).not.toHaveAttribute(
    "disabled",
    { timeout: 15_000 },
  );
}

test.beforeEach(async ({ page }) => {
  // Every test has a fresh context, and the signed-in state it starts from
  // holds no draft: the setup project never opens this page.
  await stubLookups(page);
  await page.goto("/adapt");
});

test("the About page links here and the page carries its own title", async ({ page }) => {
  await expect(page).toHaveTitle(/^Adapt \| /);
  await page.goto("/");
  await page.getByRole("link", { name: "Open the adaptation guide" }).click();
  await expect(page).toHaveURL("/adapt");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Adapt this dashboard to another disease",
  );
});

test("each need to start sits above its reason, in one column", async ({ page }) => {
  // The rows borrow the About page's .about-row, a grid whose first track is
  // a 1.5rem icon column. These carry no icon, and a label auto-placed into
  // that track wrapped one word to a line across the reason beside it.
  const rows = await page.locator(".about-row").all();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const label = (await row.locator(".about-info-label").boundingBox())!;
    const reason = (await row.locator(".about-row-value").boundingBox())!;
    expect(label.x).toBe(reason.x);
    expect(label.y + label.height).toBeLessThanOrEqual(reason.y);
  }
});

test("a complete walk-through downloads a disease/ archive", async ({ page }) => {
  // Some four hundred calls in one test: seconds on an idle machine, and
  // several times that under a loaded parallel run. The action timeout
  // above is what catches a stall, so the whole may take its time.
  test.setTimeout(180_000);
  await waitForHydration(page);

  // 1. Identity
  await fill(page, "Disease name", "exampleitis");
  await fill(page, "Short form", "EXD");
  await fill(page, "Abbreviation", "EXD");
  await fill(page, "Adjective form", "Exampleitic");
  await fill(page, "Key", "exampleitis");
  await fill(page, "Institute name", "Example Institute");
  await fill(page, "Institute short name", "EI");
  await fill(page, "Copyright line", "Example Institute (EI)");
  await fill(page, "Logo alternative text", "Example Institute");
  const logo = page.locator('input[data-field="logoLight"]');
  await openCardOf(logo);
  await logo.setInputFiles({
    name: "logo-light.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await expect(page.getByText("Uploaded: logo-light.svg")).toBeVisible();
  await fill(page, "Maintainer name", "Ada Example");
  await fill(page, "Maintainer email", "ada@example.org");
  await press(page, "Use this dashboard's cell types");
  // The site text is drafted from the names above, and the button fills the
  // cell-type column from this dashboard's own glossary.
  await expect(page.getByLabel("Site title", { exact: true })).toHaveValue(
    "EI Exampleitic Dashboard",
  );
  await expect(page.getByLabel("Column label", { exact: true }))
    .not.toHaveValue("");
  await page.getByRole("button", { name: "Next" }).click();

  // 2. Search terms. With a key the island spaces its NCBI requests 110 ms
  // apart rather than 350; the stubs ignore it, and no file may carry it.
  await fill(page, "NCBI API key (optional)", "e2e-stub-key");
  await press(page, "Add phrase");
  await fill(page, "Phrase 1", "exampleitis");
  await press(page, "Check MeSH headings");
  await expect(page.locator(".adapt-lookup-result")).toContainText(
    "Exampleitis",
  );
  for (const [i, term] of ["example marker", "second marker"].entries()) {
    await press(page, "Add marker term");
    await fill(page, `Term ${i + 1}`, term);
  }
  await press(page, "Count papers");
  await expect(page.getByText("Total across terms: 642")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  // 3. Traits
  await press(page, "Add family");
  await fill(page, "Family key", "fam-a");
  await fill(page, "Family label", "Family A");
  for (let i = 1; i <= 4; i++) {
    await press(page, "Add trait");
    await fill(page, "Key", `T${i}`, i - 1);
    await fill(page, "Label", `T${i}`, i - 1);
    await familySelect(page).nth(i - 1).selectOption("fam-a");
    await fill(page, "Long name", `Trait ${i}`, i - 1);
    await fill(page, "Definition", `Definition ${i}.`, i - 1);
    await press(page, "Find ontology term", { nth: i - 1 });
    await expect(
      page.getByLabel("Ontology term", { exact: true }).nth(i - 1),
    ).toHaveValue("HP:0000001");
  }
  await page.getByRole("button", { name: "Next" }).click();

  // 4. Trials
  await press(page, "Add population");
  await fill(page, "Key", "Early");
  await fill(page, "Label", "Early");
  await fill(page, "Population column label", "EXD Population");
  await fill(page, "Population details label", "EXD Population Details");
  await press(page, "Add search term");
  await fill(page, "Term 1", "exampleitis");
  await press(page, "Count studies");
  await expect(page.locator(".adapt-lookup-result")).toContainText(
    "12 studies",
  );
  await fill(page, "Condition substrings (comma separated)", "exampleitis");
  await press(page, "Add mechanism family");
  await fill(page, "Family key", "anti-example");
  await fill(page, "Family label", "Anti-example");
  await press(page, "Add mechanism", { exact: true });
  await fill(page, "Mechanism", "Example receptor antagonist");
  await familySelect(page).last().selectOption("anti-example");
  await page.getByRole("button", { name: "Next" }).click();

  // 5. Monogenic genes
  await press(page, "Add gene");
  await fill(page, "HGNC symbol", "GENEA");
  await press(page, "Check symbols");
  await expect(page.locator(".adapt-lookup-result")).toContainText(
    "Syndrome one (OMIM 100001)",
  );
  await expect(page.locator(".adapt-lookup-result")).not.toContainText(
    "Region syndrome",
  );
  await expect(page.locator(".adapt-lookup-result")).not.toContainText(
    "not provided",
  );
  await press(page, "Add OMIM row");
  await fill(page, "Cytogenetic location", "1p36.1");
  await fill(page, "Inheritance (AD, AR, XL…)", "AD");
  await fill(page, "Phenotype mapping key (1–4)", "3");
  await fill(page, "Gene MIM number", "100002");
  await page.getByRole("button", { name: "Next" }).click();

  // 6. Prompt
  await press(page, "Draft the four derived sections");
  for (
    const id of [
      "persona.specificity",
      "strategy.neighbouring_conditions",
      "strategy.background_example",
      "strategy.causal_gene_example",
      "strategy.mr_example",
      "strategy.ortholog_example",
      "strategy.convergence_example",
      "guidance.specificity_note",
      "rubric.subgroup_example",
      "rubric.neighbour_gwas_gene",
      "rubric.modifiers",
    ]
  ) {
    await fill(page, id, `Text for ${id}.`);
  }
  for (const [i, pmid] of ["10000001", "10000002"].entries()) {
    await press(page, "Add example paper");
    await fill(page, "PMID", pmid, i);
    await fill(page, "Example type", "include_validated", i);
    await fill(page, "Gene symbol", "GENEC", i);
    await press(page, "Fetch abstract", { nth: i });
    await expect(page.locator(".code-block").nth(i)).toContainText(
      "GENEC reached",
    );
    await fill(
      page,
      "Paper states (verbatim sentence)",
      "GENEC reached genome-wide significance for T1.",
      i,
    );
    await fill(page, "Trait keys (comma separated)", "T1", i);
    await fill(page, "Confidence (0–1)", "0.9", i);
    await fill(page, "Reasoning", "GWAS plus TWAS.", i);
  }
  await page.getByRole("button", { name: "Next" }).click();

  // 7. Gold papers
  await press(page, "Add the example papers");
  for (let i = 3; i <= 10; i++) {
    await press(page, "Add PMID");
    await fill(page, "PMID", String(10_000_000 + i), i - 1);
  }
  for (let i = 0; i < 10; i++) {
    await fill(page, "Why it is gold", "landmark paper", i);
  }
  await press(page, "Check PMIDs");
  await expect(page.getByText("Paper 10000010")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  // 8. Review
  await expect(page.locator(".adapt-remaining")).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download disease-adaptation.zip" })
      .click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const entries = unzipSync(new Uint8Array(readFileSync(path!)));
  expect(Object.keys(entries).sort()).toEqual([
    "ADAPT-CHECKLIST.md",
    "adapt-answers.json",
    "disease/README.md",
    "disease/manifest.json",
    "disease/omim_info.csv",
    "disease/phenogram.json",
    "disease/pipeline.json",
    "disease/prompt.md",
    "disease/recall_gold.csv",
    "disease/timeline.json",
    "disease/vocabulary.json",
    "static/institute/logo-light.svg",
  ]);
  const manifest = JSON.parse(
    new TextDecoder().decode(entries["disease/manifest.json"]),
  );
  expect(manifest.disease.key).toBe("exampleitis");
  expect(manifest.populations).toEqual([{ key: "Early", label: "Early" }]);
  const answers = new TextDecoder().decode(entries["adapt-answers.json"]);
  expect(answers).not.toContain("e2e-stub-key");
  expect(JSON.parse(answers).identity.disease.name).toBe("exampleitis");

  // The draft survives a reload.
  await page.reload();
  await expect(page.getByLabel("Disease name")).toHaveValue("exampleitis");
});

test("the download stays disabled while a step has issues", async ({ page }) => {
  await waitForHydration(page);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(
    page.getByRole("button", { name: "Download disease-adaptation.zip" }),
  ).toBeDisabled();
  await expect(page.locator(".adapt-remaining li").first()).toBeVisible();
  // The issues sit under the step that holds them, and its button goes
  // there; the first open control on the revealed step takes focus, so the
  // page scrolls to it and a screen reader hears the step change.
  await page.getByRole("button", { name: "Go to Trials" }).click();
  await expect(page.getByRole("button", { name: "Add population" }))
    .toBeFocused();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "5. Monogenic genes" }))
    .toBeFocused();
});

test("every field's description points at a hint or an error on the page", async ({ page }) => {
  // The ids come from useId, rendered once on the server and again as the
  // island hydrates; a description naming an id the page no longer has
  // would leave the error unannounced after the next edit.
  await waitForHydration(page);
  const dangling = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[aria-describedby]")].flatMap((el) =>
        el.getAttribute("aria-describedby")!.split(" ").filter((id) =>
          document.getElementById(id) === null
        )
      )
    );
  expect(await dangling()).toEqual([]);
  const key = page.getByLabel("Key", { exact: true });
  // Untouched: required, and not yet in error.
  await expect(key).toHaveAttribute("aria-required", "true");
  await expect(key).not.toHaveAttribute("aria-invalid", "true");
  await fill(page, "Key", "exampleitis");
  await expect(key).not.toHaveAttribute("aria-invalid", "true");
  expect(await dangling()).toEqual([]);
  // An offending character is in error at once.
  await fill(page, "Key", "Not A Key");
  await expect(key).toHaveAttribute("aria-invalid", "true");
  expect(await dangling()).toEqual([]);
});

test("a second tab takes the draft the first one saves", async ({ page, context }) => {
  // Every edit saves at once; a tab left open on an older draft would
  // otherwise save over this one's work with its next keystroke.
  await waitForHydration(page);
  const other = await context.newPage();
  await other.goto("/adapt");
  await waitForHydration(other);
  await fill(page, "Disease name", "exampleitis");
  await expect(other.getByLabel("Disease name", { exact: true }))
    .toHaveValue("exampleitis");
  await other.close();
});

/** Press Export answers on Review and read the file it downloads. */
async function exportAnswers(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export answers" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("adapt-answers.json");
  return readFileSync((await download.path())!, "utf8");
}

/** Choose a file for Import answers, as the file dialog would. */
const importFile = (page: Page, name: string, body: string) =>
  page.getByLabel("Import answers file").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(body),
  });

test("Export answers leaves the NCBI key behind, and an import keeps the one typed here", async ({ page }) => {
  await waitForHydration(page);
  await fill(page, "Disease name", "exampleitis");
  await page.getByRole("button", { name: "Search terms", exact: true }).click();
  await fill(page, "NCBI email (optional)", "me@example.org");
  await fill(page, "NCBI API key (optional)", "SECRETKEY123");
  const exported = await exportAnswers(page);
  expect(exported).not.toContain("SECRETKEY123");
  expect(exported).not.toContain("me@example.org");
  expect(JSON.parse(exported).identity.disease.name).toBe("exampleitis");

  // Start over asks, then empties every answer, the credentials with them.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByLabel("Disease name", { exact: true }))
    .toHaveValue("");
  await page.getByRole("button", { name: "Search terms", exact: true }).click();
  await expect(page.getByLabel("NCBI API key (optional)", { exact: true }))
    .toHaveValue("");
  await fill(page, "NCBI API key (optional)", "NEWKEY456");

  // A key is all there is to lose, and an import keeps it, so the import
  // replaces the answers without asking.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await importFile(page, "adapt-answers.json", exported);
  await expect(statusLine(page)).toHaveText(
    "Imported the answers in adapt-answers.json.",
  );
  expect(dialogs).toEqual([]);
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(page.getByLabel("Disease name", { exact: true }))
    .toHaveValue("exampleitis");
  await page.getByRole("button", { name: "Search terms", exact: true }).click();
  await expect(page.getByLabel("NCBI API key (optional)", { exact: true }))
    .toHaveValue("NEWKEY456");
  await expect(page.getByLabel("NCBI email (optional)", { exact: true }))
    .toHaveValue("");
});

test("an import asks before it replaces answers, and refuses a file that is no export", async ({ page }) => {
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    if (accept) dialog.accept();
    else dialog.dismiss();
  });
  const stored = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).identity.disease.name,
      DRAFT_KEY,
    );
  await waitForHydration(page);
  await fill(page, "Disease name", "exampleitis");
  const older = await exportAnswers(page);
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await fill(page, "Disease name", "exampleosis");
  await page.getByRole("button", { name: "Review", exact: true }).click();

  // Any JSON whose version is 1 once passed for an export, with every step
  // empty, and replaced the draft unasked.
  await importFile(page, "settings.json", '{"version":1,"theme":"dark"}');
  await expect(statusLine(page)).toHaveText(
    "That file is not an answers export from this wizard.",
  );
  await importFile(
    page,
    "adapt-answers.json",
    JSON.stringify({ ...JSON.parse(older), version: 2 }),
  );
  await expect(statusLine(page)).toHaveText(
    "That file comes from another version of the wizard (version 2) and cannot be imported here.",
  );
  await importFile(page, "huge.json", " ".repeat(9_000_000));
  await expect(statusLine(page)).toHaveText(
    "huge.json is larger than any answers export, so it was not read.",
  );
  expect(dialogs).toEqual([]);
  expect(await stored()).toBe("exampleosis");

  // An older export over newer work asks first; dismissed, nothing moves.
  await importFile(page, "adapt-answers.json", older);
  await expect(statusLine(page)).toHaveText(
    "Kept the answers here; adapt-answers.json was not imported.",
  );
  expect(dialogs).toEqual([
    "Replace every answer here with the answers in adapt-answers.json? Export them first to keep them.",
  ]);
  expect(await stored()).toBe("exampleosis");

  accept = true;
  await importFile(page, "adapt-answers.json", older);
  await expect(statusLine(page)).toHaveText(
    "Imported the answers in adapt-answers.json.",
  );
  expect(dialogs).toHaveLength(2);
  expect(await stored()).toBe("exampleitis");
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(page.getByLabel("Disease name", { exact: true }))
    .toHaveValue("exampleitis");
});

test("a lookup that fails says so on the status line", async ({ page }) => {
  // Registered after the stubs, so it answers first.
  await page.route(
    "https://eutils.ncbi.nlm.nih.gov/**",
    (route) => route.fulfill({ status: 500, body: "" }),
  );
  await waitForHydration(page);
  await page.getByRole("button", { name: "Search terms", exact: true }).click();
  await press(page, "Add phrase");
  await fill(page, "Phrase 1", "exampleitis");
  await press(page, "Check MeSH headings");
  await expect(statusLine(page)).toContainText(
    'Could not resolve "exampleitis"',
  );
});

test("a refused save raises the alert until a save succeeds", async ({ page }) => {
  // The draft's writes are refused, as a full quota refuses them, until
  // the test lifts the refusal; the page's other storage is untouched.
  await page.addInitScript((draftKey) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (
        key === draftKey &&
        (globalThis as { refuse?: boolean }).refuse !== false
      ) {
        throw new DOMException("The quota is full.", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  }, DRAFT_KEY);
  await page.reload();
  await waitForHydration(page);
  const alert = page.getByRole("alert").filter({
    hasText: "refused to save the draft",
  });
  await expect(alert).toHaveCount(0);
  await fill(page, "Disease name", "exampleitis");
  await expect(alert).toBeVisible();
  // Every edit saves the whole draft, so the first save that lands keeps
  // what the refused ones could not, and the alert goes with it.
  await page.evaluate(() => {
    (globalThis as { refuse?: boolean }).refuse = false;
  });
  await fill(page, "Short form", "EXD");
  await expect(alert).toHaveCount(0);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).identity.disease,
      DRAFT_KEY,
    ),
  ).toMatchObject({ name: "exampleitis", short: "EXD" });
});

test("a comma list and a decimal can be typed one key at a time", async ({ page }) => {
  // These fields store the parsed value. Rendering it straight back
  // dropped a trailing comma, or the "." of a half-typed decimal, under
  // the cursor, so only a paste could enter a second item; fill() pastes,
  // which is why the walk-through above never saw it.
  await waitForHydration(page);
  await page.getByRole("button", { name: "Trials", exact: true }).click();
  const conditions = page.getByLabel("Condition substrings (comma separated)", {
    exact: true,
  });
  await openCardOf(conditions);
  await conditions.pressSequentially("exampleitis, example disease");
  await expect(conditions).toHaveValue("exampleitis, example disease");

  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await press(page, "Add example paper");
  const confidence = page.getByLabel("Confidence (0–1)", { exact: true });
  await confidence.fill("");
  await confidence.pressSequentially("0.75");
  await expect(confidence).toHaveValue("0.75");

  await page.reload();
  await waitForHydration(page);
  await page.getByRole("button", { name: "Trials", exact: true }).click();
  await openCardOf(conditions);
  await expect(conditions).toHaveValue("exampleitis, example disease");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(confidence).toHaveValue("0.75");
});

test("an offending character is named, marked and fixed in one press", async ({ page }) => {
  await waitForHydration(page);
  const key = page.getByLabel("Key", { exact: true });
  await key.pressSequentially("Example-itis");
  await expect(page.getByText('"E" and "-" can\'t be used here')).toBeVisible();
  await expect(page.locator(".adapt-echo mark")).toHaveCount(2);
  // Tab reaches the fix, and Enter takes it.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Use example_itis" }))
    .toBeFocused();
  await page.keyboard.press("Enter");
  await expect(key).toHaveValue("example_itis");
  await expect(key).toBeFocused();
  await expect(key).not.toHaveAttribute("aria-invalid", "true");
});

test("tabbing to a field's fix is not leaving it; tabbing off the fix is", async ({ page }) => {
  // An address with no scheme is a note while it is typed and an error once
  // the field is left, so aria-invalid shows exactly when the island counted
  // the field as left. An offending character could not show it: that is
  // red at once, left or not.
  await waitForHydration(page);
  const url = page.getByLabel("Institute URL (optional)", { exact: true });
  await openCardOf(url);
  await url.pressSequentially("example.org");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Use https://example.org" }))
    .toBeFocused();
  await expect(url).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Tab");
  await expect(url).not.toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText(
      "The institute URL must be a web address starting with http:// or https://, or be left empty.",
    ),
  ).toBeVisible();
});

test("a fixed comma list keeps its fix on the next key", async ({ page }) => {
  await waitForHydration(page);
  await page.getByRole("button", { name: "Trials", exact: true }).click();
  const conditions = page.getByLabel("Condition substrings (comma separated)", {
    exact: true,
  });
  await openCardOf(conditions);
  await conditions.pressSequentially("small-vessel, dementia");
  await page.getByRole("button", { name: "Use small vessel, dementia" })
    .click();
  await expect(conditions).toHaveValue("small vessel, dementia");
  await conditions.pressSequentially(", x");
  await expect(conditions).toHaveValue("small vessel, dementia, x");
});

test("a blank field tabbed through stays calm; one typed and cleared turns red", async ({ page }) => {
  await waitForHydration(page);
  const name = page.getByLabel("Disease name", { exact: true });
  await name.focus();
  await page.keyboard.press("Tab");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await name.fill("x");
  await name.fill("");
  await page.keyboard.press("Tab");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("The disease name is required.")).toBeVisible();
});

test("Next reveals the step it leaves; the stepper does not", async ({ page }) => {
  await waitForHydration(page);
  const name = page.getByLabel("Disease name", { exact: true });
  await page.getByRole("button", { name: "Search terms" }).click();
  await page.getByRole("button", { name: "Identity" }).click();
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
});

test("a folded card's body is hidden, not merely marked", async ({ page }) => {
  // The body keeps its markup in the page with `hidden`, and a display rule
  // on the body class outranks the user agent's [hidden] rule: every card
  // once drew open, with all six Continue buttons on screen.
  await waitForHydration(page);
  const bodies = page.locator(".adapt-card-body");
  await expect(bodies).toHaveCount(6);
  await expect(page.locator('[data-card="disease"] .adapt-card-body'))
    .toBeVisible();
  for (
    const id of ["institute", "logos", "maintainer", "site", "cells"]
  ) {
    // Counted first: a card id that matches nothing is not visible either.
    const body = page.locator(`[data-card="${id}"] .adapt-card-body`);
    await expect(body).toHaveCount(1);
    await expect(body).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "Continue", exact: true }))
    .toHaveCount(1);
});

test("finishing a card key by key leaves it open until Continue", async ({ page }) => {
  // The step's first unfinished card is decided when the step opens, not on
  // every render: the last key of the last required field must not fold the
  // card from under the cursor and leave focus in a hidden input.
  await waitForHydration(page);
  await fill(page, "Disease name", "exampleitis");
  await fill(page, "Short form", "EXD");
  await fill(page, "Abbreviation", "EXD");
  await fill(page, "Adjective form", "Exampleitic");
  const key = page.getByLabel("Key", { exact: true });
  await key.pressSequentially("exampleitis");
  const disease = page.locator('[data-card="disease"] .adapt-card-head');
  const institute = page.locator('[data-card="institute"] .adapt-card-head');
  await expect(disease).toHaveAttribute("aria-expanded", "true");
  await expect(disease).toContainText("Complete");
  await expect(key).toBeFocused();
  await expect(key).toBeVisible();
  await expect(institute).toHaveAttribute("aria-expanded", "false");
  await continueOpenCard(page);
  await expect(disease).toHaveAttribute("aria-expanded", "false");
  await expect(institute).toHaveAttribute("aria-expanded", "true");
  await expect(institute).toBeFocused();
});

test("Continue folds a finished card and opens the next; on an unfinished one it shows the gaps", async ({ page }) => {
  await waitForHydration(page);
  await continueOpenCard(page);
  await expect(page.getByLabel("Disease name", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Disease name", { exact: true }))
    .toHaveAttribute("aria-invalid", "true");
  await fill(page, "Disease name", "exampleitis");
  await fill(page, "Short form", "EXD");
  await fill(page, "Abbreviation", "EXD");
  await fill(page, "Adjective form", "Exampleitic");
  await fill(page, "Key", "exampleitis");
  await continueOpenCard(page);
  const disease = page.locator('[data-card="disease"] .adapt-card-head');
  const institute = page.locator('[data-card="institute"] .adapt-card-head');
  await expect(disease).toHaveAttribute("aria-expanded", "false");
  await expect(disease).toContainText("exampleitis · EXD");
  await expect(institute).toHaveAttribute("aria-expanded", "true");
  await expect(institute).toBeFocused();
});

test("Show what's left opens the card holding the first gap and focuses it", async ({ page }) => {
  await waitForHydration(page);
  await fill(page, "Disease name", "exampleitis");
  await fill(page, "Short form", "EXD");
  await fill(page, "Abbreviation", "EXD");
  await fill(page, "Adjective form", "Exampleitic");
  await fill(page, "Key", "exampleitis");
  await page.getByRole("button", { name: "Show what's left" }).click();
  const institute = page.getByLabel("Institute name", { exact: true });
  await expect(institute).toBeFocused();
  await expect(institute).toHaveAttribute("aria-invalid", "true");
});

test("a reloaded draft shows an offending character at once", async ({ page }) => {
  await waitForHydration(page);
  await fill(page, "Key", "Example-itis");
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByLabel("Key", { exact: true }))
    .toHaveAttribute("aria-invalid", "true");
});

test("a draft this build cannot read is kept aside, offered, and never saved over", async ({ page }) => {
  const foreign = '{"version": 99, "identity": {}}';
  await page.evaluate(
    ([key, text]) => localStorage.setItem(key, text),
    [DRAFT_KEY, foreign],
  );
  await page.reload();
  await waitForHydration(page);
  const notice = page.getByRole("alert").filter({
    hasText: "could not be read",
  });
  await expect(notice).toBeVisible();
  const kept = () =>
    page.evaluate(
      (key) => localStorage.getItem(`${key}-unreadable`),
      DRAFT_KEY,
    );
  expect(await kept()).toBe(foreign);
  // The first keystroke saves a draft of this version; the one kept stays.
  await fill(page, "Disease name", "exampleitis");
  await expect.poll(() =>
    page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)
  ).toContain('"exampleitis"');
  expect(await kept()).toBe(foreign);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    notice.getByRole("button", { name: "Download the stored draft" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("adapt-draft-unreadable.json");
  expect(readFileSync((await download.path())!, "utf8")).toBe(foreign);
});

test("a tab whose saves are refused keeps its answers and takes the other tab's", async ({ page, context }) => {
  await waitForHydration(page);
  const other = await context.newPage();
  await other.goto("/adapt");
  await waitForHydration(other);
  // This tab can no longer save: its answers exist nowhere else.
  await page.evaluate((key) => {
    const setItem = Storage.prototype.setItem;
    Object.assign(globalThis, { __restoreSetItem: setItem });
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) throw new DOMException("refused", "QuotaExceededError");
      return setItem.call(this, name, value);
    };
  }, DRAFT_KEY);
  await fill(page, "Disease name", "mine");
  await expect(page.getByRole("alert").filter({ hasText: "refused" }))
    .toBeVisible();
  // The other tab saves a different answer; this one merges it in and keeps
  // its own.
  await fill(other, "Maintainer name", "Ada Example");
  await openCardOf(page.getByLabel("Maintainer name", { exact: true }));
  await expect(page.getByLabel("Maintainer name", { exact: true }))
    .toHaveValue("Ada Example");
  await expect(page.getByLabel("Disease name", { exact: true }))
    .toHaveValue("mine");
  // Closing it now asks first.
  let asked = false;
  page.once("dialog", async (dialog) => {
    asked = dialog.type() === "beforeunload";
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
  await other.close();
});

test("a Start over in another tab takes back what this one had revealed", async ({ page, context }) => {
  await waitForHydration(page);
  // Typed and cleared, then left: the field turns red.
  const name = page.getByLabel("Disease name", { exact: true });
  await name.fill("x");
  await name.fill("");
  await name.press("Tab");
  await expect(page.locator(".adapt-field.is-error")).not.toHaveCount(0);
  const other = await context.newPage();
  await other.goto("/adapt");
  await waitForHydration(other);
  await other.getByRole("button", { name: "Review", exact: true }).click();
  other.once("dialog", (dialog) => dialog.accept());
  await other.getByRole("button", { name: "Start over" }).click();
  await expect(page.locator(".adapt-field.is-error")).toHaveCount(0);
  await other.close();
});

test("pressing the current step's own segment moves nothing", async ({ page }) => {
  await waitForHydration(page);
  const institute = page.locator('[data-card="institute"]');
  await institute.locator(".adapt-card-head").click();
  await expect(institute).toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(institute).toHaveClass(/is-open/);
});

test("a lookup's failure waits on its step while the researcher is elsewhere", async ({ page }) => {
  await page.unroute("https://eutils.ncbi.nlm.nih.gov/**");
  await page.route(
    "https://eutils.ncbi.nlm.nih.gov/**",
    (route) => route.fulfill({ status: 500, body: "" }),
  );
  await waitForHydration(page);
  await page.getByRole("button", { name: "Search terms", exact: true })
    .click();
  await press(page, "Add phrase");
  await fill(page, "Phrase 1", "exampleitis");
  await press(page, "Check MeSH headings");
  await expect(statusLine(page)).toContainText("Could not resolve");
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(statusLine(page)).toHaveText("");
  await page.getByRole("button", { name: "Search terms", exact: true })
    .click();
  await expect(statusLine(page)).toContainText("Could not resolve");
});

test("a click that leaves a field lands, though leaving it shows a message", async ({ page }) => {
  await waitForHydration(page);
  const email = page.getByLabel("Maintainer email", { exact: true });
  await openCardOf(email);
  // Half an address, then straight to the card's Continue: the message the
  // field shows once left must not move the button out from under the
  // pointer between its press and its release.
  await email.fill("a");
  const next = page.locator('[data-card="maintainer"]').getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await next.evaluate((button) => {
    Object.assign(globalThis, { __clicks: 0 });
    button.addEventListener("click", () => {
      const counter = globalThis as unknown as { __clicks: number };
      counter.__clicks += 1;
    });
  });
  await next.click();
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { __clicks: number }).__clicks
    ),
  ).toBe(1);
  await expect(page.locator('[data-card="maintainer"] .adapt-field.is-error'))
    .not.toHaveCount(0);
});

test("until the island runs, the page says so and the form stays shut", async ({ page }) => {
  await page.route("**/fresh-island__AdaptWizard*", (route) => route.abort());
  await page.goto("/adapt");
  await expect(page.getByText("Loading the wizard…")).toBeVisible();
  await expect(page.locator("fieldset.adapt")).toHaveAttribute("disabled", "");
  await expect(page.locator(".adapt-stepper")).toHaveCSS("opacity", "0.6");
  await page.unroute("**/fresh-island__AdaptWizard*");
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByText("Loading the wizard…")).toHaveCount(0);
});

test("a logo outlives a reload under its own key, and Start over clears it", async ({ page }) => {
  await waitForHydration(page);
  const logo = page.locator('input[data-field="logoLight"]');
  await openCardOf(logo);
  await logo.setInputFiles({
    name: "logo-light.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
    ),
  });
  await expect(page.getByText("Uploaded: logo-light.svg")).toBeVisible();
  const stored = (key: string) =>
    page.evaluate((name) => localStorage.getItem(name), key);
  // Kept apart, so a keystroke does not rewrite its bytes.
  expect(await stored(`${DRAFT_KEY}-logo-light`)).toContain("logo-light.svg");
  expect(JSON.parse((await stored(DRAFT_KEY))!).identity.logoLight).toBeNull();
  await page.reload();
  await waitForHydration(page);
  await openCardOf(page.locator('input[data-field="logoLight"]'));
  await expect(page.getByText("Uploaded: logo-light.svg")).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect.poll(() => stored(`${DRAFT_KEY}-logo-light`)).toBeNull();
});
