# End-to-end tests

`e2e/` is a self-contained npm project — `package.json`, `package-lock.json`,
its own `node_modules`. This is not incidental. The root `node_modules` is a
Deno-built symlink farm under `nodeModulesDir: "manual"`; running `npm install`
against a root `package.json` would treat every one of those symlinks as
extraneous and prune them. Keep npm inside `e2e/`.

`e2e` is in `deno.json`'s `exclude`, so `deno fmt`, `deno lint` and `deno check`
never walk into it — `deno check` cannot resolve `@playwright/test`'s
`@types/node` under `manual` mode. Playwright transpiles the specs itself and
does not type-check them.

The suite drives the **production build**: `playwright.config.ts` runs
`deno task build && deno serve` in its `webServer` block, because the islands
import `data/*.json` at build time and only the bundled output proves hydration
works. It needs no database.

The suite signs in once through the `setup` project (see "Login" in the root
`CLAUDE.md`). One consequence:

- `reuseExistingServer` is on outside CI, so a server already on port 8000 has
  to have been started with the same passphrase and session secret, or the setup
  project cannot sign in and every test fails at once.

`fixtures/auth.ts` uses `__dirname`, not `import.meta.url`: Playwright loads the
config as CommonJS, where `import.meta` is a syntax error.

The app has no `data-testid` attributes and no ids on Fresh-rendered elements,
so selectors lean on ARIA roles and CSS classes. Three traps, the first two
absorbed by `e2e/helpers.ts` — use it rather than reaching for raw locators:

- Checkbox names are not unique — `"Show All"` appears four times on `/trials`.
  Scope every checkbox lookup to its group first.
- Positional selectors break on the trials table. Merged rows omit their covered
  cells, so a column sits at a different `nth-child` depending on the row. Match
  on cell content instead.
- `toHaveText` on a tooltipped cell needs `{ useInnerText: true }`. The cell
  also holds the tooltip's `[popover]` panel; closed, it is `display: none` and
  so invisible to the user, the accessibility tree and innerText — but it is
  still in `textContent`, which is what `toHaveText` reads by default. Three
  assertions in `genes-table.spec.ts` depend on this. `/map` has the same trap
  for a different reason: `.map-container` also holds the visually-hidden site
  list, so a `toHaveText` on it or any wider ancestor swallows every facility
  entry. The existing assertions scope to `.map-stats` to stay clear of it.

Every count a spec asserts is derived, not pinned. `fixtures/expected.deno.ts`
runs under Deno — `fixtures/expected-data.ts` shells out to it once per worker
with `execFileSync` — so the numbers come from the app's own `lib/` over the
committed JSON: the summary totals, the filter counts per choice, the radar and
karyogram layouts, the map's sites and countries. A spec that needs a row to
click guards with `test.skip(count === 0, …)`, so the whole suite passes on
`deno task data:empty`.
