---
name: deploy
description: Use when deploying the dashboard to Deno Deploy or diagnosing a broken deploy - the build-config fields the console will not flag, why the app directory must be empty, the entrypoint, and the two runtime secrets whose absence makes a whole site answer 503.
---

# Hosting on Deno Deploy

The app runs on Deno Deploy at
`https://csvd-dashboard.mathieubpoiriericm.deno.net`, built from `main` through
the native GitHub integration. `README.md`'s "Deployment" section carries the
build-config table; the plan and its reasoning are in
`docs/superpowers/plans/2026-08-31-deno-deploy-hosting.md`. Four things are
non-obvious enough to state here:

- **`deno install` is mandatory, and the console will not tell you it is
  missing.** `nodeModulesDir` is `"manual"`, so Vite cannot resolve without it.
  The Fresh preset renders both the install and build commands as greyed
  placeholders in _empty_ fields, which look exactly like values that have been
  set — enter both explicitly rather than trusting the preset.
- **App directory must be empty, not `/`.** A `/` there fails the Warm up stage
  with `Module not found file:///_fresh/server.js`, naming the module rather
  than the field that caused it.
- **The entrypoint is not a setting.** Runtime config is "Native Fresh
  integration" and Deploy resolves `_fresh/server.js` itself — never `main.ts`,
  and never `_fresh/compiled-entry.js`, which the plugin emits alongside
  `server.js` but which calls `Deno.serve({ port: Deno.env.get("PORT") })` and
  so passes a string where a number is required. The build page reports the
  entrypoint it chose.
- **The two login secrets are runtime, not build, configuration.** A context
  missing one goes green through every build stage and answers 503 on every
  route, because the gate above fails closed and the builder cannot see the
  runtime context. A wholly-503 site after a successful deploy is that, and
  nothing else.

Because `data/*.json` is committed and bundled at build time, regenerating data
and pushing it to `main` republishes the site — `tests/filters_test.ts`'s caveat
about regeneration now has a production consequence as well as a test one.
