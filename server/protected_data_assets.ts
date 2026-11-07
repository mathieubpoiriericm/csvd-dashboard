/** Server/build-only boundary around browser chunks that contain data/*.json. */

import { getCookies } from "@std/http/cookie";
import type { Middleware } from "fresh";
import { fileURLToPath } from "node:url";

import {
  loginConfig,
  notConfiguredResponse,
  SESSION_COOKIE,
  verifySession,
} from "../lib/auth.ts";
import { rewriteResponseHeaders } from "./response_header_policy.ts";

/**
 * The prefix of every protected chunk name: `protected-data-<module>` for a
 * lib/data/ module, and the bare name for the lib/data.ts facade. Rollup
 * appends the content hash after it.
 */
export const PROTECTED_DATA_CHUNK_NAME = "protected-data";

const PROTECTED_DATA_ASSET = /^\/assets\/protected-data-[A-Za-z0-9_-]+\.js$/;

const PRIVATE_NO_STORE = "private, no-store";

const normalizeFileSystemPath = (value: string) =>
  value.replaceAll("\\", "/").replace(/\/+$/, "");

function moduleFilePath(moduleId: string): string | null {
  let id = moduleId.split("?", 1)[0];
  const fileUrlStart = id.lastIndexOf("file://");
  if (fileUrlStart >= 0) {
    try {
      id = fileURLToPath(id.slice(fileUrlStart));
    } catch {
      return null;
    }
  } else if (id.startsWith("/@fs/")) {
    id = id.slice("/@fs".length);
  } else if (id.startsWith("\0")) {
    return null;
  }
  return normalizeFileSystemPath(id);
}

/** Where a module sits inside the protected boundary. */
type ProtectedDataModule =
  | { kind: "generated-json" }
  | { kind: "facade" }
  | { kind: "client-data"; path: string };

/**
 * Classify a module against the protected boundary, or null outside it:
 * generated JSON, every module in the browser-facing lib/data/ boundary
 * (`path` is relative to lib/data/), and the lib/data.ts facade. The
 * lib/data/ part matters when a data correction or lookup constant lives in
 * TypeScript rather than raw JSON. Unrelated JSON (for example visualization
 * encoding) remains public code. Ownership and naming both read this, so a
 * chunk name can only ever refine ownership.
 */
function classifyProtectedDataModule(
  moduleId: string,
  repositoryRoot: string,
): ProtectedDataModule | null {
  const id = moduleFilePath(moduleId);
  if (id === null) return null;
  const root = normalizeFileSystemPath(repositoryRoot);
  const clientDataRoot = `${root}/lib/data/`;
  if (id.startsWith(clientDataRoot)) {
    return { kind: "client-data", path: id.slice(clientDataRoot.length) };
  }
  if (id === `${root}/lib/data.ts`) return { kind: "facade" };
  if (id.startsWith(`${root}/data/`) && id.endsWith(".json")) {
    return { kind: "generated-json" };
  }
  return null;
}

/**
 * Whether a module belongs to the protected boundary. The dev and build
 * guards decide ownership here, never from a chunk name.
 */
export function isProtectedDataModule(
  moduleId: string,
  repositoryRoot: string,
): boolean {
  return classifyProtectedDataModule(moduleId, repositoryRoot) !== null;
}

/**
 * Vite's `manualChunks` name for a protected module: each lib/data/ module
 * gets a chunk of its own, so a page downloads only the datasets its islands
 * import. Generated JSON is left unnamed on purpose -- Rollup pulls an
 * unnamed dependency into its importer's manual chunk, so each file ships
 * with the lib/data module that reads it. Every name stays within the
 * characters `PROTECTED_DATA_ASSET` accepts, or the gate would not see the
 * file (and the build guard would refuse it); two paths that sanitize to the
 * same name fail the build guard rather than share a chunk.
 */
export function protectedDataChunkName(
  moduleId: string,
  repositoryRoot: string,
): string | undefined {
  const module = classifyProtectedDataModule(moduleId, repositoryRoot);
  switch (module?.kind) {
    case "facade":
      return PROTECTED_DATA_CHUNK_NAME;
    case "client-data": {
      const stem = module.path.replace(/\.[^./]+$/, "").replaceAll("/", "-")
        .replace(/[^A-Za-z0-9_-]/g, "_");
      return `${PROTECTED_DATA_CHUNK_NAME}-${stem}`;
    }
    default:
      return undefined;
  }
}

/**
 * Mirror Fresh staticFiles()'s decode/re-encode normalization. Without this,
 * `%70rotected-data-...js` would miss our matcher and then be decoded and
 * served by the downstream static middleware.
 */
export function normalizeStaticPathname(
  requestPathname: string,
  basePath = "",
): string | null {
  let pathname = requestPathname;
  if (basePath) {
    pathname = pathname !== basePath ? pathname.slice(basePath.length) : "/";
  }

  try {
    return "/" + decodeURIComponent(pathname).split("/").filter(Boolean).map(
      encodeURIComponent,
    ).join("/");
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/**
 * True only for a protected chunk, `/assets/protected-data-<name>-<hash>.js`
 * (or the facade's bare `protected-data-<hash>.js`).
 */
export function isProtectedDataAssetPath(
  pathname: string,
  basePath = "",
): boolean {
  const normalized = normalizeStaticPathname(pathname, basePath);
  return normalized !== null && PROTECTED_DATA_ASSET.test(normalized);
}

/** Replace Fresh's immutable/public asset policy and partition caches by cookie. */
export function makePrivateNoStore(response: Response): Response {
  return rewriteResponseHeaders(response, (headers) => {
    headers.set("Cache-Control", PRIVATE_NO_STORE);

    const vary = headers.get("Vary");
    const fields = vary?.split(",").map((field) =>
      field.trim()
    ).filter(Boolean) ??
      [];
    if (!fields.some((field) => field.toLowerCase() === "cookie")) {
      fields.push("Cookie");
    }
    headers.set("Vary", fields.join(", "));
  });
}

function unauthorized(request: Request): Response {
  return makePrivateNoStore(
    new Response(request.method === "HEAD" ? null : "Unauthorized", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
}

/**
 * Authenticate only the generated protected-data chunks before staticFiles().
 * All other assets continue downstream unchanged so the login page can load.
 */
export function protectDataAssets<State>(): Middleware<State> {
  return async function protectDataAssets(ctx) {
    if (!isProtectedDataAssetPath(ctx.url.pathname, ctx.config.basePath)) {
      return await ctx.next();
    }

    const config = loginConfig();
    if (config === null) {
      return makePrivateNoStore(notConfiguredResponse());
    }

    const cookie = getCookies(ctx.req.headers)[SESSION_COOKIE];
    if (!(await verifySession(config.sessionSecret, cookie))) {
      return unauthorized(ctx.req);
    }

    return makePrivateNoStore(await ctx.next());
  };
}
