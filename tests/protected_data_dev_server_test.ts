import { assertEquals } from "@std/assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Connect } from "vite";

import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import {
  classifyProtectedDevRequest,
  protectedDataDevMiddleware,
} from "../server/protected_data_dev.ts";

const ROOT = "/repo";
const SECRET = "dev-boundary-test-session-secret";

Deno.test("dev classifier covers Vite paths, queries, encoding, and source maps", () => {
  const protectedPaths = [
    "/data/table1.json",
    "/lib/data/genes.ts",
    "/lib/data.ts",
    "/@fs//repo/data/table1.json",
    "/@fs//repo/lib/data/locations.ts",
    "/@id/__x00__deno::1::file:///repo/data/table1.json?import",
    "/@id/%5F%5Fx00%5F%5Fdeno%3A%3A1%3A%3Afile%3A%2F%2F%2Frepo%2Fdata%2Ftable1.json",
    "/lib%2Fdata%2Flocations.ts",
    "/lib%252Fdata%252Flocations.ts",
    "/LIB/DATA/locations.ts",
    "/LIB/DATA.ts",
    "/@fs//repo/DATA/table1.json",
    "/@id/__x00__deno::1::file:///REPO/DATA/table1.JSON?import",
    "/lib/data/locations.ts.map",
    "/LIB/DATA/locations.ts.MAP",
    "/@fs//repo/data/table1.json.map",
    "/@id/__x00__deno::1::file:///repo/data/table1.json.map",
    "/lib/data/../data/genes.ts",
    "/lib/data/%2E%2E/data/genes.ts",
    "/@fs//repo/data/../data/table1.json",
    "/@id/__x00__deno::1::file:///repo/data/../data/table1.json?import",
    "/ui/lib/data/genes.ts",
  ];
  for (const path of protectedPaths) {
    assertEquals(
      classifyProtectedDevRequest(path, ROOT, "/ui/"),
      "protected",
      path,
    );
  }

  for (const query of ["raw", "url", "import", "direct"]) {
    assertEquals(
      classifyProtectedDevRequest(`/data/table1.json?${query}`, ROOT),
      "protected",
      query,
    );
  }
});

Deno.test("dev classifier leaves public modules and their source maps public", () => {
  for (
    const path of [
      "/islands/ThemeToggle.tsx",
      "/islands/ThemeToggle.tsx.map",
      "/lib/theme.ts",
      "/lib/phenogram_encoding.json",
      "/data/readme.csv",
      "/data/table1.json.map.map",
      "/@id/__x00__deno::1::file:///repo/lib/theme.ts",
    ]
  ) {
    assertEquals(classifyProtectedDevRequest(path, ROOT), "public", path);
  }
});

Deno.test("dev classifier rejects malformed and excessive encoding", () => {
  assertEquals(
    classifyProtectedDevRequest("/lib/data/%ZZ.ts", ROOT),
    "malformed",
  );
  assertEquals(
    classifyProtectedDevRequest(
      "/lib%252525252Fdata%252525252Flocations.ts",
      ROOT,
    ),
    "malformed",
  );
});

async function withMiddlewareServer(
  getSessionSecret: () => string | null,
  run: (baseUrl: string, downstreamCalls: () => number) => Promise<void>,
): Promise<void> {
  let downstreamCalls = 0;
  const middleware = protectedDataDevMiddleware(ROOT, { getSessionSecret });
  const server = createServer((request, response) => {
    middleware(request as Connect.IncomingMessage, response, () => {
      downstreamCalls++;
      response.statusCode = 200;
      response.setHeader(
        "Cache-Control",
        "public, max-age=31536000, immutable",
      );
      response.setHeader("Vary", "Accept-Encoding");
      response.end("downstream module");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    await run(
      `http://127.0.0.1:${address.port}`,
      () => downstreamCalls,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function assertPrivateNoStore(response: Response): void {
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(
    response.headers.get("vary")?.split(",").map((field) => field.trim())
      .includes("Cookie"),
    true,
  );
}

Deno.test("dev middleware denies anonymous data modules without redirect", async () => {
  await withMiddlewareServer(() => SECRET, async (baseUrl, downstreamCalls) => {
    for (
      const path of [
        "/lib/data/genes.ts?raw",
        "/@fs//repo/data/table1.json?url",
        "/@id/__x00__deno::1::file:///repo/data/table1.json?import",
        "/lib/data/locations.ts.map?direct",
        "/@fs//repo/DATA/table1.json?import",
        "/lib/data/../data/genes.ts",
      ]
    ) {
      const response = await fetch(`${baseUrl}${path}`);
      assertEquals(response.status, 401, path);
      assertEquals(response.headers.get("location"), null, path);
      assertPrivateNoStore(response);
      assertEquals(await response.text(), "Unauthorized", path);
    }
    assertEquals(downstreamCalls(), 0);

    const publicResponse = await fetch(
      `${baseUrl}/islands/ThemeToggle.tsx.map`,
    );
    assertEquals(publicResponse.status, 200);
    assertEquals(await publicResponse.text(), "downstream module");
    assertEquals(
      publicResponse.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assertEquals(downstreamCalls(), 1);
  });
});

Deno.test("dev middleware admits a signed session with private caching", async () => {
  const token = await issueSession(SECRET);
  await withMiddlewareServer(() => SECRET, async (baseUrl, downstreamCalls) => {
    const response = await fetch(`${baseUrl}/lib/data/genes.ts`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "downstream module");
    assertPrivateNoStore(response);
    assertEquals(response.headers.get("vary"), "Accept-Encoding, Cookie");
    assertEquals(downstreamCalls(), 1);
  });
});

Deno.test("dev middleware fails closed for config and malformed URLs", async () => {
  await withMiddlewareServer(() => null, async (baseUrl, downstreamCalls) => {
    const unconfigured = await fetch(`${baseUrl}/data/table1.json`);
    assertEquals(unconfigured.status, 503);
    assertPrivateNoStore(unconfigured);

    const malformed = await fetch(`${baseUrl}/lib/data/%ZZ.ts`);
    assertEquals(malformed.status, 400);
    assertPrivateNoStore(malformed);
    assertEquals(downstreamCalls(), 0);
  });
});
