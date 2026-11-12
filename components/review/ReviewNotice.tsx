import { SIMULATED_NOTE } from "../../lib/review/copy.ts";

/**
 * What every review page says first: the changes are real, the committee is
 * not. One block, so the three pages cannot word it three ways.
 */
export function ReviewNotice() {
  return <p class="notice notice-neutral">{SIMULATED_NOTE}</p>;
}
