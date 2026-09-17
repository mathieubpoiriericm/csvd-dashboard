import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";

import {
  isExemptPath,
  issueSession,
  LOGIN_PATH,
  loginConfig,
  loginResponse,
  LOGOUT_PATH,
  logoutResponse,
  notConfiguredResponse,
  passphraseMatches,
  safeNext,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  verifySession,
} from "../lib/auth.ts";

const SECRET = "test-session-secret";
const NOW = 1_800_000_000_000;

Deno.test("a session round-trips under the secret that issued it", async () => {
  const token = await issueSession(SECRET, NOW);
  assertMatch(token, /^\d+\.[A-Za-z0-9_-]+$/);
  assertEquals(token.split(".")[0], String(NOW + SESSION_TTL_MS));
  assert(await verifySession(SECRET, token, NOW));
  assert(await verifySession(SECRET, token, NOW + SESSION_TTL_MS - 1));
});

Deno.test("a session is rejected once it expires", async () => {
  const token = await issueSession(SECRET, NOW);
  assertEquals(await verifySession(SECRET, token, NOW + SESSION_TTL_MS), false);
});

Deno.test("a session signed under another secret is rejected", async () => {
  const token = await issueSession("another-secret", NOW);
  assertEquals(await verifySession(SECRET, token, NOW), false);
});

Deno.test("a session whose expiry was edited is rejected", async () => {
  const token = await issueSession(SECRET, NOW);
  const [, signature] = token.split(".");
  const later = `${NOW + 10 * SESSION_TTL_MS}.${signature}`;
  assertEquals(await verifySession(SECRET, later, NOW), false);
});

Deno.test("a missing or malformed session is rejected without throwing", async () => {
  for (
    const value of [
      undefined,
      "",
      "no-dot",
      ".signature-only",
      `${NOW + 1}.`,
      `${NOW + 1}.!!not-base64url!!`,
      `notanumber.${"a".repeat(43)}`,
      `1e12.${"a".repeat(43)}`,
      `-${NOW}.${"a".repeat(43)}`,
    ]
  ) {
    assertEquals(await verifySession(SECRET, value, NOW), false, `${value}`);
  }
});

Deno.test("two issues at the same instant sign identically, two instants do not", async () => {
  assertEquals(
    await issueSession(SECRET, NOW),
    await issueSession(SECRET, NOW),
  );
  assertNotEquals(
    await issueSession(SECRET, NOW),
    await issueSession(SECRET, NOW + 1),
  );
});

Deno.test("passphraseMatches compares whole strings", async () => {
  assert(
    await passphraseMatches(
      "correct horse battery staple",
      "correct horse battery staple",
    ),
  );
  assertEquals(
    await passphraseMatches("correct horse", "correct horse battery"),
    false,
  );
  assertEquals(
    await passphraseMatches("correct horse", "correct horsE"),
    false,
  );
  assertEquals(await passphraseMatches("correct horse", ""), false);
});

Deno.test("safeNext keeps only a same-site path", () => {
  assertEquals(safeNext("/genes?trait=lacunar"), "/genes?trait=lacunar");
  assertEquals(safeNext("/"), "/");
  for (
    const raw of [
      undefined,
      null,
      "",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "genes",
      "javascript:alert(1)",
    ]
  ) {
    assertEquals(safeNext(raw), "/", `${raw}`);
  }
});

Deno.test("sessionCookie is HttpOnly, Lax, site-wide, 30 days, and Secure off localhost", () => {
  const cookie = sessionCookie("token", "csvd-dashboard.example.deno.net");
  assertEquals(cookie.name, SESSION_COOKIE);
  assertEquals(cookie.value, "token");
  assertEquals(cookie.httpOnly, true);
  assertEquals(cookie.sameSite, "Lax");
  assertEquals(cookie.path, "/");
  assertEquals(cookie.maxAge, 30 * 24 * 60 * 60);
  assertEquals(cookie.secure, true);
  assertEquals(sessionCookie("token", "localhost").secure, false);
  assertEquals(sessionCookie("token", "127.0.0.1").secure, false);
});

Deno.test("loginConfig needs both variables and reads nothing else", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(loginConfig(env({})), null);
  assertEquals(loginConfig(env({ DASHBOARD_PASSPHRASE: "p" })), null);
  assertEquals(loginConfig(env({ DASHBOARD_SESSION_SECRET: "s" })), null);
  assertEquals(
    loginConfig(
      env({ DASHBOARD_PASSPHRASE: "", DASHBOARD_SESSION_SECRET: "s" }),
    ),
    null,
  );
  assertEquals(
    loginConfig(
      env({ DASHBOARD_PASSPHRASE: "p", DASHBOARD_SESSION_SECRET: "s" }),
    ),
    { passphrase: "p", sessionSecret: "s" },
  );
});

Deno.test("loginConfig reads the process environment by default", () => {
  const saved = {
    passphrase: Deno.env.get("DASHBOARD_PASSPHRASE"),
    secret: Deno.env.get("DASHBOARD_SESSION_SECRET"),
  };
  try {
    Deno.env.set("DASHBOARD_PASSPHRASE", "from-env");
    Deno.env.set("DASHBOARD_SESSION_SECRET", "from-env-secret");
    assertEquals(loginConfig(), {
      passphrase: "from-env",
      sessionSecret: "from-env-secret",
    });
  } finally {
    for (
      const [name, value] of [
        ["DASHBOARD_PASSPHRASE", saved.passphrase],
        ["DASHBOARD_SESSION_SECRET", saved.secret],
      ] as const
    ) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("only the login and logout paths are exempt from the gate", () => {
  assertEquals(isExemptPath(LOGIN_PATH), true);
  assertEquals(isExemptPath(LOGOUT_PATH), true);
  for (const path of ["/", "/genes", "/login/", "/loginx", "/logout/x"]) {
    assertEquals(isExemptPath(path), false, path);
  }
});

Deno.test("logoutResponse clears the cookie and returns to the login page", () => {
  const response = logoutResponse();
  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), LOGIN_PATH);
  const setCookie = response.headers.get("set-cookie") ?? "";
  assertMatch(setCookie, new RegExp(`^${SESSION_COOKIE}=;`));
  assertMatch(setCookie, /Expires=Thu, 01 Jan 1970/);
  assertMatch(setCookie, /Path=\//);
});

Deno.test("notConfiguredResponse is a 503 that says what is missing", async () => {
  const response = notConfiguredResponse();
  assertEquals(response.status, 503);
  assertMatch(response.headers.get("content-type") ?? "", /^text\/html/);
  const body = await response.text();
  assertMatch(body, /DASHBOARD_PASSPHRASE/);
  assertMatch(body, /DASHBOARD_SESSION_SECRET/);
});

const CONFIG = {
  passphrase: "correct horse battery staple",
  sessionSecret: SECRET,
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

Deno.test("loginResponse answers a correct passphrase with a cookie and a redirect", async () => {
  const response = await loginResponse(
    CONFIG,
    form({ passphrase: CONFIG.passphrase, next: "/genes" }),
    "csvd-dashboard.example.deno.net",
    NOW,
  );
  assert(response);
  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), "/genes");
  const setCookie = response.headers.get("set-cookie") ?? "";
  assertMatch(
    setCookie,
    new RegExp(`^${SESSION_COOKIE}=\\d+\\.[A-Za-z0-9_-]+;`),
  );
  assertMatch(setCookie, /Secure/);
  assertMatch(setCookie, /HttpOnly/);
  assertMatch(setCookie, /SameSite=Lax/);
  assertMatch(setCookie, /Path=\//);
  assertMatch(setCookie, /Max-Age=2592000/);
  const token = setCookie.slice(SESSION_COOKIE.length + 1).split(";")[0];
  assert(await verifySession(SECRET, token, NOW));
});

Deno.test("loginResponse sends an off-site next back to the front page", async () => {
  const response = await loginResponse(
    CONFIG,
    form({ passphrase: CONFIG.passphrase, next: "//evil.example" }),
    "localhost",
  );
  assert(response);
  assertEquals(response.headers.get("location"), "/");
  const setCookie = response.headers.get("set-cookie") ?? "";
  assertNotEquals(setCookie, "");
  assertEquals(/Secure/.test(setCookie), false);
});

Deno.test("loginResponse is null for a wrong or missing passphrase", async () => {
  assertEquals(
    await loginResponse(
      CONFIG,
      form({ passphrase: "wrong", next: "/" }),
      "localhost",
    ),
    null,
  );
  assertEquals(await loginResponse(CONFIG, form({}), "localhost"), null);
});
