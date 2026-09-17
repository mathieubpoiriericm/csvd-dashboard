# Deno Deploy hosting — implementation plan

**Status: shipped 2026-09-10** at
<https://csvd-dashboard.mathieubpoiriericm.deno.net>. Every step below is done.
The console had moved on from this plan in several places; each is corrected in
situ and marked **As built**. The standing reference is `README.md`'s
"Deployment" section and `CLAUDE.md`'s "Hosting".

**Goal:** Publish the dashboard at a public URL on Deno Deploy, so collaborators
can use it without a checkout, a Deno install or a build.

## Context

The research behind this plan is mostly confirmation rather than design: the app
is already in the shape Deno Deploy wants. **The one application change is the
login** (see "Login" below): the dashboard shows pre-publication research, so a
public URL needs a gate, and the gate needs two secrets.

- **Nothing at request time needs infrastructure.** All seven routes are pure
  `define.page(...)` — no `define.handlers`, no async route code. Every dataset
  is a build-time JSON module import (`lib/data/genes.ts:3` and siblings). There
  is no `Deno.env`, no PostgreSQL and no server-side `fetch` in `routes/`,
  `lib/`, `islands/`, `components/`, `main.ts` or `utils.ts`. This is the
  architecture `CLAUDE.md` already states: nothing queries a database at request
  time, and nothing fetches JSON at runtime.
- **`.env.example` was entirely pipeline-side until the login.** The web app now
  reads exactly two variables, both under "Login" below. Still no database and
  no KV: the session is a signed cookie, not a stored one.
- **`deno task build` already emits what Deploy executes.** `_fresh/server.js`
  default-exports `{ fetch }`, which is exactly the shape the dynamic runtime
  runs. `e2e/playwright.config.ts:41` already drives that artifact.
- **The payload is ~2 MB** (`_fresh/` = 1.9 MB) against a 1 GB limit. The
  checkout's 1.6 GB is `.venv` (1.5 G), `node_modules` (86 M) and `e2e` (19 M),
  all gitignored and so absent from the builder's clone.

Deploy Classic (`dash.deno.com`, `deployctl`) sunset on 2026-07-20. This targets
the current Deno Deploy at `console.deno.com` only.

Decisions taken before design:

- **Native GitHub integration, not a CI-gated Actions job.** Pushing `main`
  builds and deploys; other branches get their own preview URL. `ci.yml` runs in
  parallel and does not gate it — a red push still ships, and the remedy is
  timeline locking (one click) rather than a workflow. For a research dashboard
  that trade is worth the absence of deploy plumbing in the repo.
- **Default `.deno.net` subdomain.** No custom domain, so no DNS work. One can
  be attached later without redeploying.
- **No edge-cache work yet.** Every request currently renders through SSR,
  including fonts and the logo, but the free tier's 1M requests and 10
  active-CPU-hours are far above what this traffic will reach. Read the
  analytics page first; optimise a measured load, not an assumed one.

## Build configuration

Enter every field explicitly rather than trusting auto-detection. The Fresh
preset's default install command is not documented anywhere, and
`nodeModulesDir` is `"manual"`, so a missing `deno install` fails the build
outright. `e2e/package.json` is also a plausible mis-detection source.

| Field                 | Value                              |
| --------------------- | ---------------------------------- |
| Framework preset      | `Fresh`                            |
| App directory         | **empty**                          |
| Install command       | `deno install`                     |
| Build command         | `deno task build`                  |
| Runtime config        | Native Fresh integration           |
| Environment variables | the two login secrets, see "Login" |
| Deployment target     | Free Regions                       |
| Build timeout         | 5 min                              |
| Build memory          | 3 GiB                              |

Keeping the `Fresh` preset rather than `No Preset` is what enables Deploy's
framework build caching alongside the `DENO_DIR` dependency cache.

**As built.** Three fields this plan named no longer exist, and two are capped
below what it asked for:

- **There is no Entrypoint field, and no Runtime field.** Runtime config reads
  "Native Fresh integration" and Deploy resolves `_fresh/server.js` itself; the
  build page reports the entrypoint it chose — it read `_fresh/server.js`, so
  this plan's value was confirmed rather than set.
- **Build timeout is capped at 5 minutes on the free tier** (Pro is required
  above it), not the 10 this plan asked for. Measured, a full build is ~30 s —
  `deno install` 1.6 s, `deno task build` 22.4 s — so the cap is not a
  constraint. Build memory defaults to 3 GiB, above the 2048 MB asked for, and
  is likewise the free-tier ceiling.
- **Region selection requires Pro.** The free tier offers one "Free Regions"
  target, which is what `global` became.

One field this plan did not anticipate mattered more than any of them: the Fresh
preset renders the install and build commands as greyed **placeholders in empty
fields**, indistinguishable at a glance from values that have been set. Both
were empty on arrival and were entered explicitly. This is the concrete form of
the "enter every field explicitly" instruction above.

## Login

One shared passphrase, a 30-day signed cookie, no store. Built from Deno
built-ins and Fresh's own plugins — Web Crypto for the signature,
`@std/http/cookie` for the cookie, `@std/crypto` for the constant-time compare,
Fresh's `csrf()` for the two POSTs — because the alternatives are worse on the
current platform: Deno KV still carries the "still in development and may
change" banner in the runtime docs, and `@deno/kv-oauth`, the one Deno-native
auth library on top of it, was archived on 2026-07-30. Per-person accounts and
OAuth were considered and declined: a research dashboard shared with a handful
of collaborators has nothing per-user to protect, and either would add a user
store to a site that otherwise needs none.

Decisions:

- **Two secrets, both required.** `DASHBOARD_PASSPHRASE` is what people type;
  `DASHBOARD_SESSION_SECRET` (32 random bytes, `openssl rand -base64 32`) signs
  the cookie. They are separate so a low-entropy passphrase cannot become a
  low-entropy signing key. Rotating the session secret logs everyone out at
  once; rotating the passphrase does not, until sessions expire.
- **The gate fails closed.** With either variable unset every route serves 503
  "Login is not configured", in dev as much as on Deploy. There is no
  environment-sniffing bypass.
- **Bounded process-local rate limiting.** `POST /login` reserves a slot before
  checking the passphrase: five recent/pending attempts per socket client and 64
  process-wide per minute. Restarts clear the ledger and replicas do not share
  it, so the passphrase must still be long and multi-instance deployments should
  add an ingress-level distributed limit.
- **The session is a stateless token** `"<expiresMs>.<base64url HMAC>"` where
  the HMAC is SHA-256 over the expiry string under the session secret. The
  middleware verifies it with `crypto.subtle.verify`, which compares in constant
  time. The cookie is `svd_session`; `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Max-Age` 30 days, `Secure` except on `localhost` / `127.0.0.1`.
  `deno task start` therefore binds to `127.0.0.1`: `deno serve` prints its bind
  address as the URL to open, and on `0.0.0.0` the browser drops the Secure
  cookie over plain HTTP and the login silently bounces back.
- **Every route is gated except `/login` and `/logout`.** Fonts, CSS, icons and
  bootstrap JavaScript stay public so the login page renders styled. Generated
  records and the browser-facing `lib/data/` layer are emitted in one
  `protected-data-<hash>.js` chunk; a session gate runs before `staticFiles()`
  and serves that chunk only as `private, no-store`.

Modules:

- `lib/auth.ts` — pure and server-only, and takes the secret as an argument so
  the coverage gate (100 % under `lib/`) can drive it without `Deno.env`:
  `issueSession(secret, now)`, `verifySession(secret, value, now)`,
  `passphraseMatches(expected, given)` (SHA-256 both, then `timingSafeEqual`),
  `safeNext(raw)` (a path that starts with exactly one `/`, else `/`), plus
  `SESSION_COOKIE` and `SESSION_TTL_MS`.
- `routes/_middleware.ts` — exempt `/login` and `/logout`; read both secrets;
  503 if either is missing; read the cookie; on failure
  `ctx.redirect("/login?next=" + encodeURIComponent(pathname + search), 303)`;
  else set `ctx.state.authenticated = true` and `ctx.next()`. `utils.ts` becomes
  `createDefine<State>()` and `main.ts` `new App<State>()` for that one flag.
- `routes/login.tsx` — `define.handlers({ GET, POST })`. GET renders the form
  with `next` from the query. POST reads `passphrase` and `next` from
  `ctx.req.formData()`; a match sets the cookie and 303s to `safeNext(next)`; a
  miss re-renders with the error and status 401.
- `routes/logout.tsx` — `POST` only: `deleteCookie` and 303 to `/login`.
- `server/protected_data_assets.ts` and `vite.config.ts` — isolate generated
  data in a named client chunk, verify the session before static serving, and
  replace the public immutable cache policy with `private, no-store`.
- `server/login_post_limiter.ts` — bounded, timer-free per-client and global
  login-attempt ledger. It keys only on the socket peer and never trusts a
  client-supplied forwarding header.
- `main.ts` — framing policy, protected-data gate, `staticFiles()`, `csrf()`,
  login limiter, then file routes, in that order.

The login page: `_app.tsx` renders a bare shell for `/login` — `<head>` and the
no-flash script unchanged, `<main>` and the footer, no navbar. The page is one
centred `.login-card` that joins the elevation recipe in `assets/app.css`
(`=== CARDS & VALUE BOXES ===`) and re-declares its three tint parameters like
every other surface. Top to bottom: the inline `<IcmLogo />` at twice the navbar
height (the wordmark inherits the card's ink, the mark keeps `--svd-icm-mark`),
the site title as `<h1>`, one sentence, a `<form method="post">` with a labelled
`password` input (`autofocus`, `autocomplete="current-password"`), a hidden
`next`, a "Sign in" button, and `<p role="alert">` on error. The theme toggle
sits in the card's corner so the stored theme is honoured. Signed-in pages get a
`<form method="post"
action="/logout">` "Sign out" button in the navbar next to
the toggle.

Local development: the two variables join `.env.example` under a
`# --- Web app login ---` block, and the `dev` task loads `.env` itself
(`--env-file=.env`) so there is no flag to remember. Nothing is `FRESH_PUBLIC_`,
so neither value can reach an island bundle.

Tests: `tests/auth_test.ts` covers `lib/auth.ts` in full (round trip, tampered,
expired, malformed, `safeNext` against `//evil.com` and absolute URLs).
`tests/routes_test.tsx` builds a Fresh `App` around the gate and the login
handlers the way the Fresh testing docs show
(`new App<State>().use(gate)…
.handler()`): redirect, exempt paths, 503 on a
missing secret, `Set-Cookie` attributes on a correct POST, 401 on a wrong one,
and the logo on the page. The e2e harness passes both variables in
`webServer.env`, a `setup` project logs in once and saves `storageState` for the
`chromium` project, so the existing specs run unchanged, and `login.spec.ts`
opts out of that state to cover the unauthenticated flow end to end.

## Steps

1. [x] **Pre-flight — prove the production artifact locally.** The e2e suite
       already drives the exact bundle Deploy will serve, so it is the strongest
       local evidence available:

   ```bash
   deno install
   deno task e2e:install   # only if e2e/node_modules is stale
   deno task test:e2e
   ```

   This proves nothing about Deploy's own builder or runtime filesystem. Step 4
   covers those.

   **Done** — 188/188 specs passed against `_fresh/server.js` in 23.8 s.

2. [x] **Create the org and app.** Browser steps, because authorising the GitHub
       App needs OAuth:
   - At `console.deno.com`, create an organisation. **The slug is permanent**,
     cannot collide with any existing Deploy Classic project, and becomes the
     middle segment of the URL.
   - `+ New App` → authorise the Deno Deploy GitHub App against
     `mathieubpoiriericm/csvd-dashboard` → select the repo.
   - `Edit build config` and set every field from the table above.
   - App slug `csvd-dashboard` (valid: 3–32 chars, lowercase, hyphenated).
   - `Create App` to start the first build.

   **Done.** Two deviations from the sequence above. The org
   `mathieubpoiriericm` already existed with two other apps, so no slug was
   chosen — the URL is `https://csvd-dashboard.mathieubpoiriericm.deno.net`. And
   the Deno Deploy GitHub App was already authorised but scoped to _selected
   repositories_, which did not include this one: the repository picker showed
   no match and offered "Configure GitHub app permissions" rather than an error
   naming the scope. Adding `csvd-dashboard` to the installation is a
   prerequisite step this plan missed, and it is a GitHub account-settings
   change, not a Deploy one.

   The equivalent non-interactive CLI form, for the record. `--app-directory` is
   deliberately **not** passed:

   ```bash
   deno deploy create --org <org> --app csvd-dashboard \
     --source github --owner mathieubpoiriericm --repo csvd-dashboard \
     --framework-preset fresh \
     --install-command "deno install" --build-command "deno task build" \
     --build-timeout 10 --build-memory-limit 2048 --region global
   ```

3. [x] **Set the login secrets.** In the app's
       `Settings → Environment
       Variables`, add `DASHBOARD_PASSPHRASE` and
       `DASHBOARD_SESSION_SECRET`, both of type **Secret**, in the
       **Production** context; add a second pair in the **Development** context
       so preview URLs are gated too, with a different passphrase. Generate the
       session secret with `openssl rand -base64 32`. Do this before the first
       build reaches Route, or the first live page is the 503 fallback. The
       passphrase is shared out of band, never committed and never pasted into
       an issue.

   **Done**, with the contexts differing from the plan. The console's contexts
   are `All`, `Production`, `Preview`, `Build` and `Local` — there is no
   "Development" context by that name; `Preview` is what gates branch URLs. Both
   variables were set to type **Secret** with context `All`, which covers
   production and previews with one passphrase; scoping a second
   `DASHBOARD_PASSPHRASE` to `Preview` is what separates them.

   The panel also accepts a dragged `.env` file, which is the trap here: `.env`
   holds twelve variables and the web app reads two. Dropping it whole uploads
   the pipeline's database password and API keys to a host that has no use for
   them. Upload a two-line file instead.

4. [x] **Verify the live deployment.** Watch the build log through Prepare →
       Install → Build → Warm up → Route; Warm up is the stage that catches a
       bad entrypoint. Then check the production URL in a browser, covering what
       only a real deploy can prove — that the server bundle resolves
       `_fresh/client/**` from `import.meta.dirname` on Deploy's filesystem. See
       Verification below.

5. [x] **Document it.** This repo records load-bearing detail rather than
       leaving it tribal:
   - `README.md` — a `## Deployment` section after `## Getting started`: the
     URL, that pushing `main` deploys, the build-config table, and the two
     secrets the app needs; the Environment Variables section lists them too.
   - `CLAUDE.md` — the three non-obvious hosting facts: the entrypoint is
     `_fresh/server.js` (never `main.ts`, never `_fresh/compiled-entry.js`), App
     directory must be empty, and `deno install` is mandatory before
     `vite build` under `nodeModulesDir: "manual"`. Plus the login's: the gate
     is `routes/_middleware.ts` and fails closed, `lib/auth.ts` is pure and
     takes the secret, `csrf()` is what protects the two POSTs, and the e2e
     specs run pre-authenticated through the `setup` project, so a spec that
     asserts on the logged-out state has to opt out of `storageState`.

## Known traps

- **App directory must be empty, not `/`.** A `/` there produces
  `Module not found file:///_fresh/server.js` at the Warm up stage. This was
  [denoland/deno#32296](https://github.com/denoland/deno/issues/32296), closed
  2026-04-17 once it was traced to exactly that setting. It is the most likely
  first-build failure and the least legible one — the error names the module,
  not the field.
- **The entrypoint is no longer a field**, so this trap is now unreachable
  rather than avoided: never point one at `_fresh/compiled-entry.js` should it
  return. The plugin emits it alongside `server.js`, but it calls
  `Deno.serve({ port: Deno.env.get("PORT") })`, passing a string where a number
  is required.
- **The install and build commands arrive as placeholders in empty fields.**
  Greyed `deno install` and `deno task build` render identically to set values.
  Both were empty. This is the likeliest way to lose the `deno install` the next
  trap insists on, and nothing in the console flags it.
- **`deno install` is not optional.** `nodeModulesDir: "manual"` means Deno will
  not populate `node_modules` implicitly and Vite resolves through it.
  `.github/workflows/ci.yml:19-22` carries the same note for the same reason.
- **Ship the whole `_fresh/` tree, not just the server bundle.**
  `_fresh/server/server-entry.mjs` reads static files off disk from
  `_fresh/client/**`; the build command produces both, so this only matters if
  the config is ever changed to upload a subset.
- **Deno's version is not pinnable** — the builder runs the same version as the
  runtime. Fresh 2.3.3 / Vite 7.3.6 is current, but a future Deploy-side bump is
  the one upgrade risk that cannot be controlled from this repo.
- **The build timeout cannot be raised past 5 minutes on the free tier**, so a
  build that grows past it has no console-side remedy. It runs in ~30 s today.
- **One concurrent build on the free tier.** Every branch push queues a preview
  build behind `main`'s. If that turns noisy, disable preview builds for
  non-default branches.
- **Regenerating `data/` redeploys the site.** `data/*.json` is committed and
  bundled at build time, so a data commit pushed to `main` ships automatically.
  That is the desired behaviour, and it means `tests/filters_test.ts`'s caveat
  about regeneration now has a production consequence as well as a test one.
- **A missing login secret is a 503 on every route, not a build failure.** The
  build cannot see the runtime context, so it goes green; the gate fails closed
  at request time. A wholly-503 site after a deploy means a context is missing a
  variable — check the Development context for preview URLs.
- **Rotating `DASHBOARD_SESSION_SECRET` logs everyone out.** That is the only
  revocation there is, and it is global. Rotating the passphrase alone leaves
  existing 30-day sessions valid.
- **The built-in login limit is process-local.** A restart resets it, N replicas
  multiply the global allowance by N, and clients sharing one socket-level
  proxy/NAT identity share the per-client quota. Keep a strong passphrase and
  add a distributed ingress limit before scaling beyond one process.

## Free tier headroom

1M requests/mo, 20 GiB egress, 10 active-CPU-hours, 150 GiB-hours memory, 10
apps, 5 custom domains, 1 concurrent build. Deployment size limit 1 GB. A ~2 MB
dashboard sits far inside all of these.

As built, the per-instance ceilings read: runtime memory 768 MiB (not the 512 MB
above), build memory 3 GiB, build timeout 5 minutes. Raising any of the three,
or selecting a region, requires Pro. The org already hosts two other apps
against the same allowance — 3.5k requests and 1.1 CPU-hours were spent nine
days into the billing period when this app was created.

## Verification

Checked from the terminal against production on 2026-09-10:

- [x] `deno task test:e2e` passes locally against the production build — 188/188
      in 23.8 s.
- [x] The Deno Deploy build reaches **Route** with no failed stage — build
      `x4esb0jysqqy`, 29.2 s, Production serving traffic.
- [x] The fonts and icons the login page loads return 200, not 404 — the
      highest-risk item, and the one the local suite cannot cover. They return
      200 **while logged out**; the login page depends on it.
  - This item was written against the retired typography and is corrected here:
    it is **six Barlow faces**, not three IBM Plex ones, and they are hashed
    `/assets/*.woff2` emitted by Vite from `assets/fonts/` rather than files
    under `static/`. Only three are referenced by the login page; the rest load
    on demand. `/images/icm_logo.png` does not exist and never needed checking —
    `components/IcmLogo.tsx` is inline SVG. What does need it, and passes: three
    `.woff2`, the stylesheet, `/favicon.ico`, `/favicon.svg` and
    `/apple-touch-icon.png`.
- [x] Logged out, `/genes` answers 303 to `/login?next=%2Fgenes` and `/` to
      `/login?next=%2F`; `/login` itself answers 200. Not 503, which is what
      proves both secrets resolved in the Production context.
- [x] `compression()` survives the platform — the stylesheet arrives
      `content-encoding: gzip`, 18.6 KB against 168 KB on disk, with the `-gzip`
      ETag suffix. Not in the original list, and worth keeping: this is the
      middleware whose dev/production discrimination is load-bearing, and only a
      real deploy exercises the `deno task start` side of it.
- [x] `README.md` and `CLAUDE.md` describe the deployment.

Checked in a signed-in browser session, which is the only way to reach any of
these:

- [x] All seven routes serve: `/`, `/genes`, `/trials`, `/map`, `/phenogram`,
      `/timeline`, and the About page's `PipelineRun` widget.
- [x] The login card shows the ICM logo in both themes; a wrong passphrase
      answers 401 with the form and the error line; the right one lands on
      `/genes` with a `svd_session` cookie marked
      `Secure; HttpOnly; SameSite=Lax`; "Sign out" returns to `/login`.
- [x] A preview URL is gated. With both secrets at context `All` it shares
      production's passphrase; separating them is the `Preview`-scoped
      `DASHBOARD_PASSPHRASE` described in step 3.
- [x] Islands hydrate: the genes table sorts, a filter narrows rows, Leaflet
      tiles load from `tile.openstreetmap.org`, timeline and phenogram draw.
- [x] Browser console is free of errors.
- [x] A trivial commit pushed to `main` builds and appears live — proving the
      integration, not just the first manual deploy.
