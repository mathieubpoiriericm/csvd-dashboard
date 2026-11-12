/**
 * The About page's pipeline preview: the two sentences it shows and the
 * cookie that remembers the switch.
 *
 * The preview shows a pipeline run widget as a technical preview. The
 * invitation and the note name the run's publication window when there is
 * one, and the cookie is the only state: a visitor who switches it on keeps
 * it for a year. Reading the cookie off a request is server-only and lives in
 * `lib/pipeline_preview_request.ts`, so this module imports nothing and the
 * island's client bundle carries no cookie parser.
 *
 * The switch and the widget can be two islands on one page (a visitor whose
 * cookie is set gets the widget drawn by the server, as an island of its
 * own), so a press is also announced as an event the widget observes; no
 * island depends on the other.
 */

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

/** The `document.cookie` assignment that switches the preview on or off. */
export function previewCookie(on: boolean): string {
  const value = on ? "1" : "";
  const maxAge = on ? PREVIEW_MAX_AGE : 0;
  return `${PREVIEW_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

/**
 * What the switch's line says when the widget could not be fetched. It asks
 * for a reload, not another press: a deploy that replaced the chunk under an
 * open page, or a session that expired, fails the same way on every press,
 * and a browser may keep a failed module for the life of the document.
 */
export const PREVIEW_LOAD_FAILED =
  "The preview could not be loaded. Reload the page to try again.";

/** The event a press of the switch is announced as. */
const PREVIEW_EVENT = "pipeline-preview";

/** Tell the page the preview was switched on or off. */
export function announcePreview(
  on: boolean,
  target: EventTarget = globalThis,
): void {
  target.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: on }));
}

/** Hear each press of the switch; the function returned stops listening. */
export function observePreview(
  listener: (on: boolean) => void,
  target: EventTarget = globalThis,
): () => void {
  const heard = (event: Event) => listener((event as CustomEvent).detail);
  target.addEventListener(PREVIEW_EVENT, heard);
  return () => target.removeEventListener(PREVIEW_EVENT, heard);
}
