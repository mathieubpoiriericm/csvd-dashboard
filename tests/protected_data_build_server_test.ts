import { assertEquals, assertThrows } from "@std/assert";
import type { Rollup } from "vite";

import { PROTECTED_DATA_CHUNK_NAME } from "../server/protected_data_assets.ts";
import {
  assertProtectedDataBundle,
  clientChunkName,
  PROTECTED_DATA_SENTINELS,
  SHARED_CHUNK_NAME,
} from "../server/protected_data_build.ts";

const ROOT = "/repo";

const PROTECTED = "assets/protected-data-Ab_12.js";
const MANIFEST = "assets/manifest-Public2.js";
const WIZARD = "assets/fresh-island__AdaptWizard-Public3.js";
const TOGGLE = "assets/fresh-island__ThemeToggle-Public4.js";

function chunk(
  fileName: string,
  code: string,
  moduleIds: string[],
  { name = "", imports = [], dynamicImports = [] }: {
    name?: string;
    imports?: string[];
    dynamicImports?: string[];
  } = {},
): Rollup.OutputChunk {
  return {
    type: "chunk",
    fileName,
    name,
    code,
    imports,
    dynamicImports,
    modules: Object.fromEntries(moduleIds.map((id) => [id, {}])),
  } as unknown as Rollup.OutputChunk;
}

/**
 * A data island that loads the protected chunk, two data-free islands that
 * stop short of it, and the manifest chunk the wizard shares with the data
 * islands.
 */
function bundle(
  protectedCode = PROTECTED_DATA_SENTINELS.join("|"),
  publicCode = "public bootstrap",
): Rollup.OutputBundle {
  const chunks = [
    chunk(PROTECTED, protectedCode, [
      "\0deno::1::file:///repo/data/table1.json",
      "/repo/lib/data/locations.ts",
    ]),
    chunk("assets/client-entry-Public1.js", publicCode, [
      "\0fresh:client-entry",
    ]),
    chunk(MANIFEST, "manifest", ["/repo/lib/disease/manifest.ts"]),
    chunk(
      "assets/fresh-island__GenesView-Public5.js",
      "genes",
      ["/repo/islands/GenesView.tsx"],
      { name: "fresh-island__GenesView", imports: [MANIFEST, PROTECTED] },
    ),
    chunk(WIZARD, "wizard", ["/repo/islands/AdaptWizard.tsx"], {
      name: "fresh-island__AdaptWizard",
      imports: [MANIFEST],
    }),
    chunk(TOGGLE, "toggle", ["/repo/islands/ThemeToggle.tsx"], {
      name: "fresh-island__ThemeToggle",
    }),
  ];
  return Object.fromEntries(chunks.map((output) => [output.fileName, output]));
}

function withImports(
  output: Rollup.OutputBundle,
  fileName: string,
  imports: { imports?: string[]; dynamicImports?: string[] },
): Rollup.OutputBundle {
  const original = output[fileName] as Rollup.OutputChunk;
  output[fileName] = { ...original, ...imports };
  return output;
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

// A fork keeps these canaries until its first export, and its manifest ships
// publicly by design: an institute named after one must not fail the build.
Deno.test("build guard ignores a canary the protected chunk does not hold", () => {
  const [canary, ...held] = PROTECTED_DATA_SENTINELS;
  assertProtectedDataBundle(bundle(held.join("|"), `public ${canary}`), ROOT);
  assertProtectedDataBundle(bundle("", `public ${canary}`), ROOT);
});

Deno.test("build guard rejects a canary held by both the protected chunk and a public one", () => {
  const [canary] = PROTECTED_DATA_SENTINELS;
  assertThrows(
    () => assertProtectedDataBundle(bundle(canary, `public ${canary}`), ROOT),
    Error,
    `Protected sentinel ${
      JSON.stringify(canary)
    } leaked into public chunk(s): ` +
      "assets/client-entry-Public1.js",
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

Deno.test("build guard rejects a data-free island that imports the protected chunk", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withImports(bundle(), WIZARD, { imports: [MANIFEST, PROTECTED] }),
        ROOT,
      ),
    Error,
    `Data-free island AdaptWizard loads the protected data chunk: ${WIZARD} -> ${PROTECTED}`,
  );
});

Deno.test("build guard follows a data-free island's imports to the protected chunk", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withImports(bundle(), MANIFEST, { imports: [PROTECTED] }),
        ROOT,
      ),
    Error,
    `Data-free island AdaptWizard loads the protected data chunk: ${WIZARD} -> ${MANIFEST} -> ${PROTECTED}`,
  );
});

Deno.test("build guard counts a data-free island's dynamic imports", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withImports(bundle(), TOGGLE, { dynamicImports: [PROTECTED] }),
        ROOT,
      ),
    Error,
    `Data-free island ThemeToggle loads the protected data chunk: ${TOGGLE} -> ${PROTECTED}`,
  );
});

Deno.test("build guard rejects a bundle without a data-free island's chunk", () => {
  const output = bundle();
  delete output[TOGGLE];
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    "No client chunk for the data-free island ThemeToggle",
  );
});

Deno.test("client chunks keep lib/data's public imports out of the protected chunk", () => {
  for (const id of ["/repo/lib/sentinels.ts", "/repo/lib/normalize.ts?v=1"]) {
    assertEquals(clientChunkName(id, ROOT), SHARED_CHUNK_NAME);
  }
  for (
    const id of [
      "\0deno::1::file:///repo/data/table1.json",
      "/repo/lib/data/normalize.ts",
    ]
  ) {
    assertEquals(clientChunkName(id, ROOT), PROTECTED_DATA_CHUNK_NAME);
  }
  for (const id of ["/repo/lib/filters.ts", "/elsewhere/lib/sentinels.ts"]) {
    assertEquals(clientChunkName(id, ROOT), undefined);
  }
  assertEquals(
    clientChunkName("C:\\repo\\lib\\sentinels.ts", "C:\\repo\\"),
    SHARED_CHUNK_NAME,
  );
});
