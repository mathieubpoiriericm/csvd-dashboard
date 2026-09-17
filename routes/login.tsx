import { page } from "fresh";

import { define } from "../utils.ts";
import { IcmLogo } from "../components/IcmLogo.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";
import { SITE_TITLE } from "../lib/constants.ts";
import {
  LOGIN_PATH,
  loginConfig,
  loginResponse,
  LOGOUT_PATH,
  notConfiguredResponse,
  safeNext,
} from "../lib/auth.ts";

export interface LoginData {
  /** Safe same-site, non-auth destination after a successful login. */
  next: string;
  /** True when the last submission did not match. */
  error: boolean;
}

/**
 * The gate exempts this path, so the POST has to check the configuration
 * itself; the decision is in lib/auth.ts and the route only renders the
 * form around it.
 */
export const handler = define.handlers({
  GET(ctx) {
    return page<LoginData>({
      next: safeLoginNext(ctx.url.searchParams.get("next")),
      error: false,
    });
  },
  async POST(ctx) {
    const config = loginConfig();
    if (config === null) return notConfiguredResponse();
    const form = await ctx.req.formData();
    form.set("next", safeLoginNext(form.get("next")?.toString()));
    const response = await loginResponse(config, form, ctx.url.hostname);
    if (response !== null) return response;
    return page<LoginData>(
      { next: safeLoginNext(form.get("next")?.toString()), error: true },
      { status: 401 },
    );
  },
});

/** A same-site destination that cannot loop back into an auth endpoint. */
export function safeLoginNext(raw: string | null | undefined): string {
  const next = safeNext(raw);
  const pathname = new URL(next, "http://dashboard.local").pathname;
  const canonical = pathname.replace(/\/+$/, "") || "/";
  return canonical === LOGIN_PATH || canonical === LOGOUT_PATH ? "/" : next;
}

/**
 * The login card. Exported on its own so tests can render it with either
 * data shape without going through a Fresh context.
 */
export function LoginCard({ next, error }: LoginData) {
  return (
    <div class="login-page">
      <ThemeToggle />
      <section class="login-card" aria-labelledby="login-title">
        <IcmLogo />
        <h1 id="login-title">{SITE_TITLE}</h1>
        <p class="login-lede">
          Putative causal genes and clinical trial drugs for cerebral small
          vessel disease (SVD). This preview is shared with collaborators; enter
          the passphrase to continue.
        </p>
        <form method="post" action={LOGIN_PATH} class="login-form">
          <label class="login-label">
            <span>Passphrase</span>
            <input
              type="password"
              name="passphrase"
              autofocus
              autocomplete="current-password"
              required
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "login-error" : undefined}
            />
          </label>
          <input type="hidden" name="next" value={next} />
          {error && (
            <p id="login-error" class="login-error" role="alert">
              That passphrase is not right. Check it and try again.
            </p>
          )}
          <button type="submit" class="login-submit">Sign in</button>
        </form>
      </section>
    </div>
  );
}

export default define.page<typeof handler>(function Login({ data }) {
  return <LoginCard {...data} />;
});
