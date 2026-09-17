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

  for (const sentinel of PROTECTED_DATA_SENTINELS) {
    const publicOwners = chunks.filter((chunk) =>
      chunk !== protectedChunks[0] && chunk.code.includes(sentinel)
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
