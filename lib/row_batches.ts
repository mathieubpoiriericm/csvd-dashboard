/**
 * Where the first render of a table page should stop, so the frame that
 * answers an interaction carries a bounded number of new rows.
 *
 * Creating a row is what costs: a /genes row is about sixty elements and
 * eight tooltips, and at 4x CPU throttling drawing 87 of them in the frame of
 * a page-size change measured a 184 ms event, at the edge of a good INP. Rows
 * already on screen are never held back -- a sort or a narrowing search only
 * moves or removes them, and holding one back would tear it down only to
 * build it again a frame later. So the batch is every row the last frame drew,
 * plus the first `batch` rows it did not, and the caller draws the rest after
 * that frame has painted.
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
