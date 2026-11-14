import { HttpError, page } from "fresh";

import { define } from "../utils.ts";
import { Page } from "../components/Page.tsx";
import { errorHeading, errorStatus } from "../lib/error_page.ts";
import { PREVIEWS_LABEL, PREVIEWS_PATH } from "../lib/previews.ts";

/**
 * Every error a route throws, and every unmatched path, renders here inside
 * the app shell, so a 404 keeps the navbar, the skip link, the theme script
 * and `lang`; Fresh's default answered a bare "Not Found" text body. It runs
 * inside the login gate (routes/_middleware.ts), so a signed-out visitor is
 * still sent to /login before reaching it.
 *
 * An unmatched path reaches here with no `ctx.error`: Fresh's not-found tail
 * throws outside the chain that records it. Without a matched route it is a
 * 404; with one, the method was refused (405). The error is recorded here so
 * the shell's title (routes/_app.tsx) reads it as for any thrown one.
 */
export const handler = define.handlers((ctx) => {
  ctx.error ??= new HttpError(ctx.route === null ? 404 : 405);
  const status = errorStatus(ctx.error) ?? 500;
  // Fresh's own handler logged these; answering here would otherwise
  // swallow them.
  // deno-lint-ignore no-console
  if (status >= 500) console.error(ctx.error);
  return page(undefined, { status });
});

export default define.page<typeof handler>(function ErrorPage({ error }) {
  const status = errorStatus(error) ?? 500;
  return (
    <Page
      contained
      title={errorHeading(status)}
      description={status === 404
        ? "The page you asked for does not exist, or is not on offer at the moment."
        : "The page could not be shown. Please try again later."}
    >
      {
        /* Each with an explicit aria-current: left unset, Fresh's render marks
        a link to an ancestor of this path as current (routes/_app.tsx). */
      }
      <p>
        <a href="/" aria-current="false">Go to the dashboard's home page</a> or
        {" "}
        <a href={PREVIEWS_PATH} aria-current="false">
          see the {PREVIEWS_LABEL.toLowerCase()}
        </a>.
      </p>
    </Page>
  );
});
