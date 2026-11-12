/** Simulated time: how the committee's clock reads, counted from the run. */

const DAY_MS = 86_400_000;

/** Midnight UTC of the calendar day `ms` falls on. */
const dayStart = (ms: number): number =>
  ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * `Day N, HH:MM`: N the whole UTC calendar days from the run's date to the
 * event's, the clock the event's own UTC time. Calendar days, not elapsed
 * hours, so an event late on the run's day is still Day 0.
 */
export function simulatedTime(at: string, runTimestamp: string): string {
  const when = Date.parse(at);
  const days = Math.round(
    (dayStart(when) - dayStart(Date.parse(runTimestamp))) / DAY_MS,
  );
  const date = new Date(when);
  return `Day ${days}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}
