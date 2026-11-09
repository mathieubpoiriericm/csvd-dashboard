import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fileURLToPath } from "node:url";

import {
  leafletLegacyCss,
  stripLeafletIeDeclarations,
} from "../server/legacy_css.ts";

const LEAFLET_CSS = fileURLToPath(
  new URL(
    "../node_modules/.deno/leaflet@1.9.4/node_modules/leaflet/dist/leaflet.css",
    import.meta.url,
  ),
);

Deno.test("strips the two IE declarations Firefox reports, and nothing else", async () => {
  const source = await Deno.readTextFile(LEAFLET_CSS);
  const stripped = stripLeafletIeDeclarations(source);

  assert(!stripped.includes("behavior:"));
  assert(!/^\s*filter:\s*progid/m.test(stripped));
  // The silent IE lines stay, and so does the rule Safari still uses.
  assertStringIncludes(stripped, "-ms-filter:");
  assertStringIncludes(stripped, "image-rendering: -webkit-optimize-contrast;");
  assertEquals(source.split("\n").length - stripped.split("\n").length, 2);
});

Deno.test("throws when a Leaflet upgrade removes a declaration", () => {
  assertThrows(
    () =>
      stripLeafletIeDeclarations(
        ".lvml {\n\tbehavior: url(#default#VML);\n}\n",
      ),
    Error,
    "progid",
  );
});

Deno.test("plugin transforms leaflet.css and leaves every other module alone", () => {
  const transform = leafletLegacyCss().transform as (
    code: string,
    id: string,
  ) => string | null;
  const css =
    "a {\n\tbehavior: url(#default#VML);\n\tfilter: progid:DXImageTransform.Microsoft.Matrix(M11=1);\n}\n";

  assertEquals(
    transform(css, "/r/node_modules/leaflet/dist/leaflet.css"),
    "a {\n}\n",
  );
  assertEquals(
    transform(css, "/r/node_modules/leaflet/dist/leaflet.css?direct"),
    "a {\n}\n",
  );
  assertEquals(transform(css, "/r/assets/app.css"), null);
  assertEquals(
    transform(css, "/r/leaflet.markercluster/dist/MarkerCluster.css"),
    null,
  );
});
