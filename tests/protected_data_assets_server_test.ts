import { assert, assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import { App } from "fresh";
import { fileURLToPath } from "node:url";

import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import {
  isProtectedDataAssetPath,
  makePrivateNoStore,
  normalizeStaticPathname,
  protectDataAssets,
  PROTECTED_DATA_CHUNK_NAME,
  protectedDataChunkName,
} from "../server/protected_data_assets.ts";

const PASSPHRASE = "test-passphrase";
const SECRET = "test-session-secret";

async function withLoginEnv(
  configured: boolean,
  run: () => Promise<void>,
): Promise<void> {
  const names = ["DASHBOARD_PASSPHRASE", "DASHBOARD_SESSION_SECRET"] as const;
  const saved = names.map((name) => Deno.env.get(name));
  try {
    if (configured) {
      Deno.env.set(names[0], PASSPHRASE);
      Deno.env.set(names[1], SECRET);
    } else {
      for (const name of names) Deno.env.delete(name);
    }
    await run();
  } finally {
    names.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
  }
}

function assetHandler(basePath = "") {
  return new App({ basePath })
    .use(protectDataAssets())
    .get(
      "/assets/:name",
      () =>
        new Response("asset bytes", {
          headers: {
            "Cache-Control": "public, max-age=31536000, immutable",
            Vary: "If-None-Match",
          },
        }),
    )
    .handler();
}

function assertPrivateNoStore(response: Response): void {
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertMatch(response.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
}

Deno.test("generated JSON and lib/data modules receive the protected chunk name", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const dataDirectory = new URL("../data/", import.meta.url);
  let count = 0;

  for await (const entry of Deno.readDir(dataDirectory)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    count++;
    const moduleId = fileURLToPath(new URL(entry.name, dataDirectory));
    assertEquals(
      protectedDataChunkName(moduleId, repositoryRoot),
      PROTECTED_DATA_CHUNK_NAME,
      entry.name,
    );
    assertEquals(
      protectedDataChunkName(`${moduleId}?import`, repositoryRoot),
      PROTECTED_DATA_CHUNK_NAME,
      `${entry.name}?import`,
    );
    assertEquals(
      protectedDataChunkName(
        `\0deno::1::${new URL(entry.name, dataDirectory).href}`,
        repositoryRoot,
      ),
      PROTECTED_DATA_CHUNK_NAME,
      `virtual ${entry.name}`,
    );
  }

  assert(count > 0);
  const clientDataDirectory = new URL("../lib/data/", import.meta.url);
  for await (const entry of Deno.readDir(clientDataDirectory)) {
    if (!entry.isFile) continue;
    assertEquals(
      protectedDataChunkName(
        fileURLToPath(new URL(entry.name, clientDataDirectory)),
        repositoryRoot,
      ),
      PROTECTED_DATA_CHUNK_NAME,
      `lib/data/${entry.name}`,
    );
  }
  assertEquals(
    protectedDataChunkName(
      fileURLToPath(new URL("../lib/data.ts", import.meta.url)),
      repositoryRoot,
    ),
    PROTECTED_DATA_CHUNK_NAME,
  );
  assertEquals(
    protectedDataChunkName(
      fileURLToPath(new URL("../lib/phenogram_encoding.json", import.meta.url)),
      repositoryRoot,
    ),
    undefined,
  );
  assertEquals(
    protectedDataChunkName("C:\\repo\\data\\trials.json", "C:\\repo"),
    PROTECTED_DATA_CHUNK_NAME,
  );
});

Deno.test("protected asset matching mirrors Fresh static path normalization", () => {
  for (
    const pathname of [
      "/assets/protected-data-Ab_12.js",
      "/assets/%70rotected-data-Ab_12.js",
      "/%61ssets/protected-data-Ab_12.js",
      "/assets/protected%2Ddata-Ab_12.js",
      "/assets/protected-data-Ab_12%2Ejs",
      "/assets%2Fprotected-data-Ab_12.js",
      "//assets///protected-data-Ab_12.js",
      "/assets//%2F/protected-data-Ab_12.js",
    ]
  ) {
    assertEquals(isProtectedDataAssetPath(pathname), true, pathname);
  }

  assertEquals(
    isProtectedDataAssetPath(
      "/dashboard//assets///protected-data-Ab_12.js",
      "/dashboard",
    ),
    true,
  );
  assertEquals(
    normalizeStaticPathname("/dashboard", "/dashboard"),
    "/",
  );

  for (
    const pathname of [
      "/assets/protected-data.js",
      "/assets/protected-data-Ab_12.css",
      "/assets/protected-data-Ab_12.js.map",
      "/assets/nested/protected-data-Ab_12.js",
      "/assets/public-protected-data-Ab_12.js",
      "/assets/%2570rotected-data-Ab_12.js",
    ]
  ) {
    assertEquals(isProtectedDataAssetPath(pathname), false, pathname);
  }

  assertEquals(normalizeStaticPathname("/assets/%ZZ.js"), null);
  assertEquals(isProtectedDataAssetPath("/assets/%ZZ.js"), false);
});

Deno.test("anonymous protected asset requests fail without redirect", async () => {
  await withLoginEnv(true, async () => {
    const handler = assetHandler();
    for (
      const pathname of [
        "/assets/protected-data-Ab_12.js",
        "/assets/%70rotected-data-Ab_12.js",
        "/assets%2Fprotected-data-Ab_12.js",
        "//assets///protected-data-Ab_12.js",
      ]
    ) {
      const response = await handler(
        new Request(`http://localhost${pathname}`),
      );
      assertEquals(response.status, 401, pathname);
      assertEquals(response.headers.get("location"), null, pathname);
      assertPrivateNoStore(response);
      assertEquals(await response.text(), "Unauthorized", pathname);
    }
  });
});

Deno.test("authenticated protected assets are private and public assets stay public", async () => {
  await withLoginEnv(true, async () => {
    const handler = assetHandler();
    const token = await issueSession(SECRET);
    const protectedResponse = await handler(
      new Request("http://localhost/assets/protected-data-Ab_12.js", {
        headers: { Cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    assertEquals(protectedResponse.status, 200);
    assertEquals(await protectedResponse.text(), "asset bytes");
    assertPrivateNoStore(protectedResponse);
    assertMatch(protectedResponse.headers.get("vary") ?? "", /If-None-Match/i);
    assertNotMatch(
      protectedResponse.headers.get("cache-control") ?? "",
      /public|immutable/i,
    );

    const publicResponse = await handler(
      new Request("http://localhost/assets/client-entry-Ab_12.js"),
    );
    assertEquals(publicResponse.status, 200);
    assertEquals(
      publicResponse.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assertEquals(publicResponse.headers.get("vary"), "If-None-Match");
  });
});

Deno.test("private cache policy can wrap an immutable redirect", () => {
  const response = makePrivateNoStore(
    Response.redirect("http://localhost/login", 303),
  );
  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), "http://localhost/login");
  assertPrivateNoStore(response);
});

Deno.test("protected asset authentication honors Fresh basePath", async () => {
  await withLoginEnv(true, async () => {
    const response = await assetHandler("/dashboard")(
      new Request(
        "http://localhost/dashboard//assets%2Fprotected-data-Ab_12.js",
      ),
    );
    assertEquals(response.status, 401);
    assertPrivateNoStore(response);
  });
});

Deno.test("a missing login configuration fails the protected boundary closed", async () => {
  await withLoginEnv(false, async () => {
    const response = await assetHandler()(
      new Request("http://localhost/assets/protected-data-Ab_12.js"),
    );
    assertEquals(response.status, 503);
    assertPrivateNoStore(response);
  });
});
