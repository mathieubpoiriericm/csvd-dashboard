import { assertThrows } from "@std/assert";
import type { Rollup } from "vite";

import {
  assertProtectedDataBundle,
  PROTECTED_DATA_SENTINELS,
} from "../server/protected_data_build.ts";

const ROOT = "/repo";

function chunk(
  fileName: string,
  code: string,
  moduleIds: string[],
): Rollup.OutputChunk {
  return {
    type: "chunk",
    fileName,
    code,
    modules: Object.fromEntries(moduleIds.map((id) => [id, {}])),
  } as Rollup.OutputChunk;
}

function bundle(
  protectedCode = PROTECTED_DATA_SENTINELS.join("|"),
  publicCode = "public bootstrap",
): Rollup.OutputBundle {
  return {
    "assets/protected-data-Ab_12.js": chunk(
      "assets/protected-data-Ab_12.js",
      protectedCode,
      [
        "\0deno::1::file:///repo/data/table1.json",
        "/repo/lib/data/locations.ts",
      ],
    ),
    "assets/client-entry-Public1.js": chunk(
      "assets/client-entry-Public1.js",
      publicCode,
      ["/repo/islands/ThemeToggle.tsx"],
    ),
  };
}

Deno.test("build guard accepts sentinels and data modules only in protected chunk", () => {
  assertProtectedDataBundle(bundle(), ROOT);
});

Deno.test("build guard accepts a sentinel removed by normal data regeneration", () => {
  assertProtectedDataBundle(
    bundle("regenerated dataset without canaries"),
    ROOT,
  );
});

Deno.test("build guard rejects a named sentinel in a public chunk", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        bundle(
          PROTECTED_DATA_SENTINELS.join("|"),
          `public ${PROTECTED_DATA_SENTINELS[2]}`,
        ),
        ROOT,
      ),
    Error,
    "leaked into public chunk",
  );
});

Deno.test("build guard rejects lib/data modules in a public chunk", () => {
  const output = bundle();
  output["assets/client-entry-Public1.js"] = chunk(
    "assets/client-entry-Public1.js",
    "public bootstrap",
    ["/repo/lib/data/locations.ts"],
  );
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    "Protected modules emitted in public chunk",
  );
});
