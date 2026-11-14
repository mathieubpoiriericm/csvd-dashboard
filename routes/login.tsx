import { page } from "fresh";

import { define } from "../utils.ts";
import { InstituteLogo } from "../components/InstituteLogo.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";
import { SITE_TITLE } from "../lib/constants.ts";
import { LOGIN_LEDE } from "../lib/disease/site.ts";
import {
  LOGIN_PATH,
  loginConfig,
  loginResponse,
  LOGOUT_PATH,
  notConfiguredResponse,
  safeNext,
} from "../lib/auth.ts";
import { readCappedBytes } from "../server/request_body.ts";

/**
 * The largest login body read, in bytes: a passphrase, a `next` path and a
 * multipart envelope's framing fit in a small fraction of it.
 */
export const LOGIN_BODY_LIMIT = 8_192;

function plainRefusal(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

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
    // The gate exempts this route, so anyone can reach it: read at most
    // LOGIN_BODY_LIMIT bytes, counted as they arrive, before parsing, since
    // formData() would buffer a body of any size on a small machine. A 413
    // settles the limiter's slot as "other", not as a wrong guess.
    const bytes = await readCappedBytes(ctx.req, LOGIN_BODY_LIMIT);
    if (bytes === null) return plainRefusal(413, "Payload Too Large");
    // A body that is not a form (JSON, text, a multipart with no boundary)
    // makes formData() throw; that is the client's mistake, so answer 400
    // rather than letting it surface as a logged 500.
    let form: FormData;
    try {
      form = await new Response(bytes, {
        headers: {
          "Content-Type": ctx.req.headers.get("content-type") ?? "",
        },
      }).formData();
    } catch {
      return plainRefusal(400, "Bad Request");
    }
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
        <InstituteLogo />
        <h1 id="login-title">{SITE_TITLE}</h1>
        <p class="login-lede">
          {LOGIN_LEDE}{" "}
          This preview is shared with collaborators; enter the passphrase to
          continue.
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
