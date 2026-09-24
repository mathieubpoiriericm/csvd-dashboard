import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clientChunkName,
  protectedDataBuildGuard,
} from "./server/protected_data_build.ts";
import { protectedDataDevGuard } from "./server/protected_data_dev.ts";

const REPOSITORY_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    protectedDataDevGuard(REPOSITORY_ROOT),
    fresh(),
    protectedDataBuildGuard(REPOSITORY_ROOT),
  ],
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              return clientChunkName(id, REPOSITORY_ROOT);
            },
          },
        },
      },
    },
  },
  server: {
    watch: {
      // Playwright's MCP server writes screenshots, page snapshots and a
      // console log into .playwright-mcp/ inside the project, and Vite
      // watches the project. Driving the dev server with it otherwise puts
      // the page into a reload loop: every write triggers a full reload,
      // which re-renders, which writes again. A console.log in an island
      // makes it self-sustaining, and it looks exactly like an island that
      // will not hydrate.
      //
      // logs/ is ignored for the ordinary version of the same problem: the
      // pipeline writes a progress file and a per-invocation log there, so
      // a run in one terminal would reload the page in another.
      ignored: ["**/.playwright-mcp/**", "**/logs/**"],
    },
  },
});
