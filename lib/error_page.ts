import { HttpError } from "fresh";

/**
 * The status an error page answers with: an `HttpError`'s own, and 500 for
 * anything else thrown. `null` when there is no error, as on every page that
 * rendered normally.
 */
export function errorStatus(error: unknown): number | null {
  if (error === null || error === undefined) return null;
  return error instanceof HttpError ? error.status : 500;
}

/**
 * The error page's heading, which is also its browser title. Deliberately
 * generic: nothing from the error itself, whose message may name internals,
 * is ever shown.
 */
export function errorHeading(status: number): string {
  if (status === 404) return "Page not found";
  return status >= 500 ? "Something went wrong" : "Request not served";
}
