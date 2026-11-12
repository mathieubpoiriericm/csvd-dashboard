import { assertEquals, assertThrows } from "@std/assert";
import type { Rollup } from "vite";

import { PROTECTED_DATA_CHUNK_NAME } from "../server/protected_data_assets.ts";
import {
  assertProtectedDataBundle,
  clientChunkName,
  PROTECTED_DATA_SENTINELS,
  protectedDataInlineLimit,
  SHARED_CHUNK_NAME,
} from "../server/protected_data_build.ts";

const ROOT = "/repo";

const PROTECTED = "assets/protected-data-Ab_12.js";
const PROTECTED_2 = "assets/protected-data-references-Cd_34.js";
const MANIFEST = "assets/manifest-Public2.js";
const WIZARD = "assets/fresh-island__AdaptWizard-Public3.js";
const TOGGLE = "assets/fresh-island__ThemeToggle-Public4.js";
const PREVIEW = "assets/fresh-island__PipelinePreview-Public6.js";
const WIDGET = "assets/fresh-island__PipelineRun-Public7.js";

/**
 * A chunk whose listed modules each render code; `typeOnly` modules render
 * nothing, as a type-only import does once the compiler erases it.
 */
function chunk(
  fileName: string,
  code: string,
  moduleIds: string[],
  { name = "", imports = [], dynamicImports = [], typeOnly = [] }: {
    name?: string;
    imports?: string[];
    dynamicImports?: string[];
    typeOnly?: string[];
  } = {},
): Rollup.OutputChunk {
  return {
    type: "chunk",
    fileName,
    name,
    code,
    imports,
    dynamicImports,
    modules: Object.fromEntries([
      ...moduleIds.map((id) => [id, { renderedLength: 1 }]),
      ...typeOnly.map((id) => [id, { renderedLength: 0 }]),
    ]),
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
    // The preview switch reaches the run report only through the widget it
    // loads when switched on.
    chunk(WIDGET, "widget", ["/repo/islands/PipelineRun.tsx"], {
      name: "fresh-island__PipelineRun",
      imports: [PROTECTED],
    }),
    chunk(PREVIEW, "preview", ["/repo/islands/PipelinePreview.tsx"], {
      name: "fresh-island__PipelinePreview",
      dynamicImports: [WIDGET],
    }),
  ];
  return Object.fromEntries(chunks.map((output) => [output.fileName, output]));
}

/** A second protected chunk, the references table, loaded by GenesView. */
function withSecondProtectedChunk(
  output: Rollup.OutputBundle,
  code = "references",
): Rollup.OutputBundle {
  output[PROTECTED_2] = chunk(PROTECTED_2, code, [
    "\0deno::1::file:///repo/data/refs.json",
    "/repo/lib/data/references.ts",
  ]);
  const genes = "assets/fresh-island__GenesView-Public5.js";
  return withImports(output, genes, {
    imports: [MANIFEST, PROTECTED, PROTECTED_2],
  });
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
    `Data-free island AdaptWizard loads a protected data chunk: ${WIZARD} -> ${PROTECTED}`,
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
    `Data-free island AdaptWizard loads a protected data chunk: ${WIZARD} -> ${MANIFEST} -> ${PROTECTED}`,
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
    `Data-free island ThemeToggle loads a protected data chunk: ${TOGGLE} -> ${PROTECTED}`,
  );
});

Deno.test("build guard lets an on-demand island reach a dataset through a dynamic import", () => {
  // bundle() already has the preview switch importing the widget
  // dynamically, and the widget importing the protected chunk.
  assertProtectedDataBundle(bundle(), ROOT);
});

Deno.test("build guard rejects an on-demand island that imports the protected chunk statically", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withImports(bundle(), PREVIEW, { imports: [PROTECTED] }),
        ROOT,
      ),
    Error,
    `On-demand island PipelinePreview loads a protected data chunk with the page: ${PREVIEW} -> ${PROTECTED}`,
  );
});

Deno.test("build guard follows an on-demand island's static imports to the protected chunk", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withImports(bundle(), PREVIEW, { imports: [WIDGET] }),
        ROOT,
      ),
    Error,
    `On-demand island PipelinePreview loads a protected data chunk with the page: ${PREVIEW} -> ${WIDGET} -> ${PROTECTED}`,
  );
});

Deno.test("build guard rejects a bundle without an on-demand island's chunk", () => {
  const output = bundle();
  delete output[PREVIEW];
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    "No client chunk for the on-demand island PipelinePreview",
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
  for (
    const id of [
      "/repo/lib/sentinels.ts",
      "/repo/lib/normalize.ts?v=1",
      "/repo/lib/collections.ts",
    ]
  ) {
    assertEquals(clientChunkName(id, ROOT), SHARED_CHUNK_NAME, id);
  }
  assertEquals(
    clientChunkName("/repo/lib/data/normalize.ts", ROOT),
    `${PROTECTED_DATA_CHUNK_NAME}-normalize`,
  );
  // JSON is unnamed: Rollup places it with the lib/data module importing it.
  assertEquals(
    clientChunkName("\0deno::1::file:///repo/data/table1.json", ROOT),
    undefined,
  );
  for (const id of ["/repo/lib/filters.ts", "/elsewhere/lib/sentinels.ts"]) {
    assertEquals(clientChunkName(id, ROOT), undefined);
  }
  assertEquals(
    clientChunkName("C:\\repo\\lib\\sentinels.ts", "C:\\repo\\"),
    SHARED_CHUNK_NAME,
  );
});

Deno.test("build guard accepts several protected chunks", () => {
  assertProtectedDataBundle(withSecondProtectedChunk(bundle()), ROOT);
});

Deno.test("build guard rejects a bundle with no protected chunk", () => {
  const output = bundle();
  delete output[PROTECTED];
  output["assets/public-Ab_12.js"] = chunk("assets/public-Ab_12.js", "public", [
    "/repo/lib/filters.ts",
  ]);
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    "Expected at least one protected data chunk, found 0",
  );
});

// Rollup pulls an unnamed dependency of a manual chunk into it, so a public
// helper that only lib/data imports would make its other importers load data.
Deno.test("build guard rejects a public module with code in a protected chunk", () => {
  const output = bundle();
  output[PROTECTED] = chunk(PROTECTED, "data", [
    "\0deno::1::file:///repo/data/table1.json",
    "/repo/lib/data/locations.ts",
    "/repo/lib/collections.ts",
  ]);
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    `Public modules emitted in protected chunk ${PROTECTED}: /repo/lib/collections.ts`,
  );
});

Deno.test("build guard ignores a type-only public module in a protected chunk", () => {
  const output = bundle();
  output[PROTECTED] = chunk(
    PROTECTED,
    "data",
    ["\0deno::1::file:///repo/data/table1.json", "/repo/lib/data/locations.ts"],
    { typeOnly: ["/repo/lib/types.ts"] },
  );
  assertProtectedDataBundle(output, ROOT);
});

Deno.test("build guard rejects a canary held by a second protected chunk and a public one", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withSecondProtectedChunk(
          bundle("no canary", "public P07942"),
          "P07942",
        ),
        ROOT,
      ),
    Error,
    "leaked into public chunk",
  );
});

Deno.test("build guard rejects a data-free island that reaches a second protected chunk", () => {
  assertThrows(
    () =>
      assertProtectedDataBundle(
        withImports(withSecondProtectedChunk(bundle()), WIZARD, {
          imports: [MANIFEST, PROTECTED_2],
        }),
        ROOT,
      ),
    Error,
    `Data-free island AdaptWizard loads a protected data chunk: ${WIZARD} -> ${PROTECTED_2}`,
  );
});

// Rollup never merges two manual chunk names, so two lib/data modules in one
// chunk means their names collided: lib/data/sub/x.ts and lib/data/sub-x.ts
// are both protected-data-sub-x.
Deno.test("build guard rejects lib/data modules whose chunk names collide", () => {
  const output = bundle();
  output[PROTECTED] = chunk(PROTECTED, "data", [
    "/repo/lib/data/sub/x.ts",
    "/repo/lib/data/sub-x.ts",
  ]);
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    `Protected chunk ${PROTECTED} holds lib/data modules whose chunk names collide: /repo/lib/data/sub/x.ts, /repo/lib/data/sub-x.ts`,
  );
});

Deno.test("build guard rejects a case alias of protected data in a public chunk", () => {
  const output = bundle();
  output["assets/client-entry-Public1.js"] = chunk(
    "assets/client-entry-Public1.js",
    "public bootstrap",
    ["/repo/DATA/table1.json"],
  );
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    "Protected modules emitted in public chunk assets/client-entry-Public1.js: /repo/DATA/table1.json",
  );
});

/** An emitted asset, as Vite names one: its source relative to the root. */
function asset(
  fileName: string,
  originalFileNames: string[],
): Rollup.OutputAsset {
  return {
    type: "asset",
    fileName,
    name: undefined,
    names: [],
    originalFileName: originalFileNames[0] ?? null,
    originalFileNames,
    source: "{}",
    needsCodeReference: false,
  } as unknown as Rollup.OutputAsset;
}

// `new URL("../data/x.json", import.meta.url)` and a `?url` import from a
// lib/data module emit the file itself as a public asset, which no chunk check
// sees: the bytes would be served as they are, without a session.
Deno.test("build guard rejects protected data emitted as a public asset", () => {
  const output = bundle();
  output["assets/table1-Ab12.json"] = asset("assets/table1-Ab12.json", [
    "data/table1.json",
  ]);
  assertThrows(
    () => assertProtectedDataBundle(output, ROOT),
    Error,
    "Protected data emitted as a public asset assets/table1-Ab12.json: data/table1.json",
  );
});

Deno.test("build guard accepts public assets", () => {
  const output = bundle();
  output["assets/Barlow-400-Ab12.woff2"] = asset(
    "assets/Barlow-400-Ab12.woff2",
    ["node_modules/@fontsource/barlow/files/barlow-latin-400-normal.woff2"],
  );
  output["assets/client-entry-Ab12.css"] = asset(
    "assets/client-entry-Ab12.css",
    [],
  );
  assertProtectedDataBundle(output, ROOT);
});

// Under assetsInlineLimit (4 KB) Vite inlines a file as a data: URL inside
// the importing chunk, where no asset check could see it, so protected data
// is never inlined; every other file keeps Vite's default.
Deno.test("protected data is never inlined as a data URL", () => {
  const shouldInline = protectedDataInlineLimit(ROOT);
  assertEquals(shouldInline("/repo/data/pipeline_status.json"), false);
  assertEquals(shouldInline("/repo/lib/data/genes.ts"), false);
  assertEquals(shouldInline("/repo/assets/logo.svg"), undefined);
});
