/**
 * The About page's pipeline preview: the two sentences it shows and the
 * cookie that remembers the switch.
 *
 * The preview shows a pipeline run widget as a technical preview. The
 * invitation and the note name the run's publication window when there is
 * one, and the cookie is the only state: a visitor who switches it on keeps
 * it for a year.
 */
import { getCookies } from "@std/http/cookie";

/** The cookie that remembers the preview switch. */
export const PREVIEW_COOKIE = "pipeline_preview";

/** The cookie's lifetime in seconds: one year. */
const PREVIEW_MAX_AGE = 31536000;

/** The window phrase for a run over `daysBack` days, or "" when there is none. */
function previewWindow(daysBack: number | null): string {
  if (daysBack === null || daysBack === 0) return "";
  if (daysBack === 1) return " over the last day of publications";
  return ` over the last ${daysBack} days of publications`;
}

/** The sentence that invites a visitor to switch the preview on. */
export function previewInvitation(daysBack: number | null): string {
  const phrase = previewWindow(daysBack);
  return `Curious what the pipeline can do? Switch on a technical preview of a real run${phrase}.`;
}

/** The note shown beside the preview, saying its findings are not elsewhere. */
export function previewNote(daysBack: number | null): string {
  const phrase = previewWindow(daysBack);
  return `Technical preview: a real pipeline run${phrase}. Its findings are not in the other pages.`;
}

/** Whether the request's cookies switch the preview on. */
export function previewRequested(headers: Headers): boolean {
  return getCookies(headers)[PREVIEW_COOKIE] === "1";
}

/** The `document.cookie` assignment that switches the preview on or off. */
export function previewCookie(on: boolean): string {
  const value = on ? "1" : "";
  const maxAge = on ? PREVIEW_MAX_AGE : 0;
  return `${PREVIEW_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}
