/**
 * Pure arithmetic behind the responsive trials radar: how far the plate is
 * scaled down, how far a marker may grow to compensate, and whether a solved
 * label layout has a fault.
 */

import { type Box, CANVAS, type Marker, overlaps } from "./timeline.ts";

/**
 * The plate's rendered width over its drawing width, clamped to `(0, 1]`. A
 * width of zero or less (the server render, jsdom) has no layout and is 1.
 */
export function plateScale(renderedWidth: number): number {
  if (renderedWidth <= 0) return 1;
  return Math.min(renderedWidth / CANVAS.width, 1);
}

/**
 * The largest factor by which markers of `restRadius` may grow before two of
 * them touch: half the minimum pairwise centre distance over the radius.
 * `Infinity` when fewer than two markers leave nothing to touch.
 */
export function markerGrowthCap(
  markers: readonly Marker[],
  restRadius: number,
): number {
  let min = Infinity;
  for (let i = 0; i < markers.length; i++) {
    for (let j = i + 1; j < markers.length; j++) {
      const d = Math.hypot(
        markers[i].point.x - markers[j].point.x,
        markers[i].point.y - markers[j].point.y,
      );
      if (d < min) min = d;
    }
  }
  return min / 2 / restRadius;
}

/** Growth that keeps a marker's rendered size at rest, capped, never below 1. */
export function markerGrowth(scale: number, cap: number): number {
  return Math.max(1, Math.min(1 / scale, cap));
}

export interface LayoutFaults {
  labelPairs: number;
  clipped: number;
  touching: number;
  markerPairs: number;
}

const CLIP_TOLERANCE = 0.01;

/** Counts what a settled label layout still gets wrong. */
export function countFaults(
  input: { labels: readonly Box[]; markers: readonly Box[]; plate: Box },
): LayoutFaults {
  const { labels, markers, plate } = input;
  let labelPairs = 0;
  let markerPairs = 0;
  let touching = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlaps(labels[i], labels[j])) labelPairs++;
    }
    for (const m of markers) if (overlaps(labels[i], m)) touching++;
  }
  for (let i = 0; i < markers.length; i++) {
    for (let j = i + 1; j < markers.length; j++) {
      if (overlaps(markers[i], markers[j])) markerPairs++;
    }
  }
  const clipped = labels.filter((l) =>
    l.x < plate.x - CLIP_TOLERANCE ||
    l.y < plate.y - CLIP_TOLERANCE ||
    l.x + l.width > plate.x + plate.width + CLIP_TOLERANCE ||
    l.y + l.height > plate.y + plate.height + CLIP_TOLERANCE
  ).length;
  return { labelPairs, clipped, touching, markerPairs };
}

export function isClean(f: LayoutFaults): boolean {
  return f.labelPairs === 0 && f.clipped === 0 && f.touching === 0 &&
    f.markerPairs === 0;
}
