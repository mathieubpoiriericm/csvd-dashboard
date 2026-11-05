---
paths:
  - "routes/_middleware.ts"
  - "routes/_app.tsx"
  - "routes/login.tsx"
  - "routes/logout.tsx"
  - "lib/auth.ts"
  - "main.ts"
  - "utils.ts"
  - "e2e/**"
---

# Login

The dashboard sits behind one shared passphrase and a 30-day signed cookie — no
store, no Deno KV, no auth library. Five things are load-bearing:

- **The gate is `routes/_middleware.ts`, and it fails closed.** It runs for
  every file route, exempts only `/login` and `/logout`, and answers 503 on
  every other route while `DASHBOARD_PASSPHRASE` or `DASHBOARD_SESSION_SECRET`
  is unset — in development too. The exemption comes first, so `/login` still
  renders without them, which is why Fly's liveness check on it cannot see a
  missing secret and `scripts/smoke_deploy.sh` checks `GET /` instead. There is no environment-sniffing bypass; put both
  in `.env`, which `deno task dev` and `deno task start` both load; an exported
  variable beats the file, so a host that injects secrets is unaffected. Static
  assets never reach the gate because `main.ts` registers `staticFiles()` first,
  which is what keeps the login page styled.
- **`deno task start` binds to `127.0.0.1`, and that flag is load-bearing.** The
  cookie is `Secure` on every hostname but `localhost` and `127.0.0.1`, and
  `deno serve` prints its bind address as the URL to open. Without the flag it
  prints `http://0.0.0.0:8000/`, where a browser drops the Secure cookie over
  plain HTTP: the login succeeds, the redirect back arrives with no session, and
  the form reappears with no error — which reads as a rejected passphrase.
  `e2e/tests/login.spec.ts` reads the task and signs in on the host it names.
- **`lib/auth.ts` is pure and takes the secret as an argument.** It never reads
  `Deno.env` except through the injectable reader in `loginConfig`, so the 100 %
  floor under `lib/` holds without touching the process environment. The token
  is `"<expiresMs>.<base64url HMAC-SHA256>"`, verified with
  `crypto.subtle.verify` (constant time); the passphrase compare goes through
  `timingSafeEqual` on two digests. The routes are thin: `routes/login.tsx` and
  `routes/logout.tsx` call `loginResponse` / `logoutResponse` and render the
  card.

`main.ts` runs `csrf()` through `server/same_site_origin.ts`, which also
accepts `https://<host>`. Fly terminates TLS, so the app's own URL is `http://`;
a browser that sends `Origin` but no `Sec-Fetch-Site` (Safari before 16.4,
Firefox before 90, a header-stripping proxy) was refused every sign-in and
sign-out with a bare 403 while plain `csrf()` compared the two. `safeNext()`
admits only printable ASCII after the one leading `/`: a browser drops tab, LF
and CR from a `Location`, so `/\t/evil.example` used to redirect off-site.

`_app.tsx` renders `/login` as a bare sheet (no navbar) and, for a verified
session, a "Sign out" form beside the theme toggle; the flag it reads is
`ctx.state.authenticated`, the one field in `State` (`utils.ts`).
