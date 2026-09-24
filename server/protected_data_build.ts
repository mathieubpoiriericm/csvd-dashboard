/** Production-build invariants for the authenticated client-data boundary. */

import type { Plugin, Rollup } from "vite";

import {
  isProtectedDataAssetPath,
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
 * Islands that render nothing of the dataset, so must hydrate without the
 * protected chunk: the login page renders the theme toggle before any
 * session exists, and the adapt wizard would otherwise wait on the whole
 * dataset, uncacheable, before its form unlocks.
 */
export const DATA_FREE_ISLANDS = ["AdaptWizard", "ThemeToggle"] as const;

/** Rollup's name for the public chunk `clientChunkName` assigns. */
export const SHARED_CHUNK_NAME = "shared";

/**
 * Public modules that lib/data/ imports. Rollup pulls a manual chunk's
 * dependencies into it unless they have a chunk of their own, so without one
 * these would ship inside the protected chunk, and a data-free island that
 * reads the absent sentinels or the manifest's normalizers would load it.
 */
const SHARED_MODULES = ["lib/sentinels.ts", "lib/normalize.ts"];

/** Vite's `manualChunks`: the protected chunk, and the public one beside it. */
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

/** The chain of chunk files from one chunk to another, or null. */
function importChain(
  from: Rollup.OutputChunk,
  to: string,
  chunksByFile: ReadonlyMap<string, Rollup.OutputChunk>,
): string[] | null {
  const importedBy = new Map<string, string | null>([[from.fileName, null]]);
  const queue = [from.fileName];
  for (const fileName of queue) {
    if (fileName === to) {
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
  if (protectedChunks.length !== 1) {
    throw new Error(
      `Expected exactly one protected data chunk, found ${protectedChunks.length}`,
    );
  }
  const [protectedChunk] = protectedChunks;

  for (const chunk of chunks) {
    const protectedModules = Object.keys(chunk.modules).filter((moduleId) =>
      protectedDataChunkName(moduleId, repositoryRoot) !== undefined
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

  const chunksByFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  for (const island of DATA_FREE_ISLANDS) {
    const entry = chunks.find((chunk) =>
      chunk.name === `fresh-island__${island}`
    );
    if (entry === undefined) {
      throw new Error(`No client chunk for the data-free island ${island}`);
    }
    const chain = importChain(entry, protectedChunk.fileName, chunksByFile);
    if (chain !== null) {
      throw new Error(
        `Data-free island ${island} loads the protected data chunk: ${
          chain.join(" -> ")
        }`,
      );
    }
  }

  for (const sentinel of PROTECTED_DATA_SENTINELS) {
    // A canary the data does not hold proves nothing, and public text may
    // carry it for its own reasons: a fork keeps these until its first
    // export, and its manifest, which ships publicly, can name one.
    if (!protectedChunk.code.includes(sentinel)) continue;
    const publicOwners = chunks.filter((chunk) =>
      chunk !== protectedChunk && chunk.code.includes(sentinel)
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
