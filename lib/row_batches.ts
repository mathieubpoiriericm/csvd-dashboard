/**
 * Where the first render of a table page should stop, so the frame that
 * answers an interaction carries a bounded number of new rows.
 *
 * Creating a row is what costs: a /genes row is about sixty elements and
 * eight tooltips, and at 4x CPU throttling drawing 87 of them in the frame of
 * a page-size change measured a 184 ms event, at the edge of a good INP. The
 * batch is a prefix of the page: every row up to the point where `batch` rows
 * the last frame did not draw have been counted, and the caller draws the rest
 * after that frame has painted. Rows already drawn inside that prefix cost
 * nothing, so a sort or a narrowing search -- which only move or remove rows --
 * renders whole. A drawn row that sits past the cutoff (a search cleared back
 * to a full page, its few drawn rows spread through it) is torn down and built
 * again a frame later: the price of a contiguous batch, and far smaller than
 * drawing every new row that comes before it in one frame.
 *
 * `continuesBlock(index)` says that row `index` belongs to a merged block
 * started above it (a covered cell, on the trials table). A batch never ends
 * inside one: the block's rowspan cell would be short for a frame and its
 * covered cells missing.
 */
export function firstBatchEnd(
  ids: readonly string[],
  drawn: ReadonlySet<string>,
  batch: number,
  continuesBlock: (index: number) => boolean,
): number {
  let end = 0;
  let fresh = 0;
  for (; end < ids.length; end++) {
    if (drawn.has(ids[end])) continue;
    if (fresh === batch) break;
    fresh++;
  }
  while (end < ids.length && continuesBlock(end)) end++;
  return end;
}
