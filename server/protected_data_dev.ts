/** Authentication boundary for data-bearing modules served by Vite in dev. */

import { getCookies } from "@std/http/cookie";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Connect, Plugin } from "vite";

import { loginConfig, SESSION_COOKIE, verifySession } from "../lib/auth.ts";
import { protectedDataChunkName } from "./protected_data_assets.ts";

const PRIVATE_NO_STORE = "private, no-store";
const ENCODED_BYTE = /%[0-9A-Fa-f]{2}/;
const MAX_DECODE_PASSES = 4;

export type ProtectedDevRequestKind = "protected" | "public" | "malformed";

export interface ProtectedDataDevMiddlewareOptions {
  basePath?: string;
  getSessionSecret?: () => string | null;
}

function requestPath(requestUrl: string): string {
  const suffix = requestUrl.search(/[?#]/);
  return suffix < 0 ? requestUrl : requestUrl.slice(0, suffix);
}

function stripBasePath(pathname: string, basePath: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`)
    ? pathname.slice(base.length)
    : pathname;
}

function requestModuleId(
  pathname: string,
  repositoryRoot: string,
  basePath: string,
): string {
  const path = stripBasePath(pathname, basePath);
  const idMatch = path.match(/^\/+@id\/(.*)$/s);
  if (idMatch) return idMatch[1].replace("__x00__", "\0");

  const fsMatch = path.match(/^\/+@fs\/(.*)$/s);
  if (fsMatch) {
    const filePath = fsMatch[1].replaceAll("\\", "/");
    return /^[A-Za-z]:\//.test(filePath) ? filePath : resolve("/", filePath);
  }

  return resolve(repositoryRoot, path.replace(/^\/+/u, ""));
}

function isProtectedModuleId(
  moduleId: string,
  repositoryRoot: string,
): boolean {
  const hasProtectedOwnership = (candidate: string) =>
    protectedDataChunkName(candidate, repositoryRoot) !== undefined ||
    // Vite ultimately reads from the host filesystem. Conservatively fold
    // both sides so an APFS case alias cannot evade this lexical boundary.
    protectedDataChunkName(
        candidate.toLowerCase(),
        repositoryRoot.toLowerCase(),
      ) !==
      undefined;

  if (hasProtectedOwnership(moduleId)) {
    return true;
  }
  return /\.map$/i.test(moduleId) &&
    hasProtectedOwnership(moduleId.slice(0, -".map".length));
}

/**
 * Classify direct, /@fs, and Vite-wrapped /@id module requests. Query modes do
 * not affect ownership. Additional decoding passes conservatively catch URLs
 * decoded once by an upstream loopback proxy before Vite sees them. Filesystem
 * ownership matching is case-insensitive here because common macOS volumes
 * resolve case aliases even though URL and JavaScript comparisons do not.
 */
export function classifyProtectedDevRequest(
  requestUrl: string,
  repositoryRoot: string,
  basePath = "/",
): ProtectedDevRequestKind {
  let pathname = requestPath(requestUrl);

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (error) {
      if (error instanceof URIError) return "malformed";
      throw error;
    }

    const moduleId = requestModuleId(decoded, repositoryRoot, basePath);
    if (isProtectedModuleId(moduleId, repositoryRoot)) return "protected";
    if (decoded === pathname || !ENCODED_BYTE.test(decoded)) return "public";
    pathname = decoded;
  }

  // Do not pass an excessively encoded request into a stack whose layers may
  // disagree about how many times it should be decoded.
  return "malformed";
}

type HeaderValue = number | string | readonly string[] | undefined;

function varyWithCookie(value: HeaderValue): string {
  const fields = (Array.isArray(value) ? value.join(",") : String(value ?? ""))
    .split(",").map((field) => field.trim()).filter(Boolean);
  if (fields.includes("*")) return "*";
  if (!fields.some((field) => field.toLowerCase() === "cookie")) {
    fields.push("Cookie");
  }
  return fields.join(", ");
}

function setPrivateNoStore(response: ServerResponse): void {
  response.setHeader("Cache-Control", PRIVATE_NO_STORE);
  response.setHeader("Vary", varyWithCookie(response.getHeader("Vary")));
}

/** Keep Vite's own send() helper from restoring public or validator caching. */
function enforcePrivateNoStore(response: ServerResponse): void {
  const setHeader = response.setHeader;
  response.setHeader = function setProtectedHeader(name, value) {
    const normalized = name.toLowerCase();
    return setHeader.call(
      this,
      name,
      normalized === "cache-control"
        ? PRIVATE_NO_STORE
        : normalized === "vary"
        ? varyWithCookie(value)
        : value,
    );
  };
  setPrivateNoStore(response);
}

function endDenied(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.statusCode = status;
  setPrivateNoStore(response);
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(request.method === "HEAD" ? undefined : body);
}

/** Connect middleware exported separately for deterministic boundary tests. */
export function protectedDataDevMiddleware(
  repositoryRoot: string,
  options: ProtectedDataDevMiddlewareOptions = {},
): Connect.NextHandleFunction {
  const getSessionSecret = options.getSessionSecret ??
    (() => loginConfig()?.sessionSecret ?? null);

  return function protectedDataDevMiddleware(request, response, next) {
    const handle = async () => {
      const kind = classifyProtectedDevRequest(
        request.url ?? "/",
        repositoryRoot,
        options.basePath,
      );
      if (kind === "public") {
        next();
        return;
      }
      if (kind === "malformed") {
        endDenied(request, response, 400, "Bad Request");
        return;
      }

      const sessionSecret = getSessionSecret();
      if (sessionSecret === null) {
        endDenied(request, response, 503, "Login is not configured");
        return;
      }

      const cookieHeader = request.headers.cookie;
      const cookies = getCookies(
        new Headers(cookieHeader ? { Cookie: cookieHeader } : undefined),
      );
      if (!(await verifySession(sessionSecret, cookies[SESSION_COOKIE]))) {
        endDenied(request, response, 401, "Unauthorized");
        return;
      }

      enforcePrivateNoStore(response);
      next();
    };

    handle().catch(next);
  };
}

/** Install before Fresh and Vite's transform middleware, only during serve. */
export function protectedDataDevGuard(repositoryRoot: string): Plugin {
  return {
    name: "csvd-protected-data-dev-boundary",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(
        protectedDataDevMiddleware(repositoryRoot, {
          basePath: server.config.base,
        }),
      );
    },
  };
}
