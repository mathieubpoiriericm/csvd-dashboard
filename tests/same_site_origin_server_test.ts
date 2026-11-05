import { assertEquals } from "@std/assert";
import { App } from "fresh";

import { isSameSiteOrigin, sameSiteCsrf } from "../server/same_site_origin.ts";

Deno.test("the page's own host over HTTPS is the same site behind a TLS proxy", () => {
  const url = new URL("http://dashboard.example/logout");
  assertEquals(isSameSiteOrigin("http://dashboard.example", url), true);
  assertEquals(isSameSiteOrigin("https://dashboard.example", url), true);
  assertEquals(isSameSiteOrigin("https://evil.example", url), false);
  assertEquals(isSameSiteOrigin("https://dashboard.example.evil", url), false);
  assertEquals(isSameSiteOrigin("null", url), false);
});

function post(origin: string | null, secFetchSite?: string) {
  const handler = new App()
    .use(sameSiteCsrf())
    .post("/logout", () => new Response(null, { status: 303 }))
    .handler();
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  if (secFetchSite) headers.set("sec-fetch-site", secFetchSite);
  // As the app sees a request Fly has terminated TLS for.
  return handler(
    new Request("http://dashboard.example/logout", { method: "POST", headers }),
  );
}

Deno.test("a browser that sends Origin but no Sec-Fetch-Site can sign out over HTTPS", async () => {
  assertEquals((await post("https://dashboard.example")).status, 303);
  assertEquals((await post("http://dashboard.example")).status, 303);
});

Deno.test("a cross-site write is still refused", async () => {
  assertEquals((await post("https://evil.example")).status, 403);
  assertEquals((await post("https://evil.example", "cross-site")).status, 403);
  assertEquals((await post(null, "same-origin")).status, 303);
});
