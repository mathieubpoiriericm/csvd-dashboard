# Design Sweep Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 60 verified findings from the 2026-09-03 design sweep, and
leave behind guardrails so the axes that drifted cannot drift again silently.

**Architecture:** The sweep's thesis is that every axis
`tests/styles_contract_test.ts` asserts on is clean and every axis it does not
assert on has drifted. So the plan is ordered by that mechanism rather than by
severity: first harden the two defects in the guardrail itself, then finish each
half-built scale _together with_ the repointing that uses it and the assertion
that pins it, then work outward to the surfaces.

**Dependencies — the phases are not all independent.** Honour these or the task
fails:

| Task                     | Needs      | Why                                                     |
| ------------------------ | ---------- | ------------------------------------------------------- |
| 11 (Leaflet chrome)      | Tasks 3, 4 | uses `--svd-radius-round` and `--svd-leading-normal`    |
| 15 (sticky headers)      | Task 7     | uses `--svd-navbar-h` for the scroll container's height |
| 25 (key rail)            | Task 7     | same token, same reason                                 |
| 14, 16 (tables)          | Task 13    | need the per-column class hook                          |
| 21 (endpoint disclosure) | Task 20    | renders the extracted `ApiList`                         |
| 24 (label collision)     | Task 6     | a wider plate moves the derived 1341px breakpoint       |

Everything else is independent and can be reordered, split onto separate
branches, or dropped. Phases 6, 8 and 9 touch nothing the others touch.

**Tech Stack:** Deno 2 + Fresh 2 (Preact), TypeScript, plain CSS with custom
properties (no PostCSS/Sass — `deno fmt` does not read `.css`, so
`tests/styles_contract_test.ts` is the only thing that polices it), Playwright
for e2e, Python for the two print figures.

**Spec:** `docs/superpowers/specs/2026-09-03-design-sweep-findings.md` — all 60
findings with rule, evidence and fix. Finding IDs below (`F01`…`F60`) refer to
it.

## Global Constraints

Copied verbatim from the spec; every task's requirements implicitly include this
section.

- **`tests/styles_contract_test.ts` case 5 asserts every declared `--svd-*`
  token is used.** A token added in one commit and consumed in the next turns
  the suite red in between. Scale extension and repointing therefore land in the
  SAME commit, always.
- **Cases 1-3 assert exact media-query and declaration text** for the tooltip
  caps, the sticky sidebar and the timeline drawer. Any breakpoint or
  sticky-offset change edits those cases in the same commit.
- **33 app-owned class names are load-bearing for e2e.** The eight reached
  through `e2e/helpers.ts` are `.filter-count`, `.data-table`, `.table-control`,
  `.tooltip-pop`, `.is-placed`, `.empty-state`, `.filter-none`,
  `.filter-active`. Do not rename these.
- **Trial rows may take NO additional class.** `e2e/tests/trials-table.spec.ts`
  asserts the row class set is exactly `{group-even, group-odd}`. Adding classes
  to `<td>` is fine.
- **Positional selectors must keep working:** `td:nth-child(3)` on genes,
  `td:nth-child(10)`/`(11)` on trials, the two-row grouped `thead` with
  `colspan [3,4,2,1]`, the 13-column trials `thead`, `.pagination span` first
  child, `.leaflet-popup-content > .map-popup`, `.marker-cluster > span`. Column
  order and per-row cell counts must not change.
- **Rule-less classes that are e2e selectors are not dead**: `.label-bg`,
  `.wedge`, `.rim-band`, `.phenogram-block`, `.about-warning` and others. Do not
  "clean" them.
- **`runtime.spec.ts` is the tripwire:** every route at 1440x900 and 390x844,
  asserting `documentElement.scrollWidth <= innerWidth`, zero page errors, zero
  4xx/5xx.
- **`lib/` sits under a 100% coverage floor** (`deno task test:coverage`).
- **The two figure layout rules are implemented twice** — `lib/timeline.ts` /
  `scripts/timeline_figure.py` and `lib/phenogram.ts` /
  `scripts/phenogram_figure.py` — and pinned by `tests/timeline_layout_test.ts`,
  `tests/scripts/test_timeline_figure.py`, `tests/phenogram_layout_test.ts`,
  `tests/scripts/test_phenogram_figure.py`. A change to either rule is four
  files plus two renderers.
- **Data colours live in `lib/timeline_encoding.json` /
  `lib/phenogram_encoding.json`** and reach the DOM as SVG attributes, never
  CSS. The dark blocks must not be able to touch them.
- **`app.css` loads after `leaflet.css`** (`client.ts:7-10`) and overrides it at
  equal specificity, so Leaflet overrides win on order — but only if the
  selector's specificity ties or beats Leaflet's. `.leaflet-control-attribution`
  (0,1,0) LOSES to `leaflet.css:413`; use
  `.leaflet-container .leaflet-control-attribution` (0,2,0).
- **Do not run `ruff format`** — the repo was never ruff-format clean.
- **`data/*.json` is curated scientific judgement.** No task here regenerates
  data.

## Verification used by every task

Unless a task says otherwise, "the gate" means all three of:

```bash
deno task check                       # fmt, lint, deno check
deno task test                        # 416 unit tests incl. styles_contract_test.ts
npx --prefix e2e playwright test -c e2e/playwright.config.ts
```

Baseline at plan time: `deno task check` exit 0, 416 unit tests pass.

## File Structure

| File                                              | Responsibility in this plan                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `assets/app.css`                                  | Token block (tiers 1-3 + scales), all rules. Touched by nearly every task.                    |
| `tests/styles_contract_test.ts`                   | The guardrail. Gains six new assertions and two bug fixes.                                    |
| `components/TableShell.tsx`                       | Gains one `identityColumn` prop + a per-column class hook — the prerequisite for F13/F16/F17. |
| `components/PipelineSyncs.tsx`                    | Loses its copied `.pipeline-api` markup and its hand-written truncation sentence.             |
| `components/ApiList.tsx`                          | **New.** The one `.pipeline-api` list, called from two places.                                |
| `islands/PipelineRun.tsx`                         | Consumes `ApiList`; drawer trigger moves to the title row.                                    |
| `islands/TrialsTimeline.tsx`                      | Legend sample ground, label separation, `role="tooltip"` removal, plate radius.               |
| `lib/timeline.ts` + `scripts/timeline_figure.py`  | Canvas/radius growth and tangential label separation — changed together.                      |
| `lib/pipeline_display.ts`                         | Gains the truncation sentence PipelineSyncs hand-writes today.                                |
| `lib/constants.ts`                                | Filter label unification; the two `\n` literals.                                              |
| `islands/GenesView.tsx`, `islands/TrialsView.tsx` | Filter config collapses `name` into `label`; column class hooks.                              |
| `islands/CLAUDE.md`                               | The `aria-expanded` rationale is corrected from "rendering hazard" to house style.            |

---

# Phase 1 — Harden the guardrail, then finish the scales

Ordered first because the guardrail is what makes every later phase checkable,
and because the scales are the root cause: 116 spacing literals exist largely
because there was no token above 24px to reach for.

### Task 1: Fix the two defects in the guardrail itself

Implements **F04** (type-scale check satisfied by a colour token) and **F08**
(colour-literal check blind to `oklch()`). Test-only — no CSS changes, so
nothing can regress visually.

**Files:**

- Modify: `tests/styles_contract_test.ts:116-131` (case 7) and `:258-272`
  (case 11)

**Interfaces:**

- Produces: module-level `COLOUR_LITERAL` (RegExp) and
  `typeScaleSteps(): Set<string>`.
- Produces:
  `declarationsOf(property: string): Array<{ selector: string; value: string; line: number }>`
  — extracted from the rule-region walker that already exists inside case 11,
  which tracks the selector each declaration belongs to. Tasks 2-5, 8, 9 and 19
  all consume it, so it must be extracted here rather than reinvented per task.
- Produces: `onFourPxGrid(value: string, allow: Map<string, string>): boolean` —
  true when a length is a multiple of 4px (`0.25rem` steps) or is present in the
  allowlist.
- Produces: `recipeSelectorList(): string[]` — the selectors listed at the head
  of `=== CARDS & VALUE BOXES ===`, used by Task 19.

The assertions in Tasks 2-5, 8, 9 and 19 are written against these helpers. Do
not create a second rule-region walker in a later task; extend this one.

- [ ] **Step 1: Write the two failing tests**

Add to `tests/styles_contract_test.ts`:

```ts
Deno.test("the type scale's declared set excludes colour aliases", () => {
  // --svd-text-muted is a tier-3 colour alias (app.css:292). The old pattern
  // /--svd-text-([\w-]+):/g matched it, so `font-size: var(--svd-text-muted)`
  // satisfied the on-scale assertion.
  assertEquals(
    typeScaleSteps().has("muted"),
    false,
    "--svd-text-muted is a colour alias, not a step on the type scale",
  );
});

Deno.test("the colour-literal pattern catches every colour notation", () => {
  for (
    const s of [
      "color: oklch(0.5 0.1 270)",
      "background: hsl(200 50% 50%)",
      "fill: lab(50% 20 30)",
      "color: #abc",
      "background: rgb(1 2 3)",
    ]
  ) assert(COLOUR_LITERAL.test(s), `${s} must be caught`);

  for (
    const s of [
      "background: color-mix(in oklab, var(--svd-tint) 20%, transparent)",
      "color: var(--svd-ink)",
    ]
  ) {
    assertEquals(COLOUR_LITERAL.test(s), false, `${s} must be allowed`);
  }
});
```

- [ ] **Step 2: Run them and watch both fail**

```bash
deno test -A tests/styles_contract_test.ts --filter "declared set excludes"
deno test -A tests/styles_contract_test.ts --filter "colour notation"
```

Expected: the first fails on `typeScaleSteps is not defined`; after Step 3's
helper exists but before its filter, it fails asserting `true !== false`. The
second fails on `COLOUR_LITERAL is not defined`.

- [ ] **Step 3: Extract the helpers and the pattern, and fix both**

Case 11 already contains the walker every later assertion needs — it iterates
the rule region tracking the selector each declaration belongs to. Lift that
loop into `declarationsOf(property)` and have case 11 call it, so the behaviour
it already has is the behaviour Tasks 2-5, 8, 9 and 19 inherit. Then add
`onFourPxGrid` and `recipeSelectorList` beside it.

Replace the inline `declared` set in case 11 with a module-level helper, and
hoist the literal pattern:

```ts
/** The nine names that are steps on the type scale, in order. */
const TYPE_STEPS = [
  "2xs",
  "xs",
  "sm",
  "base",
  "md",
  "lg",
  "xl",
  "2xl",
  "3xl",
] as const;

/**
 * The type-scale steps the token region declares.
 *
 * Filtered against TYPE_STEPS because `--svd-text-muted` and `--svd-text` are
 * tier-3 colour aliases that share the prefix; without the filter a colour
 * token satisfies `font-size` being "on the scale".
 */
function typeScaleSteps(): Set<string> {
  return new Set(
    [...tokenRegion.matchAll(/--svd-text-([\w-]+):/g)]
      .map((m) => m[1])
      .filter((s) => (TYPE_STEPS as readonly string[]).includes(s)),
  );
}

/**
 * Every CSS colour notation, minus the ones that are legal in a rule.
 *
 * `color-mix(` and `var(` must NOT match: the depth recipe (app.css:874-880)
 * mixes tints in every surface rule. `\bcolor\(` cannot match "color-mix("
 * because a hyphen follows, and `\blab\(` cannot match inside "oklab" because
 * the boundary fails after "ok".
 */
const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|:\s*(?:white|black)\b/;
```

Then in case 11 use `const declared = typeScaleSteps();`, and in case 7 use
`const literal = COLOUR_LITERAL;`.

- [ ] **Step 4: Run the whole contract suite**

```bash
deno test -A tests/styles_contract_test.ts
```

Expected: all cases pass, including the two new ones. If case 7 now reports
leaks, they are real `oklch()` literals it was previously blind to — fix them in
this commit.

- [ ] **Step 5: Commit**

```bash
git add tests/styles_contract_test.ts
git commit -m "Close the two holes in the stylesheet guardrail

The type-scale check built its set of valid steps with
/--svd-text-([\w-]+):/g, which also matched the tier-3 colour alias
--svd-text-muted -- so font-size: var(--svd-text-muted) counted as
on-scale. The colour-literal check knew #hex, rgb() and the two named
colours, but not oklch(), the notation the entire palette is authored
in, nor hsl/lab/lch/hwb.

Both were latent rather than live: no rule exercised either hole. They
are the likeliest next mistakes, which is the argument for closing them
before the repointing work lands on top."
```

### Task 2: Finish the spacing scale and repoint all 116 literals

Implements **F01** (partially — the space half) and **F02**. The token additions
and the repointing MUST land together: contract case 5 fails on a
declared-but-unused token.

**Files:**

- Modify: `assets/app.css:214-219` (scale), plus ~116 declarations across the
  rule region
- Modify: `tests/styles_contract_test.ts` (new assertion)

**Interfaces:**

- Produces: `--svd-space-7: 2rem`, `--svd-space-8: 2.5rem`,
  `--svd-space-9: 3rem`; a `SPACING_ALLOWLIST` in the contract test, consumed by
  no other task.

- [ ] **Step 1: Write the failing assertion**

```ts
Deno.test("every spacing value is on the 4px scale", () => {
  // Design spec §11.2. It could not be written until the scale reached 48px:
  // 116 of 266 declarations were raw largely because nothing above 24px existed.
  //
  // Sub-grid values are real: a 1px hairline nudge and the 2px gap between the
  // density-readout bars are geometry, not rhythm. They are allowlisted with a
  // reason, the way case 11's `notType` map already works, and the allowlist is
  // asserted to be live so it cannot outlive the rules it excuses.
  const allow = new Map<string, string>([
    ["1px", "hairline nudges that pair with a 1px border"],
    ["2px", "density-readout bar gaps (app.css:1301, 1313)"],
  ]);
  const offScale = spacingDeclarations().filter(({ value }) =>
    !/var\(--svd-space-/.test(value) && !/^0$|^auto$/.test(value.trim()) &&
    !onFourPxGrid(value, allow)
  );
  assertEquals(
    offScale.map((d) => `${d.line}: ${d.selector} { ${d.value} }`),
    [],
  );
});
```

- [ ] **Step 2: Run it and record the failure list**

```bash
deno test -A tests/styles_contract_test.ts --filter "4px scale" 2>&1 | head -60
```

Expected: FAIL listing ~116 declarations. Keep this list — it is the work queue
for Step 4.

- [ ] **Step 3: Extend the scale**

At `assets/app.css:214-219`, after `--svd-space-6`:

```css
/* Space — 4px grid. 7-9 were added when the sweep found 116 declarations off
   the scale, most of them above the old 24px ceiling with nothing to reach for. */
--svd-space-7: 2rem;
--svd-space-8: 2.5rem;
--svd-space-9: 3rem;
```

- [ ] **Step 4: Repoint every literal using this mapping**

Ties round **up**. Two deliberate exceptions are marked.

| literal   | px   | token               |   | literal   | px   | token           |
| --------- | ---- | ------------------- | - | --------- | ---- | --------------- |
| `0.2rem`  | 3.2  | `--svd-space-1`     |   | `0.8rem`  | 12.8 | `--svd-space-3` |
| `0.25rem` | 4    | `--svd-space-1`     |   | `0.9rem`  | 14.4 | `--svd-space-4` |
| `0.3rem`  | 4.8  | `--svd-space-1`     |   | `1rem`    | 16   | `--svd-space-4` |
| `0.35rem` | 5.6  | `--svd-space-2` ¹   |   | `1.1rem`  | 17.6 | `--svd-space-4` |
| `0.4rem`  | 6.4  | `--svd-space-2` ¹   |   | `1.25rem` | 20   | `--svd-space-5` |
| `0.45rem` | 7.2  | `--svd-space-2`     |   | `1.5rem`  | 24   | `--svd-space-6` |
| `0.5rem`  | 8    | `--svd-space-2`     |   | `2rem`    | 32   | `--svd-space-7` |
| `0.55rem` | 8.8  | `--svd-space-2`     |   | `2.5rem`  | 40   | `--svd-space-8` |
| `0.6rem`  | 9.6  | `--svd-space-2`     |   | `3rem`    | 48   | `--svd-space-9` |
| `0.65rem` | 10.4 | `--svd-space-3`     |   | `4px`     | 4    | `--svd-space-1` |
| `0.7rem`  | 11.2 | `--svd-space-3`     |   | `6px`     | 6    | `--svd-space-2` |
| `0.75rem` | 12   | `--svd-space-3`     |   | `8px`     | 8    | `--svd-space-2` |
| `0.05rem` | 0.8  | delete ²            |   | `10px`    | 10   | `--svd-space-3` |
| `0.1rem`  | 1.6  | `1px` (allowlisted) |   | `12px`    | 12   | `--svd-space-3` |
| `0.15rem` | 2.4  | `2px` (allowlisted) |   | `16px`    | 16   | `--svd-space-4` |

¹ Nearest-step would split these either side of the boundary (5.6 → 4, 6.4 → 8).
They are both `gap` on chip and row groups and the sweep measured them doing the
same job 0.8px apart, so both collapse to `--svd-space-2`. This is the one place
the rule is overridden, and it is the finding's point.

² `0.05rem` is 0.8px — below the rendering floor at every zoom. Delete the
declaration and confirm on a screenshot diff that nothing moves.

Values in `em` (`0.06em`, `0.25em`) are relative to their own font size, not
rhythm; leave them and add them to the allowlist with that reason if the
assertion flags them.

- [ ] **Step 5: Run the gate and diff the pixels**

```bash
deno task check && deno task test
npx --prefix e2e playwright test -c e2e/playwright.config.ts
```

Then rebuild and re-capture, comparing against the sweep's baseline in the
scratchpad:

```bash
deno task build
DASHBOARD_PASSPHRASE='e2e passphrase: correct horse battery staple' \
DASHBOARD_SESSION_SECRET='e2e-session-secret-not-for-production' \
  deno serve -A --port 8000 _fresh/server.js &
node <capture script>   # see "Re-capturing screenshots" at the end of this plan
```

Expected: every page renders within ±2px of baseline. A larger move means a
mapping row was wrong for that site — fix the site, not the table.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Finish the spacing scale and put all 116 literals on it

The scale stopped at 24px while the sheet needed 32, 40 and 48, so most
of the 116 off-scale declarations had no token to reach for. Between
0.25rem and 0.5rem it had grown five intermediates -- 0.3 0.35 0.4 0.45 --
and the rendered census found 3.2px and 3.25px both in use, one twentieth
of a pixel apart across 253 declarations.

gap: 0.35rem (12 uses) and gap: 0.4rem (8 uses) both become --svd-space-2
rather than splitting either side of the nearest-step boundary: they are
the same gap on the same kind of row, which is what the finding was.

The assertion the 2026-08-27 spec asked for in §11.2 lands with them. It
could not have been written before: half the scale it checks did not exist."
```

### Task 3: Add the pill/circle radius steps and repoint

Implements **F05**. Every one of the 15 raw radii is the step the scale never
got, so this is a two-token change plus fifteen substitutions.

**Files:**

- Modify: `assets/app.css:265-268` (scale) and 15 declarations
- Modify: `tests/styles_contract_test.ts` (new assertion)

- [ ] **Step 1: Write the failing assertion**

```ts
Deno.test("every border-radius is on the radius scale", () => {
  const offScale = radiusDeclarations().filter(({ value }) =>
    !/var\(--svd-radius-/.test(value) && value.trim() !== "inherit"
  );
  assertEquals(offScale.map((d) => `${d.line}: ${d.selector}`), []);
});
```

- [ ] **Step 2: Run it**

```bash
deno test -A tests/styles_contract_test.ts --filter "radius scale"
```

Expected: FAIL listing 15 declarations — `999px` at app.css:1094, 1188, 1195,
1679, 1868, 2729, 3313, 3734 and `50%` at 1164, 1175, 1723, 2628, 2717,
2799, 3015.

- [ ] **Step 3: Add the two steps and repoint**

```css
--svd-radius-full: 999px; /* pill: chips, badges, the range track */
--svd-radius-round: 50%; /* circle: slider thumbs, marker dots, glyph wells */
```

Replace `999px` with `var(--svd-radius-full)` at the eight sites and `50%` with
`var(--svd-radius-round)` at the seven. Leave the two `inherit` declarations
(app.css:2143, 3636) — `.pipeline-drawer` deliberately takes its card's radius.

- [ ] **Step 4: Run the gate**

Expected: green. `e2e/tests/map.spec.ts` asserts no radius; nothing else does.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Give the radius scale its pill and circle steps

All 15 raw border-radius declarations were 999px or 50% -- the one step
the scale was specified with and never got. app.css contained no other
off-token radius, so the whole gap closes with two tokens."
```

### Task 4: Add the leading and tracking scales and repoint

Implements **F06**. `--svd-leading-tight` was the only line-height token and
there was no letter-spacing token at all, so 15 of 20 line-heights and 8 of 8
trackings were raw.

**Files:**

- Modify: `assets/app.css:234` (scale) and 23 declarations
- Modify: `tests/styles_contract_test.ts` (two new assertions)

- [ ] **Step 1: Write the failing assertions**

```ts
Deno.test("every line-height is on the leading scale", () => {
  const off = leadingDeclarations().filter(({ value }) =>
    !/var\(--svd-leading-/.test(value) && value.trim() !== "1" &&
    value.trim() !== "inherit"
  );
  assertEquals(off.map((d) => `${d.line}: ${d.selector} { ${d.value} }`), []);
});

Deno.test("every letter-spacing is on the tracking scale", () => {
  const off = trackingDeclarations().filter(({ value }) =>
    !/var\(--svd-tracking-/.test(value) && value.trim() !== "normal"
  );
  assertEquals(off.map((d) => `${d.line}: ${d.selector} { ${d.value} }`), []);
});
```

`line-height: 1` stays exempt: it is the "no leading" case on a single-line SVG
label (app.css:2804), not a step.

- [ ] **Step 2: Run both and record the failures**

Expected: 14 line-height declarations (1.05, 1.1, 1.2, 1.3, 1.35, 1.4, 1.45,
1.5) and 7 letter-spacing declarations (-0.012em, -0.01em, 0.02em, 0.03em ×2,
0.04em, 0.08em).

- [ ] **Step 3: Add the steps**

```css
--svd-leading-tight: 1.25;
--svd-leading-snug: 1.35; /* the 1.3/1.35 pair; headings that wrap once */
--svd-leading-normal: 1.5; /* body prose */

/* Tracking. Negative steps tighten display sizes, positive ones open up the
   uppercase eyebrows; -0.01em and -0.012em were separately typed values
   0.002em apart, which is below the rendering floor at any size here. */
--svd-tracking-tight: -0.012em;
--svd-tracking-normal: 0.02em;
--svd-tracking-wide: 0.04em;
--svd-tracking-caps: 0.08em;
```

- [ ] **Step 4: Repoint**

| literal              | →                      |   | literal               | →                       |
| -------------------- | ---------------------- | - | --------------------- | ----------------------- |
| `1.05`, `1.1`, `1.2` | `--svd-leading-tight`  |   | `-0.01em`, `-0.012em` | `--svd-tracking-tight`  |
| `1.3`, `1.35`        | `--svd-leading-snug`   |   | `0.02em`              | `--svd-tracking-normal` |
| `1.4`, `1.45`, `1.5` | `--svd-leading-normal` |   | `0.03em` ×2, `0.04em` | `--svd-tracking-wide`   |
|                      |                        |   | `0.08em`              | `--svd-tracking-caps`   |

`1.05` and `1.1` sit on display headings where the difference from 1.25 is one
or two pixels; collapse them and check the About hero and `.about-kpi-value` on
the screenshot diff.

- [ ] **Step 5: Run the gate and diff the pixels.** Expected: text blocks shift
      by at most one line-height step; nothing reflows to a new line count.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Give leading and tracking real scales

line-height had one token and nine raw values, four of them (1.3 1.35
1.4 1.45) inside a 0.15 band. letter-spacing had no token at all and
eight distinct raw values, including -0.01em and -0.012em on separate
rules -- 0.002em apart, below the rendering floor."
```

### Task 5: Put font-weight on its tokens and tighten case 11

Implements **F07**. The contract test checks only that a weight is renderable by
the shipped face, never that it comes from a token, so 30 of 56 declarations are
raw integers.

**Files:**

- Modify: `assets/app.css` (30 declarations)
- Modify: `tests/styles_contract_test.ts` (case 11's weight half)

- [ ] **Step 1: Extend the existing weight assertion**

Keep the renderability check and add a second one beside it:

```ts
Deno.test("every font-weight comes from the weight scale", () => {
  const off = weightDeclarations().filter(({ value }) =>
    !/var\(--svd-weight-/.test(value) && value.trim() !== "inherit"
  );
  assertEquals(off.map((d) => `${d.line}: ${d.selector} { ${d.value} }`), []);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL listing 30 declarations — `700` at
      app.css:499, 942, 961, 998, 1447, 2706, 3278, 3535, 3549, 3690; `600` at
      sixteen sites; `500` at 969, 2397, 3259.

- [ ] **Step 3: Repoint.** `400` → `var(--svd-weight-regular)`, `500` →
      `var(--svd-weight-medium)`, `600` → `var(--svd-weight-semibold)`, `700` →
      `var(--svd-weight-bold)`. Leave `inherit` at app.css:1483.

- [ ] **Step 4: Run the gate.** Two e2e specs assert computed weights —
      `genes-table.spec.ts:119` expects `"700"` and `tooltips.spec.ts:53-54`
      expects `"400"` and `"700"`. The tokens resolve to those exact numbers, so
      both stay green; if either fails, the repointing picked the wrong step.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Put the last 30 font-weights on the weight scale

Case 11 asserted only that a weight was renderable by the shipped face.
IBM Plex Sans Variable declares 100-700, so every raw integer passed and
54% of declarations never reached a token. The renderability check stays;
tokenization is now a second assertion beside it."
```

---

# Phase 2 — Breakpoints

### Task 6: Consolidate ten breakpoints onto a documented set

Implements **F03**, plus the two derivations that depend on it: the timeline's
41px dead band (**F36**) and the phenogram's stacking query sitting ~380px too
low (**F56**).

**Files:**

- Modify: `assets/app.css` — 14 width media queries at 1340, 1901, 1943, 1973,
  1980, 2479, 2583 (container), 2642, 2850, 2858, 3058, 3127, 3133, 3824, 3851
- Modify: `tests/styles_contract_test.ts` — cases 2 and 3 assert exact query
  text

- [ ] **Step 1: Declare the set as a comment block and an assertion**

CSS custom properties cannot be used in media queries, so the "token" is a
documented constant list plus a test that fails on anything outside it.

```ts
/**
 * The breakpoints this stylesheet is allowed to use.
 *
 * Each is a real layout change, and three are derived rather than chosen — the
 * derivation is in a comment beside the query and must stay there, because the
 * timeline's 1300px was 41px below its own derived value and produced a band
 * where the radar shrank and gained a scrollbar it did not have at 1300.
 */
const BREAKPOINTS = new Set([480, 600, 900, 901, 1100, 1101, 1341, 1410, 1482]);

Deno.test("every breakpoint is on the documented set", () => {
  const used = [...css.matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)]
    .map((m) => Number(m[1]));
  assertEquals([...new Set(used)].filter((n) => !BREAKPOINTS.has(n)), []);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL listing `700`, `980`, `1300`.

- [ ] **Step 3: Make the three moves**

- **Delete the duplicated 600px block.** `app.css:1340` and `:1980` are both
  `@media (max-width: 600px)`. Merge `:1340`'s `.readout-dist` rule into the
  `:1980` block and delete the earlier one. (Task 17 changes what that rule
  does; the merge is independent of it.)
- **`980px` → `900px`** at `:3127` (`.about-grid` → one column). It sits 80px
  from the sidebar's 900px doing the same "go single column" job; one number,
  one behaviour.
- **`700px` → `600px`** at `:3133` and `:3824`. Both are the phone layout the
  600px block already owns.
- **`1300px` → `1341px`** at `:2642`, with the derivation in the comment:
  `960 plate + 2x var(--svd-space-4) + var(--svd-space-5) + 18rem rail + 2x1.25rem page gutters = 1342`.
- **`1100px` → `1482px`** at `:3058` for the phenogram only, with its
  derivation:
  `1100 canvas + 32 .phenogram-scroll padding + 20 var(--svd-space-5) + 288 rail + 40 gutters = 1482`.
  Note the trade in the comment: at ≤1482 the key drops under the figure, so the
  right-hand-rail arrangement no longer appears at the spec's named 1440 manual
  width. Leave `:2479` and `:2858` at 1100 — those are the timeline's own column
  switches.

- [ ] **Step 4: Update contract cases 2 and 3.** Both assert exact media-query
      text including `1410px`; that value does not move, so only re-read them to
      confirm. If Step 3 touched a query they name, update the literal in the
      same commit.

- [ ] **Step 5: Run the gate, including `runtime.spec.ts` at both viewports.**
      Then sweep the widths by hand or by script at 480, 600, 900, 1100, 1341,
      1410, 1482 and confirm no width sits between two designs.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Put the ten breakpoints on a documented set of nine

The 2026-08-27 spec asked for documented constants and for the duplicated
600px block to be deleted; neither happened, and the sheet reached ten
values with two off-by-one pairs and three near-neighbours in the
900-1100 band.

Two are corrections rather than consolidations. The timeline stacked at
1300 while its own layout needs 1342, so 1300-1341 was a band where the
radar shrank and gained a horizontal scrollbar it did not have at 1300.
The phenogram stacked at 1100 while its canvas needs 1482, so it scrolled
sideways and lost gene labels at every width between."
```

### Task 7: Publish the navbar height once and let the skip link read it

Implements **F12**. `#main-content` has no `scroll-margin-top`, so the skip link
lands the reader behind the sticky navbar — 101px hidden at 1440, growing to
255px as the navbar wraps to three rows.

**Files:**

- Modify: `assets/app.css` — token block, `.navbar-inner` responsive rules,
  `#main-content`, the two sticky `top` values
- Modify: `tests/styles_contract_test.ts:38-72` (cases 2 and 3 read those `top`
  values)

- [ ] **Step 1: Write the failing e2e assertion**

In `e2e/tests/navigation.spec.ts`:

```ts
test("the skip link lands the heading below the navbar", async ({ page }) => {
  await page.goto("/genes");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const navBottom = await page.locator("header.navbar").evaluate((n) =>
    n.getBoundingClientRect().bottom
  );
  const h1Top = await page.locator("main h1").evaluate((n) =>
    n.getBoundingClientRect().top
  );
  expect(h1Top).toBeGreaterThanOrEqual(navBottom - 1);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL — `h1Top` is ~101px above `navBottom`.

- [ ] **Step 3: Publish the height and consume it**

```css
:root {
  /* The sticky navbar's height, published so the skip-link target and both
     sticky panels read one number. It changes at the two widths where the bar
     re-wraps, and the sticky offsets were previously two hard-coded rems that
     covered only two of the seven heights the bar actually takes. */
  --svd-navbar-h: 6.5rem;
}
@media (max-width: 1410px) {
  :root {
    --svd-navbar-h: 9.5rem;
  }
}
@media (max-width: 600px) {
  :root {
    --svd-navbar-h: 11rem;
  }
}

#main-content {
  scroll-margin-top: var(--svd-navbar-h);
}
```

Then repoint `.sidebar-section`'s and `.timeline-drawer`'s `top` to
`var(--svd-navbar-h)` and their `max-height` to
`calc(100vh - var(--svd-navbar-h) - 1.5rem)`.

- [ ] **Step 4: Update contract cases 2 and 3.** They assert the literal strings
      `top: 9.5rem` and `max-height: calc(100vh - 11rem)`. Rewrite them to
      assert the `var(--svd-navbar-h)` form and that the three `--svd-navbar-h`
      values exist. Keep the cases' intent: only sticky desktop filters take the
      stacked-navbar cap.

- [ ] **Step 5: Run the gate.** Expected: the new navigation test passes;
      `map.spec.ts:66-70` (which scrolls to top because the navbar intercepts
      Leaflet's zoom controls) still passes.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts e2e/tests/navigation.spec.ts
git commit -m "Publish the navbar height once and let the skip link clear it

The skip link jumped to #main-content with no scroll-margin-top, so the
heading landed behind the sticky bar -- 101px hidden at 1440 and 255px at
390, where the bar wraps to three rows. The two sticky panels carried
hard-coded rems that covered two of the seven heights the bar takes.
One custom property, set at the two widths where the bar re-wraps, now
serves the skip target and both panels."
```

---

# Phase 3 — Colour architecture

Independent of Phases 4-8. Each task is a pure refactor with no intended visual
change, so the screenshot diff is the test.

### Task 8: Promote the seven raw oklch values into the palette tier

Implements **F09**. `oklch(0.9390 0.0163 278.5)` is retyped six times across the
two dark blocks, which must stay byte-identical — so each value is maintained in
two places.

**Files:**

- Modify: `assets/app.css:35-71` (palette), `:85-96` (semantic light),
  `:326-379` and `:382-438` (both dark blocks)

- [ ] **Step 1: Write the failing assertion**

```ts
Deno.test("no raw oklch value appears outside the palette ramps", () => {
  // Tier 1 is where ramps live (app.css:16-17). A raw oklch in tier 2 is a
  // palette step that skipped the ramp, and the two dark blocks must stay
  // byte-identical, so every one of them is maintained twice.
  const rampNames = /^--svd-(?:indigo|ember|teal|red|amber)-\d+:/;
  const leaks = tokenRegion
    .map((line, i) => [i + 12, line.trim()] as const)
    .filter(([, l]) =>
      /^--svd-[\w-]+:\s*oklch\(/.test(l) && !rampNames.test(l)
    );
  assertEquals(leaks.map(([n, l]) => `${n}: ${l}`), []);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL listing `--svd-line-strong`,
      `--svd-color-ok-hover` in light, and `--svd-nav-ink`, `--svd-ink`,
      `--svd-tooltip-ink`, `--svd-ink-muted`, `--svd-line-strong`,
      `--svd-color-danger`, `--svd-color-ok-hover` in each dark block.

- [ ] **Step 3: Add the missing ramp steps and alias onto them**

```css
--svd-indigo-100: oklch(0.9390 0.0163 278.5); /* dark ink, nav ink, tooltip ink */
--svd-indigo-300: oklch(0.6609 0.0556 276.4); /* dark ink-muted */
--svd-indigo-450: oklch(0.7229 0.0273 269.5); /* light line-strong */
--svd-indigo-650: oklch(0.4200 0.0520 275.0); /* dark line-strong */
--svd-red-400: oklch(0.7048 0.1867 22.2); /* dark danger */
--svd-teal-600: oklch(0.4500 0.0820 182.0); /* light ok-hover */
--svd-teal-300: oklch(0.8600 0.1100 184.0); /* dark ok-hover */
```

Then every semantic name becomes `var(--svd-indigo-100)` and so on, in both dark
blocks identically.

- [ ] **Step 4: Run the gate.** Case 8 (the two dark blocks are byte-identical)
      is the one that catches a half-applied edit. The screenshot diff must show
      zero change — these are the same values behind a name.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Move the seven raw oklch values into the palette ramps

The token block's own rule is that tier 1 is where ramps live. Seven
values skipped it, and because the two dark blocks must stay
byte-identical each was maintained twice -- oklch(0.9390 0.0163 278.5)
was written out six times, as --svd-nav-ink, --svd-ink and
--svd-tooltip-ink in both blocks. No rendered change."
```

### Task 9: Rebuild the trial-status swatches as oklch ramp steps

Implements **F10**. Fifteen tokens x two themes = 30 hand-picked Tailwind hex
values, the one colour family whose dark mode is a re-pick rather than a
lightness inversion.

**Files:**

- Modify: `assets/app.css:193-209` and the status block in both dark blocks

- [ ] **Step 1: Write the failing assertion**

```ts
Deno.test("status swatches are ramp steps, not hex", () => {
  const hex = tokenRegion
    .map((line, i) => [i + 12, line.trim()] as const)
    .filter(([, l]) => /^--svd-status-[\w-]+:\s*#/.test(l));
  assertEquals(hex.map(([n, l]) => `${n}: ${l}`), []);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL listing 24 hex declarations (the six
      `transparent` and `var()` ones on `unknown` already pass).

- [ ] **Step 3: Build four ramps and derive both themes**

`recruiting` is a green the palette does not have; `active` is amber, which
exists; `completed` is indigo, which exists; `terminated` is red, which exists.
Add the green and reuse the rest:

```css
/* Green — trial status only. The other four status hues are ramp steps that
   already exist; this is the one the palette was missing. */
--svd-green-100: oklch(0.9400 0.0600 155.0);
--svd-green-200: oklch(0.8800 0.0900 158.0);
--svd-green-300: oklch(0.8200 0.1100 160.0);
--svd-green-700: oklch(0.4200 0.0800 158.0);
--svd-green-900: oklch(0.2600 0.0500 158.0);
--svd-green-950: oklch(0.2100 0.0450 158.0);
```

Light: `bg` = the 100 step, `border` = the 200, `text` = the 700/800. Dark: `bg`
= the 950, `border` = the 900, `text` = the 300. Apply the same shape to amber,
indigo and red so all five families read as one system.

- [ ] **Step 4: Measure before committing.** Each `text` on its own `bg` must
      clear 4.5:1 in both themes — this is the family most likely to regress,
      and `assets/CLAUDE.md` is explicit that a tint must be measured on the
      rendered pixels rather than against white. Re-run the contrast probe (see
      the end of this plan) and confirm it still reports zero failures on
      `/trials` and `/map` in both themes.

- [ ] **Step 5: Run the gate.** `e2e/tests/map.spec.ts:122-123` asserts the
      `popup-status-*` class names, not their colours, so it stays green.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Bring the trial-status swatches into the colour system

They were the one family outside it: 15 tokens x 2 themes = 30 hand-picked
Tailwind hex values, maintained in four blocks because the dark blocks are
duplicated. Every other colour here is an oklch ramp whose dark mode is a
lightness inversion; this family was a re-pick. The 2026-08-27 spec called
for exactly this rebuild -- the unknown-duplicates-completed half was fixed
at the time, the hex half was not.

Contrast re-measured on the rendered pixels in both themes: still zero
WCAG AA failures."
```

### Task 10: Split tier 3 into what it claims to be

Implements **F11**. The block says "pre-modernization names, aliased onto tier
2... Delete a name here once its last use is gone", but 12 of its 25 entries are
derived `color-mix()`/composite values with no tier-2 equivalent, so that rule
can never fire for them.

**Files:**

- Modify: `assets/app.css:285-315`, `assets/CLAUDE.md`

- [ ] **Step 1: Move the 12 derived values into tier 2**

`--svd-bg-sticky-head`, `--svd-bg-sticky-even`, `--svd-bg-tooltip-hover`,
`--svd-bg-hover-accent`, `--svd-ring-accent`, `--svd-rail-accent`,
`--svd-accent-subtle`, `--svd-bg-group`, `--svd-bg-row-even`,
`--svd-bg-row-stripe`, `--svd-gradient-bar`, `--svd-transition` are semantic
values, not aliases. Move them above the tier-3 banner, unchanged.

- [ ] **Step 2: Decide the 13 real aliases explicitly**

`--svd-primary`, `--svd-accent`, `--svd-danger-text`, `--svd-text`,
`--svd-text-muted`, `--svd-bg-page`, `--svd-bg-card`, `--svd-bg-light`,
`--svd-border`, `--svd-border-section`, `--svd-link`, `--svd-link-visited`,
`--svd-font` carry 120 uses between them. Either finish the migration (repoint
all 120 and delete the block) or keep it and restate the comment as a permanent
compatibility layer. **Recommended: finish it** — the sweep found
`--svd-transition` at 40 uses against 2/1/3 for the tier-2 tokens it wraps,
which is the migration having reversed direction.

- [ ] **Step 3: Correct the comment** at `assets/app.css:20-22` and the Tokens
      section of `assets/CLAUDE.md` so neither describes a migration that is not
      happening.

- [ ] **Step 4: Run the gate.** No rendered change; case 4 and case 5 (tokens
      declared and used) are the ones that catch a mistake here.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css assets/CLAUDE.md
git commit -m "Stop tier 3 describing a migration that is not happening

Twelve of its 25 entries are derived color-mix() values with no tier-2
equivalent, so the block's own deletion rule can never fire for them --
they are semantic tokens filed under legacy, and they move up. The
thirteen that are genuinely 1:1 aliases carry 120 uses, which is the
migration having stalled rather than progressed."
```

---

# Phase 4 — Contain Leaflet

Twelve findings, ten of which are one stylesheet block. Leaflet ships its own
complete visual system and the app overrides it only for popups, so everything
else — the container ground, the zoom bar, the scale bar, the attribution, the
cluster badges — renders in Leaflet's light-mode defaults on a dark page.

**The specificity trap is documented at `client.ts:3-6`**: `app.css` loads after
`leaflet.css` and wins on order _only at equal or greater specificity_. A bare
`.leaflet-control-attribution` (0,1,0) loses to `leaflet.css:413`; use
`.leaflet-container .leaflet-control-attribution` (0,2,0).

### Task 11: Theme Leaflet's chrome

Implements **F44**, **F45**, **F46**, **F47**, **F48**, **F49**, **F51**,
**F54** and **F55** — container ground, control chrome and its theme flip, popup
close button, attribution link colour and contrast, three of the seven corner
radii, the two foreign typefaces, the three off-token transitions, and the wrong
ink token on the cluster badge.

**Files:**

- Modify: `assets/app.css:2241-2244` and the Leaflet override block at `:2407`

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/tests/theme.spec.ts`, beside the existing tile-filter assertions:

```ts
test("Leaflet chrome follows the theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/map");
  const ground = page.locator(".map-container .leaflet-container");
  await expect(ground).not.toHaveCSS("background-color", "rgb(221, 221, 221)");
  const zoom = page.locator("a.leaflet-control-zoom-in");
  await expect(zoom).not.toHaveCSS("background-color", "rgb(255, 255, 255)");
});
```

- [ ] **Step 2: Run it.** Expected: FAIL — the container is `#ddd` and the zoom
      button white.

- [ ] **Step 3: Write the override block**

```css
/* Leaflet ships a complete light-mode visual system. app.css loads after it
   (client.ts:7-10) and wins on order, but only at equal specificity -- a bare
   .leaflet-control-attribution (0,1,0) loses to leaflet.css:413, so the
   container is named to reach (0,2,0). */
.map-container .leaflet-container {
  background: var(--svd-surface);
  font-family: var(--svd-font-sans);
}

.leaflet-bar a,
.leaflet-control-scale-line,
.leaflet-container .leaflet-control-attribution {
  background: var(--svd-surface);
  color: var(--svd-ink);
  border-color: var(--svd-line);
  font-family: var(--svd-font-sans);
}

.leaflet-bar {
  border-radius: var(--svd-radius-xs);
  box-shadow: var(--svd-shadow-sm);
}

.leaflet-bar a {
  border-radius: var(--svd-radius-xs);
}

.leaflet-bar a:hover {
  background: var(--svd-bg-tooltip-hover);
}

/* leaflet.css:318-322 is (0,1,2) and keeps #f4f4f4 / #bbb, and
   map.spec.ts:76-110 drives the zoom-out button into this state. */
.leaflet-bar a.leaflet-disabled {
  background: var(--svd-ground);
  color: var(--svd-ink-muted);
}

/* A white halo drawn for black-on-white; the plate is now themed. */
.leaflet-control-scale-line {
  text-shadow: none;
}

.leaflet-control-attribution a {
  color: var(--svd-link);
}

/* The panel was repainted dark; the close button kept Leaflet's greys --
   3.82:1 at rest and 2.48:1 on hover, i.e. hover moved away from the ink. */
.leaflet-container a.leaflet-popup-close-button {
  font: var(--svd-weight-regular) var(--svd-text-md) / var(--svd-leading-normal)
    var(--svd-font-sans);
  color: var(--svd-ink-muted);
}

.leaflet-container a.leaflet-popup-close-button:hover,
.leaflet-container a.leaflet-popup-close-button:focus {
  color: var(--svd-ink);
}

.marker-cluster {
  border-radius: var(--svd-radius-round);
}

.marker-cluster > div {
  border-radius: var(--svd-radius-round);
  font-family: var(--svd-font-sans);
  /* The fill is --svd-color-primary, so the ink is --svd-on-primary. */
  color: var(--svd-on-primary);
}

/* MarkerCluster.css:9 requires the leg's duration and easing to match the
   marker transform, or the leg stops tracking it. */
.leaflet-cluster-anim .leaflet-marker-icon,
.leaflet-cluster-spider-leg,
.leaflet-fade-anim .leaflet-popup,
.leaflet-zoom-anim .leaflet-zoom-animated {
  transition-duration: var(--svd-duration-slow);
  transition-timing-function: var(--svd-ease-out);
}
```

- [ ] **Step 4: Run the gate.** `map.spec.ts:83-99` asserts the zoom buttons by
      accessible name, visibility and `aria-disabled`, never colour; `:104`
      waits on `.leaflet-zoom-anim` reaching count 0, which 220ms satisfies;
      `:134` clicks the close button, whose 24x24 hit box comes from separate
      `width`/`height` declarations left untouched.

- [ ] **Step 5: Re-measure contrast on `/map` in both themes.** The attribution
      was 3.43:1 in dark and moved with whatever tile was underneath; with an
      opaque `--svd-surface` plate it must clear 4.5:1 and stop depending on map
      contents.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css e2e/tests/theme.spec.ts
git commit -m "Bring Leaflet's chrome inside the design system

The app overrode Leaflet's popups and nothing else, so on a dark page the
container ground stayed #ddd (59% of the map box at 390px), and the zoom
bar, scale bar and attribution stayed white plates with black ink. The
popup close button kept Leaflet's greys after the panel was repainted --
3.82:1 at rest and 2.48:1 on hover, so hover moved away from the ink.

Also folds in the three off-token transitions Leaflet ships, the two
foreign typefaces its zoom control and cluster badges were rendering in,
three of the seven corner radii /map showed in one viewport, and the
cluster badge naming --svd-on-accent over a --svd-color-primary fill."
```

### Task 12: Make the map plate a member of the depth recipe

Implements **F50**, **F52** and **F53** — `.map-container` is the one page-level
plate outside the recipe and paints no background at all; the 700px box has no
responsive height; `.map-stats` is the only centred per-page summary.

**Files:**

- Modify: `assets/app.css:854-870` (recipe list), `:2230-2260`

- [ ] **Step 1: Add `.map-container` to the recipe selector list** at
      `app.css:854-870`, beside `.map-error`, and delete its own `border-radius`
      (`:2232`) and `box-shadow` (`:2234`) — the recipe supplies both. No
      `--svd-tint-base` declaration is needed: the default at `:179` is
      `var(--svd-bg-card)` = `var(--svd-surface)`. Keep `overflow: hidden`,
      which clips the map's corners. The radius intentionally moves 16px → 12px;
      nothing asserts it.

- [ ] **Step 2: Give the box a height that follows its width**

```css
.map-container,
.trials-map {
  /* 700px fixed left 69% of the box as empty out-of-tile grey at 390px. */
  min-height: min(700px, 75vh);
}
```

`.trials-map`'s existing `min-height: 700px !important` (`:2237`) must be
replaced, not supplemented. Do **not** raise the initial zoom instead:
`fitBounds` runs after init and overwrites it.

- [ ] **Step 3: Left-align the stats strip.** Delete `justify-content: center`
      at `:2256`. Keep `.map-stats .date-badge { margin-bottom: 0 }` at `:2276`
      — `.date-badge` carries `margin-bottom: var(--svd-space-4)` at `:1676`, so
      that reset is load-bearing. Keep the comment at `:2246-2251`, which
      records that margin collapsing here was fixed once already.

- [ ] **Step 4: Run the gate**, including `runtime.spec.ts` at 390x844 — the
      height change is the one most likely to introduce overflow.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css
git commit -m "Join the map plate to the depth recipe and let it breathe

.map-container was the one page-level plate outside the shared surface
rule and painted no background at all, so it inherited the page ground
while every sibling panel sat on a surface. Its 700px fixed height left
69% of the box empty at 390px, and .map-stats was the only per-page
summary centred rather than starting at the content edge."
```

---

# Phase 5 — Tables

Nine findings, three of which need the same missing piece: `TableShell` emits no
per-column class, so nothing in CSS can address a column by identity. Task 13
adds it and must land first.

### Task 13: Give TableShell a per-column class hook

Prerequisite for **F14**, **F17** and **F19**. `columnClass()` at
`components/TableShell.tsx:230-231` emits only `col-group-start` today.

**Files:**

- Modify: `components/TableShell.tsx:230-231`, `islands/GenesView.tsx`,
  `islands/TrialsView.tsx`
- Test: `tests/components_test.tsx`

**Interfaces:**

- Produces: `TableShellProps.identityColumn?: string` and a `col-<columnId>`
  class on every `<td>` and leaf `<th>`, consumed by Tasks 14-16.

- [ ] **Step 1: Write the failing test**

```tsx
Deno.test("TableShell tags every cell with its column id", () => {
  const html = renderToString(<GenesView />);
  assertStringIncludes(html, 'class="col-gene');
  assertStringIncludes(html, 'class="col-chromosomalLocation');
});
```

- [ ] **Step 2: Run it.** Expected: FAIL — no `col-` class but
      `col-group-start`.

- [ ] **Step 3: Emit the class.** Extend `columnClass()` to append
      `col-${column.id}`, and add an `identityColumn` prop that also emits
      `col-identity` on that column's `<td>` and leaf `<th>`. This is **additive
      on the class list**, so `td.group-cell`, the `group-even`/`group-odd` row
      classes and every `td:nth-child(N)` selector are untouched.

- [ ] **Step 4: Run the gate.** `trials-table.spec.ts:62,65,81,89,99,104` and
      `:74,144-145` are the assertions that would catch an accidental
      replacement rather than an append.

- [ ] **Step 5: Commit.**

### Task 14: Fix the sticky identity column

Implements **F14** (the sticky treatment lands on Mechanism of Action in every
merged drug block and overlaps the pinned Drug cell) and **F15** (the sticky
cell is 3% translucent on odd blocks, so scrolled columns read through the drug
name).

**Files:**

- Modify: `islands/TrialsView.tsx` (pass `identityColumn`),
  `assets/app.css:1503-1526`, `:3186-3189`

- [ ] **Step 1: Write the failing e2e assertion** — scroll `.table-scroll` right
      on `/trials` and assert the pinned cell's computed `background-color` is
      fully opaque and that no `td` other than the drug column carries the
      sticky treatment.

- [ ] **Step 2: Repoint the selectors.** Change `app.css:1503-1526` from
      `td:first-child` / `thead tr:last-child th:first-child` to
      `td.col-identity` / `th.col-identity`. Covered rows then carry no identity
      cell, which is correct — the merged Drug cell already labels them.

- [ ] **Step 3: Split the stripe rule.** At `:3186-3189`, keep
      `--svd-bg-row-stripe` on the `<tr>` and give the sticky cell
      `--svd-bg-sticky-even`, the same split `tr:nth-child(even)` (`:1496-1498`)
      and `tr:nth-child(even) td:first-child` (`:1519-1521`) already use.
      Dark-safe: `--svd-bg-sticky-even` mixes into `--svd-surface`, which the
      dark blocks override.

- [ ] **Step 4: Run the gate and check both tables scrolled right, in both
      themes.**

- [ ] **Step 5: Commit.**

### Task 15: Make the table headers stick

Implements **F18**. **The obvious fix does not work** and the sweep verified
why: injecting `position: sticky` on `thead th` live left the header scrolling
away, because `.table-scroll { overflow-x: auto }` makes `overflow-y` compute to
`auto`, so the thead's nearest scroll container is `.table-scroll` itself —
whose height equals its content and therefore never scrolls.

**Files:**

- Modify: `assets/app.css:1443-1445`, the `thead` rules

- [ ] **Step 1: Bound the container first**

```css
.table-scroll {
  /* Sticky headers need a scroll container that actually scrolls. overflow-x:
     auto makes overflow-y compute to auto, so this element IS the scrollport --
     but its height equalled its content, so nothing ever scrolled within it and
     a sticky thead had nothing to stick to. The measure matches .sidebar-section
     (app.css:979) and .timeline-drawer (:2766). */
  max-height: calc(100vh - var(--svd-navbar-h) - 1.5rem);
}
```

- [ ] **Step 2: Stick the header**

```css
.data-table thead th {
  position: sticky;
  top: 0;
  background: var(--svd-bg-sticky-head);
}
```

On `/genes` the second header row offsets by row 1's height. Keep
`thead tr:last-child th:first-child`'s existing `z-index: 3` above the body's
sticky column. The background must stay opaque.

- [ ] **Step 3: Run the gate.** `runtime.spec.ts:33-49` measures horizontal
      overflow only, and tooltips stay unclipped because they are top-layer
      popovers (`tooltips.spec.ts:6`).

- [ ] **Step 4: Commit.**

### Task 16: Set the identifier columns in mono and give columns real measures

Implements **F19** (data cells are not IBM Plex Mono — the chosen direction's
second signature is unbuilt) and **F17** (column widths are allocated by
header-label length, so the widest columns hold the least data and rows run
62-434px tall).

**Files:**

- Modify: `assets/app.css` — move the misfiled rules, then add per-column rules

- [ ] **Step 1: Move the misfiled rules.** `.data-table td { max-width: 28ch }`
      and the four drug-group striping rules sit under `=== PAGE HEADINGS ===`
      at `app.css:3179-3202`, 1,700 lines from `=== DATA TABLE ===` (1421-1538),
      which already holds a "Merged drug-group cells" block. Move them there.
      (This is **F13**.)

- [ ] **Step 2: Set mono on the identifier columns the spec names**

```css
.data-table .col-gene,
.data-table .col-chromosomalLocation,
.data-table .col-registryId,
.data-table .col-targetSampleSize,
.data-table .col-estimatedCompletionDate,
.data-table .col-clinicalTrialPhase {
  font-family: var(--svd-font-mono);
  font-variant-numeric: tabular-nums;
}
```

Deliberately **not** `references` — that column holds citation prose ("Morel,
H., et al. (2023)"), not the reference counts the spec names — and **not**
`confidence`, which renders "—" or a decimal and is already tabular.

- [ ] **Step 3: Replace the single 28ch cap with per-column measures.** Narrow
      set (`gene`, `chromosomalLocation`, `mendelianRandomization`,
      `confidence`, `clinicalTrialPhase`, `geneticEvidence`) gets
      `white-space: normal` on the header plus a small `min-width`; wide-prose
      set (`sourceQuote`, `primaryOutcome`, `trialName`, `references`) gets a
      larger `max-width`.

- [ ] **Step 4: Run the gate.** Column order and per-row cell counts must not
      change — `genes-table.spec.ts:191` and `trials-table.spec.ts:165,191,199`
      index by `td:nth-child(N)`.

- [ ] **Step 5: Commit.**

### Task 17: Keep the density readout's text alternative below 600px

Implements **F20**. `.readout-dist { display: none }` removes the distribution
histogram from both table pages on a phone — and takes its screen-reader
`ul.visually-hidden` with it, so the loss is not only visual.

**Files:**

- Modify: `components/DensityReadout.tsx`, `assets/app.css` (the merged 600px
  block)

- [ ] **Step 1: Lift `ul.visually-hidden` out of `.readout-dist`** so the
      per-bucket counts survive the hide — which also stops a region named after
      chromosomes from containing none. Alternatively move the hide to
      `.readout-bars`.

- [ ] **Step 2: Drop the hide for the 5-bucket `/trials` histogram**, which has
      no fit problem at any width.

- [ ] **Step 3: Run the gate.** Keep `.readout-bars[aria-hidden="true"]` and
      `.readout-dist .readout-stat-label em` intact —
      `e2e/tests/readout.spec.ts:66` and `:70-79` pin both.

- [ ] **Step 4: Commit.**

### Task 18: Two one-line table fixes

Implements **F21** (the above-table row count is the only one of three readouts
of the same number in proportional figures) and **F22** (`main-content` names
two regions on one page).

- [ ] **Step 1:** Add `font-variant-numeric: tabular-nums` to `.filter-message`
      (`app.css:1401`). Selector-only addition; `.filter-message`,
      `.filter-active` and `.filter-none` are e2e-load-bearing names and none
      changes.

- [ ] **Step 2:** Rename the inner `.main-content` to `.layout-main`, matching
      its `.layout-sidebar` parent. Three edits:
      `components/FilterPanel.tsx:66`, `assets/app.css:617`,
      `e2e/tests/filter-collapse.spec.ts:27`. It is **not** on the protected
      list. Leave `<main id="main-content">` alone — the skip link and
      `navigation.spec.ts` depend on it.

- [ ] **Step 3: Run the gate and commit.**

---

# Phase 6 — The About page and the pipeline widget

### Task 19: Join `.pipeline-sync` to the depth recipe

Implements **F23**, the highest-severity mechanical finding. The three refresh
entries re-declare the recipe's parameters (`--svd-tint-wash`,
`--svd-tint-base`) but were never added to the selector list that reads them
back, so both properties are dead and the entries paint no background, border or
shadow at all — in either theme. Its own comment (`app.css:3680-3681`) claims "A
surface on the same recipe `.pipeline-record` uses, minus the rail", which the
CSS contradicts.

**Files:**

- Modify: `assets/app.css:854-870`

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("every surface that declares recipe parameters joins the recipe", () => {
  // A rule that sets --svd-tint-wash or --svd-tint-base is asking for the
  // shared surface treatment. If it is not in the selector list at :854-870,
  // nothing reads those properties back and the surface paints nothing.
  const declarers = selectorsDeclaring(/--svd-tint(-wash|-base)?:/);
  const members = recipeSelectorList();
  assertEquals(
    declarers.filter((s) => !members.includes(s) && s !== ":root"),
    [],
  );
});
```

- [ ] **Step 2: Run it.** Expected: FAIL listing `.pipeline-sync`.

- [ ] **Step 3: Add `.pipeline-sync` to the list** at `app.css:854-870`, beside
      `.pipeline-record`. Its existing parameter block then resolves:
      `--svd-tint` inherits `var(--svd-color-primary)` from `:root` (`:173`),
      and its own `border-radius: var(--svd-radius-sm)` (`:3686`) still wins
      over the recipe's `md`, being declared further down the sheet at equal
      specificity.

- [ ] **Step 4: Look at `/` in both themes.** The three refreshes must now read
      as three surfaces rather than three runs of text separated by whitespace.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Let the refresh entries paint the surface they ask for

.pipeline-sync re-declared --svd-tint-wash and --svd-tint-base but was
never added to the selector list that reads them back, so both properties
were dead and the three refreshes rendered as bare text in both themes --
no box, no border, no wash, only whitespace between one event and the
next. Its own comment said it was on the same recipe as .pipeline-record.

The new assertion closes the class of bug: declaring a recipe parameter
without joining the recipe is now a test failure."
```

### Task 20: Extract the copied API list and the truncation sentence

Implements **F28** (the `.pipeline-api` `<li>` is copied verbatim into two
files, contradicting the comment above the copy that says it is not a copy) and
**F29** (PipelineSyncs hand-writes the sentence PipelineRun gets from
`describeTruncation()`, so one class renders two different sentences on one page
— one ends in a period, one does not).

**Files:**

- Create: `components/ApiList.tsx`
- Modify: `islands/PipelineRun.tsx:684-697`,
  `components/PipelineSyncs.tsx:91-104` and `:109-114`
- Modify: `lib/pipeline_display.ts:293`
- Test: `tests/pipeline_display_test.tsx`

**Interfaces:**

- Produces: `ApiList({ apis }: { apis: ApiServiceRecord[] })` rendering the
  `<ul>` of `.pipeline-api` items; each caller keeps its own wrapper and
  heading.
- Produces: `describeTruncation(shown, total, noun?)` — the optional noun and
  terminal period replace PipelineSyncs' hand-written string.

- [ ] **Step 1: Write the failing test**

```tsx
Deno.test("both API lists render identically", () => {
  const apis = [{ label: "ClinVar", method: "GET", endpoint: "/x", calls: 2 }];
  assertEquals(
    renderToString(<ApiList apis={apis} />),
    renderToString(<ApiList apis={apis} />),
  );
});

Deno.test("describeTruncation carries its noun and punctuation", () => {
  assertEquals(describeTruncation(200, 1412), "Showing 200 of 1,412");
  assertEquals(
    describeTruncation(3, 12, "errors"),
    "Showing 3 of 12 errors.",
  );
});
```

- [ ] **Step 2: Run them.** Expected: FAIL — `ApiList` does not exist,
      `describeTruncation` takes two arguments.

- [ ] **Step 3: Extract both.** The `<li>` markup is byte-identical between the
      two files (a normalised diff returns empty), so the extraction is a move,
      not a rewrite. Decide the punctuation once — today one
      `.pipeline-truncation` ends with a period and the other does not, on the
      same page.

- [ ] **Step 4: Run the gate.** `e2e/tests/about.spec.ts:224-228` asserts over
      `.pipeline-api-name`; the markup does not change, only where it lives.

- [ ] **Step 5: Commit.**

### Task 21: Put the endpoint register behind a disclosure

Implements **F24**. `islands/CLAUDE.md:127-132` states the rule plainly:
endpoint paths and HTTP verbs are a maintainer's register and belong in the
drawer, not on the card, because the card sits a few hundred pixels above a Data
Sources panel naming the same class of thing in prose. `PipelineRun` obeys it;
`PipelineSyncs` renders eight endpoint rows inline.

Measured cost: the syncs card runs y=1319→2145 of a 2795px page — 30% of its
height — and the reader-facing Citation & Contact and Data Sources cards do not
start until 78% down.

**Files:**

- Modify: `components/PipelineSyncs.tsx:89-107`

- [ ] **Step 1: Keep on the card** the mode name, status badge, timestamp,
      duration and the `.pipeline-sources` fetched/written counts. **Move behind
      a disclosure** the `ApiList` from Task 20.

- [ ] **Step 2: Use a native `<details>/<summary>`, not an island.**
      `PipelineSyncs` holds no state — its own comment at `:20-23` says "Not an
      island" and sanctions promotion only "if a per-refresh drawer is ever
      wanted". `<details>` also keeps the eight `.pipeline-api-name` elements in
      the DOM, which is what `about.spec.ts:224-228` asserts over.

- [ ] **Step 3: Run the gate and re-measure the page.** Citation & Contact
      should lift several hundred pixels.

- [ ] **Step 4: Commit.**

### Task 22: Three type and layout corrections on the About card

Implements **F25** (the pipeline funnel's ten figures are the only headline
numerals not in mono), **F26** (the drawer's open control is bottom-left and its
close control top-right of the same box, ~600px apart), **F27**
(`.pipeline-source-detail` orphans its count on a right-aligned second line
below ~450px) and **F16** (the drawer trigger wears the hover skin at rest).

**Files:**

- Modify: `assets/app.css:3533-3538`, `:960`, `:3835-3838`, `:3614-3617`
- Modify: `islands/PipelineRun.tsx:437-438`, `:616-628`

- [ ] **Step 1: Set the funnel in mono.** Add
      `font-family: var(--svd-font-mono)` to `.pipeline-stat-value` and set its
      weight from `--svd-weight-medium`, matching `.about-kpi-value`; change
      `.value-box-value`'s raw `700` at `:960` to `var(--svd-weight-medium)` so
      the two states of the same page agree. Keep the 16px step — this is a
      dense readout, not four hero figures. Do **not** reorder `.pipeline-stat`
      to value-first; at 390px it is already a ten-row single column.

- [ ] **Step 2: Give the drawer trigger a rest state of its own.** Text and
      chevron at `--svd-text-sm` in `--svd-link`, no fill and no ring; move
      `background: var(--svd-bg-hover-accent)` /
      `border-color: var(--svd-ring-accent)` into
      `.pipeline-drawer-trigger:hover, :focus-visible` beside the existing
      `:hover` at `:3614-3617`. **Do not switch it to indigo** — the accent is
      the app-wide interaction hue (`assets/CLAUDE.md:108-111`), so an indigo
      control would diverge from every other affordance.

- [ ] **Step 3: Move the trigger onto the `.card-title` row** — heading left,
      button right. It is the only row whose right side is free at 1440, 1024
      and 390, and it puts open and close at the same point. Two constraints:
      the trigger is conditional on `recorded` (`PipelineRun.tsx:437-438`), so
      the title row must not depend on it for its own alignment; and at 390 the
      title ink ends at x≈180 of 390, so the 300px label "View everything this
      run recorded" must shorten or wrap below the heading at that width.

- [ ] **Step 4: Fix the orphaned count.** Add
      `.pipeline-source-detail { margin-left: 0; width: 100% }` to the same
      600px block that already carries `.pipeline-api-detail` (`:3835-3838`), so
      the two identically-built row types wrap the same way.

- [ ] **Step 5: Run the gate and commit.**

---

# Phase 7 — The two figures

> **Staleness warning.** Commit `6ca497a` ("Say on the radar which trial records
> are thin, and which are unassessed") landed **after** this sweep captured its
> baseline. It added a third evidence state (`supported` solid ring /
> `unsupported` dashed ring / `unassessed` no ring), a `recordFlag` hollow
> centre on 18 of 111 markers, and a second `.timeline-legend-sample` site
> (`islands/TrialsTimeline.tsx:425` and `:459`). `.timeline-legend-item` is now
> 55, not the 53 the sweep measured.
>
> **Before executing Tasks 23-26, re-capture `/timeline` in both themes and
> re-measure.** The findings' shape almost certainly survives — a near-black
> ring cut from the plate has no ground on a themed legend panel either way, and
> a _dashed_ near-black ring is likely worse, not better — but the specific
> contrast numbers below predate the change and must not be quoted as current.

### Task 23: Give the timeline's legend sample a fixed light ground

Implements **F32** and **F33**, which are two readings of one defect: in dark
mode the "Genetic evidence" key's two samples are indistinguishable and the ring
measures 1.04:1 — the key exists to teach a distinction it cannot show.

The cause is that the legend sample is _chrome_ but reuses _plate-relative_
colours: the circle is stroked with `PLATE` (`#ffffff`) to cut it from the white
figure plate, but the legend panel is a themed surface, so in dark the white
stroke reads as the ring.

**Files:**

- Modify: `assets/app.css:2632-2637`

- [ ] **Step 1: Write the failing e2e assertion** — in dark mode, assert the two
      `.timeline-legend-sample` circles differ in computed appearance.

- [ ] **Step 2: Give the sample the ground its colours were drawn for**

```css
.timeline-legend-sample {
  /* The samples are cut from the figure plate with stroke={PLATE}, so they only
     read on that plate. --svd-figure-plate is declared once (app.css:147) and
     never overridden by the dark blocks, exactly like --svd-figure-ink beside
     it, so both the #ffffff disc stroke and the #14172b ring recover their
     meaning in both themes. */
  background: var(--svd-figure-plate);
  border-radius: var(--svd-radius-xs);
}
```

- [ ] **Step 3: Leave `fill="currentColor"` alone.** `--svd-ink-muted` resolves
      to a mid indigo in both themes and stays legible on white. Do **not**
      switch it to `var(--svd-figure-ink)`, which is near-black and would
      collide with the near-black ring. Do **not** simply delete
      `stroke={PLATE}` at `islands/TrialsTimeline.tsx:414` — that removes the
      false ring but leaves the real one at 1.06:1. Do **not** change the
      `PLATE` constant: the halos, marker rings and band separators are all cut
      from that white.

- [ ] **Step 4: Run the gate.** `timeline.spec.ts:30-37` asserts
      `.timeline-legend-family` count 14, `.timeline-legend-item` count **55**
      and `.timeline-legend-dot` colours — none of which this touches. Apply the
      background to **both** `.timeline-legend-sample` sites
      (`islands/TrialsTimeline.tsx:425` and `:459`): since `6ca497a` the
      evidence key has three states and the record flag has a sample of its own,
      and both are cut from the plate.

- [ ] **Step 5: Commit.**

### Task 24: Stop the timeline's drug labels colliding

Implements **F31**: 144 overlapping label pairs, and the label is the marker's
only identity channel. The count is **font-dependent and cannot be pinned** —
`e2e/tests/timeline.spec.ts:48-59` records 144 on macOS and 127 on CI's Linux
chromium for the same build and data, which is why it is bounded above zero and
under a ceiling of 170 rather than asserted exactly. That comment also says
"Lower the ceiling when the UI work lands; it is what that work has to move", so
this task is the work it is waiting for — the palette is one hue per family
precisely because eleven pairwise distinct hues cannot clear a colour-vision
check.

**This is the highest-risk task in the plan.** It changes a layout rule
implemented twice and pinned by four test files.

**Files:**

- Modify: `lib/timeline.ts:75` (`CANVAS`), `:77` (`OUTER_RADIUS`), `:429`
  (`separateLabels`)
- Modify: `scripts/timeline_figure.py` — the same three changes
- Modify: `assets/app.css` — `.timeline-figure { min-width: 960px }`
- Modify: `tests/timeline_layout_test.ts`,
  `tests/scripts/test_timeline_figure.py`
- Modify: `e2e/tests/timeline.spec.ts:114`

- [ ] **Step 1: Raise `CANVAS` and `OUTER_RADIUS` together**, keeping the
      ~45-unit label gutter. Enlarging `OUTER_RADIUS` alone pushes every marker
      and its label further out and clips them — the canvas must grow first.

- [ ] **Step 2: Raise `.timeline-figure`'s `min-width`** to the new native width
      so the plate still scrolls sideways rather than squashing. This interacts
      with Task 6: a wider plate raises the derived 1341px breakpoint, so
      recompute and update that comment too.

- [ ] **Step 3: Extend `separateLabels()`** — today it returns only vertical
      `dy` shifts — to also displace tangentially, with a leader line back to
      its marker.

- [ ] **Step 4: Mirror every change in `scripts/timeline_figure.py`** and re-pin
      both layout tests. Keep `boxes: 120` intact (no hiding labels) and lower
      the 170 ceiling in `e2e/tests/timeline.spec.ts:114` in the same commit.

- [ ] **Step 5: Run the gate plus `deno task figure`** and compare the print
      render to the island at the same data.

- [ ] **Step 6: Commit.**

### Task 25: Make the key rail scroll instead of running past the figure

Implements **F34**: the mechanism key runs 2,696px beside a 966px figure —
1,749px of empty ground at 1440.

**Files:**

- Modify: `assets/app.css` — the mechanism panel, scoped above the 1341px
  breakpoint

- [ ] **Step 1: Give the mechanism panel the treatment `.timeline-drawer`
      already has** in the same column (`app.css:2761-2774`):
      `position: sticky; top: var(--svd-navbar-h);
max-height: calc(100vh - var(--svd-navbar-h) - 1.5rem); overflow-y: auto`.
      Scope it to the rail case so the stacked layout below the breakpoint is
      untouched.

- [ ] **Step 2: Do NOT use `column-count: 2`.** At an 18rem rail that gives
      ~9rem columns, and both the root `CLAUDE.md` and `app.css:2547` record
      that "every mechanism name wraps at 18rem". Halving it would wreck the
      long names the rail exists to hold.

- [ ] **Step 3: Run the gate and commit.**

### Task 26: Unify the two figure keys

Implements **F35**: the two keys are declared parallel but diverge in body size,
family-heading treatment, and whether the family hue is shown at all.

- [ ] **Step 1: Unify the size.** Set `.phenogram-legend-list` (`app.css:2984`)
      to `--svd-text-sm`, matching the timeline. This shortens the timeline rail
      rather than lengthening it — raising the timeline to `--svd-text-base`
      instead would worsen the rail measured in Task 25.

- [ ] **Step 2: Pick one family-heading treatment.** Applying the timeline's
      uppercase-eyebrow treatment to `.phenogram-legend-family-name` costs
      nothing and leaves the phenogram's swatch in place, since its family hue
      already exists in `lib/phenogram_encoding.json`.

- [ ] **Step 3: Do NOT add a family-hue swatch to the timeline.**
      `lib/timeline_encoding.json`'s `families` entries carry only `key`,
      `label` and `mechanisms` — no colour — so that would mean adding a field
      to the encoding, updating `FamilyEncoding` in `lib/timeline.ts`, mirroring
      it in `scripts/timeline_figure.py` and re-pinning
      `tests/timeline_encoding_test.ts`.

- [ ] **Step 4: Run the gate and commit.**

### Task 27: Four small figure corrections

Implements **F38** (the theme-color hex is hardcoded in three places with tests
pinning the copies to each other), **F39** (the timeline plate has square
corners while the phenogram's is rounded inside the identical card), **F40**
(the two figures' hover tooltips are two different languages over the same fixed
white plate), and **F42**/**F43** (`role="tooltip"` on an `aria-hidden` element;
`.timeline-legend-evidence` has no rule and no test).

- [ ] **Step 1: Test the theme-color equality rather than asserting it in a
      comment.** The meta tag genuinely cannot read a custom property, so the
      hex must exist — but add a check that resolves `--svd-nav` in each theme
      from computed styles and compares it to `THEME_COLORS`, replacing the
      literal at `e2e/tests/theme.spec.ts:46`. For the timeline, record in
      `lib/timeline_encoding.json` that `#14172b` is `--svd-figure-ink` and must
      move with it: `boundary.color` and `geneticEvidence.Yes.ring` are chrome
      cut from the plate, not data colours.

- [ ] **Step 2: Round the timeline plate.** Cheapest: add `rx={9}` to the plate
      rect at `islands/TrialsTimeline.tsx:829` (SVG user units scale ~1.11x at
      1440, so 9 units ≈ the 8px the phenogram gets; the corners are empty
      white). The `PLATE` constant must stay — the halos, marker rings and band
      separators are cut from it — and `scripts/timeline_figure.py` needs no
      change, since the print figure has no card around it.

- [ ] **Step 3: Align the two tooltips.** CSS only: scope a
      `.phenogram-canvas .tooltip-pop` variant onto `--svd-figure-surface` /
      `--svd-figure-ink` / `--svd-figure-line` to match `.timeline-tooltip`, and
      align the two `max-width`/gutter pairs (pick one of 360/20 or 400/16 and
      use it in both). **Do not touch `.tooltip-pop` globally** —
      `e2e/helpers.ts` reaches it and the tables depend on the filled indigo
      panel. Keep the phenogram's reuse of `components/Tooltip.tsx`, which is
      the documented source of its Enter/Tab/Escape handling.

- [ ] **Step 4: Delete `role="tooltip"`** at `islands/TrialsTimeline.tsx:532`.
      `aria-hidden` is the deliberate contract (the drawer is the accessible
      path); the role is inert and only misinforms. No test or selector touches
      it.

- [ ] **Step 5: Drop `.timeline-legend-evidence`** at
      `islands/TrialsTimeline.tsx:401` — it is a second class on an element that
      already carries `.timeline-legend-list`, with no rule and no test, so it
      reads as a styling hook that was lost. Leave `.plate`: a comment above the
      rect explains the white sheet, which is what keeps the next reader from
      grepping for a rule that never existed.

- [ ] **Step 6: Run the gate and commit.**

---

# Phase 8 — Copy, semantics and the last cleanup

### Task 28: Give each filter group one name

Implements **F57**. Five of nine groups name themselves differently in the
sidebar and in the Active Filters line, and `name` never reaches the DOM —
`islands/TrialsView.tsx:309-311` destructures it away, and
`lib/filters.ts:277-278` is its only consumer.

The five that disagree: `Mendelian Randomization` vs
`Mendelian Randomization Performed?`; `Omics Studies` vs
`Evidence From Other Omics Studies`; `Genetic Evidence` vs `Genetic Evidence?`;
`Registry` vs `Clinical Trial Registry`; `Phase` vs `Clinical Trial Phase`.

**Files:**

- Modify: `lib/filters.ts`, `islands/GenesView.tsx`,
  `islands/TrialsView.tsx:324`

- [ ] **Step 1: Write the failing test** asserting the summary term for each
      group equals its sidebar legend.

- [ ] **Step 2: Collapse the pair.** Keep the fuller sidebar wording as the
      single source and have `checkboxFilterSummary` read `label`, dropping
      `name` from `CheckboxFilterConfig`. "Clinical Trial Registry: NCT" reads
      no worse than "Registry: NCT" and is traceable.

- [ ] **Step 3: Align `TrialsView.tsx:324`** to Title Case so the slider's
      accessible name matches the legend directly above it.

- [ ] **Step 4: Check the e2e specs that assert on the readout text** before
      landing the rename, then run the gate and commit.

### Task 29: Take the newlines out of the registry labels

Implements **F58**. Two `REGISTRY_CHOICES` labels carry a literal `\n`, and
`.filter-option`'s `white-space: pre-line` makes the browser honour it.

- [ ] **Step 1:** Remove both `\n` from `lib/constants.ts:122` and `:126` and
      let the labels wrap.

- [ ] **Step 2:** Reconsider `white-space: pre-line` at `assets/app.css:1112`.
      It is the only `pre-line` rule outside `.pipeline`-scoped prose at
      `:3505`, and it exists solely to serve those two strings while handing
      every future label a hidden formatting channel. If the two-line shape is
      genuinely wanted, get it from the stylesheet instead.

- [ ] **Step 3: Run the gate and commit.**

### Task 30: Correct the `aria-expanded` documentation and spelling

Implements **F41**, which is a **correction of an earlier claim**: this is not a
rendering bug. Preact 10.29.8 stringifies `aria-*` attributes —
`props.js:137-149` guards
`value != NULL && (value !== false || name[4] == '-')`, and `aria-expanded`[4]
is `-` — and `e2e/tests/filter-collapse.spec.ts:36` already asserts the
attribute renders, and passes.

- [ ] **Step 1:** `components/FilterPanel.tsx:50` →
      `aria-expanded={collapsed ? "false" : "true"}`, matching its four
      siblings. Behaviour-neutral, so `filter-collapse.spec.ts` stays green.

- [ ] **Step 2:** Correct `islands/CLAUDE.md:98-100`. Keep the one-spelling
      convention but restate its justification as house style, not as a
      rendering hazard — as written it will send the next reader hunting a bug
      this Preact does not have.

- [ ] **Step 3: Run the gate and commit.**

### Task 31: Decide the drawer announcement, and drop the unreachable glyph

Implements **F37** (two structurally identical drawers, only one announced) and
**F30** (the `arrowDownTray` glyph is unreachable).

- [ ] **Step 1: Pick one announcement and apply it to both.** The argument runs
      toward removal: delete `islands/TrialsTimeline.tsx:472` — focus already
      lands inside the drawer, and a polite live region re-reads the whole
      eleven-field record every time the user moves between markers. If the
      announcement is wanted instead, add the identical line at
      `islands/PipelineRun.tsx:636`. No test asserts `aria-live`, so either
      direction is safe.

- [ ] **Step 2: Drop `fields.payload`** from
      `lib/pipeline_encoding.json:255-258` and the `arrowDownTray` path from
      `components/Icon.tsx:83`. Both tests keep passing and nothing else names
      either. If a payload stat is planned, add the `<Stat name="payload">` that
      renders it instead of leaving the pair asserted-but-unseen.

- [ ] **Step 3: Run the gate and commit.**

---

# Phase 9 — The Figma token overview

The `cSVD-Dashboard` file is an organised overview of this repo's design tokens
— **not** a source of design intent, and its screens are known to be out of sync
with the app. These two tasks fix the overview's own accuracy and nothing else.

Requires the Figma desktop app running (pages load lazily) and the `figma-use`
skill loaded before any `use_figma` call.

### Task 32: Give every variable a usable CSS name

Implements **F59**. 19 of 136 variables carry no usable name, against the file's
own STATUS banner. Seven of them are live: bound 98 times on page
`02 Components`, with `nav/ink-dim` alone bound 70 times — so the invalid string
is the most-used mapping in the file.

- [ ] **Step 1:** For the five `nav/*` variables, clear `codeSyntax.WEB` and
      move the derivation into the variable description — `"--svd-nav-ink 24%"`
      is a `color-mix()` result, not a property name, and cannot be pasted into
      CSS. This is what the 14 `recipe/*` rows already do.

- [ ] **Step 2:** For the 14 `recipe/*` rows, confirm the description carries
      the derivation; add it where missing.

- [ ] **Step 3:** Re-run the read-only variable dump and assert every row now
      has either a valid `--svd-*` name or an empty name plus a description.

### Task 33: Close the three split pairs and one deprecated name

Implements **F60**.

- [ ] **Step 1:** Add the three missing halves: `--svd-focus-color` (its
      `-width` and `-offset` are present), `--svd-highlight-wash` (its
      `--svd-color-highlight` is present), and `--svd-font-sans` /
      `--svd-font-mono`.

- [ ] **Step 2:** Repoint `alias/surface-translucent`'s WEB name from
      `--svd-bg-light` to `--svd-surface-translucent`. The former is the tier-3
      alias `assets/CLAUDE.md` says to delete once its last use is gone; the
      overview should document the name meant to survive.

---

# Appendix — Re-capturing the visual baseline

Several tasks call for a screenshot diff. The sweep's baseline is 38 full-page
PNGs at 1440/1024/390 in both themes, plus computed-style dumps. To reproduce:

```bash
deno task build
DASHBOARD_PASSPHRASE='e2e passphrase: correct horse battery staple' \
DASHBOARD_SESSION_SECRET='e2e-session-secret-not-for-production' \
  deno serve -A --port 8000 _fresh/server.js &
```

Then drive `e2e/node_modules/playwright` from a standalone script (not a spec
file — the suite's `testDir` is `e2e/tests` and this is not a test): sign in
once at `/login` with the passphrase above, set `localStorage['svd-theme']` to
`light`/`dark` via `addInitScript`, and capture each of `/`, `/genes`,
`/trials`, `/map`, `/timeline`, `/phenogram` at 1440x900, 1024x900 and 390x844.

**Two traps the sweep hit, both of which produced false findings before they
were caught:**

1. **Colour must not be parsed with a regex.** Computed colours serialise as
   `oklch(...)` here, so an `rgb()`-only parser silently falls back to white and
   reports contrast failures that do not exist. Resolve every colour by
   compositing it over black and over white on a 1x1 canvas and recovering alpha
   from the difference.
2. **SVG text is painted by `fill`, not `color`,** and `.visually-hidden` is
   clipped rather than hidden. Reading `color` on `<text>` and counting clipped
   nodes produced 321 phantom failures on `/phenogram` alone.

With both corrected the baseline is **zero WCAG AA failures across all 14
page/theme combinations**. Any task that changes a colour must leave that number
at zero.
