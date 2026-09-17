# UI Touch-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the twelve items in `docs/ui-touch-ups.md`: an unframed
About-page notice, a drawer trigger that reads as a button, endpoint-qualified
service names, a published trial status with a "Study status" filter (default
hides Completed) on the trials table, radar and map, tinted empty radar wedges,
and both figure keys collapsed above their plates.

**Architecture:** Presentation fixes are CSS + markup with their contract tests.
The service names are a registry change in `pipeline/api_telemetry.py` that the
export re-applies on read, so the committed JSON follows the registry without a
new run. Trial status crosses the JSON boundary as a fourteenth `overallStatus`
key, matched by a new `matchesStatus` in `lib/filters.ts` and offered as a
checkbox group whose _default_ is not Show-All (the first such group, via an
`initial` on `useCheckboxFilters`). The radar and map gain the same group; the
radar recomputes its layout per selection, the map rebuilds its cluster layer.

**Tech Stack:** Deno + Fresh/Preact islands, `@tanstack/table-core`, Leaflet
1.9.4, Python 3 pipeline (asyncpg, pydantic), pytest, Playwright (in `e2e/`, its
own npm project).

**Spec:** `docs/superpowers/specs/2026-09-10-ui-touch-ups-design.md`

## Global Constraints

- Run every Python command through `uv run …`; never `ruff format`. TypeScript
  gates are `deno task check` (fmt, lint, `deno check`) and
  `deno task test:coverage` (100 % line floor under `lib/`).
- `uv run pytest` collects only `tests/pipeline`; run
  `uv run pytest tests/scripts` explicitly after touching `scripts/`.
- e2e runs from the repo root:
  `npx --prefix e2e playwright test -c e2e/playwright.config.ts [tests/x.spec.ts]`.
  Never run npm against the root `package.json`.
- Import the narrow data module (`lib/data/trials.ts`), never the barrel
  `lib/data.ts`, from an island.
- JSON output is byte-exact and every `data/*.json` is gated by
  `tests/pipeline/export/test_writer.py`; regenerate with `deno task data`
  (needs PostgreSQL + `.env`, see `.claude/skills/regenerate-data/SKILL.md`).
  Never hand-edit `data/*.json`.
- Sentinel strings are load-bearing: `"(unknown)"` is `UNKNOWN` in
  `lib/sentinels.ts` and is what the export writes for a NULL.
- Data colours in the two figures are SVG attributes from the encoding JSON,
  never CSS.
- Both figure plates stay white; the mechanism palette stays one hue per family.
- Print figure and About totals keep every published row (web-only default
  filter).
- Commit messages end with the attribution trailer given in the session.

---

### Task 1: About-page notice without registration marks

**Files:**

- Modify: `routes/index.tsx:231-237`
- Modify: `assets/app.css:2390-2394` (replace `.warning-card`),
  `assets/app.css:4479-4481` (comment)
- Modify: `tests/styles_contract_test.ts:455-530, 700-712`
- Modify: `assets/CLAUDE.md:50`
- Test: `tests/styles_contract_test.ts`, `e2e/tests/about.spec.ts:22`

**Interfaces:**

- Produces: CSS classes `.notice`, `.notice-warning` (not members of the surface
  recipe; no `::after`).

- [ ] **Step 1: Write the failing contract test**

Append to `tests/styles_contract_test.ts` (next to the F16 test near line 1520):

```ts
Deno.test("the About notice is not a framed surface", () => {
  // The warning used to be `.card` + `.warning-card`, which inherited the
  // recipe's registration marks. A notice is not a panel: it carries the
  // danger tint and a left stripe, and nothing else from the recipe.
  const members = recipeSelectorList();
  assert(!members.includes(".notice"), ".notice must not join the recipe");
  assert(!css.includes(".warning-card"), ".warning-card is gone");
  const notice = css.match(/\.notice\s*\{([^}]*)\}/)?.[1] ?? "";
  assert(notice !== "", "no bare `.notice` rule found");
  assert(/border-left:\s*4px solid var\(--svd-notice-color\);/.test(notice));
  assert(!/--svd-tint/.test(notice), "the notice reads no recipe parameter");
  assert(!/\.notice(?:-warning)?::after/.test(css), "no corner marks");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test tests/styles_contract_test.ts --filter "About notice"` Expected:
FAIL — `no bare .notice rule found`.

- [ ] **Step 3: Replace the markup**

In `routes/index.tsx` replace lines 231-237 with:

```tsx
<p class="notice notice-warning about-warning">
  <strong>
    This is a preview of a dashboard that is still a work in progress.
  </strong>
</p>;
```

- [ ] **Step 4: Replace the CSS**

In `assets/app.css` replace the `.warning-card` block (lines 2390-2394) with:

```css
/* A notice is a line, not a panel: it carries a colour and a stripe and
   nothing from the surface recipe -- no frame, no registration marks. The
   colour is its own custom property rather than a recipe parameter, so
   the styles contract's "declares a depth-recipe parameter" scan does not
   read it as a bare modifier. */
.notice {
  margin: 0;
  padding: var(--svd-space-3) var(--svd-space-4);
  border-left: 4px solid var(--svd-notice-color);
  border-radius: var(--svd-radius-md);
  background: color-mix(in oklab, var(--svd-notice-color) 6%,
    var(--svd-surface));
  color: var(--svd-text);
}

.notice-warning {
  --svd-notice-color: var(--svd-color-danger);
}
```

Edit the comment at `assets/app.css:4479-4481` so it no longer cites
`.warning-card` (say "the way `.about-hero` does").

- [ ] **Step 5: Retire `.warning-card` from the contract test and docs**

In `tests/styles_contract_test.ts`:

- Lines 460-463, 495, 506 and 707-712: replace mentions of `.warning-card` with
  `.about-hero` (the one remaining recipe modifier).
- Lines 497, 508, 523: the fixture strings `'<div class="card warning-card">'`
  etc. are self-contained; rename them to `about-hero` so the comments and the
  fixtures agree.

In `assets/CLAUDE.md:50` change "a chip inside a `.warning-card`" to "a chip
inside an `.about-hero`".

- [ ] **Step 6: Run the gates**

Run: `deno test tests/styles_contract_test.ts && deno task check` Expected:
PASS. The "declares a depth-recipe parameter" test must list no offenders.

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/about.spec.ts`
Expected: PASS (`.about-warning` still carries the sentence).

- [ ] **Step 7: Commit**

```bash
git add routes/index.tsx assets/app.css assets/CLAUDE.md tests/styles_contract_test.ts
git commit -m "Make the About-page notice an unframed line"
```

---

### Task 2: Drawer trigger reads as a button at rest

**Files:**

- Modify: `assets/app.css:4639-4668`
- Modify: `tests/styles_contract_test.ts:1520-1562` (the F16 test)

- [ ] **Step 1: Rewrite the F16 test to pin the new rest state**

Replace the whole
`Deno.test("F16's drawer trigger wears no fill or ring at rest, …")` with:

```ts
Deno.test("F16's drawer trigger reads as a button at rest and lifts on hover and focus-visible", () => {
  // It used to rest as a bare link -- no border, no fill -- which read as
  // text. It now wears the drawer-close treatment at rest (a visible
  // border on the light fill) and takes the accent fill and ring on
  // :hover and :focus-visible together, so a keyboard user sees the same
  // engaged state a pointer does.
  const restBlock = ruleRegion.join("\n").match(
    /\.pipeline-drawer-trigger\s*\{([^}]*)\}/,
  )?.[1] ?? "";
  assert(restBlock !== "", "no bare `.pipeline-drawer-trigger` rule found");
  assert(
    /border:\s*1px solid var\(--svd-border\);/.test(restBlock),
    `rest state must draw its border: ${restBlock}`,
  );
  assert(
    /background:\s*var\(--svd-bg-light\);/.test(restBlock),
    `rest state must have the light fill: ${restBlock}`,
  );
  assert(
    !restBlock.includes("--svd-ring-accent") &&
      !restBlock.includes("--svd-bg-hover-accent"),
    `rest state must not wear the hover tokens: ${restBlock}`,
  );

  const engagedFill = declarationsOf("background").find((d) =>
    d.selector.includes(".pipeline-drawer-trigger:hover") &&
    d.selector.includes(".pipeline-drawer-trigger:focus-visible")
  );
  assert(
    engagedFill !== undefined,
    "no rule pairs :hover with :focus-visible on the trigger",
  );
  assertEquals(engagedFill?.value, "var(--svd-bg-hover-accent)");

  const engagedRing = declarationsOf("border-color").find((d) =>
    d.selector === engagedFill?.selector
  );
  assertEquals(engagedRing?.value, "var(--svd-ring-accent)");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test tests/styles_contract_test.ts --filter "F16"` Expected: FAIL —
`rest state must draw its border`.

- [ ] **Step 3: Change the CSS**

In `assets/app.css` replace lines 4639-4668 with:

```css
/* Rest wears the drawer-close treatment -- a visible border on the light
   fill -- so the control reads as a button, not as a link in the title
   row. Both the accent fill and the ring land on :hover and :focus-visible
   together (below), so a keyboard user sees the same "this responds to
   you" state a pointer does. */
.pipeline-drawer-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--svd-space-2);
  padding: var(--svd-space-2) var(--svd-space-4);
  border: 1px solid var(--svd-border);
  border-radius: var(--svd-radius-sm);
  background: var(--svd-bg-light);
  color: var(--svd-link);
  font: inherit;
  font-size: var(--svd-text-sm);
  font-weight: var(--svd-weight-semibold);
  cursor: pointer;
  transition: background-color var(--svd-transition),
    border-color var(--svd-transition);
}

.pipeline-drawer-trigger:hover,
.pipeline-drawer-trigger:focus-visible {
  background: var(--svd-bg-hover-accent);
  border-color: var(--svd-ring-accent);
}
```

(The old `:hover`-only `border-color: var(--svd-rail-accent)` override and the
unused `transform` transition are dropped.)

- [ ] **Step 4: Run the gates**

Run: `deno test tests/styles_contract_test.ts && deno task check` Expected:
PASS.

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/about.spec.ts`
Expected: PASS (the trigger's accessible name is unchanged).

- [ ] **Step 5: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Give the run drawer trigger a button's rest state"
```

---

### Task 3: Endpoint-qualified service labels in the telemetry registry

**Files:**

- Modify: `pipeline/api_telemetry.py`
- Modify: `pipeline/pubmed_search.py:192-198` (no change needed if Step 4 is
  followed; verify)
- Test: `tests/pipeline/test_api_telemetry.py`,
  `tests/pipeline/test_api_inventory_wiring.py`

**Interfaces:**

- Produces: `display_label(service_key: str, endpoint: str) -> str` and
  `relabel_api_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]` in
  `pipeline/api_telemetry.py`. `ApiService` gains
  `endpoint_labels: tuple[tuple[str, str], ...] = ()`.
  `ApiRecorder._row(service, endpoint, method)` and `record_endpoint(...)` lose
  their `label` parameter; `_service_label` is removed.

- [ ] **Step 1: Write the failing tests**

In `tests/pipeline/test_api_telemetry.py`, change the `TestResolveService`
parametrisation rows and add a class:

```python
# In the parametrize list of test_known_services_resolve_to_display_names,
# the E-utilities and Europe PMC rows keep resolving to the *service* label:
("eutils.ncbi.nlm.nih.gov", "/entrez/eutils/esearch.fcgi", "NCBI E-utilities"),
("www.ebi.ac.uk", "/europepmc/webservices/rest/search", "Europe PMC"),
# and three new rows for the PDF hosts:
("linkinghub.elsevier.com", "/retrieve/pii/S0000", "Elsevier ScienceDirect"),
("journals.sagepub.com", "/doi/10.1177/x", "SAGE Journals"),
("www.jstage.jst.go.jp", "/article/mrms/1/2/3/_article", "J-STAGE"),
```

```python
from pipeline.api_telemetry import display_label, relabel_api_rows


class TestDisplayLabel:
    @pytest.mark.parametrize(
        ("key", "endpoint", "label"),
        [
            ("ncbi_eutils", "/entrez/eutils/esearch.fcgi", "E-utilities search"),
            ("ncbi_eutils", "/entrez/eutils/esummary.fcgi", "E-utilities summary"),
            ("ncbi_eutils", "/entrez/eutils/efetch.fcgi", "E-utilities fetch"),
            ("ncbi_eutils", "/entrez/eutils/elink.fcgi", "NCBI E-utilities"),
            ("europepmc", "/europepmc/webservices/rest/search", "Europe PMC search"),
            ("europepmc", "/europepmc/webservices/rest/:id/fullTextXML",
             "Europe PMC full text"),
            ("anthropic", "/v1/messages", "Anthropic"),
            ("mystery", "/x", "mystery"),
            # A host recorded before it was registered keeps its hostname as
            # its key; the registry can still name it on the way out.
            ("linkinghub.elsevier.com", "/retrieve/pii/:id", "Elsevier ScienceDirect"),
            ("link.springer.com", "/content/pdf/:id.pdf", "link.springer.com"),
        ],
    )
    def test_labels_are_qualified_by_endpoint(
        self, key: str, endpoint: str, label: str
    ) -> None:
        assert display_label(key, endpoint) == label

    def test_relabel_api_rows_rewrites_only_the_label(self) -> None:
        rows = [
            {"service": "ncbi_eutils", "label": "NCBI E-utilities",
             "endpoint": "/entrez/eutils/esearch.fcgi", "method": "GET", "calls": 6},
            {"service": "journals.sagepub.com", "label": "journals.sagepub.com",
             "endpoint": "/doi/:id/:id", "method": "GET", "calls": 1},
        ]
        assert relabel_api_rows(rows) == [
            {**rows[0], "label": "E-utilities search"},
            {**rows[1], "label": "SAGE Journals"},
        ]
```

Update the existing expectations that pin the old labels:

- `test_clinvar_shares_the_e_utilities_row` (line 93-101): keep — it asserts the
  _key_ only.
- `test_a_transport_failure_names_its_service_from_the_url` (line 265-277):
  `assert row.label == "E-utilities fetch"`.
- `tests/pipeline/test_api_inventory_wiring.py:84`:
  `assert [row.label for row in rows] == ["E-utilities search"]`.
- `tests/pipeline/test_api_inventory_wiring.py:160`
  (`_assert_one_error("Europe PMC")` for `fetch_europepmc_fulltext`): the
  full-text call hits `/europepmc/webservices/rest/:id/fullTextXML`, so
  `_assert_one_error("Europe PMC full text")`.

- [ ] **Step 2: Run to verify they fail**

Run:
`uv run pytest tests/pipeline/test_api_telemetry.py tests/pipeline/test_api_inventory_wiring.py -q`
Expected: FAIL — `ImportError: cannot import name 'display_label'`.

- [ ] **Step 3: Extend the registry**

In `pipeline/api_telemetry.py`:

```python
@dataclass(frozen=True, slots=True)
class ApiService:
    """An external service, as the dashboard names it.

    ``endpoint_labels`` qualifies the label for named endpoints, keyed by
    the *normalised* path (``normalize_path``) so a stored row can be
    re-labelled on the way out of the database as well as on the way in.
    The service key never changes with it: the recorder aggregates by
    (service, endpoint, method) already, so one key still yields one row
    per endpoint -- the label is the only thing that differs.
    """

    key: str
    label: str
    host_suffix: str
    path_prefix: str = ""
    endpoint_labels: tuple[tuple[str, str], ...] = ()


SERVICES: Final[tuple[ApiService, ...]] = (
    ApiService(
        "ncbi_idconv",
        "NCBI PMC ID Converter",
        "pmc.ncbi.nlm.nih.gov",
        "/tools/idconv",
    ),
    ApiService(
        "ncbi_eutils",
        "NCBI E-utilities",
        "eutils.ncbi.nlm.nih.gov",
        endpoint_labels=(
            ("/entrez/eutils/esearch.fcgi", "E-utilities search"),
            ("/entrez/eutils/esummary.fcgi", "E-utilities summary"),
            ("/entrez/eutils/efetch.fcgi", "E-utilities fetch"),
        ),
    ),
    ApiService(
        "europepmc",
        "Europe PMC",
        "ebi.ac.uk",
        "/europepmc",
        endpoint_labels=(
            ("/europepmc/webservices/rest/search", "Europe PMC search"),
            ("/europepmc/webservices/rest/:id/fullTextXML", "Europe PMC full text"),
        ),
    ),
    ApiService("unpaywall", "Unpaywall", "api.unpaywall.org"),
    ApiService("uniprot", "UniProt", "uniprot.org"),
    ApiService("clinicaltrials", "ClinicalTrials.gov", "clinicaltrials.gov"),
    ApiService("opentargets", "Open Targets", "platform.opentargets.org"),
    ApiService("orphadata", "Orphadata", "api.orphadata.com"),
    ApiService("anthropic", "Anthropic", "api.anthropic.com"),
    # Publisher hosts Unpaywall hands `download_and_parse_pdf`. The set is
    # open-ended (see `resolve_service`), so only the hosts that have
    # actually appeared in a run are named; a new one labels itself.
    ApiService("elsevier", "Elsevier ScienceDirect", "linkinghub.elsevier.com"),
    ApiService("sage", "SAGE Journals", "journals.sagepub.com"),
    ApiService("jstage", "J-STAGE", "www.jstage.jst.go.jp"),
)

_BY_KEY: Final[dict[str, ApiService]] = {service.key: service for service in SERVICES}


def display_label(service_key: str, endpoint: str) -> str:
    """The label a row shows for this service at this (normalised) endpoint.

    A key the registry does not know is either a genuinely unregistered
    host -- which labels itself, as ``resolve_service`` records it -- or a
    host that was unregistered when the row was stored and has been
    registered since. The second case is tried through ``resolve_service``
    so the export can name it without a new run.
    """
    service = _BY_KEY.get(service_key)
    if service is None:
        service = _BY_KEY.get(resolve_service(service_key, endpoint)[0])
    if service is None:
        return service_key
    for path, label in service.endpoint_labels:
        if endpoint == path:
            return label
    return service.label


def relabel_api_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-derive ``label`` on wire-form api rows from the registry.

    The stored run and sync reports carry the label a service had when the
    run happened. This is what lets a rename in ``SERVICES`` reach
    ``data/pipeline_run.json`` and ``data/pipeline_syncs.json`` on the next
    export rather than on the next run.
    """
    return [
        {**row, "label": display_label(str(row["service"]), str(row["endpoint"]))}
        for row in rows
    ]
```

Delete `_service_label`. Update `resolve_service` so its docstring's last
sentence reads "It is one service at the URL, so it is one key; `display_label`
names the endpoint." — it still returns `(service.key, service.label)`.

- [ ] **Step 4: Route the recorder through `display_label`**

In `ApiRecorder`:

```python
def _row(self, service: str, endpoint: str, method: str) -> ApiServiceRecord:
    method = method.upper()
    key = (service, endpoint, method)
    row = self._rows.get(key)
    if row is None:
        row = ApiServiceRecord(
            service=service,
            label=display_label(service, endpoint),
            endpoint=endpoint,
            method=method,
        )
        self._rows[key] = row
    return row
```

Remove the `label` keyword from `record_endpoint` and from its two callers
(`record` and `record_service_call`); `record` and `note_retry` call
`service, _ = resolve_service(host, path)`. `record_service_failure` and
`note_service_retry` become `_recorder._row(service_key, endpoint, method)`.
`pipeline/pubmed_search.py` keeps passing `"ncbi_eutils"` with the esearch
endpoint and now gets "E-utilities search" without a change; confirm with
`grep -rn "record_endpoint\|_service_label" pipeline/` that no other caller
passes `label=`.

- [ ] **Step 5: Run the Python gates**

Run:
`uv run pytest tests/pipeline/test_api_telemetry.py tests/pipeline/test_api_inventory_wiring.py -q && uv run ruff check pipeline tests && uv run ty check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pipeline/api_telemetry.py tests/pipeline/test_api_telemetry.py tests/pipeline/test_api_inventory_wiring.py
git commit -m "Qualify E-utilities and Europe PMC labels by endpoint, name three PDF hosts"
```

---

### Task 4: The export re-labels stored API rows

**Files:**

- Modify: `pipeline/export/lookups.py:248-249, 296`
- Modify: `islands/CLAUDE.md:193-197`
- Modify: `tests/pipeline_widget_test.tsx:132, 138, 235, 301`;
  `tests/pipeline_run_data_test.ts:96-97, 146`
- Test: `tests/pipeline/export/test_read_pipeline_run.py`

**Interfaces:**

- Consumes: `relabel_api_rows` from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `TestReadPipelineRun` in
`tests/pipeline/export/test_read_pipeline_run.py`:

```python
    async def test_api_labels_follow_the_registry_not_the_stored_row(
        self, mocker
    ) -> None:
        # The label is stored with the run. A rename in SERVICES has to reach
        # the committed file on the next export, not the next run.
        stored = _stored(apis=[{
            "service": "ncbi_eutils",
            "label": "NCBI E-utilities",
            "endpoint": "/entrez/eutils/esearch.fcgi",
            "method": "GET",
            "calls": 6, "ok": 6, "notFound": 0, "errors": 0,
            "retries": 0, "totalMs": 100.0, "bytes": 10,
        }, {
            "service": "journals.sagepub.com",
            "label": "journals.sagepub.com",
            "endpoint": "/doi/:id/:id",
            "method": "GET",
            "calls": 1, "ok": 0, "notFound": 0, "errors": 1,
            "retries": 0, "totalMs": 5.0, "bytes": 0,
        }])
        _connection(mocker, {"report": json.dumps(stored)})

        result = await read_pipeline_run()

        assert result is not None
        assert [row["label"] for row in result["apis"]] == [
            "E-utilities search",
            "SAGE Journals",
        ]
        assert result["apis"][0]["service"] == "ncbi_eutils"
```

If `_stored()`'s wire keys for api rows differ (check
`ApiServiceRecord.to_wire()` / `WireModel` alias rules — `not_found` →
`notFound`, `total_ms` → `totalMs`), match them.

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/export/test_read_pipeline_run.py -q`
Expected: FAIL — labels still `NCBI E-utilities` / `journals.sagepub.com`.

- [ ] **Step 3: Relabel on read**

In `pipeline/export/lookups.py` add
`from pipeline.api_telemetry import relabel_api_rows` and change line 249:

```python
wire = PipelineRunReport.model_validate(stored).to_wire()
wire["apis"] = relabel_api_rows(wire["apis"])
return wire
```

and line 296 (the sync reports) likewise:

```python
wire = SyncRunReport.model_validate(stored).to_wire()
wire["apis"] = relabel_api_rows(wire["apis"])
published.append(wire)
```

Add one sentence to `read_pipeline_run`'s docstring: "API labels are re-derived
from the registry on the way out (`relabel_api_rows`), so a rename in `SERVICES`
reaches the committed file at the next export."

- [ ] **Step 4: Update the TypeScript fixtures**

They are fixtures, not reads of the data, so they keep passing — change the
literals so they stop asserting the retired name:

- `tests/pipeline_widget_test.tsx:132` `subject: "E-utilities fetch"`, `:138`
  `label: "E-utilities fetch"`, `:235`
  `"The service asked us to slow down (E-utilities fetch)"`, `:301`
  `assertStringIncludes(markup, "E-utilities fetch")`.
- `tests/pipeline_run_data_test.ts:97` `label: "E-utilities fetch"`, `:146`
  `assertEquals(result.apis[0].label, "E-utilities fetch")`.

- [ ] **Step 5: Document the contract**

Replace the bullet at `islands/CLAUDE.md:193-197` with:

```markdown
- Source labels ride the wire rather than the encoding, as `ApiServiceRecord`'s
  label does: which database was consulted is data, not appearance. They are
  **re-derived at export**, though: `read_pipeline_run` and
  `read_pipeline_syncs` pass every api row through `relabel_api_rows` in
  `pipeline/api_telemetry.py`, so a rename in `SERVICES` (or a newly registered
  publisher host) reaches `data/pipeline_run.json` at the next `deno task data`
  rather than the next run. The cost is unchanged: a new upstream renders
  whatever Python calls it with no contract test failing.
```

- [ ] **Step 6: Run the gates**

Run:
`uv run pytest tests/pipeline/export -q && uv run ruff check . && uv run ty check && deno test tests/pipeline_widget_test.tsx tests/pipeline_run_data_test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add pipeline/export/lookups.py islands/CLAUDE.md tests/pipeline/export/test_read_pipeline_run.py tests/pipeline_widget_test.tsx tests/pipeline_run_data_test.ts
git commit -m "Re-derive API service labels from the registry at export"
```

---

### Task 5: Publish `overallStatus` in table2.json and regenerate the data

**Files:**

- Modify: `pipeline/export/main.py:200-250` (`_read_curated_trials`)
- Modify: `pipeline/export/tables.py:242-255` (`_UNKNOWN_COLUMNS`), `:377-390`
  (docstring)
- Modify: `pipeline/CLAUDE.md:1284-1348`
- Test: `tests/pipeline/export/test_export_main.py:646-760`,
  `tests/pipeline/export/test_tables.py:18-32, 425-441`
- Regenerate: `data/table2.json`, `data/pipeline_run.json` (labels from Task 4),
  `data/pipeline_syncs.json`

**Interfaces:**

- Produces: a fourteenth wire key `overallStatus` on every row of
  `data/table2.json`, last in key order, holding CT.gov's upper-case token or
  `"(unknown)"`.

- [ ] **Step 1: Write the failing tests**

In `tests/pipeline/export/test_tables.py` add `"overall_status": "RECRUITING"`
as the **last** entry of `_TRIAL` (migration 013 appended the column, so
`SELECT *` returns it last) and add:

```python
def test_overall_status_is_published_and_a_null_becomes_the_sentinel() -> None:
    assert clean_trial_row(dict(_TRIAL))["Overall Status"] == "RECRUITING"
    assert (
        clean_trial_row({**_TRIAL, "overall_status": None})["Overall Status"]
        == "(unknown)"
    )
```

In `tests/pipeline/export/test_export_main.py`, in
`TestStoppedTrialsAreNotPublished`, add:

```python
    async def test_the_status_is_published_on_every_surviving_row(self, mocker) -> None:
        # It used to be stripped here. The dashboard now filters on it.
        self._rows(mocker, [self._trial(), self._trial(
            registry_id="ISRCTN14632228", overall_status=None)])

        rows = await _read_curated_trials()

        assert [row["overall_status"] for row in rows] == ["RECRUITING", None]
```

and change `test_a_database_without_the_column_publishes_everything` to keep its
assertion (a missing key stays missing — `clean_trial_row` then raises
`KeyError`, which is the loud failure the export wants on a database below
migration 013; note that in a comment).

- [ ] **Step 2: Run to verify they fail**

Run:
`uv run pytest tests/pipeline/export/test_tables.py tests/pipeline/export/test_export_main.py -q`
Expected: FAIL — `KeyError: 'Overall Status'` and `'overall_status'` missing
from the returned rows.

- [ ] **Step 3: Stop stripping the column; fill its sentinel**

In `pipeline/export/main.py` replace the tail of `_read_curated_trials`:

```python
return running
```

and replace the docstring paragraph that begins "`overall_status` is stripped
from every row on the way out" with:

```
`overall_status` is published with the row -- as `overallStatus`, the
fourteenth key -- so the dashboard can offer a "Study status" filter
whose default hides completed trials while keeping them in the record.
A NULL (a registry ClinicalTrials.gov cannot speak for, or a row no
sweep has reached) publishes as "(unknown)" through `_UNKNOWN_COLUMNS`.
```

In `pipeline/export/tables.py` append `"Overall Status",` to `_UNKNOWN_COLUMNS`
and update the comment above it ("14 columns" — it is one of the columns
`clean_trial_row` receives; the key order follows the database column order,
where migration 013 put it last).

- [ ] **Step 4: Run the Python gates**

Run:
`uv run pytest tests/pipeline/export -q && uv run ruff check . && uv run ty check`
Expected: PASS, except
`test_trial_row_key_order_matches_the_committed_artifact`, which reads the
committed `data/table2.json` and stays red until Step 6.

- [ ] **Step 5: Check status coverage in the database**

Follow `.claude/skills/regenerate-data/SKILL.md` to reach the production
PostgreSQL, then:

```sql
SELECT overall_status, count(*)
FROM clinical_trials
WHERE svd_population IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;
```

Expected: NCT rows carry a status; only the ISRCTN/ChiCTR/ACTRN rows are NULL.
If most NCT rows are NULL, run the status sweep first (`update_trial_statuses`,
reached through the `--clinical-trials` sync in
`pipeline/clinical_trials_fetch.py:993`) and read `status_refreshed` in its
report before exporting.

- [ ] **Step 6: Regenerate**

Run: `deno task data` Expected: `data/table2.json` rows gain a trailing
`"overallStatus"`; `data/pipeline_run.json` shows "E-utilities
search/summary/fetch", "Europe PMC search/full text", "Elsevier ScienceDirect",
"SAGE Journals", "J-STAGE"; the `nctIds` set is unchanged
(`git diff --stat data/`). Do **not** run `deno task geocode` unless `nctIds`
changed.

Record the split for the later re-pins:

```bash
deno eval 'const t = JSON.parse(Deno.readTextFileSync("data/table2.json")); const c = {}; for (const r of t) c[r.overallStatus] = (c[r.overallStatus] ?? 0) + 1; console.log(t.length, c)'
```

- [ ] **Step 7: Run every gate**

Run: `uv run pytest -q && deno task check && deno task test:coverage` Expected:
PASS. `tests/pipeline/export/test_writer.py` re-encodes the regenerated files
byte-for-byte; `tests/data_contract_test.ts` tolerates the extra key (Task 6
adds it to the allowlist).

- [ ] **Step 8: Rewrite the pipeline doc**

In `pipeline/CLAUDE.md:1284-1348`, change the heading sentence to "**A
terminated or withdrawn trial is written and never published; every other status
is published as `overallStatus`.**" and replace the last bullet ("The export
gate is a denylist, and it is stripped on the way out") with:

```markdown
- **The export gate is a denylist, and the column is published.**
  `_UNPUBLISHED_TRIAL_STATUSES` in `pipeline/export/main.py` is `TERMINATED` and
  `WITHDRAWN` only: `SUSPENDED` intends to resume and `UNKNOWN` is CT.gov
  reporting that a still-recruiting sponsor stopped updating -- an information
  gap, not a stopped trial -- so publishing stays the default. NULL publishes
  too, as `"(unknown)"` through `_UNKNOWN_COLUMNS`, which is what keeps the
  ISRCTN, ChiCTR and ANZCTR rows in Table 2 forever. Every surviving row carries
  its status as the fourteenth key, `overallStatus`, because the dashboard's
  "Study status" filter (`STATUS_CHOICES` in `lib/constants.ts`, `matchesStatus`
  in `lib/filters.ts`) reads it: the default selection hides COMPLETED on the
  trials table, the radar and the map while the rows stay in the file, the print
  figure and the About totals. The map matches the same choices against
  `geocoded_trials.json`'s per-facility status, which the geocoder writes at a
  separate time; the two can disagree for a trial whose status moved between the
  two commands, and the map's own file wins there.
```

- [ ] **Step 9: Commit**

```bash
git add pipeline/export/main.py pipeline/export/tables.py pipeline/CLAUDE.md tests/pipeline/export/test_export_main.py tests/pipeline/export/test_tables.py data/table2.json data/pipeline_run.json data/pipeline_syncs.json
git commit -m "Publish overallStatus in table2.json and re-export"
```

(Include the status split from Step 6 in the commit body.)

---

### Task 6: Status vocabulary, type, boundary and matching (lib)

**Files:**

- Create: `lib/trial_status.ts`
- Modify: `lib/trials.ts:65-111` (move the status vocabulary out, re-export)
- Modify: `lib/types.ts:35-50`, `lib/data/trials.ts`, `lib/constants.ts` (after
  `SPONSOR_CHOICES`), `lib/filters.ts:136-230`
- Test: `tests/trials_test.ts`, `tests/filters_test.ts`,
  `tests/data_contract_test.ts:42-56, 457-470`

**Interfaces:**

- Produces:
  - `lib/trial_status.ts`: `type StatusKind`,
    `interface TrialStatus { label: string; className: string; kind: StatusKind }`,
    `TRIAL_STATUSES: Readonly<Record<string, TrialStatus>>`,
    `STATUS_NOT_STATED = "UNKNOWN"`, `resolveTrialStatus(value: string | null)`
    (returns `{ raw, label, className, kind }`).
  - `lib/constants.ts`: `STATUS_CHOICES: readonly FilterChoice[]` (Show All
    first), `DEFAULT_TRIAL_STATUSES: readonly string[]` (every non-Show-All
    choice except `COMPLETED`).
  - `lib/filters.ts`:
    `export interface TrialFilters { …; statuses: readonly string[] }`,
    `matchesStatus(status: string | null, selected: NormalizedSelection): boolean`,
    `defaultTrialFilters(): TrialFilters`,
    `visibleTrials(rows: readonly Trial[]): Trial[]`,
    `filterLocationsByStatus(locations: readonly TrialLocation[], statuses: readonly string[]): TrialLocation[]`.
  - `Trial.overallStatus: string`.

- [ ] **Step 1: Write the failing tests**

`tests/trials_test.ts` — the `resolveTrialStatus` expectations gain `kind`; add
`assert` to the `@std/assert` import and append:

```ts
import { STATUS_NOT_STATED, TRIAL_STATUSES } from "../lib/trial_status.ts";

Deno.test("every ClinicalTrials.gov status carries a kind, and UNKNOWN is the not-stated choice", () => {
  for (const [token, status] of Object.entries(TRIAL_STATUSES)) {
    assertMatch(token, /^[A-Z_]+$/);
    assert(
      ["recruiting", "active", "completed", "terminated", "unknown"].includes(
        status.kind,
      ),
    );
  }
  assertEquals(STATUS_NOT_STATED, "UNKNOWN");
});
```

`tests/filters_test.ts` — add `statuses: [SHOW_ALL]` to `NO_TRIAL_FILTERS` (the
file already imports `trials`, `filterTrials`, `SHOW_ALL` and
`assert`/`assertEquals`; add any it lacks) and append:

```ts
import { DEFAULT_TRIAL_STATUSES, STATUS_CHOICES } from "../lib/constants.ts";
import {
  defaultTrialFilters,
  filterLocationsByStatus,
  visibleTrials,
} from "../lib/filters.ts";
import { UNKNOWN } from "../lib/sentinels.ts";

Deno.test("status choices derive from the vocabulary and the default hides Completed", () => {
  const values = STATUS_CHOICES.map((c) => c.value);
  assertEquals(values[0], SHOW_ALL);
  assert(values.includes("COMPLETED") && values.includes("UNKNOWN"));
  assert(!values.includes("TERMINATED") && !values.includes("WITHDRAWN"));
  assertEquals(
    DEFAULT_TRIAL_STATUSES,
    values.filter((v) => v !== SHOW_ALL && v !== "COMPLETED"),
  );
});

Deno.test("status filtering folds the export sentinel onto the UNKNOWN choice", () => {
  const rows = [
    { ...trials[0], overallStatus: "COMPLETED" },
    { ...trials[0], overallStatus: " recruiting " },
    { ...trials[0], overallStatus: "UNKNOWN" },
    { ...trials[0], overallStatus: UNKNOWN },
  ];
  const only = (statuses: string[]) =>
    filterTrials(rows, { ...NO_TRIAL_FILTERS, statuses }).map((r) =>
      r.overallStatus
    );
  assertEquals(only(["COMPLETED"]), ["COMPLETED"]);
  assertEquals(only(["RECRUITING"]), [" recruiting "]);
  assertEquals(only(["UNKNOWN"]), ["UNKNOWN", UNKNOWN]);
  assertEquals(only([SHOW_ALL]).length, 4);
  assertEquals(visibleTrials(rows).length, 3);
  assertEquals(defaultTrialFilters().statuses, DEFAULT_TRIAL_STATUSES);
});

Deno.test("location status filtering treats a null status as not stated", () => {
  const site = {
    nctId: "NCT00000001",
    facilityName: "A",
    city: "B",
    state: null,
    country: "C",
    trialTitle: "T",
    status: null,
    lat: 0,
    lon: 0,
  };
  assertEquals(
    filterLocationsByStatus([site, { ...site, status: "COMPLETED" }], [
      "UNKNOWN",
    ]).length,
    1,
  );
  assertEquals(filterLocationsByStatus([site], [SHOW_ALL]).length, 1);
  assertEquals(
    filterLocationsByStatus([site], DEFAULT_TRIAL_STATUSES).length,
    1,
  );
});
```

`tests/data_contract_test.ts` — add `"overallStatus"` to `TRIAL_STRING_FIELDS`
(last), `statuses: [SHOW_ALL]` to `trialDefaults`, and
`["statuses", STATUS_CHOICES]` to `dimensions` (import `STATUS_CHOICES`).

- [ ] **Step 2: Run to verify they fail**

Run:
`deno test tests/trials_test.ts tests/filters_test.ts tests/data_contract_test.ts`
Expected: FAIL — module `lib/trial_status.ts` not found; `overallStatus` missing
on `Trial`.

- [ ] **Step 3: Create `lib/trial_status.ts` and slim `lib/trials.ts`**

```ts
/**
 * ClinicalTrials.gov's overall-status vocabulary, as both `data/table2.json`
 * (`overallStatus`, one per trial row) and `data/geocoded_trials.json`
 * (`status`, one per facility) carry it. It is its own module because
 * `lib/constants.ts` derives `STATUS_CHOICES` from it and `lib/trials.ts`
 * imports `lib/constants.ts`; a cycle between the two would evaluate the
 * choice list before the vocabulary existed.
 */

export type StatusKind =
  | "recruiting"
  | "active"
  | "completed"
  | "terminated"
  | "unknown";

export interface TrialStatus {
  label: string;
  className: string;
  kind: StatusKind;
}

function defineStatus(label: string, kind: StatusKind): TrialStatus {
  return { label, className: `popup-status-${kind}`, kind };
}

export const TRIAL_STATUSES: Readonly<Record<string, TrialStatus>> = {
  RECRUITING: defineStatus("Recruiting", "recruiting"),
  ENROLLING_BY_INVITATION: defineStatus(
    "Enrolling by Invitation",
    "recruiting",
  ),
  ACTIVE_NOT_RECRUITING: defineStatus("Active, Not Recruiting", "active"),
  NOT_YET_RECRUITING: defineStatus("Not Yet Recruiting", "active"),
  COMPLETED: defineStatus("Completed", "completed"),
  TERMINATED: defineStatus("Terminated", "terminated"),
  WITHDRAWN: defineStatus("Withdrawn", "terminated"),
  SUSPENDED: defineStatus("Suspended", "terminated"),
  UNKNOWN: defineStatus("Unknown", "unknown"),
};

/**
 * The choice that also answers for a trial with no ClinicalTrials.gov record
 * at all -- the export's "(unknown)" sentinel and a facility with a null
 * status. CT.gov's own UNKNOWN means "the sponsor stopped updating"; from the
 * dashboard's side both are "status not stated".
 */
export const STATUS_NOT_STATED = "UNKNOWN";

export interface ResolvedTrialStatus extends TrialStatus {
  raw: string;
}

/** Display label and badge class for a ClinicalTrials.gov status. */
export function resolveTrialStatus(value: string | null): ResolvedTrialStatus {
  const raw = value?.trim() ?? "";
  const status = TRIAL_STATUSES[raw.toUpperCase()];
  return {
    raw,
    label: status?.label ?? raw,
    className: status?.className ?? "popup-status-unknown",
    kind: status?.kind ?? "unknown",
  };
}
```

In `lib/trials.ts` delete lines 65-111 and add
`export { resolveTrialStatus, type ResolvedTrialStatus } from "./trial_status.ts";`
so `islands/TrialsMap.tsx` and `components/MapPopup.tsx` keep their import.

- [ ] **Step 4: Type, boundary, choices**

`lib/types.ts` — after `sponsorType: string;` add:

```ts
/** ClinicalTrials.gov overall status token, or "(unknown)" when no registry record answers. */
overallStatus: string;
```

`lib/data/trials.ts` — after `sponsorType:` add
`overallStatus: text(source.overallStatus, UNKNOWN),`.

`lib/constants.ts` — after `SPONSOR_CHOICES`:

```ts
import { STATUS_NOT_STATED, TRIAL_STATUSES } from "./trial_status.ts";

/**
 * Derived from the status vocabulary rather than restated: every published
 * token needs a choice or `tests/data_contract_test.ts` fails. TERMINATED
 * and WITHDRAWN never publish (`_UNPUBLISHED_TRIAL_STATUSES` in
 * pipeline/export/main.py); SUSPENDED can, so it keeps a choice.
 */
export const STATUS_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  ...Object.entries(TRIAL_STATUSES)
    .filter(([token, status]) =>
      status.kind !== "terminated" || token === "SUSPENDED"
    )
    .map(([token, status]) => (
      token === STATUS_NOT_STATED
        ? {
          label: status.label,
          value: token,
          description: "registry not updated, or no ClinicalTrials.gov record",
        }
        : { label: status.label, value: token }
    )),
];

/** The first filter default that is not Show-All: completed trials stay in the record and off the page. */
export const DEFAULT_TRIAL_STATUSES: readonly string[] = STATUS_CHOICES
  .map((choice) => choice.value)
  .filter((value) => value !== SHOW_ALL && value !== "COMPLETED");
```

(Check `FilterChoice` in `lib/types.ts` has the optional `description`;
`components/CheckboxFilter.tsx:87-105` already renders it.)

- [ ] **Step 5: Matching**

In `lib/filters.ts`:

```ts
import { DEFAULT_TRIAL_STATUSES, YES_NO_CHOICES } from "./constants.ts";
import { isAbsent } from "./sentinels.ts";
import { STATUS_NOT_STATED } from "./trial_status.ts";
import type { Trial, TrialLocation } from "./types.ts";

export interface TrialFilters {
  geneticEvidence: readonly string[];
  registries: readonly string[];
  phases: readonly string[];
  populations: readonly string[];
  sponsors: readonly string[];
  statuses: readonly string[];
}

/**
 * A row with no ClinicalTrials.gov record publishes "(unknown)", a facility
 * with none carries null; both answer the same choice as CT.gov's UNKNOWN.
 */
function matchesStatus(
  status: string | null,
  selected: NormalizedSelection,
): boolean {
  const value = status === null || isAbsent(status)
    ? STATUS_NOT_STATED
    : status;
  return matches(value, selected);
}
```

In `filterTrials` destructure `statuses`, add
`const wantedStatuses = activeSelection(statuses);` and, before `return true`:

```ts
if (wantedStatuses && !matchesStatus(trial.overallStatus, wantedStatuses)) {
  return false;
}
```

Then add:

```ts
/** Every group unconstrained except status, which starts without Completed. */
export function defaultTrialFilters(): TrialFilters {
  return {
    geneticEvidence: YES_NO_CHOICES.map((choice) => choice.value),
    registries: [SHOW_ALL],
    phases: [SHOW_ALL],
    populations: [SHOW_ALL],
    sponsors: [SHOW_ALL],
    statuses: [...DEFAULT_TRIAL_STATUSES],
  };
}

/** The rows a page shows before anyone touches a filter. */
export function visibleTrials(rows: readonly Trial[]): Trial[] {
  return filterTrials(rows, defaultTrialFilters());
}

/** The map's facilities under a status selection. */
export function filterLocationsByStatus(
  locations: readonly TrialLocation[],
  statuses: readonly string[],
): TrialLocation[] {
  const wanted = activeSelection(statuses);
  if (!wanted) return [...locations];
  return locations.filter((location) => matchesStatus(location.status, wanted));
}
```

If `lib/constants.ts` already imports from `lib/filters.ts` (check with
`grep -n "filters" lib/constants.ts`), move `defaultTrialFilters` and
`DEFAULT_TRIAL_STATUSES` usage so no cycle forms; today `constants.ts` imports
only `types.ts`, `sentinels.ts` and `vocabulary.json`.

- [ ] **Step 6: Run the gates**

Run:
`deno test tests/trials_test.ts tests/filters_test.ts tests/data_contract_test.ts && deno task check && deno task test:coverage`
Expected: PASS; coverage under `lib/` stays at 100 % (the tests above cover
every new branch).

- [ ] **Step 7: Commit**

```bash
git add lib/trial_status.ts lib/trials.ts lib/types.ts lib/data/trials.ts lib/constants.ts lib/filters.ts tests/trials_test.ts tests/filters_test.ts tests/data_contract_test.ts
git commit -m "Add the study-status vocabulary, choices and matcher"
```

---

### Task 7: A filter group with a non-Show-All default

**Files:**

- Modify: `components/useCheckboxFilters.ts`
- Modify: `CLAUDE.md` "Filtering" section (one paragraph)
- Test: `tests/checkbox_filters_test.tsx`

**Interfaces:**

- Produces: `FilterDefinition.initial?: readonly string[]`; `useCheckboxFilters`
  seeds and `reset()`s from it; `initial` is never forwarded to
  `CheckboxFilter`.

- [ ] **Step 1: Write the failing test**

Append to `tests/checkbox_filters_test.tsx`:

```ts
Deno.test("a definition's initial selection seeds the group and survives reset", () => {
  const definitions = {
    status: {
      label: "Study status",
      choices: [
        { value: SHOW_ALL, label: "Show All" },
        { value: "RECRUITING", label: "Recruiting" },
        { value: "COMPLETED", label: "Completed" },
      ],
      initial: ["RECRUITING"],
    },
  } as const;
  const snapshots: Array<{ values: { status: string[] }; summary: string[] }> =
    [];

  function Harness() {
    const { values, controls, summary, reset } = useCheckboxFilters(
      definitions,
    );
    snapshots.push({ values, summary });
    assertEquals("initial" in controls[0], false);
    if (snapshots.length === 1) controls[0].onChange([SHOW_ALL]);
    else if (snapshots.length === 2) reset();
    return null;
  }

  renderToString(<Harness />);

  const seeded = {
    values: { status: ["RECRUITING"] },
    summary: ["Study status: Recruiting"],
  };
  assertEquals(snapshots, [
    seeded,
    { values: { status: [SHOW_ALL] }, summary: [] },
    seeded,
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test tests/checkbox_filters_test.tsx` Expected: FAIL — first snapshot
is `[SHOW_ALL]`.

- [ ] **Step 3: Implement `initial`**

Replace `components/useCheckboxFilters.ts` lines 10-31 with:

```ts
type FilterDefinition = Omit<CheckboxFilterConfig, "selected" | "onChange"> & {
  /**
   * The selection the group starts with and returns to on reset. Absent,
   * a binary group starts with both choices and a showAll group with
   * Show All -- both "unconstrained". The trials pages' "Study status" is
   * the one group that starts constrained (every status but Completed),
   * and the "Active Filters:" line reports it on first paint on purpose.
   */
  initial?: readonly string[];
};

/** One definition owns each filter's controls, initial selection and reset. */
export function useCheckboxFilters<K extends string>(
  definitions: Record<K, FilterDefinition>,
) {
  const keys = Object.keys(definitions) as K[];
  const initialValues = () => {
    const values = {} as Record<K, string[]>;
    for (const key of keys) {
      const { mode, choices, initial } = definitions[key];
      values[key] = initial
        ? [...initial]
        : mode === "binary"
        ? choices.map((choice) => choice.value)
        : [SHOW_ALL];
    }
    return values;
  };
  const [values, setValues] = useState(initialValues);
  const controls: CheckboxFilterConfig[] = keys.map((key) => {
    const { initial: _initial, ...definition } = definitions[key];
    return {
      ...definition,
      selected: values[key],
      onChange: (selected) =>
        setValues((previous) => ({ ...previous, [key]: selected })),
    };
  });
```

(`deno lint` allows the `_initial` unused-prefix.)

- [ ] **Step 4: Document**

In `CLAUDE.md`, "Filtering" section, after the paragraph on the two non-obvious
matching rules, add:

```markdown
One group starts constrained: the trials pages' "Study status" seeds
`DEFAULT_TRIAL_STATUSES` (every status but Completed) through the `initial`
field on a `useCheckboxFilters` definition, and `reset()` returns to it rather
than to Show All. The `Active Filters:` line therefore reports it on first
paint, which is intended -- it is what tells a viewer completed trials are
hidden. `visibleTrials()` in `lib/filters.ts` is the same default as a function,
for the SSR tests and any count that has to agree with the page.
```

- [ ] **Step 5: Run the gates and commit**

Run: `deno test tests/checkbox_filters_test.tsx && deno task check` Expected:
PASS.

```bash
git add components/useCheckboxFilters.ts tests/checkbox_filters_test.tsx CLAUDE.md
git commit -m "Let a checkbox filter group declare its initial selection"
```

---

### Task 8: Trials table — the Study status group and column

**Files:**

- Modify: `islands/TrialsView.tsx:18-25, 128-195, 197-219`
- Modify: `tests/routes_test.tsx:207-218`
- Modify: `e2e/tests/trials-filters.spec.ts`, `e2e/tests/trials-table.spec.ts`,
  `e2e/tests/readout.spec.ts:34-51, 64-70`, `e2e/tests/tooltips.spec.ts:345-392`
- Test: as listed

**Interfaces:**

- Consumes: `STATUS_CHOICES`, `DEFAULT_TRIAL_STATUSES` (Task 6), `initial` (Task
  7), `resolveTrialStatus` (Task 6), `visibleTrials` (Task 6).

- [ ] **Step 1: Update the SSR test first**

In `tests/routes_test.tsx:207-218` import `visibleTrials` from
`../lib/filters.ts` and replace the `showing … rows` assertion with:

```ts
const shown = visibleTrials(trials).length;
assertStringIncludes(html, `showing ${shown} of ${trials.length} rows`);
assertStringIncludes(html, "Study status");
assertStringIncludes(html, "Study Status");
```

Run: `deno test tests/routes_test.tsx --filter "Trials route"` Expected: FAIL —
the page still shows every row and no status group.

- [ ] **Step 2: Add the group and the column**

In `islands/TrialsView.tsx`:

- Import `DEFAULT_TRIAL_STATUSES, STATUS_CHOICES` from `../lib/constants.ts` and
  `resolveTrialStatus` from `../lib/trials.ts`.
- After the `registryId` column definition add:

```tsx
column.accessor("overallStatus", {
  header: "Study Status",
  cell: ({ row }) =>
    isAbsent(row.original.overallStatus)
      ? <Absent />
      : resolveTrialStatus(row.original.overallStatus).label,
}),
```

- Add to `FILTERS` (last):

```ts
statuses: {
  label: "Study status",
  choices: STATUS_CHOICES,
  initial: DEFAULT_TRIAL_STATUSES,
},
```

Run: `deno test tests/routes_test.tsx && deno task check` Expected: PASS.

- [ ] **Step 3: Re-pin the e2e specs**

Compute the new numbers from the regenerated file (Task 5, Step 6) — call the
default-visible row count `SHOWN`:

```bash
deno eval 'import { trials } from "./lib/data/trials.ts"; import { visibleTrials, filterTrials, defaultTrialFilters } from "./lib/filters.ts"; const v = visibleTrials(trials); console.log({ total: trials.length, shown: v.length, evidenceYes: v.filter(t => t.geneticEvidence === "Yes").length, cadasil: v.filter(t => JSON.stringify(t).includes("CADASIL")).length, academic: v.filter(t => t.sponsorType === "Academic").length })'
```

Then:

- `e2e/tests/trials-filters.spec.ts`: keep `TOTAL = 102`, add
  `const SHOWN = <n>` and `const STATUS = "Study status"`. "starts
  unconstrained" becomes "starts with completed trials hidden":
  `expectSummary(page, "Study status: Recruiting, Enrolling by Invitation, Active, Not Recruiting, Not Yet Recruiting, Suspended, Unknown")`
  (the labels in `STATUS_CHOICES` order), `expectRowCount(page, SHOWN, TOTAL)`,
  the five old groups read "All" and `filterCount(page, STATUS)` reads the
  active count. Add a test that ticks `choice(page, STATUS, "Show All")` and
  expects `TOTAL` of `TOTAL`, and one that unticks every status but "Completed"
  and expects `TOTAL - SHOWN`. Every per-choice count in the file is recomputed
  against the default-visible set (`v` above), including the clear-all test
  (`reset` returns to the seeded default, so its `expectSummary` is the status
  line, not "None", and the status group has `DEFAULT_TRIAL_STATUSES.length`
  checked boxes). "every group renders its full choice list" gains `STATUS` with
  `STATUS_CHOICES.length` checkboxes (7: Show All + 6).
- `e2e/tests/trials-table.spec.ts`: `TOTAL` becomes the pair `SHOWN`/`TOTAL` in
  the banner (`showing ${SHOWN} of ${TOTAL}`), page counts at 10/25/100
  recomputed from `SHOWN`, "thirteen columns" → fourteen (`toHaveCount(14)`,
  `new Array(14)`), first cell / Aspirin rowspan / "CADASIL" / "Academic" counts
  recomputed. If Aspirin or Acetylcysteine is hidden by default, pick the first
  visible drug and the first visible multi-row drug.
- `e2e/tests/readout.spec.ts:34-51`: the first `.readout-stat-value` reads
  `${SHOWN}\s*/\s*${TOTAL}`; the phase-label list is `PHASES` — every phase
  present in the _full_ data still renders (`TRIALS_PER_PHASE` is computed from
  `trials`), so the seven labels stay. Line 64-70's "CADASIL" count recomputed.
- `e2e/tests/tooltips.spec.ts:345-392`: confirm `NCT05755997`, the four gene
  rows and `FGA, FGB, FGG` are in `v`; if one is COMPLETED, tick "Show All" in
  the status group at the top of that test.

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/trials-filters.spec.ts tests/trials-table.spec.ts tests/readout.spec.ts tests/tooltips.spec.ts tests/filter-collapse.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add islands/TrialsView.tsx tests/routes_test.tsx e2e/tests/trials-filters.spec.ts e2e/tests/trials-table.spec.ts e2e/tests/readout.spec.ts e2e/tests/tooltips.spec.ts
git commit -m "Trials table: Study status group (Completed hidden by default) and column"
```

(List the recomputed counts in the body.)

---

### Task 9: Radar — the same group, layout recomputed per selection

**Files:**

- Modify: `islands/TrialsTimeline.tsx` (module constants at 34-40; the legend at
  424-520; the component from 676; the JSX at 1019-1267)
- Modify: `assets/app.css` (new `.timeline-controls` rules beside
  `.timeline-layout`)
- Modify: `tests/routes_test.tsx:231-250`
- Modify: `e2e/tests/timeline.spec.ts`,
  `e2e/tests/performance-behavior.spec.ts:96-125`
- Test: as listed

**Interfaces:**

- Consumes: `useCheckboxFilters` with `initial` (Task 7),
  `filterTrials`/`defaultTrialFilters` (Task 6), `CheckboxFilter`.
- Produces: `TimelineLegend({ layout })` takes the layout as a prop;
  `populationTitle(sectors, key)`.

- [ ] **Step 1: SSR test first**

In `tests/routes_test.tsx:231-250` replace each `trials.length` with
`visibleTrials(trials).length` and add
`assertStringIncludes(html, "Study status");`.

Run: `deno test tests/routes_test.tsx --filter "Timeline route"` Expected: FAIL
— `class="drug"` count is still `trials.length`.

- [ ] **Step 2: Thread the layout through the island**

In `islands/TrialsTimeline.tsx`:

- Replace lines 34-40 with:

```ts
// add `useMemo` to the existing `preact/hooks` import at the top of the file
import { CheckboxFilter } from "../components/CheckboxFilter.tsx";
import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { DEFAULT_TRIAL_STATUSES, STATUS_CHOICES } from "../lib/constants.ts";
import { defaultTrialFilters, filterTrials } from "../lib/filters.ts";

const RADAR_FILTERS = {
  statuses: {
    label: "Study status",
    choices: STATUS_CHOICES,
    initial: DEFAULT_TRIAL_STATUSES,
  },
} as const;

type Layout = ReturnType<typeof computeTimelineLayout>;

/** A sector's display title, falling back to its raw key. */
const populationTitle = (layout: Layout, key: string) =>
  layout.sectors.find((s) => s.key === key)?.label.join(" ") ?? key;
```

- `function TimelineLegend({ layout }: { layout: Layout })` — replace every
  `LAYOUT.` inside it with `layout.`.
- In the component, first lines:

```ts
const { values, controls, summary } = useCheckboxFilters(RADAR_FILTERS);
const filtered = useMemo(
  () =>
    filterTrials(trials, {
      ...defaultTrialFilters(),
      statuses: values.statuses,
    }),
  [values],
);
const layout = useMemo(() => computeTimelineLayout(filtered), [filtered]);
```

- Replace every remaining `LAYOUT.` with `layout.` and every
  `populationTitle(x)` with `populationTitle(layout, x)`; `SECTOR_BY_KEY` goes.
- The measurement pass is a function of the layout, so a new layout restarts it.
  After the `useLayoutEffect(() => measureRef.current(), [nudges, shifts])` line
  add:

```ts
// A new selection is a new figure: the drawer's index and every measured
// box, nudge and shift belong to the old marker set. Reset them all and
// let the mount pass run again over the new labels.
const mountedLayout = useRef(layout);
useLayoutEffect(() => {
  if (mountedLayout.current === layout) return;
  mountedLayout.current = layout;
  restoreFocusTo.current = null;
  nudgePasses.current = 0;
  solvedGeometry.current = undefined;
  dispatchInteraction({ type: "close-drawer" });
  dispatchInteraction({ type: "hide-tooltip" });
  setBoxes(new Map());
  setNudges(new Map());
  setShifts(new Map());
}, [layout]);
```

(Check the reducer's action names at the top of the file — `close-drawer` and
`hide-tooltip` are the ones `close()` and `hide()` dispatch.)

- In the JSX, between the skip link and `<div class="timeline-main">` insert:

```tsx
<div class="timeline-controls">
  {controls.map((props) => <CheckboxFilter key={props.label} {...props} />)}
  <p class="timeline-controls-count" role="status">
    Showing {filtered.length} of {trials.length} trials
    {summary.length > 0 ? ` · ${summary.join("; ")}` : ""}
  </p>
</div>;
```

and change `<TimelineLegend />` to `<TimelineLegend layout={layout} />`.

- [ ] **Step 3: Style the strip**

In `assets/app.css`, after the `.timeline-layout` rule:

```css
/* The status group above the plate: the sidebar's fieldset laid out as a
   row, since the radar has no sidebar. The count line is what the tables'
   `Active Filters:` line is here -- it says completed trials are hidden. */
.timeline-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--svd-space-3) var(--svd-space-5);
}

.timeline-controls .filter-group {
  margin: 0;
}

.timeline-controls .filter-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--svd-space-2) var(--svd-space-4);
}

.timeline-controls-count {
  margin: 0;
  align-self: center;
  font-size: var(--svd-text-sm);
  color: var(--svd-text-muted);
}
```

Read the `.filter-group` / `.filter-options` base rules under the "FILTER
SIDEBAR" banner first and override only what the sidebar sets (a `min-width`, a
bottom margin, a column `display`).

Run:
`deno test tests/routes_test.tsx tests/timeline_layout_test.ts && deno task check`
Expected: PASS (the layout test reads the raw `trials`, so its numbers are
unchanged).

- [ ] **Step 4: Re-pin and re-verify the e2e**

```bash
deno eval 'import { trials } from "./lib/data/trials.ts"; import { visibleTrials } from "./lib/filters.ts"; import { computeTimelineLayout } from "./lib/timeline.ts"; const l = computeTimelineLayout(visibleTrials(trials)); console.log({ markers: l.markers.length, empty: l.cells.filter(c => !c.filled).length, rings: l.markers.filter(m => m.evidenceRing).length, dashes: l.markers.filter(m => m.evidenceDash).length, gaps: l.markers.filter(m => m.flagReasons.length).length, families: l.familyLegend.length, mechanisms: l.familyLegend.reduce((n, f) => n + f.entries.length, 0), firstCAA: l.markers[0].trial.drug, bands: l.rimBands.length })'
```

In `e2e/tests/timeline.spec.ts` replace: `g.drug` 102 → `markers`;
`circle.evidence` 21 → `rings`; `circle.gap` 16 → `gaps`; `path.rim-band` 4 →
`bands`; `.timeline-legend-family` 13 → `families`; `.timeline-legend-item` 50 →
`3 + 1 + mechanisms`; swatch set size 46 → `mechanisms`; the 9-dashed/12-solid
split → `dashes`/`rings - dashes`; the drawer heading `"Jiedu Huayu"` →
`firstCAA`; the tooltip's `BAC` and `Cerebrolysin`/`NCT05755997` fixtures must
be in the visible set, else tick Show All in the status group first
(`page.getByRole("group", { name: /^Study status/ }).getByRole("checkbox", { name: /^Show All/ }).check()`).
In the label sweep (lines 106-220) set `boxes` to `markers + 11` and `markers`;
the `colliding: []`, `touching: []`, `misfit: []`, `clipped: []` pins **stay at
zero** — if any is non-zero, fix the layout (this is a real regression), do not
renumber. In `e2e/tests/performance-behavior.spec.ts:96-125` `text[data-label]`
113 → `markers + 11` and `g.drug` 102 → `markers`. Add one test:

```ts
test("ticking Show All in the study-status group draws every trial", async ({ page }) => {
  await figureSettled(page);
  const group = page.getByRole("group", { name: /^Study status/ });
  await group.getByRole("checkbox", { name: /^Show All/ }).check();
  await expect(page.locator(FIGURE).locator("g.drug")).toHaveCount(102);
  await expect(page.locator(".timeline-controls-count")).toContainText(
    "Showing 102 of 102 trials",
  );
});
```

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts tests/performance-behavior.spec.ts tests/runtime.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add islands/TrialsTimeline.tsx assets/app.css tests/routes_test.tsx e2e/tests/timeline.spec.ts e2e/tests/performance-behavior.spec.ts
git commit -m "Radar: Study status group, layout recomputed per selection"
```

---

### Task 10: Empty wedges take their population's colour

**Files:**

- Modify: `lib/timeline_encoding.json:92-95`, `lib/timeline.ts:93, 404-419`,
  `scripts/timeline_figure.py:236-250`
- Test: `tests/timeline_layout_test.ts:87-103`,
  `tests/timeline_encoding_test.ts:38, 220-221`,
  `tests/scripts/test_timeline_figure.py:78-94`

- [ ] **Step 1: Change the three tests**

`tests/timeline_layout_test.ts:87-103`:

```ts
Deno.test("twenty-eight cells; an empty one keeps its population's colour at the empty-cell opacity", () => {
  assertEquals(layout.cells.length, 28);
  const empty = layout.cells.filter((c) => !c.filled)
    .map((c) => [c.population, c.phase]);
  assertEquals(empty, EMPTY_CELLS);
  for (const cell of layout.cells) {
    const population = encoding.populations.find((p) =>
      p.key === cell.population
    )!;
    assertEquals(
      cell.color,
      population.color,
      `${cell.population}/${cell.phase}`,
    );
    if (!cell.filled) assertEquals(cell.opacity, encoding.emptyCell.opacity);
    else {assert(
        cell.opacity > encoding.emptyCell.opacity,
        "a filled cell reads darker than an empty one",
      );}
    assert(cell.path.startsWith("M "), "cell has no path");
  }
});
```

`tests/timeline_encoding_test.ts`: line 38 becomes
`emptyCell: { opacity: number };`, lines 220-221 become
`assert(encoding.emptyCell.opacity > 0 && encoding.emptyCell.opacity < Math.min(...encoding.rings.map((r) => r.opacity)), "an empty cell is fainter than every filled ring");`.

`tests/scripts/test_timeline_figure.py:78-94`:
`expected = colours[cell.population]` for every cell, and
`assert cell.opacity == encoding["emptyCell"]["opacity"]` when
`not cell.filled`.

Run:
`deno test tests/timeline_layout_test.ts tests/timeline_encoding_test.ts; uv run pytest tests/scripts/test_timeline_figure.py -q`
Expected: FAIL — empty cells are `#ffffff`.

- [ ] **Step 2: Change the encoding and both renderers**

`lib/timeline_encoding.json`:

```json
"emptyCell": {
  "opacity": 0.1
},
```

`lib/timeline.ts:93`: `emptyCell: { opacity: number };` and at 416-417:

```ts
color: sector.color,
opacity: filled ? ring.opacity : enc.emptyCell.opacity,
```

`scripts/timeline_figure.py:245-248`:

```python
color=sector.color,
opacity=(
    ring["opacity"] if filled else encoding["emptyCell"]["opacity"]
),
```

- [ ] **Step 3: Verify, look, commit**

Run:
`deno test tests/timeline_layout_test.ts tests/timeline_encoding_test.ts && uv run pytest tests/scripts -q && deno task check && deno task figure`
Expected: PASS; open `figures/` output and the `/timeline` page — the empty
cells read as a faint tint of their sector, the `boundary` hairline still
visible between cells. If 0.1 is too faint against the white plate, raise it but
keep it below the faintest ring.

```bash
git add lib/timeline_encoding.json lib/timeline.ts scripts/timeline_figure.py tests/timeline_layout_test.ts tests/timeline_encoding_test.ts tests/scripts/test_timeline_figure.py
git commit -m "Radar: empty cells keep their population colour at a faint opacity"
```

---

### Task 11: Radar key above the plate, collapsed

**Files:**

- Modify: `islands/TrialsTimeline.tsx` (legend wrapper at 424-426; JSX at
  1027-1028 and 1267)
- Modify: `assets/app.css:3199-3212` (skip link), `:3283-3303` (comment), new
  `.figure-key` / `.figure-end` rules
- Modify: `CLAUDE.md` "Timeline" section (the "The key sits under the plate,
  always" paragraph)
- Test: `e2e/tests/timeline.spec.ts:43-72, 600-649, 731-739`,
  `tests/routes_test.tsx:231-250`

**Interfaces:**

- Produces: `<details class="figure-key" id="timeline-key">` with
  `<summary>Key</summary>`;
  `<p class="figure-end" id="timeline-end" tabIndex={-1}>`; CSS `.figure-key`,
  `.figure-key > summary`, `.figure-end` (shared with Task 12).

- [ ] **Step 1: Update the e2e first**

`e2e/tests/timeline.spec.ts:731-739`:

```ts
test("a keyboard user can skip the figure to its end", async ({ page }) => {
  await page.goto("/timeline");
  const skip = page.getByRole("link", { name: "Skip the figure" });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await skip.press("Enter");
  await expect(page.locator("#timeline-end")).toBeInViewport();
  await expect(page.locator("#timeline-end")).toBeFocused();
});

test("the key sits above the plate and opens on demand", async ({ page }) => {
  await figureSettled(page);
  const key = page.locator("#timeline-key");
  await expect(key).not.toHaveAttribute("open", "");
  await expect(key.locator(".timeline-legend")).toBeHidden();
  const keyBox = await key.boundingBox();
  const plateBox = await page.locator(".timeline-main > .blueprint-frame")
    .boundingBox();
  expect(keyBox!.y + keyBox!.height).toBeLessThanOrEqual(plateBox!.y);
  await key.locator("summary").click();
  await expect(key.locator(".timeline-legend")).toBeVisible();
});
```

Add a helper
`async function openKey(page: Page) { await page.locator("#timeline-key summary").click(); }`
and call it before the legend assertions in "draws one group per trial…" (lines
43-72, after `figureSettled`) and in the dark-mode test (600-649, after
`switchToDarkTheme`).

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts -g "key|skip"`
Expected: FAIL — no `#timeline-end`, key is not a `<details>`.

- [ ] **Step 2: Move and wrap the key**

In `islands/TrialsTimeline.tsx`:

- `TimelineLegend` returns:

```tsx
<details class="figure-key" id="timeline-key">
  <summary class="figure-key-summary">Key</summary>
  <div class="timeline-legend">
    … (the three sections, unchanged)
  </div>
</details>;
```

(Drop `tabIndex={-1}` — the `<summary>` is focusable.)

- In the JSX: skip link becomes
  `<a class="skip-figure" href="#timeline-end">Skip the figure</a>`; place
  `<TimelineLegend layout={layout} />` **after** `.timeline-controls` and
  **before** `<div class="timeline-main">`; after `.timeline-main`'s closing tag
  add
  `<p class="figure-end" id="timeline-end" tabIndex={-1}>End of the trials radar</p>`;
  delete the old `<TimelineLegend />` below the plate. Update the docblock above
  `TimelineLegend` ("The key, rendered under the plate…") to say "above the
  plate, collapsed".

- [ ] **Step 3: CSS**

In `assets/app.css` extend the skip-link rules (3199-3212) so `.figure-end`
shares them:

```css
.skip-figure:not(:focus),
.figure-end:not(:focus) {
  …existing visually-hidden declarations…
}

.skip-figure:focus,
.figure-end:focus {
  display: inline-block;
  padding: var(--svd-space-1) var(--svd-space-2);
}

.figure-end {
  margin: 0;
}
```

Add, next to `.timeline-legend`:

```css
/* Both keys sit above their plate, closed on load, so the figure stays near
   the top of the page: expanded, six families of long mechanism names push
   the radar below the fold, which is why the key used to sit below. The
   summary is the same clickable pill `.pipeline-apis summary` is. */
.figure-key {
  min-width: 0;
}

.figure-key > summary {
  display: inline-flex;
  align-items: center;
  gap: var(--svd-space-2);
  padding: var(--svd-space-2) var(--svd-space-3);
  border: 1px solid var(--svd-border);
  border-radius: var(--svd-radius-sm);
  background: var(--svd-bg-light);
  color: var(--svd-primary);
  font-weight: var(--svd-weight-bold);
  cursor: pointer;
  list-style: none;
}

.figure-key > summary::-webkit-details-marker {
  display: none;
}

.figure-key > summary::marker {
  content: '';
}

.figure-key > summary::before {
  content: '▸';
  transition: transform var(--svd-transition);
}

.figure-key[open] > summary::before {
  transform: rotate(90deg);
}

.figure-key > summary:hover,
.figure-key > summary:focus-visible {
  background: var(--svd-bg-hover-accent);
  border-color: var(--svd-ring-accent);
}

.figure-key[open] > summary {
  margin-bottom: var(--svd-space-4);
}
```

Rewrite the comment block at 3283-3290 ("Plate first, key under it — always…")
to: "Key first, collapsed, then the plate: the key is a `<details>` closed on
load so the radar stays above the fold (open, its mechanism families ran the
page long). `.timeline-layout` is still a plain column; `align-items: stretch`
(the default) is load-bearing — at flex-start the column sizes itself to the
1072px plate and the document overflows instead of the scroll container
scrolling."

- [ ] **Step 4: Docs and gates**

In `CLAUDE.md`, Timeline section, replace the paragraph beginning "**The key
sits under the plate, always**" with:

```markdown
**The key sits above the plate, collapsed** -- a `<details class="figure-key">`
closed on load, the phenogram's arrangement too. It was a right-hand rail once
(dropped below the figure at 1453px, with a stacking breakpoint, a sticky rail
and two `:has()` queries to arbitrate the column against the open drawer), then
a block under the plate. Above and open it pushed the radar below the fold --
six families of long mechanism names -- so it opens on demand. The skip link
targets `#timeline-end`, a focusable `.figure-end` line after the plate, not the
key: "skip the figure" has to land past the 100-odd marker buttons.
```

Run:
`deno test tests/routes_test.tsx && deno task check && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts tests/runtime.spec.ts tests/theme.spec.ts`
Expected: PASS. `tests/routes_test.tsx` still finds "Mechanism of action" and
"Genetic evidence" in the SSR HTML (a closed `<details>` still renders its
content).

- [ ] **Step 5: Commit**

```bash
git add islands/TrialsTimeline.tsx assets/app.css CLAUDE.md e2e/tests/timeline.spec.ts
git commit -m "Radar: key above the plate as a collapsed details"
```

---

### Task 12: Phenogram key above the plate, collapsed

**Files:**

- Modify: `islands/Phenogram.tsx:309-316, 367-…` (legend block)
- Modify: `assets/app.css:3210-3222` (comment)
- Modify: `CLAUDE.md` "Phenogram" section ("Its key sits under the plate too"
  paragraph)
- Test: `e2e/tests/phenogram.spec.ts:22-37, 196-204`,
  `tests/routes_test.tsx:220-230`

**Interfaces:**

- Consumes: `.figure-key`, `.figure-end` CSS from Task 11.

- [ ] **Step 1: Update the e2e first**

`e2e/tests/phenogram.spec.ts:196-204`:

```ts
test("a keyboard user can skip the figure to its end", async ({ page }) => {
  await page.goto("/phenogram");
  const skip = page.getByRole("link", { name: "Skip the figure" });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await skip.press("Enter");
  await expect(page.locator("#phenogram-end")).toBeInViewport();
  await expect(page.locator("#phenogram-end")).toBeFocused();
});

test("the key sits above the plate and opens on demand", async ({ page }) => {
  await page.goto("/phenogram");
  const key = page.locator("#phenogram-key");
  await expect(key).not.toHaveAttribute("open", "");
  const keyBox = await key.boundingBox();
  const plateBox = await page.locator(".phenogram-layout > .blueprint-frame")
    .boundingBox();
  expect(keyBox!.y + keyBox!.height).toBeLessThanOrEqual(plateBox!.y);
  await key.locator("summary").click();
  await expect(key.locator(".phenogram-legend")).toBeVisible();
});
```

In the first test (22-37) the `.phenogram-legend-family` count and the
trait-pill count are counts of attached elements and pass closed; the pill-fit
sweep (55-97) measures `getBBox()` on the SVG, not the key. If any legend
assertion needs geometry, click the summary first.

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/phenogram.spec.ts -g "key|skip"`
Expected: FAIL.

- [ ] **Step 2: Move and wrap the key**

In `islands/Phenogram.tsx`: the skip link becomes `href="#phenogram-end"`; move
the `<div class="phenogram-legend" id="phenogram-key" tabIndex={-1}>…</div>`
block from after the plate to directly after the skip link, wrapped as:

```tsx
<details class="figure-key" id="phenogram-key">
  <summary class="figure-key-summary">Key</summary>
  <div class="phenogram-legend">
    … (the two sections, unchanged)
  </div>
</details>;
```

and after the `phenogram-unplaced` paragraph add
`<p class="figure-end" id="phenogram-end" tabIndex={-1}>End of the phenogram</p>`.

Rewrite the comment at `assets/app.css:3210-3222` to match Task 11's wording
("Key first, collapsed, then the plate…").

In `CLAUDE.md`, Phenogram section, replace "Its key sits under the plate too, in
the same arrangement and for the same reasons — …" with "Its key sits above the
plate too, in the same collapsed `<details>` and for the same reasons —
supporting evidence in one cell, the phenotype key spanning two, both on
`auto-fit` grids guarded with `min(…, 100%)`. The skip link targets
`#phenogram-end` after the plate."

- [ ] **Step 3: Gates and commit**

Run:
`deno test tests/routes_test.tsx && deno task check && npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/phenogram.spec.ts tests/runtime.spec.ts`
Expected: PASS.

```bash
git add islands/Phenogram.tsx assets/app.css CLAUDE.md e2e/tests/phenogram.spec.ts
git commit -m "Phenogram: key above the plate as a collapsed details"
```

---

### Task 13: Map — the Study status group, cluster rebuilt per selection

**Files:**

- Modify: `islands/TrialsMap.tsx`
- Modify: `assets/app.css` (`.map-controls`, beside `.map-stats`)
- Modify: `routes/map.tsx:16-19`, `e2e/tests/map.spec.ts:203-219, 293-298`,
  `e2e/fixtures/expected-data.ts`, `e2e/CLAUDE.md:53-55`,
  `tests/routes_test.tsx:253-262`
- Test: as listed

**Interfaces:**

- Consumes: `filterLocationsByStatus`, `STATUS_CHOICES`,
  `DEFAULT_TRIAL_STATUSES`, `useCheckboxFilters` with `initial`,
  `CheckboxFilter`.

- [ ] **Step 1: SSR test first**

`tests/routes_test.tsx:253-262`: import `filterLocationsByStatus` and
`DEFAULT_TRIAL_STATUSES`; the `<li` count becomes
`filterLocationsByStatus(trialLocations, DEFAULT_TRIAL_STATUSES).length`; the
sites stat keeps `trialLocations.length`; add
`assertStringIncludes(html, "Study status")`.

Run: `deno test tests/routes_test.tsx --filter "Map route"` Expected: FAIL.

- [ ] **Step 2: State and the marker builder**

In `islands/TrialsMap.tsx`:

- Imports: `useMemo` from `preact/hooks`; `CheckboxFilter`,
  `useCheckboxFilters`; `DEFAULT_TRIAL_STATUSES, STATUS_CHOICES` from
  `../lib/constants.ts`; `filterLocationsByStatus` from `../lib/filters.ts`.
- Module constant:

```ts
const MAP_FILTERS = {
  statuses: {
    label: "Study status",
    choices: STATUS_CHOICES,
    initial: DEFAULT_TRIAL_STATUSES,
  },
} as const;
```

- `LocationList` takes `locations: readonly TrialLocation[]` and maps over it
  instead of `trialLocations`.
- In the component:

```ts
const { values, controls, summary } = useCheckboxFilters(MAP_FILTERS);
const visibleLocations = useMemo(
  () => filterLocationsByStatus(trialLocations, values.statuses),
  [values],
);
/** Set once Leaflet is up: rebuilds the cluster layer for a location set. */
const populateRef = useRef<
  ((locations: readonly TrialLocation[]) => void) | null
>(null);
```

- Inside the existing effect, move the whole
  `for (const location of trialLocations) { … cluster.addLayer(marker); }` loop
  into a function `populate(locations)` defined after `cluster` is created:

```ts
const markers: L.CircleMarker[] = [];
const populate = (locations: readonly TrialLocation[]) => {
  for (const cleanup of markerCleanups.splice(0)) cleanup();
  cluster.clearLayers();
  markers.length = 0;
  const colors = markerColors();
  for (const location of locations) {
    … the existing per-location body, unchanged, using `colors` in place of `initialMarkerColors` …
    cluster.addLayer(marker);
  }
};
populateRef.current = populate;
populate(visibleLocations);
map.addLayer(cluster);
```

`repaint` keeps reading `markers`. `fitBounds` runs once here on
`trialLocations.length > 0` (bounds of the first population). In the effect's
cleanup add `populateRef.current = null;`.

- A second effect:

```ts
useEffect(() => {
  populateRef.current?.(visibleLocations);
}, [visibleLocations]);
```

- JSX: before `<div class="map-stats">` add:

```tsx
<div class="map-controls">
  {controls.map((props) => <CheckboxFilter key={props.label} {...props} />)}
  <p class="map-controls-count" role="status">
    Showing {visibleLocations.length} of {trialLocations.length} sites
    {summary.length > 0 ? ` · ${summary.join("; ")}` : ""}
  </p>
</div>;
```

and
`<LocationList visible={loadError !== null} locations={visibleLocations} />`.

- CSS, beside `.map-stats`:

```css
.map-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--svd-space-3) var(--svd-space-5);
  padding: var(--svd-space-4) var(--svd-space-4) 0;
}

.map-controls .filter-group {
  margin: 0;
}

.map-controls .filter-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--svd-space-2) var(--svd-space-4);
}

.map-controls-count {
  margin: 0;
  align-self: center;
  font-size: var(--svd-text-sm);
  color: var(--svd-text-muted);
}
```

Run:
`deno test tests/routes_test.tsx tests/trials_map_test.ts tests/components_test.tsx && deno task check`
Expected: PASS.

- [ ] **Step 3: Re-pin the e2e and fix the stale comments**

```bash
deno eval 'import { trialLocations } from "./lib/data/locations.ts"; import { filterLocationsByStatus } from "./lib/filters.ts"; import { DEFAULT_TRIAL_STATUSES } from "./lib/constants.ts"; console.log(filterLocationsByStatus(trialLocations, DEFAULT_TRIAL_STATUSES).length)'
```

- `e2e/fixtures/expected-data.ts`: add `mapSitesShown: <n>` (expected 173 from
  the committed per-facility counts — verify).
- `e2e/tests/map.spec.ts:203-219`: `toHaveCount(EXPECTED.mapSitesShown)`; the
  `.map-stats` test (19-36) keeps `mapSites` 378. Add:

```ts
test("the study-status group hides completed sites by default and shows them on request", async ({ page }) => {
  const count = page.locator(".map-controls-count");
  await expect(count).toContainText(
    `Showing ${EXPECTED.mapSitesShown} of ${EXPECTED.mapSites} sites`,
  );
  await page.getByRole("group", { name: /^Study status/ })
    .getByRole("checkbox", { name: /^Show All/ }).check();
  await expect(count).toContainText(
    `Showing ${EXPECTED.mapSites} of ${EXPECTED.mapSites} sites`,
  );
  await expect(page.locator(".visually-hidden li")).toHaveCount(
    EXPECTED.mapSites,
  );
});
```

- The popup test at 113-129 keeps its `completed` alternative (reachable after
  Show All).
- `routes/map.tsx:16-19`, `e2e/tests/map.spec.ts:293-298`,
  `e2e/CLAUDE.md:53-55`: replace the "8 of the 16 trials" / "16 curated trials,
  57 map sites" wording with the current shape ("79 genes, 102 trial rows, 378
  map sites for 69 of the 77 NCT trials") without pinning numbers the fixtures
  already hold.

Run:
`npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/map.spec.ts tests/audit-regressions.spec.ts tests/runtime.spec.ts`
Expected: PASS.

- [ ] **Step 4: Document and commit**

In `islands/CLAUDE.md`'s Map section add a seventh detail: "**The cluster layer
is rebuilt per status selection.** `populate(locations)` clears the layer,
disposes every marker cleanup and re-adds the visible set; the per-add
accessibility decoration and the popup host lifecycle run again for each, which
is why they live inside the loop and not in a one-time setup. `fitBounds` runs
once, on the first population."

```bash
git add islands/TrialsMap.tsx islands/CLAUDE.md assets/app.css routes/map.tsx tests/routes_test.tsx e2e/tests/map.spec.ts e2e/fixtures/expected-data.ts e2e/CLAUDE.md
git commit -m "Map: Study status group, cluster rebuilt per selection"
```

---

### Task 14: Whole-suite verification

- [ ] **Step 1: Every gate**

```bash
deno task check && deno task test:coverage && uv run pytest -q && uv run pytest tests/scripts -q && uv run ruff check . && uv run ty check
npx --prefix e2e playwright test -c e2e/playwright.config.ts
```

Expected: all PASS.

- [ ] **Step 2: Manual pass**

`deno task start`, then at 1440, 900 and 390 px:

- About: the notice has no corner marks; the trigger has a visible border and
  light fill at rest; the drawer's External services list reads "E-utilities
  search/summary/fetch", "Europe PMC search/full text", "Elsevier
  ScienceDirect", "SAGE Journals", "J-STAGE".
- Trials: the sidebar shows "Study status" with Completed unticked; the banner
  reports it; a Study Status column renders labels; ticking Show All restores
  every row.
- Radar: the status strip, the collapsed "Key" above the plate, empty wedges
  faintly tinted, the figure recomputes on a selection with no overlapping
  labels, the drawer still opens by keyboard, Tab from "Skip the figure" lands
  after the plate.
- Phenogram: collapsed key above, skip link lands after the plate.
- Map: status strip, "Showing n of 378 sites", clusters rebuild on selection,
  popups still open by keyboard.
- `deno task figure`: the print radar draws every row with tinted empty cells.

- [ ] **Step 3: Close the to-do**

Delete `docs/ui-touch-ups.md` (every item is landed; the spec and this plan
record them), and commit:

```bash
git rm docs/ui-touch-ups.md
git commit -m "Remove the landed UI touch-up list"
```
