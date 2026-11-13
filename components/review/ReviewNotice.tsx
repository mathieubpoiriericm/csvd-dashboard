import { formatLongDate } from "../../lib/constants.ts";
import { SIMULATED_NOTE } from "../../lib/review/copy.ts";

/**
 * What every review page says first: the changes are real, the committee is
 * not. One block, so the three pages cannot word it three ways. Its second
 * line names the run the round comes from, which is day 0 of the simulated
 * clock the history and the members' activity count from.
 */
export function ReviewNotice({ runTimestamp }: { runTimestamp: string }) {
  const date = formatLongDate(runTimestamp);
  return (
    <div class="notice notice-neutral review-notice">
      <p>{SIMULATED_NOTE}</p>
      {date && <p class="review-notice-run">Pipeline run of {date}</p>}
    </div>
  );
}
