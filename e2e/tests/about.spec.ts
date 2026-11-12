import { expect, test } from "@playwright/test";
import { EXPECTED, MAINTAINER_EMAIL } from "../fixtures/expected-data.ts";

/**
 * Headline counts are derived in lib/data/summary.ts from the committed JSON.
 * Publications counts distinct PMIDs; the "(reference needed)" sentinel is
 * excluded. e2e/fixtures/expected-data.ts derives the same numbers through
 * the same function, so regenerating the data moves both together.
 */
const TOTALS = [
  ["Putative Causal Genes", String(EXPECTED.geneCount)],
  ["Drugs Tested", String(EXPECTED.drugCount)],
  ["Clinical Trials", String(EXPECTED.trialCount)],
  ["Publications", String(EXPECTED.publicationCount)],
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("shows the work-in-progress notice", async ({ page }) => {
  await expect(page.locator(".about-warning")).toContainText(
    "This is a preview of a dashboard that is still a work in progress.",
  );
});

test("the dashboard totals report the committed dataset", async ({ page }) => {
  const summary = page.getByRole("region", { name: "Dashboard totals" });
  await expect(summary.locator(".about-kpi")).toHaveCount(4);

  for (const [label, value] of TOTALS) {
    const kpi = summary.locator(".about-kpi").filter({ hasText: label });
    await expect(kpi.locator(".about-kpi-value")).toHaveText(value);
    await expect(kpi.locator(".about-kpi-label")).toHaveText(label);
  }
});

/**
 * The four figures read as one row above 480px, and as two rows of two at
 * 480px and below. A quarter of a phone's hero is narrower than an uppercase
 * "PUBLICATIONS", and `overflow-wrap: anywhere` then split it as
 * "PUBLICATION / S"; half of one fits every label whole.
 */
test("the totals keep one row above 480px, two rows at and below", async ({ page }) => {
  for (const [width, rows] of [[1440, 1], [900, 1], [600, 1], [481, 1], [480, 2], [380, 2], [320, 2]]) {
    await page.setViewportSize({ width, height: 900 });

    const tops = await page.locator(".about-kpi").evaluateAll((cells) =>
      cells.map((cell) => Math.round(cell.getBoundingClientRect().top))
    );
    expect(tops, `four cells at ${width}px`).toHaveLength(4);
    expect(new Set(tops).size, `${rows} row(s) at ${width}px`).toBe(rows);

    // The row must also fit the hero rather than spilling out of it.
    const fits = await page.locator(".about-kpis").evaluate((row) => {
      const body = row.closest(".card-body") as HTMLElement;
      return row.scrollWidth <= row.clientWidth + 1 &&
        row.getBoundingClientRect().right <=
          body.getBoundingClientRect().right + 0.5;
    });
    expect(fits, `the row fits the hero at ${width}px`).toBe(true);

    // No label may break inside a word: each word draws on one line.
    const split = await page.locator(".about-kpi-label").evaluateAll((labels) =>
      labels.flatMap((label) => {
        const text = label.firstChild as Text;
        const out: string[] = [];
        for (const m of text.data.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(text, m.index!);
          range.setEnd(text, m.index! + m[0].length);
          const lines = new Set(
            [...range.getClientRects()].map((r) => Math.round(r.top)),
          );
          if (lines.size > 1) out.push(m[0]);
        }
        return out;
      })
    );
    expect(split, `words split across lines at ${width}px`).toEqual([]);
  }
});

/**
 * While only the hand-curated data is published, the About page says so in
 * place of the run report: no run fed what it shows, so neither account of
 * one, nor the reference-data refreshes, renders.
 */
test("says only the hand-curated data is shown, in place of the run", async ({ page }) => {
  test.skip(!EXPECTED.goldOnly, "the gold-only switch is off");
  await expect(page.locator(".about-gold-notice")).toContainText(
    EXPECTED.goldOnlyNotice,
  );
  await expect(page.getByRole("heading", { name: "Last Pipeline Run" }))
    .toHaveCount(0);
  await expect(page.locator(".pipeline-card")).toHaveCount(0);
  await expect(page.locator(".pipeline-status-timestamp")).toHaveCount(0);
  await expect(page.locator(".pipeline-sync")).toHaveCount(0);
});

/**
 * The technical preview: a switch in the gold-only notice that shows the
 * run widget beneath it. Off by default, and remembered in a cookie the
 * route reads, so the server draws the page the visitor left.
 *
 * The widget reaches the page two ways, and both are walked here: fetched
 * by the switch when it is pressed, and drawn by the server, as an island
 * of its own, for a visitor whose cookie already has it on.
 */
test.describe("the technical preview of a pipeline run", () => {
  test.skip(
    !(EXPECTED.goldOnly && EXPECTED.hasPipelineRun),
    "the preview needs gold-only on and a recorded run",
  );

  const notice = ".about-gold-notice";
  const live = '.about-preview-switch:not([disabled])';
  // The run report's chunk and the widget's: neither belongs on a page
  // whose preview is off.
  const report = /protected-data-pipeline_run|fresh-island__PipelineRun/;

  test("is off at first, and only invites", async ({ page }) => {
    const toggle = page.getByRole("switch", {
      name: "Technical preview of a pipeline run",
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".about-preview-line")).toHaveText(
      EXPECTED.previewInvitation,
    );
    await expect(page.locator(".pipeline-card")).toHaveCount(0);
  });

  test("switches the widget on beneath the notice, keeps it on a reload, and off again", async ({ page }) => {
    const toggle = page.getByRole("switch", {
      name: "Technical preview of a pipeline run",
    });
    await page.waitForSelector(live);
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".about-preview-line")).toHaveText(
      EXPECTED.previewNote,
    );
    const card = page.locator(".pipeline-card");
    await expect(card).toBeVisible();
    // Directly beneath the notice, above the welcome card.
    expect(
      await page.locator(notice).evaluate((el) =>
        el.nextElementSibling?.classList.contains("pipeline-card") ?? false
      ),
    ).toBe(true);
    await expect(card.locator(".pipeline-preview-mark")).toHaveText(
      "Technical preview",
    );

    // The widget the switch fetched is live: its dialog opens and Escape
    // closes it.
    const dialog = page.getByRole("dialog", { name: "Run details" });
    await page.getByRole("button", { name: "Run details" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The cookie brings it back drawn by the server, and live again.
    await page.reload();
    await expect(card).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.waitForSelector(live);
    await page.getByRole("button", { name: "Run details" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const body = await (await page.request.get("/")).text();
    expect(body).toContain("pipeline-card");

    // The widget the server drew is another island, and follows the
    // switch all the same: off, on again, and off.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(card).toHaveCount(0);
    await toggle.click();
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await toggle.click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(card).toHaveCount(0);
  });

  test("fetches the run report only once the preview is switched on", async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (request) => {
      fetched.push(new URL(request.url()).pathname);
    });
    await page.goto("/");
    await page.waitForSelector(live);
    await page.waitForLoadState("networkidle");
    expect(fetched.filter((path) => report.test(path))).toEqual([]);

    const toggle = page.getByRole("switch", {
      name: "Technical preview of a pipeline run",
    });
    const card = page.locator(".pipeline-card");
    await toggle.click();
    await expect(card).toBeVisible();
    const afterFirst = fetched.filter((path) => report.test(path));
    expect(afterFirst.some((path) => path.includes("pipeline_run"))).toBe(true);

    // Off and on again draws the widget it already has.
    await toggle.click();
    await expect(card).toHaveCount(0);
    await toggle.click();
    await expect(card).toBeVisible();
    expect(fetched.filter((path) => report.test(path))).toEqual(afterFirst);
  });

  test("says so, and stays off, when the widget cannot be fetched", async ({ page }) => {
    await page.route(report, (route) => route.abort());
    await page.goto("/");
    await page.waitForSelector(live);
    const toggle = page.getByRole("switch", {
      name: "Technical preview of a pipeline run",
    });
    await toggle.click();
    await expect(page.locator(".about-preview-line")).toHaveText(
      EXPECTED.previewLoadFailed,
    );
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".pipeline-card")).toHaveCount(0);

    // The cookie went back off with the switch: a reload does not claim a
    // preview, and with the chunk reachable again the same press works.
    await page.unroute(report);
    await page.reload();
    await page.waitForSelector(live);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".about-preview-line")).toHaveText(
      EXPECTED.previewInvitation,
    );
    await toggle.click();
    await expect(page.locator(".pipeline-card")).toBeVisible();
  });

  test("fits a phone, on and off", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    const toggle = page.getByRole("switch", {
      name: "Technical preview of a pipeline run",
    });
    await page.waitForSelector(live);
    for (const state of ["false", "true"]) {
      await expect(toggle).toHaveAttribute("aria-checked", state);
      await expect(toggle).toBeVisible();
      const overflow = await page.evaluate(() => {
        const de = document.documentElement;
        return de.scrollWidth - de.clientWidth;
      });
      expect(overflow, `sideways scroll, aria-checked=${state}`)
        .toBeLessThanOrEqual(0);
      if (state === "false") await toggle.click();
    }
  });
});

test("offers no preview when no run is recorded", async ({ page }) => {
  test.skip(
    !(EXPECTED.goldOnly && !EXPECTED.hasPipelineRun),
    "a run is recorded, or gold-only is off",
  );
  await expect(page.locator(".about-preview-switch")).toHaveCount(0);
});

/**
 * The About page reports the last run one of two ways, and never both.
 *
 * The widget (islands/PipelineRun.tsx) renders when data/pipeline_run.json
 * carries a report; the four-number summary card is the fallback until one
 * is recorded, which is the committed state today. Assertions here are
 * structural rather than value-coupled on purpose: the counts change with
 * every run, while the block either renders or it does not.
 */
test("reports the last run exactly once", async ({ page }) => {
  test.skip(EXPECTED.goldOnly, "gold-only: the notice replaces the run");
  await expect(page.locator(".about-gold-notice")).toHaveCount(0);
  const recorded = EXPECTED.hasPipelineRun || EXPECTED.hasPipelineStatus;
  await expect(page.getByRole("heading", { name: "Last Pipeline Run" }))
    .toHaveCount(recorded ? 1 : 0);

  const widget = page.locator(".pipeline-card");
  const card = page.locator(".pipeline-status-timestamp");
  const hasWidget = await widget.count();

  // Exactly one of the two, never both: two accounts of the same run on
  // one page would invite them to disagree. Neither renders until a run is
  // recorded, which is where a fork starts.
  expect(hasWidget + await card.count()).toBe(recorded ? 1 : 0);
  test.skip(!recorded, "no pipeline run recorded");

  if (hasWidget) {
    // One row a step, however many the run recorded: a step can recur.
    expect(await widget.locator(".pipeline-step").count()).toBeGreaterThan(0);
    await expect(widget.locator(".pipeline-badge").first()).not.toBeEmpty();
  } else {
    await expect(card).not.toBeEmpty();
    await expect(page.locator(".card .value-box-label")).toHaveText([
      "Papers Processed",
      "Full-Text Retrieved",
      "Genes Extracted",
      "Genes Validated",
    ]);
  }
});

/**
 * The widget's interactions, exercised only once a run has recorded a
 * report. `data/pipeline_run.json` carries one today, but it is committed
 * as a bare `null` until a run records one, so these skip rather than
 * assert against a block that may not be on the page.
 */
test("the run details open as a dialog, walk their tabs, and close on Escape", async ({ page }) => {
  const widget = page.locator(".pipeline-card");
  test.skip(
    await widget.count() === 0,
    "no run report recorded (data/pipeline_run.json is null)",
  );
  await page.waitForSelector('.pipeline-card[data-hydrated="true"]');

  const trigger = page.getByRole("button", { name: "Run details" });
  const dialog = page.getByRole("dialog", { name: "Run details" });
  await expect(dialog).toBeHidden();

  await trigger.click();
  await expect(dialog).toBeVisible();
  // A native modal: focus is inside it, and the page behind cannot take it.
  await expect(page.getByRole("button", { name: "Close run details" }))
    .toBeFocused();

  // One tab is selected, and the arrows move the selection.
  const tabs = dialog.getByRole("tab");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel")).toHaveCount(1);
  if (await tabs.count() > 1) {
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.first()).toHaveAttribute("aria-selected", "false");
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

/**
 * Inside the open dialog nothing may scroll sideways either: a prompt hash
 * is 64 characters with no space, and a publisher's host name or an
 * endpoint path has none to wrap at.
 */
/**
 * A step's notes are in the page from the start and hidden until its row is
 * opened, so a note too wide for a phone widens nothing until someone looks.
 * A warning names endpoints and papers, neither of which has a space to
 * wrap at.
 */
test("an opened step never scrolls the page sideways, down to 320px", async ({ page }) => {
  test.skip(
    await page.locator(".pipeline-card").count() === 0,
    "no run report recorded (data/pipeline_run.json is null)",
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await page.waitForSelector('.pipeline-card[data-hydrated="true"]');
    const closed = page.locator('.pipeline-step-head[aria-expanded="false"]');
    // Each click opens the first closed row, so the locator's first match
    // is the next one.
    for (let left = await closed.count(); left > 0; left--) {
      await closed.first().click();
    }
    await expect(closed).toHaveCount(0);
    for (const more of await page.locator(".pipeline-note-more").all()) {
      await more.locator("summary").click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
  }
});

test("the open run details never scroll sideways, down to 320px", async ({ page }) => {
  test.skip(
    await page.locator(".pipeline-card").count() === 0,
    "no run report recorded (data/pipeline_run.json is null)",
  );
  // 601 is the first width past the phone layout, where a row has the
  // least room for the columns it still sets side by side.
  for (const width of [601, 390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await page.waitForSelector('.pipeline-card[data-hydrated="true"]');
    await page.getByRole("button", { name: "Run details" }).click();
    const dialog = page.getByRole("dialog", { name: "Run details" });
    const row = dialog.getByRole("tablist");
    expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(0);
    for (const tab of await dialog.getByRole("tab").all()) {
      await tab.click();
      const panel = dialog.getByRole("tabpanel");
      await expect(panel).toHaveCount(1);
      expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
  }
});

test("a step expands by keyboard as well as by click", async ({ page }) => {
  const widget = page.locator(".pipeline-card");
  test.skip(
    await widget.count() === 0,
    "no run report recorded (data/pipeline_run.json is null)",
  );

  await page.waitForSelector('.pipeline-card[data-hydrated="true"]');
  // A row is a control only when it holds a note or an error, and one that
  // failed starts open; a closed one is what this needs. Found by position:
  // a locator that asks for a closed row moves to the next one the moment
  // this one opens.
  const controls = widget.locator(".pipeline-step-head:not([disabled])");
  const states = await controls.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("aria-expanded"))
  );
  test.skip(!states.includes("false"), "no step of this run has a note");
  const head = controls.nth(states.indexOf("false"));

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");

  await head.focus();
  await page.keyboard.press("Enter");
  await expect(head).toHaveAttribute("aria-expanded", "true");
});

/**
 * The page as a whole must not scroll sideways at any width worth supporting.
 *
 * The pipeline widget's step rows used to break this below ~413px: the status
 * badge is `white-space: nowrap`, so "Passed with warnings" held a 190px grid
 * track that could not shrink and pushed the caret past the viewport edge.
 * Only the rows carrying that badge overflowed, which is why it survived --
 * a run whose steps all passed looks fine. A row's flag sits on a line of its
 * own below 900px now, and this still watches for the next thing that
 * cannot shrink.
 */
test("no page scrolls sideways, down to the narrowest phone", async ({ page }) => {
  for (const width of [1440, 1100, 900, 600, 480, 420, 380, 320]) {
    await page.setViewportSize({ width, height: 900 });

    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return de.scrollWidth - de.clientWidth;
    });
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(
      0,
    );
  }
});

test("dates the data from the curated release or the recorded run, or says neither is", async ({ page }) => {
  if (EXPECTED.goldOnly) {
    // The curated release has a date of its own, whatever the pipeline
    // recorded.
    await expect(page.locator(".date-unavailable")).toHaveCount(0);
    await expect(page.locator(".date-badge")).toHaveText(
      `Hand-curated data as of ${EXPECTED.goldDataDate}`,
    );
    return;
  }
  // data/pipeline_status.json is `null` until the pipeline records its first
  // run -- which is where a fork starts -- so which badge renders is read
  // off the committed file rather than assumed.
  if (EXPECTED.hasPipelineStatus) {
    await expect(page.locator(".date-unavailable")).toHaveCount(0);
    await expect(page.locator(".date-badge")).not.toBeEmpty();
  } else {
    await expect(page.locator(".date-unavailable")).toHaveCount(1);
  }
});

test("lists the five info rows", async ({ page }) => {
  await expect(page.locator(".about-info-label")).toHaveText([
    "How to Cite:",
    "Scientific Board:",
    "Contact Us:",
    "Maintenance:",
    "Acknowledgements:",
  ]);

  await expect(page.getByRole("link", { name: MAINTAINER_EMAIL }))
    .toHaveAttribute("href", `mailto:${MAINTAINER_EMAIL}`);
});

test("attributes the three machine-fetched annotation sources", async ({ page }) => {
  // Orphadata is CC-BY-4.0 and asserts that in every payload, so this block
  // discharges a licence obligation rather than a courtesy. The pipeline logs
  // an error if the asserted licence ever changes.
  await expect(page.locator(".about-source-label")).toHaveText([
    "ClinVar",
    "Orphanet / Orphadata",
    "Open Targets Platform",
  ]);

  await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0",
  );
});

/**
 * The reference-data refreshes. Committed as `[]` until a refresh records
 * one, so this skips the same way the drawer tests do -- and starts
 * covering the block the day the first `--sync-annotations` run lands.
 */
test("a recorded refresh names its providers on the page", async ({ page }) => {
  const block = page.locator(".pipeline-sync");
  test.skip(
    await block.count() === 0,
    "no refresh recorded (data/pipeline_syncs.json is empty)",
  );

  // It is a sibling of the run widget, not a replacement for it.
  await expect(page.getByText("Reference Data Refreshes")).toBeVisible();
  await expect(block.first().locator(".pipeline-badge")).not.toBeEmpty();

  // The point of the block: a provider reads as a display name. A bare
  // hostname here means it fell through `SERVICES` to the fallback.
  const names = block.first().locator(".pipeline-api-name");
  for (const name of await names.all()) {
    await expect(name).not.toContainText(/\.(com|org|gov)\b/);
  }
});
