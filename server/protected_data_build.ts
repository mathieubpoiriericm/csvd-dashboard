/** Production-build invariants for the authenticated client-data boundary. */

import type { Plugin, Rollup } from "vite";

import {
  isProtectedDataAssetPath,
  isProtectedDataModule,
  protectedDataChunkName,
} from "./protected_data_assets.ts";

/**
 * Known data canaries, including the TypeScript location correction. A normal
 * data refresh may remove one; when present, it must never occur publicly.
 */
export const PROTECTED_DATA_SENTINELS = [
  "COL4A1/2",
  "ChiCTR2500109773",
  "NCT06814730",
  "Amsterdam UMC",
  "Aortic aneurysm, familial thoracic 10",
  "10.1212/NXG.0000000000200069",
  "P07942",
] as const;

/**
 * Islands that render nothing of the dataset, so must hydrate without any
 * protected chunk: the login page renders the theme toggle before any
 * session exists, and the adapt wizard would otherwise wait on data,
 * uncacheable, before its form unlocks.
 */
export const DATA_FREE_ISLANDS = ["AdaptWizard", "ThemeToggle"] as const;

/** Rollup's name for the public chunk `clientChunkName` assigns. */
export const SHARED_CHUNK_NAME = "shared";

/**
 * Public modules that lib/data/ imports. Rollup pulls a manual chunk's
 * dependencies into it unless they have a chunk of their own, so without one
 * these would ship inside a protected chunk: a data-free island that reads
 * the absent sentinels or the manifest's normalizers would load it, and an
 * island that only wanted `groupBy` would load a dataset it never renders.
 * `assertProtectedDataBundle` fails the build on any public module that
 * still lands in a protected chunk.
 */
const SHARED_MODULES = [
  "lib/sentinels.ts",
  "lib/normalize.ts",
  "lib/collections.ts",
];

/** Vite's `manualChunks`: the protected chunks, and the public one beside them. */
export function clientChunkName(
  moduleId: string,
  repositoryRoot: string,
): string | undefined {
  const protectedName = protectedDataChunkName(moduleId, repositoryRoot);
  if (protectedName !== undefined) return protectedName;
  const id = moduleId.split("?", 1)[0].replaceAll("\\", "/");
  const root = repositoryRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return SHARED_MODULES.some((path) => id === `${root}/${path}`)
    ? SHARED_CHUNK_NAME
    : undefined;
}

/**
 * Vite's `build.assetsInlineLimit`: protected data is never inlined. Under
 * the limit (4 KB) Vite writes a file referenced by `new URL(…,
 * import.meta.url)` into the importing chunk as a data: URL, where neither
 * the module checks nor the asset check below can see it. Kept out of line,
 * it is emitted as an asset, which `assertProtectedDataBundle` refuses.
 * Every other file keeps Vite's default limit.
 */
export function protectedDataInlineLimit(
  repositoryRoot: string,
): (filePath: string) => false | undefined {
  return (filePath) =>
    isProtectedDataModule(filePath, repositoryRoot) ? false : undefined;
}

/** An asset's source path as Vite records it, relative to the root. */
function assetSourcePath(name: string, repositoryRoot: string): string {
  return /^(?:[A-Za-z]:)?[\\/]/.test(name)
    ? name
    : `${repositoryRoot.replace(/[\\/]+$/, "")}/${name}`;
}

/** The chain of chunk files from one chunk to the first target it reaches, or null. */
function importChain(
  from: Rollup.OutputChunk,
  isTarget: (fileName: string) => boolean,
  chunksByFile: ReadonlyMap<string, Rollup.OutputChunk>,
): string[] | null {
  const importedBy = new Map<string, string | null>([[from.fileName, null]]);
  const queue = [from.fileName];
  for (const fileName of queue) {
    if (isTarget(fileName)) {
      const chain: string[] = [];
      for (let at: string | null = fileName; at !== null;) {
        chain.unshift(at);
        at = importedBy.get(at) ?? null;
      }
      return chain;
    }
    const chunk = chunksByFile.get(fileName);
    // A dynamic import still downloads the dataset, only later.
    for (
      const next of [...chunk?.imports ?? [], ...chunk?.dynamicImports ?? []]
    ) {
      if (importedBy.has(next)) continue;
      importedBy.set(next, fileName);
      queue.push(next);
    }
  }
  return null;
}

export function assertProtectedDataBundle(
  bundle: Rollup.OutputBundle,
  repositoryRoot: string,
): void {
  const chunks = Object.values(bundle).filter(
    (output): output is Rollup.OutputChunk => output.type === "chunk",
  );
  const protectedChunks = chunks.filter((chunk) =>
    isProtectedDataAssetPath(`/${chunk.fileName}`)
  );
  if (protectedChunks.length === 0) {
    throw new Error("Expected at least one protected data chunk, found 0");
  }

  // Every emitted asset is served publicly: only protected-data chunks pass
  // through the session check. A data file referenced by URL rather than
  // imported (`new URL(…, import.meta.url)`, or `?url` from a lib/data
  // module) would be copied here verbatim.
  for (const output of Object.values(bundle)) {
    if (output.type !== "asset") continue;
    const sources = output.originalFileNames.filter((name) =>
      isProtectedDataModule(
        assetSourcePath(name, repositoryRoot),
        repositoryRoot,
      )
    );
    if (sources.length > 0) {
      throw new Error(
        `Protected data emitted as a public asset ${output.fileName}: ${
          sources.join(", ")
        }`,
      );
    }
  }

  for (const chunk of chunks) {
    const protectedModules = Object.keys(chunk.modules).filter((moduleId) =>
      isProtectedDataModule(moduleId, repositoryRoot)
    );
    if (
      protectedModules.length > 0 &&
      !isProtectedDataAssetPath(`/${chunk.fileName}`)
    ) {
      throw new Error(
        `Protected modules emitted in public chunk ${chunk.fileName}: ${
          protectedModules.join(", ")
        }`,
      );
    }
  }

  // Rollup never merges two manual chunk names, so a protected chunk holding
  // two named modules means their names collided (lib/data/sub/x.ts and
  // lib/data/sub-x.ts are both protected-data-sub-x): pages importing either
  // would download both. Fail rather than merge them silently.
  for (const chunk of protectedChunks) {
    const named = Object.keys(chunk.modules).filter((moduleId) =>
      protectedDataChunkName(moduleId, repositoryRoot) !== undefined
    );
    if (named.length > 1) {
      throw new Error(
        `Protected chunk ${chunk.fileName} holds lib/data modules whose chunk names collide: ${
          named.join(", ")
        }`,
      );
    }
  }

  // A type-only import renders nothing, so only modules that left code count.
  for (const chunk of protectedChunks) {
    const publicModules = Object.entries(chunk.modules).filter((
      [moduleId, module],
    ) =>
      module.renderedLength > 0 &&
      !isProtectedDataModule(moduleId, repositoryRoot)
    ).map(([moduleId]) => moduleId);
    if (publicModules.length > 0) {
      throw new Error(
        `Public modules emitted in protected chunk ${chunk.fileName}: ${
          publicModules.join(", ")
        }`,
      );
    }
  }

  const chunksByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  for (const island of DATA_FREE_ISLANDS) {
    const entry = chunks.find((chunk) =>
      chunk.name === `fresh-island__${island}`
    );
    if (entry === undefined) {
      throw new Error(`No client chunk for the data-free island ${island}`);
    }
    const chain = importChain(
      entry,
      (fileName) => isProtectedDataAssetPath(`/${fileName}`),
      chunksByFile,
    );
    if (chain !== null) {
      throw new Error(
        `Data-free island ${island} loads a protected data chunk: ${
          chain.join(" -> ")
        }`,
      );
    }
  }

  for (const sentinel of PROTECTED_DATA_SENTINELS) {
    // A canary the data does not hold proves nothing, and public text may
    // carry it for its own reasons: a fork keeps these until its first
    // export, and its manifest, which ships publicly, can name one.
    if (!protectedChunks.some((chunk) => chunk.code.includes(sentinel))) {
      continue;
    }
    const publicOwners = chunks.filter((chunk) =>
      !protectedChunks.includes(chunk) && chunk.code.includes(sentinel)
    );
    if (publicOwners.length > 0) {
      const names = publicOwners.map((chunk) => chunk.fileName).join(", ");
      throw new Error(
        `Protected sentinel ${
          JSON.stringify(sentinel)
        } leaked into public chunk(s): ${names}`,
      );
    }
  }
}

/** Run the invariant only for Vite's browser build, never the SSR bundle. */
export function protectedDataBuildGuard(repositoryRoot: string): Plugin {
  return {
    name: "csvd-protected-data-boundary",
    apply: "build",
    applyToEnvironment(environment) {
      return environment.name === "client";
    },
    generateBundle(_options, bundle) {
      assertProtectedDataBundle(bundle, repositoryRoot);
    },
  };
}
