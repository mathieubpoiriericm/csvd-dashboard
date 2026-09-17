# Frontend Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply every fix in the 2026-09-08 frontend audit: the two layout bugs
that hide content, the mobile navbar, the sentinel and copy work, the type and
contrast floor, the accessibility gaps, and the non-UI bugs found on the way.

**Architecture:** One branch, seven phases, each independently green. CSS
corrections come first because they carry their own contract-test pins; the
table and copy work follows because it re-pins e2e text; figures and the non-UI
bugs last. Nothing changes the data boundary, the export, the two encodings'
palettes, or any figure's geometry. New logic lands in small `lib/` modules
(`sentinels.ts`, `format.ts`) because `lib/` has a 100% line coverage floor and
every branch there ships with a unit test.

**Tech Stack:** Deno 2, Fresh 2 (Vite 7 dev server), Preact, TanStack Table v9,
Playwright e2e under `e2e/` (npm-isolated), Python `scripts/` for the print
twins.

**Spec:** `docs/superpowers/specs/2026-09-08-frontend-audit-findings.md`

## Global Constraints

- Run every gate from the repo root: `deno task check` (fmt, lint,
  `deno
  check`), `deno task test:coverage` (100% line coverage under `lib/`),
  and e2e as
  `npx --prefix e2e playwright test -c e2e/playwright.config.ts
  tests/<spec>.spec.ts`.
  `uv run pytest tests/scripts` after touching `scripts/`. Never `ruff format`.
- `assets/app.css` is gated by `tests/styles_contract_test.ts`: every `--svd-*`
  token referenced must be declared **and used**; no colour literal outside the
  token block; every media query width must be one of
  `{480, 600, 900, 1100, 1410}`; every spacing value on the 4px grid; every
  `font-size` a type token; the two dark blocks byte-identical; no
  `position: static` on a framed surface (`.sidebar-section`,
  `.timeline-drawer`, `.card`, …); several rules are matched as literal text
  (the regexes quoted in the tasks below). Run that test after every CSS edit.
- Sentinel strings (`(none)`, `(none found)`, `(unknown)`,
  `(not yet
  extracted)`, `(reference needed)`) stay byte-identical in
  `lib/data/*`, `lib/constants.ts` choice values and `lib/filters.ts`. Only
  rendering changes.
- Owner decisions, already made: tab label **"Trials Radar"** (path stays
  `/timeline`); navbar title **hidden below 900px** with a scrollable tab row;
  absent cell values render as **an em dash in muted ink**.
- Copy rule: "cerebral small vessel disease (SVD)" on first use in a page's
  prose, "SVD" after. Data labels such as "SVD Population" and "Extreme-cSVD"
  are wire values and do not change.
- Every commit: `deno fmt` clean, message in the repo's imperative style, ending
  with the session's Co-Authored-By trailer.
- Do not `git add -A`; add the files each task names.

---

## Phase 1: Layout bugs

### Task 1: Reset `top` on the two un-stuck panels (L01)

**Files:**

- Modify: `assets/app.css:2328-2336` (`.sidebar-section` inside
  `@media (max-width: 900px)`)
- Modify: `assets/app.css:3556-3562` (`.timeline-drawer` inside
  `@media (max-width: 1100px)`)
- Test: `tests/styles_contract_test.ts:583,760`
- Test: `e2e/tests/filter-collapse.spec.ts`, `e2e/tests/timeline.spec.ts`

- [ ] **Step 1: Extend the contract-test regexes so they fail today**

In `tests/styles_contract_test.ts`, replace the `.sidebar-section` mobile
assertion (line 583) with:

```ts
assertMatch(
  css,
  /@media \(max-width: 900px\) \{[\s\S]*?\.sidebar-section \{\s*position: relative;\s*max-height: none;[\s\S]*?overflow-y: visible;\s*(?:\/\*[\s\S]*?\*\/\s*)?top: auto;\s*\}/,
);
```

and the `.timeline-drawer` assertion (line 760) with:

```ts
assertMatch(
  css,
  /@media \(max-width: 1100px\) \{[^}]*\.timeline-drawer \{[^}]*position: relative;\s*max-height: none;\s*overflow-y: visible;\s*(?:\/\*[\s\S]*?\*\/\s*)?top: auto;/s,
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test tests/styles_contract_test.ts --filter "stacked-navbar cap"` and
`--filter "sticky timeline drawers"` Expected: both FAIL on the new `top: auto`
requirement.

- [ ] **Step 3: Add `top: auto` to both resets**

In `assets/app.css`, after `overflow-y: visible;` inside the ≤900px
`.sidebar-section` block (line ~2335):

```css
/* A relative box still honours `top`. Without this reset the panel kept
   the sticky rule's `top: var(--svd-navbar-h)` and sat 264px below its
   slot at 390px, overlapping the readout and table controls by the same
   amount. */
top: auto;
```

Same declaration and comment (with "152px at 1000px" and "the plate" in place of
the numbers) after `overflow-y: visible;` in the ≤1100px `.timeline-drawer`
block (line ~3561).

- [ ] **Step 4: Run the contract test**

Run: `deno test tests/styles_contract_test.ts` Expected: PASS.

- [ ] **Step 5: Pin the rendered position in e2e**

In `e2e/tests/filter-collapse.spec.ts`, in the 390×700 test that asserts
`position: "relative"`, add:

```ts
await expect(sidebar).toHaveCSS("top", "auto");
// The panel starts where its grid slot starts: no leftover sticky offset.
const [panelTop, slotTop] = await Promise.all([
  sidebar.evaluate((el) => el.getBoundingClientRect().top),
  sidebar.evaluate((el) => el.parentElement!.getBoundingClientRect().top),
]);
expect(Math.abs(panelTop - slotTop)).toBeLessThanOrEqual(1);
```

In `e2e/tests/timeline.spec.ts`, in the drawer-open overflow sweep, for the 390
and 900 viewports add
`await expect(page.locator(".timeline-drawer")).toHaveCSS("top", "auto");`.

- [ ] **Step 6: Run the two specs**

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/filter-collapse.spec.ts tests/timeline.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts e2e/tests/filter-collapse.spec.ts e2e/tests/timeline.spec.ts
git commit -m "Reset top on the filter panel and drawer once they stop being sticky"
```

### Task 2: Put the trial drawer beside the radar (L02, D01, D02)

**Files:**

- Modify: `assets/app.css:3056` (the shared column rule) and the
  `=== TRIALS TIMELINE ===` section
- Modify: `islands/TrialsTimeline.tsx:423-428` (legend docstring)
- Modify: `CLAUDE.md` ("Timeline" section, the paragraph on `.timeline-main`)
- Test: `e2e/tests/timeline.spec.ts`

- [ ] **Step 1: Write the failing e2e assertion**

Add to `e2e/tests/timeline.spec.ts`:

```ts
test("an open record sits beside the plate at desktop width and above it when stacked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/timeline");
  await page.locator("g.drug").first().click();
  const drawer = page.locator(".timeline-drawer");
  const plate = page.locator(".timeline-main > .blueprint-frame");
  await expect(drawer).toBeVisible();
  const [d, p] = await Promise.all([drawer.boundingBox(), plate.boundingBox()]);
  expect(d!.x + d!.width).toBeLessThanOrEqual(p!.x + 1);
  expect(Math.abs(d!.y - p!.y)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 900, height: 900 });
  const [d2, p2] = await Promise.all([
    drawer.boundingBox(),
    plate.boundingBox(),
  ]);
  expect(d2!.y + d2!.height).toBeLessThanOrEqual(p2!.y + 1);
  expect(Math.round(d2!.width)).toBe(Math.round(p2!.width));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts -g "beside the plate"`
Expected: FAIL on the first `toBeLessThanOrEqual` (the drawer spans the full
width above the plate).

- [ ] **Step 3: Give `.timeline-main` its own row rule**

In `assets/app.css`, remove `.timeline-main,` from the selector list at line
3056 so that rule reads
`.phenogram-layout { display: flex; flex-direction: column; … }` (keep its
comment), and add directly above the `@media (max-width: 1100px)` block at line
~3092:

```css
/* The record beside the plate: drawer first (it is the first child), the
   framed scroller taking the rest. `flex-start`, not `stretch`, so the sticky
   drawer keeps its own height and can stick; the ≤1100px query below is
   what stacks the pair. The scroller needs `min-width: 0` or its 1072px
   plate sets the row's minimum and the drawer is pushed off the right edge. */
.timeline-main {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--svd-space-4);
}

.timeline-main > .blueprint-frame {
  flex: 1 1 auto;
  min-width: 0;
}
```

- [ ] **Step 4: Run the contract test and the spec**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts`
Expected: PASS, including the existing drawer-open overflow sweep at
390/900/1200/1440/1512.

- [ ] **Step 5: Correct the two documents**

Replace the docstring at `islands/TrialsTimeline.tsx:423-428` with:

```ts
/**
 * The key, rendered under the plate at every width -- the phenogram's
 * arrangement. It was a right-hand rail once; assets/app.css records why the
 * rail and its breakpoints went.
 */
```

In `CLAUDE.md`, "Timeline" section, the sentence beginning "and below 1100px
`.timeline-main`" stays true again; add before it: "`.timeline-main` is a flex
**row** of its own (drawer, then the framed scroller), not a member of the
phenogram's column rule --- folding it in there put the record above the plate."

- [ ] **Step 6: Commit**

```bash
git add assets/app.css islands/TrialsTimeline.tsx CLAUDE.md e2e/tests/timeline.spec.ts
git commit -m "Lay the trial record beside the radar rather than above it"
```

### Task 3: Shorten the navbar below 900px and re-measure the bands (L03, L04)

**Files:**

- Modify: `assets/app.css` — the `@media (max-width: 900px)` navbar block
  (~2400-2430) and the `@media (max-width: 600px)` block (~2436-2450)
- Modify: `routes/_app.tsx:128-146`
- Test: `tests/styles_contract_test.ts:606,610,817`
- Test: `e2e/tests/navigation.spec.ts`

- [ ] **Step 1: Write the failing e2e assertion**

Add to `e2e/tests/navigation.spec.ts`:

```ts
test("the navbar stays short on a phone and the tabs scroll as one row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map");
  const bar = page.locator(".navbar");
  const box = await bar.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(120);
  await expect(page.locator(".navbar-title")).toBeHidden();
  const nav = page.locator(".navbar-nav");
  await expect(nav).toHaveCSS("flex-wrap", "nowrap");
  // The active tab is scrolled into view on load.
  await expect(page.locator('.nav-link[aria-current="page"]')).toBeInViewport();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/navigation.spec.ts -g "stays short"`
Expected: FAIL on the height (234px today).

- [ ] **Step 3: Hide the title and make the tab row scroll**

Inside the existing `@media (max-width: 900px)` block in `assets/app.css` (the
one that sets `--svd-navbar-h: 14rem`), add after the `:root` rule:

```css
/* The 79-character running head wrapped to three lines here and the tabs
   to three rows, a 234px sticky bar on an 844px screen. The head is
   repeated in <title> and on the About hero, so the bar drops it and the
   tabs become one scrollable row. */
.navbar-inner {
  grid-template-rows: auto auto;
}

.navbar-inner > .navbar-title {
  display: none;
}

.navbar-inner > nav {
  grid-area: 2 / 1 / 2 / -1;
  min-width: 0;
}

.navbar-nav {
  flex-wrap: nowrap;
  justify-content: flex-start;
  overflow-x: auto;
  scrollbar-width: thin;
  scroll-snap-type: x proximity;
  padding-bottom: var(--svd-space-1);
}

.navbar-nav > li {
  flex: 0 0 auto;
  scroll-snap-align: start;
}
```

Delete the now-dead `.navbar-inner > .navbar-title { font-size: … }` rule in the
≤600px block (line ~2444).

- [ ] **Step 4: Scroll the active tab into view**

In `routes/_app.tsx`, after the `</nav>` closing tag, add an inline script using
the same `nonce` the `NO_FLASH` script uses:

```tsx
<script
  nonce={nonce}
  dangerouslySetInnerHTML={{
    __html:
      `(function(){var n=document.querySelector('.navbar-nav');var a=n&&n.querySelector('[aria-current="page"]');if(a&&n.scrollWidth>n.clientWidth)a.scrollIntoView({inline:'center',block:'nearest'});})();`,
  }}
/>;
```

(Look at how `NO_FLASH` is emitted at `routes/_app.tsx:22-28` and reuse its
nonce variable name exactly.)

- [ ] **Step 5: Measure the bar and set the bands**

Run `deno task build && deno serve -A --port 8000 _fresh/server.js` with the
e2e's `DASHBOARD_PASSPHRASE`/`DASHBOARD_SESSION_SECRET` from
`e2e/fixtures/auth.ts`, then in a Playwright script (or the Chrome tools) log in
and read `document.querySelector('.navbar').getBoundingClientRect().height` at
widths 1440, 1000, 900, 700, 600, 390 and 320. The tallest height inside each
band, rounded **up** to the next 0.5rem, becomes the token:

- `@media (max-width: 900px)` `:root { --svd-navbar-h: <measured>rem; }` (line
  ~2416, replaces `14rem`)
- `@media (max-width: 600px)` `:root { --svd-navbar-h: <measured>rem; }` (line
  ~2424, replaces `16.5rem`)

Update the derivation comment in the token block (`assets/app.css:377-427`) with
the new measurements and the method above. Update the three literal pins in
`tests/styles_contract_test.ts` (lines 606, 610 and the string at 817) to the
new values.

- [ ] **Step 6: Run the gates**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/navigation.spec.ts tests/about.spec.ts tests/filter-collapse.spec.ts tests/readout.spec.ts`
Expected: PASS, including the skip-link test at 700×800 and 390×844.

- [ ] **Step 7: Commit**

```bash
git add assets/app.css routes/_app.tsx tests/styles_contract_test.ts e2e/tests/navigation.spec.ts
git commit -m "Hide the running head and scroll the tabs below 900px"
```

### Task 4: Small placement fixes (L07, L13, L14, T06, T08)

**Files:**

- Modify: `assets/app.css:447-460` (z tokens), `:3323` (tooltip z), `:4612`
  (`.pipeline-sources`), `:2061` (hero padding), `:3971` (`.page-header h1`),
  the `=== NUMERIC ALIGNMENT ===` per-column section near `:1929`

- [ ] **Step 1: Add the float token and use it**

In the token block after `--svd-z-sticky: 1030;`:

```css
/* Floating panels that follow the pointer: above Leaflet's controls (800),
   below the sticky bar, so a tooltip near the top never paints over it. */
--svd-z-float: 900;
```

At `.timeline-tooltip` replace `z-index: var(--svd-z-sticky);` with
`z-index: var(--svd-z-float);`.

- [ ] **Step 2: Bring the refresh counts next to their labels**

On `.pipeline-sources` add `max-width: 40rem;`.

- [ ] **Step 3: Widen the Protein column**

Beside the `.data-table td.col-gene` rules (line ~1929) add:

```css
/* "Islet cell autoantigen 1-like protein" wrapped to four lines at the
   column's 117px minimum. */
.data-table td.col-protein {
  min-width: 10rem;
}
```

- [ ] **Step 4: Two hygiene edits**

`.about-hero .card-body { padding: var(--svd-space-6) 1.75rem; }` becomes
`padding: var(--svd-space-6) var(--svd-space-7);`. Delete
`margin-bottom: var(--svd-space-2);` from `.page-header h1` (the base heading
rule at line 713 already sets it).

- [ ] **Step 5: Run the gates**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts tests/about.spec.ts tests/genes-table.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css
git commit -m "Float the radar tooltip under the bar and tidy four placements"
```

## Phase 2: Type, contrast, focus and theme

### Task 5: Raise the type floor to 12px (R04)

**Files:**

- Modify: `assets/app.css:330` (`--svd-text-2xs`), `:1535`
  (`.readout-bar-label`)
- Test: `e2e/tests/readout.spec.ts`, `e2e/tests/about.spec.ts`

- [ ] **Step 1: Change the token and the bar label**

`--svd-text-2xs: 0.6875rem;` becomes `--svd-text-2xs: 0.75rem;` with the
comment:
`/* 12px: the reading floor. It was 11px, and drove every table column header. */`.
In `.readout-bar-label` replace `font-size: 9px;` with
`font-size: var(--svd-text-2xs);`.

- [ ] **Step 2: Run the gates and look**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/readout.spec.ts tests/about.spec.ts tests/genes-table.spec.ts tests/trials-table.spec.ts tests/timeline.spec.ts`
Expected: PASS. Then open `/genes` at 900px and confirm the 24 chromosome labels
under the bars are legible and not clipped; if a label clips, set
`.readout-bar-label { overflow: visible; }` and re-run `tests/readout.spec.ts`.

- [ ] **Step 3: Commit**

```bash
git add assets/app.css
git commit -m "Raise the smallest type step to 12px"
```

### Task 6: Fix the two AA failures and the disabled buttons (R05)

**Files:**

- Modify: `assets/app.css:4889-4895` (`.login-submit`), `:2013-2017` (current
  page), `:2019-2022` (disabled)
- Test: `e2e/tests/genes-table.spec.ts` (current page is the one different
  background), `e2e/tests/login.spec.ts`

- [ ] **Step 1: Change the fills**

`.login-submit`:
`border: 1px solid var(--svd-color-primary); background: var(--svd-color-primary);`
(hover stays `--svd-color-accent-text`).
`.pagination button[aria-current='page']`:
`background: var(--svd-color-primary); border-color: var(--svd-color-primary);`.
`.pagination button:disabled`: replace `opacity: 0.45;` with
`color: var(--svd-ink-muted); border-color: color-mix(in oklab, var(--svd-tint) 24%, transparent);`.

Update the comment above `.login-submit` ("solid accent fill") to "solid primary
fill --- the accent under `--svd-on-primary` measured 3.85:1 in light, below AA;
the primary measures 9.08:1."

- [ ] **Step 2: Run the gates**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/genes-table.spec.ts tests/login.spec.ts tests/theme.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add assets/app.css
git commit -m "Fill the login and current-page buttons with the primary, not the accent"
```

### Task 7: Focus parity for hover-only controls (A06, T05, D04)

**Files:**

- Modify: `assets/app.css:1025,1067,1287,1387,3469,4192,4574` (seven hover
  selectors), `:1718` (`th.sortable:hover`), `:3640`
  (`.phenogram-genes .tooltip-box:hover`), `:3685` (delete)
- Modify: `assets/CLAUDE.md` (the "no exceptions left" focus sentence)
- Test: `tests/styles_contract_test.ts`

- [ ] **Step 1: Write the failing contract test**

Add to `tests/styles_contract_test.ts`:

```ts
Deno.test("every control that lights on hover lights on focus-visible too", () => {
  const selectors = [
    ".theme-toggle",
    ".navbar-signout",
    ".sidebar-toggle",
    ".filter-option",
    ".timeline-drawer-close",
    ".pipeline-step-head",
    ".pipeline-apis summary",
    ".phenogram-genes .tooltip-box",
  ];
  for (const selector of selectors) {
    const escaped = selector.replace(
      /[.\s]/g,
      (c) => c === "." ? "\\." : "\\s+",
    );
    assertMatch(
      css,
      new RegExp(`${escaped}:hover,\\s*${escaped}:focus-visible\\s*\\{`),
      `${selector} lights on hover alone`,
    );
  }
  assertMatch(
    css,
    /\.data-table thead th\.sortable:has\(\.sort-button:focus-visible\)/,
  );
  // The one surviving focus-colour override (F40's phenogram tooltip) is gone.
  assert(!/\.tooltip-link-btn:focus-visible\s*\{[^}]*outline-color/.test(css));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
`deno test tests/styles_contract_test.ts --filter "lights on focus-visible"`
Expected: FAIL.

- [ ] **Step 3: Edit the selectors**

For each of the eight selectors, change the selector list of its `:hover` rule
to `X:hover,\nX:focus-visible {` (keep the declarations). For the sortable
header, change `.data-table thead th.sortable:hover {` to
`.data-table thead th.sortable:hover,\n.data-table thead th.sortable:has(.sort-button:focus-visible) {`.
Delete the rule at `:3685`
(`.phenogram-canvas .tooltip-pop .tooltip-link-btn:focus-visible { outline-color: … }`).

- [ ] **Step 4: Run the gates**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/phenogram.spec.ts tests/tooltips.spec.ts`
Expected: PASS.

- [ ] **Step 5: Fix the doc**

In `assets/CLAUDE.md`, the sentence "Focus reads `--svd-focus-*`, with no
exceptions left" is now true; add after it: "`tests/styles_contract_test.ts`
also requires every control that lights on `:hover` to light on
`:focus-visible`."

- [ ] **Step 6: Commit**

```bash
git add assets/app.css assets/CLAUDE.md tests/styles_contract_test.ts
git commit -m "Light every hover state on keyboard focus as well"
```

### Task 8: Token drift and muted values (T01–T04, T07, R07, R08)

**Files:**

- Modify: `assets/app.css:188` (`--svd-tooltip-bg`), both dark blocks (the two
  `--svd-tooltip-bg` lines), `:2311` (`.warning-card`), `:3345-3363` (drawer
  headings), `:3534` (`dd`), `:4019` (`.pipeline-tint-muted`), the four pipeline
  prose rules (`.pipeline-actions` ~4261, `.pipeline-quote` ~4729,
  `.pipeline-syncs-lead` ~4506, `.pipeline-error-hint` ~4300)
- Modify: `assets/CLAUDE.md`

- [ ] **Step 1: Apply the edits**

- `:root` — `--svd-tooltip-bg: var(--svd-bg-page);` →
  `--svd-tooltip-bg: var(--svd-ground);`. Delete the `--svd-tooltip-bg` line
  from **both** dark blocks (they must stay byte-identical; the contract test
  checks).
- `.warning-card` — replace `var(--svd-bg-card)` with `var(--svd-surface)` in
  its `color-mix`.
- `.timeline-drawer-head h2` — add `color: var(--svd-primary);` (matching
  `.pipeline-drawer-head h2` at `:4492`); rewrite the shared comment at `:3348`
  to: "same size, same weight. The two themed drawers take `--svd-primary`; the
  figure tooltip keeps the fixed `--svd-figure-heading` because it floats over
  the white plate."
- `.timeline-drawer-fields dd` — `color: var(--svd-ink-muted);` →
  `color: var(--svd-ink);`.
- `.pipeline-tint-muted` — `--svd-tint-ink: var(--svd-text-muted);` →
  `--svd-tint-ink: var(--svd-ink);`.
- Add `max-width: 70ch;` to `.pipeline-actions`, `.pipeline-quote`,
  `.pipeline-syncs-lead`, `.pipeline-error-hint`.

- [ ] **Step 2: Run the gates**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts tests/about.spec.ts tests/tooltips.spec.ts`
Expected: PASS.

- [ ] **Step 3: Fix the doc**

In `assets/CLAUDE.md`, where the one-step-further inks are described (6.44:1 and
5.57:1), add: "That is the light theme. In dark, `--svd-color-warn-ink` and
`--svd-color-ok-ink` resolve to the same step as their fills (amber-300,
green-400), which already clear AA on the dark ground; the distinction is
light-only."

- [ ] **Step 4: Commit**

```bash
git add assets/app.css assets/CLAUDE.md
git commit -m "Reconcile five token drifts and lift the drawer values out of muted ink"
```

### Task 9: Print stylesheet (A12)

**Files:**

- Modify: `assets/app.css` (append before the reduced-motion block at ~3865)
- Test: `tests/styles_contract_test.ts`

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("printing drops the chrome and un-clips the tables and plates", () => {
  assertMatch(css, /@media print \{[\s\S]*?\.navbar[\s\S]*?display: none;/);
  assertMatch(
    css,
    /@media print \{[\s\S]*?\.table-scroll,[\s\S]*?max-height: none;/,
  );
  // Framed surfaces may be un-stuck but never `static` (their marks detach).
  const block = css.slice(css.indexOf("@media print {"));
  assert(!/position: static/.test(block.slice(0, block.indexOf("\n}\n"))));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test tests/styles_contract_test.ts --filter printing` Expected: FAIL
(no print block).

- [ ] **Step 3: Add the block**

```css
/* === PRINT === */

/* The dashboard's point is two figures and two tables; printed, the sticky
   bar was an ink block and the scrollers cut each table to one screen. */
@media print {
  .skip-link,
  .navbar,
  .page-footer,
  .theme-toggle,
  .sidebar-toggle {
    display: none;
  }

  .sidebar-section,
  .timeline-drawer {
    position: relative;
    top: auto;
    max-height: none;
    overflow-y: visible;
  }

  .data-table thead {
    position: static;
  }

  .table-scroll,
  .timeline-scroll,
  .phenogram-scroll {
    max-height: none;
    overflow: visible;
  }
}
```

- [ ] **Step 4: Run the gates and commit**

Run: `deno test tests/styles_contract_test.ts` — PASS.

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Add a print stylesheet that drops the chrome and un-clips the tables"
```

### Task 10: Preload the navbar's face and name the theme-color tokens (T09, T10)

**Files:**

- Modify: `routes/_app.tsx:12-15,106-112`

- [ ] **Step 1: Edit**

Above `THEME_COLORS` add the comment:
`// Byte-identical to --svd-nav in each theme (assets/app.css, the two dark blocks); e2e/tests/theme.spec.ts fails if they diverge.`
Add a third
`<link rel="preload" … href="/fonts/BarlowCondensed-500-latin.woff2" …>` after
the 600 one (the navbar title and tabs render in 500).

- [ ] **Step 2: Run and commit**

Run:
`deno task check && deno test tests/routes_test.tsx && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/theme.spec.ts`

```bash
git add routes/_app.tsx
git commit -m "Preload the navbar's condensed face and name the theme-color tokens"
```

## Phase 3: Tables and readout

### Task 11: Render absent values as an em dash (R01)

**Files:**

- Create: `lib/sentinels.ts`, `components/Absent.tsx`
- Modify: `islands/GenesView.tsx` (COLUMNS, `TooltippedValues`,
  `ReferenceCitation`), `islands/TrialsView.tsx` (COLUMNS, `GeneticTargets`),
  `components/MapPopup.tsx` (`PopupValues`), `assets/app.css`
- Test: `tests/sentinels_test.ts` (new), `tests/components_test.tsx`,
  `e2e/tests/trials-table.spec.ts:213`

**Interfaces:**

- Produces: `isAbsent(value: string): boolean`,
  `ABSENT_SENTINELS: ReadonlySet<string>` in `lib/sentinels.ts`; `<Absent />`
  and `valueOrAbsent(value: string): ComponentChildren` in
  `components/Absent.tsx`.

- [ ] **Step 1: Write the failing unit test**

`tests/sentinels_test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { ABSENT_SENTINELS, isAbsent } from "../lib/sentinels.ts";

Deno.test("the five export sentinels are absent values", () => {
  for (
    const s of [
      "(none)",
      "(none found)",
      "(unknown)",
      "(not yet extracted)",
      "(reference needed)",
    ]
  ) {
    assert(isAbsent(s), s);
    assert(ABSENT_SENTINELS.has(s));
  }
  assert(isAbsent("  (unknown) "));
  assert(!isAbsent("None"));
  assert(!isAbsent("(none) SVS"));
  assertEquals(isAbsent(""), false);
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `deno test tests/sentinels_test.ts` — FAIL (module missing).

`lib/sentinels.ts`:

```ts
/**
 * The export's absent-value sentinels, as `pipeline/export/tables.py` emits
 * them. They stay in the data and in every filter choice value; only the
 * tables and popups render them differently (components/Absent.tsx).
 */
export const ABSENT_SENTINELS: ReadonlySet<string> = new Set([
  "(none)",
  "(none found)",
  "(unknown)",
  "(not yet extracted)",
  "(reference needed)",
]);

export function isAbsent(value: string): boolean {
  return ABSENT_SENTINELS.has(value.trim());
}
```

`components/Absent.tsx`:

```tsx
import type { ComponentChildren } from "preact";
import { isAbsent } from "../lib/sentinels.ts";

/** An absent cell value: an em dash, with words for assistive technology. */
export function Absent() {
  return (
    <span class="cell-absent">
      —<span class="visually-hidden">not recorded</span>
    </span>
  );
}

export function valueOrAbsent(value: string): ComponentChildren {
  return isAbsent(value) ? <Absent /> : value;
}
```

CSS, in `=== DATA TABLE ===`: `.cell-absent { color: var(--svd-ink-muted); }`.

- [ ] **Step 3: Route every cell through it**

`islands/GenesView.tsx`:

- Define
  `const plainCell = ({ getValue }: { getValue: () => unknown }) => valueOrAbsent(String(getValue() ?? ""));`
  and add `cell: plainCell` to the `chromosomalLocation`,
  `mendelianRandomization`, `sourceQuote` columns and any other plain accessor.
- `protein`:
  `cell: ({ row }) => isAbsent(row.original.protein) ? <Absent /> : <Tooltip …>{row.original.protein}</Tooltip>`.
- `gwasTrait`: add
  `cell: ({ row }) => <TooltippedValues values={row.original.gwasTrait} tooltipFor={() => null} />`.
- `TooltippedValues`: render
  `isAbsent(value) ? <Absent /> : <Tooltip content={tooltipFor(value)}>{value}</Tooltip>`
  per entry.
- `ReferenceCitation`: first line `if (isAbsent(pmid)) return <Absent />;`.
- `brainCellTypes` and `affectedPathway` cells: return `<Absent />` when
  `isAbsent(...)` before splitting.

`islands/TrialsView.tsx`: `GeneticTargets` returns `<Absent />` when
`isAbsent(value)`; add `cell: plainCell` (same helper) to `mechanismOfAction`,
`geneticEvidence`, `trialName`, `clinicalTrialPhase`, `svdPopulation`,
`svdPopulationDetails`, `targetSampleSize`, `primaryOutcome`, `sponsorType`;
`registryId` wraps like `protein`. `estimatedCompletionDate` is handled in
Task 15.

`components/MapPopup.tsx` `PopupValues`: map each value through `valueOrAbsent`.

- [ ] **Step 4: Re-pin and run**

`e2e/tests/trials-table.spec.ts:213`: `expect(sizes[0].trim()).toMatch(/^—/);`
and update the comment ("renders as an em dash"). Add to
`tests/components_test.tsx` a render of `<GenesView />` asserting
`class="cell-absent"` appears and `(none found)` does not appear inside a `<td`.

Run:
`deno task check && deno task test:coverage && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/genes-table.spec.ts tests/trials-table.spec.ts tests/tooltips.spec.ts tests/map.spec.ts tests/genes-filters.spec.ts tests/trials-filters.spec.ts`
Expected: PASS; filters still match on the sentinel values.

- [ ] **Step 5: Commit**

```bash
git add lib/sentinels.ts components/Absent.tsx islands/GenesView.tsx islands/TrialsView.tsx components/MapPopup.tsx assets/app.css tests/sentinels_test.ts tests/components_test.tsx e2e/tests/trials-table.spec.ts
git commit -m "Render absent cell values as an em dash instead of the export sentinel"
```

### Task 12: Print choice labels in the Active Filters line (R02)

**Files:**

- Modify: `lib/filters.ts:227-241`, `components/CheckboxFilter.tsx:36-38`
- Test: `tests/filters_test.ts:223-250`, `e2e/tests/trials-filters.spec.ts`

- [ ] **Step 1: Failing test**

Add to `tests/filters_test.ts`:

```ts
Deno.test("buildFilterSummary prints choice labels, not wire values", () => {
  const summary = buildFilterSummary([
    {
      label: "Clinical Trial Phase",
      value: ["(unknown)", "I"],
      choices: [
        { label: "Show All", value: "all" },
        { label: "Clinical Trial Phase I", value: "I" },
        { label: "Phase not stated", value: "(unknown)" },
      ],
    },
  ]);
  assertEquals(summary, [
    "Clinical Trial Phase: Phase not stated, Clinical Trial Phase I",
  ]);
});
```

- [ ] **Step 2: Implement**

In `lib/filters.ts`:

```ts
interface FilterSummarySpec {
  label: string;
  value: readonly string[];
  mode?: FilterMode;
  /** When given, each value is printed as its choice's label. */
  choices?: readonly FilterChoice[];
}

export function buildFilterSummary(
  specs: readonly FilterSummarySpec[],
): string[] {
  return specs
    .filter((spec) => isFilterActive(spec.value, spec.mode))
    .map((spec) => {
      const named = spec.value.map((value) =>
        spec.choices?.find((choice) => choice.value === value)?.label ?? value
      );
      return `${spec.label}: ${named.join(", ")}`;
    });
}
```

(import `FilterChoice` from `./types.ts`). In `components/CheckboxFilter.tsx`:
`checkboxFilterSummary = ({ label, selected: value, mode, choices }) => ({ label, value, mode, choices });`.

- [ ] **Step 3: Run and re-pin**

Run: `deno test tests/filters_test.ts tests/components_test.tsx`. Then grep
`e2e/tests/*filters.spec.ts` for `expectSummary(` strings that name a wire value
(`(unknown)`, `I`, omics long names) and change them to the choice labels
("Phase not stated", "Clinical Trial Phase I"). Run both filter specs.

- [ ] **Step 4: Commit**

```bash
git add lib/filters.ts components/CheckboxFilter.tsx tests/filters_test.ts e2e/tests/genes-filters.spec.ts e2e/tests/trials-filters.spec.ts
git commit -m "Print filter choice labels in the Active Filters line"
```

### Task 13: Display the omics wire form as "TWAS (cross tissue)" (R03)

**Files:**

- Modify: `lib/filters.ts:42` (beside `omicsType`), `islands/GenesView.tsx`
  (`TooltippedValues` gets a `format` prop; the omics column passes it)
- Test: `tests/filters_test.ts`

- [ ] **Step 1: Failing test**

```ts
Deno.test("formatOmicsValue keeps the type readable and the detail in parentheses", () => {
  assertEquals(formatOmicsValue("TWAS;cross tissue"), "TWAS (cross tissue)");
  assertEquals(
    formatOmicsValue("Proteomics;plasma, CSF"),
    "Proteomics (plasma, CSF)",
  );
  assertEquals(formatOmicsValue("TWAS"), "TWAS");
  assertEquals(formatOmicsValue("(none found)"), "(none found)");
});
```

- [ ] **Step 2: Implement**

```ts
/** The wire form `Type;detail` as the cell shows it: `Type (detail)`. */
export function formatOmicsValue(value: string): string {
  const semicolon = value.indexOf(";");
  if (semicolon === -1) return value.trim();
  const detail = value.slice(semicolon + 1).trim();
  const type = value.slice(0, semicolon).trim();
  return detail ? `${type} (${detail})` : type;
}
```

`TooltippedValues` takes `format?: (value: string) => string` and renders
`{(format ?? identity)(value)}` as the trigger text; the omics column passes
`format={formatOmicsValue}`.

- [ ] **Step 3: Run, re-pin, commit**

Run:
`deno test tests/filters_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/tooltips.spec.ts tests/genes-table.spec.ts`.
If a spec pinned `TWAS;cross tissue`, change it to the new text.

```bash
git add lib/filters.ts islands/GenesView.tsx tests/filters_test.ts e2e/tests/tooltips.spec.ts
git commit -m "Show omics evidence as type and detail, not the wire form"
```

### Task 14: One count, controls above the table, one page size (R06, A03, L09, L10)

**Files:**

- Modify: `components/DensityReadout.tsx:92-95`,
  `components/TableShell.tsx:285-322,440-447`, `islands/TrialsView.tsx:237`
- Test: `e2e/tests/readout.spec.ts:70`, `e2e/tests/trials-table.spec.ts:25-60`,
  `e2e/tests/genes-table.spec.ts`

- [ ] **Step 1: Edit**

- `DensityReadout`: delete `<em>{shown} of {total}</em>` from the
  `.readout-dist` label; drop `shown`/`total` from the props if nothing else
  reads them (keep them for the visually-hidden list).
- `TableShell`: move the whole `<div class="table-controls">…</div>` block to
  after `<div class="filter-message" …>…</div>`, directly before the
  `.blueprint-frame`. Add `role="status"` to the pagination `<span>`.
- `TrialsView`: `pageSize: 25` → `pageSize: 10`.

- [ ] **Step 2: Re-pin**

- `readout.spec.ts:70`: delete the `em` assertion (the stat value assertion
  above it covers the count).
- `trials-table.spec.ts`: rows `toHaveCount(10)`, `Showing 1–10 of ${TOTAL}`,
  `pageSizeSelect` value `"10"`, first button list
  `["Previous","1","2","3","4","5","6","7","Next"]`; turn "a smaller page size
  adds pages" into "a larger page size removes pages" selecting `"25"` and
  expecting `["Previous","1","2","3","4","5","Next"]`. Update the count
  comments.
- Any spec that asserted the controls' position relative to the banner: adjust.

- [ ] **Step 3: Run and commit**

Run:
`deno test tests/components_test.tsx && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/readout.spec.ts tests/trials-table.spec.ts tests/genes-table.spec.ts tests/trials-filters.spec.ts`

```bash
git add components/DensityReadout.tsx components/TableShell.tsx islands/TrialsView.tsx e2e/tests/readout.spec.ts e2e/tests/trials-table.spec.ts
git commit -m "Count the result set once, put the controls by the table, page both tables by 10"
```

### Task 15: Format completion dates (R09)

**Files:**

- Modify: `lib/constants.ts:56-71`, `islands/TrialsView.tsx`
  (`estimatedCompletionDate` cell), `components/MapPopup.tsx`
  (`completionDates`)
- Test: `tests/constants_test.ts` (create if absent),
  `e2e/tests/trials-table.spec.ts`, `e2e/tests/map.spec.ts`

- [ ] **Step 1: Failing test**

```ts
import { formatMonthYear } from "../lib/constants.ts";
Deno.test("formatMonthYear renders M/YYYY as Mon YYYY and leaves anything else alone", () => {
  assertEquals(formatMonthYear("7/2028"), "Jul 2028");
  assertEquals(formatMonthYear("12/2026"), "Dec 2026");
  assertEquals(formatMonthYear(" 01/2027 "), "Jan 2027");
  assertEquals(formatMonthYear("(unknown)"), "(unknown)");
  assertEquals(formatMonthYear("13/2028"), "13/2028");
});
```

- [ ] **Step 2: Implement**

```ts
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** The trial table's M/YYYY completion dates as "Jul 2028"; other text verbatim. */
export function formatMonthYear(value: string): string {
  const match = /^(0?[1-9]|1[0-2])\/(\d{4})$/.exec(value.trim());
  if (!match) return value;
  return MONTH_YEAR_FORMAT.format(
    new Date(Date.UTC(Number(match[2]), Number(match[1]) - 1, 1)),
  );
}
```

Cell:
`cell: ({ row }) => valueOrAbsent(formatMonthYear(row.original.estimatedCompletionDate))`.
Popup: `completionDates.map(formatMonthYear)` before `PopupValues`.

- [ ] **Step 3: Run, re-pin, commit**

Run the unit test, then `tests/trials-table.spec.ts` and `tests/map.spec.ts`;
change any pinned `M/YYYY` text to the new form.

```bash
git add lib/constants.ts islands/TrialsView.tsx components/MapPopup.tsx tests/constants_test.ts e2e/tests/trials-table.spec.ts e2e/tests/map.spec.ts
git commit -m "Format estimated completion dates as month and year"
```

### Task 16: Column and legend labels, trait descriptions (R11, R12, R13)

**Files:**

- Modify: `islands/GenesView.tsx:49-61` (header group), `:291` and
  `islands/TrialsView.tsx:188` (legends), `lib/types.ts:357`
  (`FilterChoice.description?`), `lib/constants.ts:83-93`,
  `components/CheckboxFilter.tsx`
- Test: `e2e/tests/genes-table.spec.ts:28`, `tests/components_test.tsx:404,414`,
  `tests/filters_test.ts:226,240,246`,
  `e2e/tests/genes-filters.spec.ts:20,43,52,156,169`,
  `e2e/tests/trials-filters.spec.ts:19,46,51`,
  `e2e/tests/filter-collapse.spec.ts:15`

- [ ] **Step 1: Rename**

Group header `"Evidence From Omics Studies"` → `"Genetic and Omics Evidence"`.
Legends `"Mendelian Randomization Performed?"` →
`"Mendelian randomization performed"`, `"Genetic Evidence?"` →
`"Genetic evidence"`. Update every pinned string listed under Test above.

- [ ] **Step 2: Descriptions**

`lib/types.ts`: add `description?: string;` to `FilterChoice`.
`GWAS_TRAIT_CHOICES`:
`...vocabulary.traits.map((trait) => ({ label: trait.label, value: trait.key, description: trait.name }))`.
`CheckboxFilter` option:

```tsx
<label class="filter-option" key={choice.value} title={choice.description}>
  <input … />
  <span>
    {choice.label}
    {choice.description && <span class="visually-hidden">, {choice.description}</span>}
  </span>
</label>
```

Add to `tests/components_test.tsx` a render of `<GenesView />` asserting the
string `class="visually-hidden">,` followed by the first trait's `name` from
`lib/vocabulary.json` appears.

- [ ] **Step 3: Run and commit**

Run:
`deno task check && deno task test:coverage && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/genes-table.spec.ts tests/genes-filters.spec.ts tests/trials-filters.spec.ts tests/filter-collapse.spec.ts`

```bash
git add islands/GenesView.tsx islands/TrialsView.tsx lib/types.ts lib/constants.ts components/CheckboxFilter.tsx tests/components_test.tsx tests/filters_test.ts e2e/tests/genes-table.spec.ts e2e/tests/genes-filters.spec.ts e2e/tests/trials-filters.spec.ts e2e/tests/filter-collapse.spec.ts
git commit -m "Name the evidence group and legends plainly and expand the trait abbreviations"
```

### Task 17: Disclosure state, group counts, persisted collapse (A01, A02, A04)

**Files:**

- Modify: `components/Tooltip.tsx:139-147,195-203`,
  `components/CheckboxFilter.tsx:70-78`, `components/FilterPanel.tsx:36`
- Test: `tests/components_test.tsx`, `e2e/tests/tooltips.spec.ts`,
  `e2e/tests/filter-collapse.spec.ts`

- [ ] **Step 1: Tooltip**

Add `const [open, setOpen] = useState(false);` in `Tooltip`; in `onToggle`,
`setOpen(event.newState === "open")`. On the trigger button add
`aria-expanded={open}` and `aria-controls={popoverId}`. e2e: in
`tooltips.spec.ts`, after hovering a trigger,
`await expect(trigger).toHaveAttribute("aria-expanded", "true")` and `"false"`
after Escape.

- [ ] **Step 2: Group count**

In the legend, after the visible label:
`{!showingAll && <span class="visually-hidden">, {activeCount} selected</span>}`.
Unit test: render
`<CheckboxFilter label="X" choices={…} selected={["a"]} onChange={() => {}} />`
and assert `, 1 selected` appears; with `selected={["all"]}` it does not.

- [ ] **Step 3: Persist collapse**

```tsx
const STORAGE_KEY = "svd-filters-collapsed";
const [collapsed, setCollapsed] = useState(false);
useEffect(() => {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
  } catch { /* blocked storage */ }
}, []);
const toggle = () =>
  setCollapsed((value) => {
    const next = !value;
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch { /* blocked storage */ }
    return next;
  });
```

e2e (`filter-collapse.spec.ts`): collapse on `/genes`, `page.goto("/trials")`,
expect `.layout-sidebar` to have class `is-collapsed`.

- [ ] **Step 4: Run and commit**

Run:
`deno task check && deno task test:coverage && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/tooltips.spec.ts tests/filter-collapse.spec.ts`

```bash
git add components/Tooltip.tsx components/CheckboxFilter.tsx components/FilterPanel.tsx tests/components_test.tsx e2e/tests/tooltips.spec.ts e2e/tests/filter-collapse.spec.ts
git commit -m "Announce tooltip state and group counts, and remember the collapsed rail"
```

### Task 18: A way out of the empty state (R18)

**Files:**

- Modify: `components/TableShell.tsx` (props + empty state at ~398),
  `islands/GenesView.tsx`, `islands/TrialsView.tsx`
- Test: `e2e/tests/genes-table.spec.ts:225-235`

- [ ] **Step 1: Failing e2e**

After the existing "No rows match" assertion in `genes-table.spec.ts`, add:

```ts
await page.getByRole("button", { name: "Clear all filters" }).click();
await expect(rows(page)).toHaveCount(10);
await expect(page.getByRole("searchbox", { name: "Search genes" })).toHaveValue(
  "",
);
```

- [ ] **Step 2: Implement**

`TableShellProps` gains `onClearFilters?: () => void`. Empty state:

```tsx
<div class="empty-state">
  No rows match the current filters.
  {onClearFilters && (
    <button
      type="button"
      class="empty-state-clear"
      onClick={() => {
        setSearchInput("");
        table.setGlobalFilter("");
        onClearFilters();
      }}
    >
      Clear all filters
    </button>
  )}
</div>;
```

CSS: `.empty-state-clear { margin-left: var(--svd-space-3); }` plus the
line-drawing button treatment the pagination buttons use (copy their
border/padding declarations). Each island passes
`onClearFilters={() => { setMr(YES_NO_CHOICES.map((c) => c.value)); setGwas([SHOW_ALL]); setOmics([SHOW_ALL]); }}`
(Genes) and the five-setter equivalent (Trials).

- [ ] **Step 3: Run and commit**

Run:
`deno task check && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/genes-table.spec.ts tests/trials-table.spec.ts`

```bash
git add components/TableShell.tsx islands/GenesView.tsx islands/TrialsView.tsx assets/app.css e2e/tests/genes-table.spec.ts
git commit -m "Offer a clear-all button when no row matches"
```

## Phase 4: About page and copy

### Task 19: About page layout and rows (L05, L06, L08, R10, B10, D03)

**Files:**

- Modify: `routes/index.tsx` (KPIS label, INFO_ROWS "How to Cite", the hero
  markup, the banner, the comment at :232 and :256), `components/Page.tsx` (drop
  `banner`), `components/PipelineSyncs.tsx:14-17`, `islands/CLAUDE.md` (the
  "directly above" sentence), `assets/app.css` (hero grid)
- Test: `e2e/tests/about.spec.ts:14,22`, `tests/routes_test.tsx:136`,
  `tests/components_test.tsx:152`

- [ ] **Step 1: Markup**

- `KPIS`: `label: "Publications"`. Re-pin `about.spec.ts:14` and
  `routes_test.tsx:136`.
- "How to Cite" row: add `pending: true`.
- Hero body: wrap the badge and `<h1>` in
  `<div class="about-hero-head">…</div>`, keep `<p class="about-lede">` and
  `<section class="about-kpis">` as siblings.
- Banner: remove the `banner={…}` prop; render the same
  `<div class="card warning-card about-warning">` as the first child inside
  `<Page contained header={…}>`. Remove `banner` from `Page`'s props and JSX;
  delete the `banner=` case in `tests/components_test.tsx:152`.
- Comment at `:232`: "migration 008" → "migration 009 (the run report column)".
- Comment at `:256` and `components/PipelineSyncs.tsx:14-17` and
  `islands/CLAUDE.md`: "sits directly above Data Sources" → "sits above the
  two-column grid whose right column is Data Sources, the panel whose names it
  echoes".

- [ ] **Step 2: CSS**

```css
/* Two columns at desktop: heading left, lede right, the totals row under
   both. The 24ch heading and 62ch lede left the right half of the card
   empty. */
@media (min-width: 900px) {
  .about-hero .card-body {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    column-gap: var(--svd-space-7);
    align-items: end;
  }

  .about-hero .about-kpis {
    grid-column: 1 / -1;
  }

  .about-lede {
    max-width: none;
  }
}
```

- [ ] **Step 3: Run and commit**

Run:
`deno test tests/styles_contract_test.ts tests/routes_test.tsx tests/components_test.tsx && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/about.spec.ts tests/navigation.spec.ts`
Expected: PASS, including the four totals on one line at 1440/900/600/380.

```bash
git add routes/index.tsx components/Page.tsx components/PipelineSyncs.tsx islands/CLAUDE.md assets/app.css e2e/tests/about.spec.ts tests/routes_test.tsx tests/components_test.tsx
git commit -m "Fill the About hero, move the notice under it, and correct three comments"
```

### Task 20: Copy and the tab rename (R14–R17)

**Files:**

- Modify: `lib/constants.ts:54`, `routes/timeline.tsx:15-16`,
  `routes/genes.tsx:10-20`, `routes/map.tsx:10`, `routes/login.tsx:69-72`,
  `islands/TrialsMap.tsx:30-31`, `README.md:192,257`
- Test: `e2e/tests/navigation.spec.ts:15`, `e2e/tests/map.spec.ts` (date badge
  text)

- [ ] **Step 1: Edit**

- `TABS`: `label: "Trials Radar"`. `routes/timeline.tsx`:
  `title="Trials Radar"`, description "Planned and ongoing cerebral small vessel
  disease (SVD) trials, arranged by target population and trial phase." README
  headings "Trials Radar (`/timeline`)" and the tree entry.
- `routes/genes.tsx` description: "Genes implicated in cerebral small vessel
  disease (SVD), with the GWAS, omics and monogenic evidence supporting each
  one." Tips: "Elements with a grey background have tooltips. Hover over or
  activate them to see additional information." and "Activate a highlighted
  element to see details and reach external links via the link button in the
  tooltip."
- `routes/map.tsx` description: "Facility locations for the registered cerebral
  small vessel disease (SVD) trials."
- `routes/login.tsx` lede: "…for cerebral small vessel disease (SVD)."
- `TrialsMap`: `GENERATED_LABEL = formatLongDate(…)`; render
  `Locations resolved {GENERATED_LABEL ?? "· date unavailable"}` — check
  `map.spec.ts` for the badge text it pins and keep the dated form unchanged.
- `navigation.spec.ts:15`: `label: "Trials Radar", heading: "Trials Radar"`.

- [ ] **Step 2: Run and commit**

Run:
`deno task check && deno test tests/routes_test.tsx && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/navigation.spec.ts tests/map.spec.ts tests/login.spec.ts tests/timeline.spec.ts`

```bash
git add lib/constants.ts routes/timeline.tsx routes/genes.tsx routes/map.tsx routes/login.tsx islands/TrialsMap.tsx README.md e2e/tests/navigation.spec.ts
git commit -m "Rename the radar tab and name the disease once per page"
```

### Task 21: Small accessibility fixes (A07–A11)

**Files:**

- Modify: `islands/ThemeToggle.tsx:74-76`,
  `islands/PipelineRun.tsx:66-75,508-522`, `components/PipelineSyncs.tsx:61`,
  `components/DensityReadout.tsx:76,92`, `routes/_app.tsx:120-122`,
  `components/IcmLogo.tsx:9-15`
- Test: `tests/components_test.tsx`, `tests/pipeline_widget_test.tsx`,
  `e2e/tests/theme.spec.ts`

- [ ] **Step 1: Edit**

- `ThemeToggle`: `const hint = theme === null ? "Switch theme" : \`Switch to
  ${next} theme\`;`. (`theme.spec.ts` reads the label after hydration; it still
  passes.)
- `FieldIcon`: remove `title={label}`. Head-meta chips: remove
  `title={effort.label}` and `title={prompt.label}`; the visible text already
  names them.
- `PipelineSyncs`: `<span class="pipeline-sync-name">` →
  `<h3 class="pipeline-sync-name">`; add
  `.pipeline-sync-name { margin: 0; font-size: inherit; }` if the base `h3` rule
  changes its size.
- `DensityReadout`: give the visible label an `id` (`${axisLabel}` slugified)
  and replace `aria-label={axisLabel}` on the `<section>` with `aria-labelledby`
  naming it.
- `IcmLogo`: accept `decorative?: boolean`; when set render `aria-hidden="true"`
  and no `aria-label`. `routes/_app.tsx`:
  `<a class="navbar-brand" href="/" aria-label="Home"><IcmLogo decorative /></a>`.

- [ ] **Step 2: Run and commit**

Run:
`deno task check && deno test tests/components_test.tsx tests/pipeline_widget_test.tsx tests/routes_test.tsx && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/theme.spec.ts tests/about.spec.ts tests/readout.spec.ts tests/navigation.spec.ts`

```bash
git add islands/ThemeToggle.tsx islands/PipelineRun.tsx components/PipelineSyncs.tsx components/DensityReadout.tsx routes/_app.tsx components/IcmLogo.tsx
git commit -m "Name the home link, un-double the readout and icon labels, and make refresh names headings"
```

## Phase 5: Figures and map

### Task 22: Phenogram diagnostics, neutral sample pill, skip-figure links (L11, B04, A05)

**Files:**

- Modify: `islands/Phenogram.tsx:296-297,308-314,360-371`,
  `islands/TrialsTimeline.tsx` (before the `.blueprint-frame` at ~1012; the
  key's `<div class="timeline-legend">` gets `id="timeline-key"`),
  `assets/app.css` (`.phenogram-unplaced`, `.phenogram-pill-sample`,
  `.skip-figure`)
- Test: `e2e/tests/phenogram.spec.ts`, `e2e/tests/timeline.spec.ts`

- [ ] **Step 1: Failing e2e**

```ts
test("a keyboard user can skip the figure to its key", async ({ page }) => {
  await page.goto("/timeline");
  const skip = page.getByRole("link", { name: "Skip the figure" });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await skip.press("Enter");
  await expect(page.locator("#timeline-key")).toBeInViewport();
});
```

(Same for `/phenogram` with `#phenogram-key`.)

- [ ] **Step 2: Implement**

Both islands, immediately before their `.blueprint-frame`:
`<a class="skip-figure" href="#timeline-key">Skip the figure</a>` /
`#phenogram-key`; the key wrappers get the ids. CSS:

```css
/* In flow and clipped until focused, so it is the first stop before the
   figure's hundred markers and visible only to the reader who needs it. */
.skip-figure:not(:focus) {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.skip-figure:focus {
  display: inline-block;
  padding: var(--svd-space-1) var(--svd-space-2);
}
```

Phenogram: move the `LAYOUT.unplaced` paragraph out of `.phenogram-scroll` to
just after `.blueprint-frame`, lead "Not placed on the figure (no hg38 band for
the location): …", and `.phenogram-unplaced { color: var(--svd-text-muted); }`.
Replace `const samplePill = families[0].family;` and the inline style with
`class="phenogram-pill phenogram-pill-sample"` and CSS
`.phenogram-pill-sample { background: var(--svd-tint-base); border-color: var(--svd-border-strong); }`
(use whichever strong border token `assets/CLAUDE.md` names).

- [ ] **Step 3: Run and commit**

Run:
`deno test tests/styles_contract_test.ts && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/phenogram.spec.ts tests/timeline.spec.ts`

```bash
git add islands/Phenogram.tsx islands/TrialsTimeline.tsx assets/app.css e2e/tests/phenogram.spec.ts e2e/tests/timeline.spec.ts
git commit -m "Let keyboard users skip each figure, and neutralise the phenogram's sample pill"
```

### Task 23: Map failure inside the map box (L12, B05)

**Files:**

- Modify: `islands/TrialsMap.tsx:385-395,425-441`
- Test: `e2e/tests/map.spec.ts` (no change expected),
  `tests/components_test.tsx` if it renders the island

- [ ] **Step 1: Implement**

`const [loadError, setLoadError] = useState<string | null>(null);`. In the
catch: `setLoadError(error instanceof Error ? error.message : String(error));`
and delete the `console.error`. Render:

```tsx
{
  loadError
    ? (
      <div class="map-error" role="alert">
        The interactive map could not be loaded ({loadError}). The trial
        facility list remains available to assistive technologies.
      </div>
    )
    : (
      <div
        ref={containerRef}
        class="trials-map"
        role="application"
        aria-label="Interactive map of trial facility locations"
      />
    );
}
```

Give `.map-error` the container's `min-height` (`min(700px, 75vh)`, see
`.map-container`) so the page does not jump.

- [ ] **Step 2: Run and commit**

Run:
`deno task check && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/map.spec.ts`

```bash
git add islands/TrialsMap.tsx assets/app.css
git commit -m "Show the map's failure where the map would be"
```

### Task 24: The unknown-mechanism colour lives in the encoding (T11)

**Files:**

- Modify: `lib/timeline_encoding.json` (top-level `unknownMechanism`),
  `lib/timeline.ts:441,508`, `scripts/timeline_figure.py:110,810`
- Test: `tests/timeline_encoding_test.ts`,
  `tests/scripts/test_timeline_figure.py`

- [ ] **Step 1: Failing test**

```ts
Deno.test("the unknown-mechanism colour is encoded once and is no family's colour", () => {
  assertMatch(encoding.unknownMechanism, /^#[0-9a-f]{6}$/i);
  assert(
    !Object.values(encoding.mechanisms).includes(encoding.unknownMechanism),
  );
});
```

- [ ] **Step 2: Implement**

JSON: add `"unknownMechanism": "#888888"` after `"mechanisms"` (with a
`$comment` sibling if the file's convention uses one). TS: replace both
`?? "#888888"` with `?? enc.unknownMechanism`. Python: delete `FALLBACK_COLOR`
and at line 810 use `encoding["unknownMechanism"]`; add to
`tests/scripts/test_timeline_figure.py` an assertion that the loaded encoding
has the key.

- [ ] **Step 3: Run and commit**

Run:
`deno task test:coverage && uv run pytest tests/scripts && uv run ruff check . && uv run ty check`

```bash
git add lib/timeline_encoding.json lib/timeline.ts scripts/timeline_figure.py tests/timeline_encoding_test.ts tests/scripts/test_timeline_figure.py
git commit -m "Read the unknown-mechanism colour from the encoding in both renderers"
```

## Phase 6: Bugs outside the UI

### Task 25: Leave dev-server responses uncompressed (B01)

**Files:**

- Modify: `server/compression.ts` (the middleware body), `CLAUDE.md` (the
  `compression()` paragraph)
- Test: `tests/compression_server_test.ts`

- [ ] **Step 1: Failing test**

```ts
Deno.test("the dev server's responses are left alone", async () => {
  const next = () => response(BODY, { "Content-Type": "text/html" });
  // deno-lint-ignore no-explicit-any
  const res = await compression()(
    { req: gzipRequest(), next, config: { mode: "development" } } as any,
  );
  assertEquals(res.headers.get("Content-Encoding"), null);
});
```

- [ ] **Step 2: Implement**

At the top of the returned middleware:

```ts
// Vite's dev pipeline transforms the HTML after this middleware runs and
// treats the gzip bytes as text; the browser then reports
// ERR_CONTENT_DECODING_FAILED and never fires `load`. Production is the
// only mode that ships bundles worth compressing anyway.
if (ctx.config?.mode === "development") return ctx.next();
```

`CLAUDE.md`: append to the `compression()` paragraph: "It steps aside in
development mode: under Vite the gzip body arrived corrupt and Chromium never
reached `load`."

- [ ] **Step 3: Verify for real**

Run: `deno test tests/compression_server_test.ts`, then `deno task dev` and
`curl -s --compressed http://127.0.0.1:5173/login | head -c 100` — expect HTML,
not an empty body. Stop the server.

```bash
git add server/compression.ts tests/compression_server_test.ts CLAUDE.md
git commit -m "Skip compression under the Vite dev server"
```

### Task 26: Sort completion dates without TanStack internals (B02)

**Files:**

- Modify: `lib/sorting.ts:15-37`, `islands/TrialsView.tsx:149-160`
- Test: `tests/table_sorting_test.ts:130-157`,
  `e2e/tests/trials-table.spec.ts:220-235`

- [ ] **Step 1: Rewrite the unit tests**

Replace the `descending` test (lines 151-157) with:

```ts
// Direction is TanStack's: it negates the comparator and keeps
// `sortUndefined: "last"` rows last either way, so the helper compares
// dates only.
assertEquals(
  ["1/2027", "5/2030"].sort((a, b) => -compareCompletionDates(a, b)),
  ["5/2030", "1/2027"],
);
```

and drop the third argument everywhere.

- [ ] **Step 2: Implement**

`compareCompletionDates(a: string, b: string): number` — same body without the
`descending` branches (a valid date sorts before an invalid one; two invalid
compare by `localeCompare`). In `TrialsView`:

```ts
column.accessor(
  (row) => completionDateKey(row.estimatedCompletionDate) === null ? undefined : row.estimatedCompletionDate,
  {
    id: "estimatedCompletionDate",
    header: "Estimated Completion Date",
    sortUndefined: "last",
    sortFn: (rowA, rowB) => compareCompletionDates(rowA.original.estimatedCompletionDate, rowB.original.estimatedCompletionDate),
    cell: ({ row }) => valueOrAbsent(formatMonthYear(row.original.estimatedCompletionDate)),
  },
),
```

Note in a comment that global search no longer matches a non-date completion
value; the cell renders it regardless.

- [ ] **Step 3: Run and commit**

Run:
`deno task check && deno task test:coverage && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/trials-table.spec.ts`

```bash
git add lib/sorting.ts islands/TrialsView.tsx tests/table_sorting_test.ts
git commit -m "Keep unknown completion dates last with sortUndefined instead of the atom store"
```

### Task 27: `lib/format.ts` (B03)

**Files:**

- Create: `lib/format.ts`
- Modify: `lib/pipeline_display.ts:223-245`, `islands/GenesView.tsx:41`,
  `islands/TrialsMap.tsx:14`, `components/PipelineSyncs.tsx:34`,
  `components/ApiList.tsx:15` (only if they use the two helpers)

- [ ] **Step 1: Move**

Cut `formatCount` and `formatConfidence` (with their doc comments) into
`lib/format.ts`; in `pipeline_display.ts` add
`export { formatConfidence, formatCount } from "./format.ts";` and import them
there for internal use. `GenesView` and `TrialsMap` import from
`../lib/format.ts`.

- [ ] **Step 2: Prove the bundle shrank**

Run: `deno task build` and compare the `GenesView` island chunk size in
`_fresh/` before and after (`ls -l _fresh/client/**/GenesView*` or the build's
printed sizes); expect a drop of roughly the encoding's 9KB.

- [ ] **Step 3: Run and commit**

Run: `deno task check && deno task test:coverage`

```bash
git add lib/format.ts lib/pipeline_display.ts islands/GenesView.tsx islands/TrialsMap.tsx
git commit -m "Move the two number formatters out of the pipeline encoding's module"
```

### Task 28: Four small code fixes (B06–B09)

**Files:**

- Modify: `islands/GenesView.tsx:244-260`, `islands/TrialsView.tsx:250-266`,
  `components/useEscapeKey.ts:14-16`, `lib/tooltips.ts:23-34`
- Test: `tests/tooltips_test.ts` (imports), `tests/components_test.tsx`

- [ ] **Step 1: Edit**

- Brain cell types: drop the `tooltips.some(... === null)` bail-out; render
  `tooltips[i] ? <Tooltip content={tooltips[i]}>{part}</Tooltip> : part` per
  part. Unit test: a cell with one known and one unknown type renders exactly
  one `tooltip-box`.
- `groupParity`: wrap in `useMemo(() => { … }, [groupedByDrug, sortedRows])`
  where `const sortedRows = table.getSortedRowModel().rows;`.
- `useEscapeKey`: replace `handler.current = onEscape;` with
  `useLayoutEffect(() => { handler.current = onEscape; });` (import
  `useLayoutEffect`).
- `lib/tooltips.ts`: delete the `export { geneInfoTooltip, … }` line and any
  now-unused imports; if a test imports one of those names from
  `lib/tooltips.ts`, point it at `lib/tooltip_content.ts`.

- [ ] **Step 2: Run and commit**

Run: `deno task check && deno task test:coverage`

```bash
git add islands/GenesView.tsx islands/TrialsView.tsx components/useEscapeKey.ts lib/tooltips.ts tests/components_test.tsx tests/tooltips_test.ts
git commit -m "Per-part tooltip fallback, memoised group parity, effect-time ref, no dead re-exports"
```

## Phase 7: Final verification

### Task 29: Full gates and the rendered pass

- [ ] **Step 1: Every gate**

Run:
`deno task check && deno task test:coverage && uv run pytest tests/scripts && uv run ruff check . && uv run ty check && npx --prefix e2e playwright test -c e2e/playwright.config.ts`
Expected: all PASS.

- [ ] **Step 2: Rendered pass**

With the production server from the e2e config running, run this probe (save as
a scratch `.mjs` outside the repo, using `e2e/node_modules/playwright`):

```js
import { chromium } from "<repo>/e2e/node_modules/playwright/index.mjs";
const routes = ["/", "/genes", "/phenogram", "/trials", "/timeline", "/map"];
const sizes = [[1440, 900], [900, 900], [390, 844]];
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto("http://localhost:8000/login");
  await p.getByLabel("Passphrase").fill(
    "<PASSPHRASE from e2e/fixtures/auth.ts>",
  );
  await p.getByRole("button", { name: /sign in/i }).click();
  for (const [w, h] of sizes) {
    for (const r of routes) {
      await p.setViewportSize({ width: w, height: h });
      await p.goto("http://localhost:8000" + r);
      await p.waitForTimeout(800);
      const out = await p.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const box = (s) => {
          const e = document.querySelector(s);
          return e && Math.round(e.getBoundingClientRect().height);
        };
        const small = [...document.querySelectorAll("body *")].filter((e) =>
          !e.closest("svg") && e.childNodes.length &&
          [...e.childNodes].some((n) =>
            n.nodeType === 3 && n.textContent.trim()
          ) && parseFloat(getComputedStyle(e).fontSize) < 12
        ).length;
        return {
          overflow: document.documentElement.scrollWidth > vw,
          navbar: box(".navbar"),
          small,
        };
      });
      console.log(scheme, w, r, JSON.stringify(out));
      await p.screenshot({
        path: `shot-${scheme}-${w}${r.replace("/", "-") || "-about"}.png`,
        fullPage: true,
      });
    }
  }
  await ctx.close();
}
await b.close();
```

Expected: `overflow: false` everywhere, `small: 0` everywhere, `navbar` ≤ 120
at 390. Open the 390 `/genes` and `/trials` screenshots and confirm the filter
panel sits directly under the tips with no gap and no overlap; open the 1440
`/timeline` screenshot with a record open (click a marker first) and confirm the
drawer is left of the plate.

- [ ] **Step 3: Update the findings spec**

Append a "Status" line to
`docs/superpowers/specs/2026-09-08-frontend-audit-findings.md` naming the merge
commit and the two navbar band values measured in Task 3, then commit.

```bash
git add docs/superpowers/specs/2026-09-08-frontend-audit-findings.md
git commit -m "Record the audit remediation's outcome in the findings spec"
```
