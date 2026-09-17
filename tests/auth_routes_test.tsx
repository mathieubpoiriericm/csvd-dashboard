import {
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { App } from "fresh";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";

import Shell from "../routes/_app.tsx";
import { requireLogin } from "../routes/_middleware.ts";
import {
  handler as loginHandler,
  LoginCard,
  safeLoginNext,
} from "../routes/login.tsx";
import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import type { State } from "../utils.ts";

const PASSPHRASE = "correct horse battery staple";
const SECRET = "test-session-secret";

/**
 * Runs `fn` with the two login variables set (or, with `null`, unset), and
 * puts the process environment back afterwards whatever happens.
 */
async function withLoginEnv(
  vars: { passphrase: string; secret: string } | null,
  fn: () => Promise<void>,
): Promise<void> {
  const names = ["DASHBOARD_PASSPHRASE", "DASHBOARD_SESSION_SECRET"] as const;
  const saved = names.map((name) => Deno.env.get(name));
  try {
    if (vars === null) {
      for (const name of names) Deno.env.delete(name);
    } else {
      Deno.env.set(names[0], vars.passphrase);
      Deno.env.set(names[1], vars.secret);
    }
    await fn();
  } finally {
    names.forEach((name, i) => {
      const value = saved[i];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
}

/**
 * A dummy app around the gate, the way the Fresh testing docs build one:
 * the handlers report what the middleware left in ctx.state.
 */
function gated() {
  return new App<State>()
    .use(requireLogin)
    .get(
      "/genes",
      (ctx) => new Response(ctx.state.authenticated ? "in" : "out"),
    )
    .get("/login", () => new Response("login form"))
    .post("/logout", () => new Response("logged out"))
    .handler();
}

const CONFIGURED = { passphrase: PASSPHRASE, secret: SECRET };

function assertNoStore(response: Response): void {
  assertEquals(response.headers.get("cache-control"), "no-store");
}

Deno.test("the gate redirects a request with no session to the login page", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const res = await gated()(
      new Request("http://localhost/genes?trait=lacunar"),
    );
    assertEquals(res.status, 303);
    assertEquals(
      res.headers.get("location"),
      "/login?next=%2Fgenes%3Ftrait%3Dlacunar",
    );
    assertNoStore(res);
  });
});

Deno.test("the gate lets a valid session through and marks the state", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const token = await issueSession(SECRET);
    const res = await gated()(
      new Request("http://localhost/genes", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    assertEquals(res.status, 200);
    assertNoStore(res);
    assertEquals(await res.text(), "in");
  });
});

Deno.test("the gate rejects a session signed under another secret", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const token = await issueSession("not-the-secret");
    const res = await gated()(
      new Request("http://localhost/genes", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    assertEquals(res.status, 303);
    assertNoStore(res);
  });
});

Deno.test("the gate exempts the login and logout routes", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const handler = gated();
    const login = await handler(new Request("http://localhost/login"));
    assertEquals(login.status, 200);
    assertNoStore(login);
    assertEquals(await login.text(), "login form");
    const logout = await handler(
      new Request("http://localhost/logout", { method: "POST" }),
    );
    assertEquals(logout.status, 200);
    assertNoStore(logout);
    assertEquals(await logout.text(), "logged out");
  });
});

Deno.test("the gate canonicalizes auth slashes without rewriting methods", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const handler = gated();
    for (
      const { path, method, location } of [
        {
          path: "/login/?next=%2Fgenes",
          method: "GET",
          location: "/login?next=%2Fgenes",
        },
        { path: "/login/", method: "POST", location: "/login" },
        { path: "/logout/", method: "POST", location: "/logout" },
      ]
    ) {
      const response = await handler(
        new Request(`http://localhost${path}`, { method }),
      );
      assertEquals(response.status, 308, `${method} ${path}`);
      assertEquals(response.headers.get("location"), location);
      assertNoStore(response);
    }
  });
});

Deno.test("the gate fails closed when a secret is missing", async () => {
  await withLoginEnv(null, async () => {
    const res = await gated()(new Request("http://localhost/genes"));
    assertEquals(res.status, 503);
    assertNoStore(res);
    assertStringIncludes(await res.text(), "Login is not configured");
  });
  await withLoginEnv({ passphrase: PASSPHRASE, secret: "" }, async () => {
    const res = await gated()(new Request("http://localhost/genes"));
    assertEquals(res.status, 503);
    assertNoStore(res);
  });
});

Deno.test("the login card shows the ICM logo, the form and the return path", () => {
  const html = renderToString(<LoginCard next="/genes" error={false} />);
  assertStringIncludes(html, 'class="icm-logo"');
  assertStringIncludes(html, 'aria-label="Paris Brain Institute"');
  assertStringIncludes(html, "ICM Cerebral SVD Dashboard");
  assertStringIncludes(html, 'method="post" action="/login"');
  assertStringIncludes(html, 'type="password" name="passphrase" autofocus');
  assertStringIncludes(html, 'autocomplete="current-password"');
  assertStringIncludes(html, 'type="hidden" name="next" value="/genes"');
  assertStringIncludes(html, ">Sign in</button>");
  assertNotMatch(html, /role="alert"/);
  assertNotMatch(html, /aria-invalid/);
  assertNotMatch(html, /aria-describedby/);
});

Deno.test("the login card announces a wrong passphrase", () => {
  const html = renderToString(<LoginCard next="/" error />);
  assertMatch(html, /role="alert"[^>]*>That passphrase is not right/);
  assertStringIncludes(html, 'aria-invalid="true"');
  assertStringIncludes(html, 'aria-describedby="login-error"');
  assertStringIncludes(html, 'id="login-error"');
});

Deno.test("login destinations exclude canonical and slashed auth routes", () => {
  assertEquals(safeLoginNext("/genes?trait=lacunar"), "/genes?trait=lacunar");
  for (
    const destination of [
      "/login",
      "/login/",
      "/login?next=%2Fgenes",
      "/logout",
      "/logout/",
      "/section/../login",
    ]
  ) {
    assertEquals(safeLoginNext(destination), "/", destination);
  }
});

Deno.test("successful login cannot redirect back to an auth route", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const req = new Request("http://localhost/login", {
      method: "POST",
      body: new URLSearchParams({
        passphrase: PASSPHRASE,
        next: "/login/",
      }),
    });
    const response = await loginHandler.POST({
      req,
      url: new URL(req.url),
    } as never) as Response;
    assertEquals(response.status, 303);
    assertEquals(response.headers.get("location"), "/");
  });
});

interface ShellProps {
  Component: preact.ComponentType;
  url: URL;
  state?: State;
}

const AppShell = Shell as unknown as preact.ComponentType<ShellProps>;
const Body = () => <p>Route body</p>;

Deno.test("the shell renders the login page without the navbar", () => {
  const html = renderToString(
    h(AppShell, {
      Component: Body,
      url: new URL("http://localhost/login?next=%2Fgenes"),
      state: {},
    }),
  );
  assertStringIncludes(
    html,
    "<title>Sign in | ICM Cerebral SVD Dashboard</title>",
  );
  assertStringIncludes(html, 'class="page page-login"');
  assertStringIncludes(html, "Route body");
  assertNotMatch(html, /class="navbar"/);
  assertNotMatch(html, /aria-label="Main"/);
  assertStringIncludes(html, "MIT License");
});

Deno.test("the shell offers Sign out only to an authenticated visitor", () => {
  const url = new URL("http://localhost/genes");
  const signedIn = renderToString(
    h(AppShell, { Component: Body, url, state: { authenticated: true } }),
  );
  assertStringIncludes(signedIn, 'class="navbar"');
  assertStringIncludes(signedIn, 'method="post" action="/logout"');
  assertStringIncludes(signedIn, ">Sign out</button>");

  const anonymous = renderToString(
    h(AppShell, { Component: Body, url, state: {} }),
  );
  assertNotMatch(anonymous, /action="\/logout"/);
});

Deno.test("login GET sanitizes redirect destinations and starts without an error", () => {
  for (
    const [next, expected] of [["/genes", "/genes"], [
      "https://example.com",
      "/",
    ]]
  ) {
    const result = loginHandler.GET({
      url: new URL(`http://localhost/login?next=${encodeURIComponent(next)}`),
    } as never) as { data: { next: string; error: boolean } };
    assertEquals(result.data, { next: expected, error: false });
  }
});

Deno.test("failed login keeps a safe destination and renders an error response", async () => {
  await withLoginEnv(CONFIGURED, async () => {
    const req = new Request("http://localhost/login", {
      method: "POST",
      body: new URLSearchParams({ passphrase: "incorrect", next: "/genes" }),
    });
    const result = await loginHandler.POST(
      { req, url: new URL(req.url) } as never,
    ) as {
      data: { next: string; error: boolean };
      status: number;
    };
    assertEquals(result.data, { next: "/genes", error: true });
    assertEquals(result.status, 401);
  });
});
