import { assertEquals, assertThrows } from "@std/assert";

import { CREATED_HEADER } from "../server/adapt_session_api.ts";
import { replayToHolder } from "../server/adapt_session_holder.ts";
import {
  adaptSessionLimiter,
  isAdaptSessionPath,
  SESSION_LIMIT_VAR,
  SESSION_PER_CLIENT_LIMIT,
  sessionLimitFromEnv,
} from "../server/adapt_session_limiter.ts";

type Limiter = ReturnType<typeof adaptSessionLimiter>;

function invoke(
  limiter: Limiter,
  options: {
    hostname?: string;
    headers?: Record<string, string>;
    method?: string;
    pathname?: string;
    next?: () => Response | Promise<Response>;
  } = {},
): Promise<Response> {
  const req = new Request(
    `http://localhost${options.pathname ?? "/adapt/session/resume"}`,
    { method: options.method ?? "POST", headers: options.headers },
  );
  return Promise.resolve(
    limiter({
      req,
      url: new URL(req.url),
      info: {
        remoteAddr: {
          transport: "tcp",
          hostname: options.hostname ?? "192.0.2.1",
          port: 12_345,
        },
      },
      config: { basePath: "" },
      next: options.next ?? unknownCode,
    } as never),
  );
}

function unknownCode(): Response {
  return Response.json({ error: "unknown" }, { status: 404 });
}

function created(): Response {
  return Response.json({ code: "x" }, {
    status: 201,
    headers: { [CREATED_HEADER]: "created" },
  });
}

function saved(): Response {
  return Response.json({ revision: 2 }, { status: 200 });
}

function assertLimited(response: Response): void {
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "60");
  assertEquals(response.headers.get("cache-control"), "private, no-store");
}

Deno.test("the three session paths, and their slash aliases, are counted", () => {
  for (
    const pathname of [
      "/adapt/session/create",
      "/adapt/session/save",
      "/adapt/session/resume",
      "/adapt/session/resume/",
      "//adapt//session/resume",
      "/adapt/session/%72esume",
    ]
  ) {
    assertEquals(isAdaptSessionPath(pathname) !== null, true, pathname);
  }
  assertEquals(isAdaptSessionPath("/dash/adapt/session/save", "/dash"), "save");
  for (
    const pathname of [
      "/adapt",
      "/adapt/session",
      "/adapt/session/delete",
      "/adapt/session/resume/x",
      "/login",
      "/%ZZ",
    ]
  ) {
    assertEquals(isAdaptSessionPath(pathname), null, pathname);
  }
  assertEquals(isAdaptSessionPath("/adapt/session/save", "/dash"), null);
});

Deno.test("ten wrong codes pass and the eleventh within a minute is refused", async () => {
  const limiter = adaptSessionLimiter();
  for (let i = 0; i < SESSION_PER_CLIENT_LIMIT; i++) {
    assertEquals((await invoke(limiter)).status, 404);
  }
  assertLimited(await invoke(limiter));
  assertEquals(
    (await invoke(limiter, { hostname: "192.0.2.2" })).status,
    404,
  );
});

Deno.test("a slash alias of resume is counted with the rest", async () => {
  const limiter = adaptSessionLimiter({ perClientLimit: 2 });
  assertEquals((await invoke(limiter)).status, 404);
  assertEquals(
    (await invoke(limiter, { pathname: "/adapt/session/resume/" })).status,
    404,
  );
  assertLimited(await invoke(limiter));
});

Deno.test("every new session stays counted", async () => {
  const limiter = adaptSessionLimiter();
  for (let i = 0; i < SESSION_PER_CLIENT_LIMIT; i++) {
    assertEquals(
      (await invoke(limiter, {
        pathname: "/adapt/session/create",
        next: created,
      })).status,
      201,
    );
  }
  assertLimited(
    await invoke(limiter, { pathname: "/adapt/session/create", next: created }),
  );
});

Deno.test("a revival on save stays counted", async () => {
  const limiter = adaptSessionLimiter({ perClientLimit: 1 });
  assertEquals(
    (await invoke(limiter, { pathname: "/adapt/session/save", next: created }))
      .status,
    201,
  );
  assertLimited(
    await invoke(limiter, { pathname: "/adapt/session/save", next: saved }),
  );
});

Deno.test("plain saves release their reservation", async () => {
  const limiter = adaptSessionLimiter();
  for (let i = 0; i < 30; i++) {
    assertEquals(
      (await invoke(limiter, { pathname: "/adapt/session/save", next: saved }))
        .status,
      200,
    );
  }
});

Deno.test("a request handed over to the holder is not counted here", async () => {
  // The holder's own limiter counts the replayed request; counting it here
  // too would spend the client's budget twice.
  const limiter = adaptSessionLimiter();
  for (const operation of ["create", "save", "resume"]) {
    for (let i = 0; i < 2 * SESSION_PER_CLIENT_LIMIT; i++) {
      const response = await invoke(limiter, {
        pathname: `/adapt/session/${operation}`,
        next: () => replayToHolder("abc123def"),
      });
      assertEquals(response.status, 503, operation);
      await response.body?.cancel();
    }
  }
  assertEquals((await invoke(limiter)).status, 404);
});

Deno.test("a resumed session forgives no wrong code or new session", async () => {
  const limiter = adaptSessionLimiter({ perClientLimit: 3 });
  assertEquals((await invoke(limiter)).status, 404);
  assertEquals(
    (await invoke(limiter, {
      pathname: "/adapt/session/create",
      next: created,
    }))
      .status,
    201,
  );
  // A resume of the client's own code is not counted: many in a row pass.
  for (let i = 0; i < 30; i++) {
    assertEquals((await invoke(limiter, { next: saved })).status, 200);
  }
  // Nor does it restore the budget the two counted requests spent.
  assertEquals((await invoke(limiter)).status, 404);
  assertLimited(await invoke(limiter));
  assertLimited(
    await invoke(limiter, { pathname: "/adapt/session/create", next: created }),
  );
});

Deno.test("other requests pass through uncounted", async () => {
  const limiter = adaptSessionLimiter({ perClientLimit: 1 });
  for (
    const [method, pathname] of [
      ["GET", "/adapt"],
      ["POST", "/login"],
      ["GET", "/adapt/session/resume"],
    ]
  ) {
    for (let i = 0; i < 3; i++) {
      assertEquals(
        (await invoke(limiter, { method, pathname })).status,
        404,
        `${method} ${pathname}`,
      );
    }
  }
  assertEquals((await invoke(limiter)).status, 404);
  assertLimited(await invoke(limiter));
});

Deno.test("the trusted client-IP header keys clients behind one proxy", async () => {
  const limiter = adaptSessionLimiter({
    perClientLimit: 1,
    trustedClientIpHeader: "Fly-Client-IP",
  });
  const via = (client: string) =>
    invoke(limiter, {
      hostname: "172.16.0.2",
      headers: { "Fly-Client-IP": client },
    });
  assertEquals((await via("198.51.100.7")).status, 404);
  assertEquals((await via("203.0.113.8")).status, 404);
  assertLimited(await via("198.51.100.7"));
});

Deno.test("the app refuses a cross-site session write before anything else", async () => {
  // main.ts's own app: csrf() runs before the limiter and the login gate,
  // so a cross-site POST is a 403 whether or not the visitor is signed in.
  const { app } = await import("../main.ts");
  const response = await app.handler()(
    new Request("http://localhost/adapt/session/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ answers: "{}" }),
    }),
  );
  assertEquals(response.status, 403);
  await response.body?.cancel();
});

Deno.test("a thrown handler releases its reservation", async () => {
  const limiter = adaptSessionLimiter({ perClientLimit: 1 });
  let threw = false;
  try {
    await invoke(limiter, {
      next: () => {
        throw new Error("test failure");
      },
    });
  } catch (error) {
    threw = error instanceof Error && error.message === "test failure";
  }
  assertEquals(threw, true);
  assertEquals((await invoke(limiter)).status, 404);
});

Deno.test("the per-client limit is the default unless a host names another", () => {
  // Production sets nothing, so it keeps ten.
  assertEquals(SESSION_PER_CLIENT_LIMIT, 10);
  assertEquals(sessionLimitFromEnv(undefined), undefined);
  assertEquals(sessionLimitFromEnv(""), undefined);
  assertEquals(sessionLimitFromEnv(" "), undefined);
  assertEquals(sessionLimitFromEnv("200"), 200);
  for (const bad of ["0", "-3", "1.5", "ten", "1e3"]) {
    assertThrows(() => sessionLimitFromEnv(bad), TypeError, SESSION_LIMIT_VAR);
  }
});

Deno.test("a raised limit lets that many wrong codes pass and refuses the next", async () => {
  const limit = sessionLimitFromEnv("12");
  const limiter = adaptSessionLimiter({ perClientLimit: limit });
  for (let i = 0; i < 12; i++) {
    assertEquals((await invoke(limiter)).status, 404);
  }
  assertLimited(await invoke(limiter));
});
