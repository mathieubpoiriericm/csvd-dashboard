/**
 * The shell rendered through a real Fresh `App`, not `renderToString`: Fresh's
 * server render runs a hook over every `<a>` that the bare renderer never
 * does, and the error route is wired by Fresh's router. tests/routes_test.tsx
 * covers the shell's markup; this file covers what only a real render shows.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { App, HttpError } from "fresh";

import Shell from "../routes/_app.tsx";
import ErrorPage, { handler as errorHandler } from "../routes/_error.tsx";
import { requireLogin } from "../routes/_middleware.ts";
import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import { SITE_TITLE } from "../lib/disease.ts";
import type { State } from "../utils.ts";
import { escapeHtml } from "./helpers/html.ts";

// define.page() types its component for a route without data; Fresh's
// wrappers take one for any data. Both are only ever handed `data: null`.
type RouteComponent = Parameters<App<State>["appWrapper"]>[0];
const ShellRoute = Shell as unknown as RouteComponent;
const ErrorRoute = ErrorPage as unknown as RouteComponent;

const PAGES = ["/", "/genes", "/trials", "/previews", "/review/gene"];

function app(gated = false) {
  let built = new App<State>();
  if (gated) built = built.use(requireLogin);
  built = built
    .appWrapper(ShellRoute)
    .onError("*", { component: ErrorRoute, handler: errorHandler });
  for (const path of PAGES) {
    built = built.get(path, (ctx) => ctx.render(<p>page</p>));
  }
  return built
    .get("/gone", () => {
      throw new HttpError(404);
    })
    .get("/broken", () => {
      throw new Error("a detail that must not reach the page");
    })
    .handler();
}

function anchors(html: string): string[] {
  return html.match(/<a\s[^>]*>/g) ?? [];
}

Deno.test("no link in a real render claims to be current but the active tab", async () => {
  const handler = app();
  for (const path of PAGES) {
    const res = await handler(new Request(`http://localhost${path}`));
    assertEquals(res.status, 200, path);
    const html = await res.text();
    const tags = anchors(html);
    // Fresh marks an unvalued link to an ancestor of the path with "true";
    // "/" is an ancestor of every path.
    assertEquals(
      tags.filter((a) => a.includes('aria-current="true"')),
      [],
      path,
    );
    assertEquals(
      tags.filter((a) => a.includes('aria-current="page"')).length,
      1,
      path,
    );
  }
});

Deno.test("an unknown path renders the 404 page inside the shell", async () => {
  const handler = app();
  for (const path of ["/does-not-exist", "/gone"]) {
    const res = await handler(new Request(`http://localhost${path}`));
    assertEquals(res.status, 404, path);
    const html = await res.text();
    assertStringIncludes(html, '<html lang="en">');
    assertStringIncludes(html, '<nav aria-label="Main">');
    assertStringIncludes(
      html,
      `<title>Page not found | ${escapeHtml(SITE_TITLE)}</title>`,
    );
    assertStringIncludes(html, "<h1>Page not found</h1>");
    assertEquals(
      anchors(html).filter((a) => a.includes('aria-current="true"')),
      [],
    );
  }
});

Deno.test("a refused method keeps its status and the shell", async () => {
  const res = await app()(
    new Request("http://localhost/genes", { method: "POST" }),
  );
  assertEquals(res.status, 405);
  const html = await res.text();
  assertStringIncludes(html, '<nav aria-label="Main">');
  assertStringIncludes(html, "<h1>Request not served</h1>");
});

Deno.test("a thrown error renders a generic 500 page and hides its detail", async () => {
  const handler = app();
  const logged = console.error;
  console.error = () => {};
  try {
    const res = await handler(new Request("http://localhost/broken"));
    assertEquals(res.status, 500);
    const html = await res.text();
    assertStringIncludes(html, '<nav aria-label="Main">');
    assertStringIncludes(html, "<h1>Something went wrong</h1>");
    assertStringIncludes(
      html,
      `<title>Something went wrong | ${escapeHtml(SITE_TITLE)}</title>`,
    );
    assertEquals(html.includes("must not reach the page"), false);
  } finally {
    console.error = logged;
  }
});

Deno.test("the login gate runs before the error page", async () => {
  const names = ["DASHBOARD_PASSPHRASE", "DASHBOARD_SESSION_SECRET"] as const;
  const saved = names.map((name) => Deno.env.get(name));
  try {
    Deno.env.set(names[0], "correct horse battery staple");
    Deno.env.set(names[1], "test-session-secret");
    const handler = app(true);
    const out = await handler(new Request("http://localhost/does-not-exist"));
    assertEquals(out.status, 303);
    assertEquals(
      out.headers.get("location"),
      "/login?next=%2Fdoes-not-exist",
    );
    await out.body?.cancel();

    const token = await issueSession("test-session-secret");
    const signedIn = await handler(
      new Request("http://localhost/does-not-exist", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    assertEquals(signedIn.status, 404);
    assertStringIncludes(await signedIn.text(), '<nav aria-label="Main">');
  } finally {
    names.forEach((name, i) => {
      const value = saved[i];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
});
