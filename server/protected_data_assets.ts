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

/** Rollup uses this as the stable name before appending its content hash. */
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

/**
 * Assign generated JSON and every module in the browser-facing lib/data/
 * boundary to the protected client chunk. The latter matters when a data
 * correction or lookup constant lives in TypeScript rather than raw JSON.
 * Unrelated JSON (for example visualization encoding) remains public code.
 */
export function protectedDataChunkName(
  moduleId: string,
  repositoryRoot: string,
): string | undefined {
  const id = moduleFilePath(moduleId);
  if (id === null) return undefined;
  const root = normalizeFileSystemPath(repositoryRoot);
  const generatedDataRoot = `${root}/data/`;
  const clientDataRoot = `${root}/lib/data/`;
  const clientDataFacade = `${root}/lib/data.ts`;
  return (id.startsWith(generatedDataRoot) && id.endsWith(".json")) ||
      id.startsWith(clientDataRoot) || id === clientDataFacade
    ? PROTECTED_DATA_CHUNK_NAME
    : undefined;
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

/** True only for the generated JavaScript chunk name reserved above. */
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
