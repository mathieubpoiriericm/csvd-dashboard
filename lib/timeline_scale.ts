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

/** Below this width the radar is never attempted. */
export const RADAR_MIN_ROOM = 480;
/** How much wider a room must get before a mode change is reversed. */
export const HYSTERESIS = 32;
/**
 * The first raise of the floor past a height-limited fault; each raise in
 * an unbroken run of them doubles the last.
 */
export const FLOOR_STEP = 48;

export type RadarMode = "radar" | "phone";

export interface RadarState {
  mode: RadarMode;
  /** A plate width in CSS px; 0 when unknown. */
  floor: number;
  /** The drawer sits above the plate instead of beside it. */
  stacked: boolean;
  /**
   * The last height-limited raise of the floor, in CSS px, which the next
   * one doubles; 0 once a solve is clean or faults for another reason.
   */
  raise: number;
}

export interface RadarObservation {
  /** The width the plate could take with the drawer stacked. */
  room: number;
  plateWidth: number;
  /**
   * The width the plate could take in its row as it stands (the scroller's
   * content width): what a height-limited plate grows towards.
   */
  available: number;
  heightLimited: boolean;
  drawerBeside: boolean;
  /** The drawer's width plus the row gap. */
  drawerSpace: number;
  /** Null until a solve has settled at this size. */
  clean: boolean | null;
}

export function initialRadarState(room: number): RadarState {
  return {
    mode: room < RADAR_MIN_ROOM ? "phone" : "radar",
    floor: 0,
    stacked: false,
    raise: 0,
  };
}

/** One step of the mode decision; the first matching rule wins. */
export function nextRadarState(
  s: RadarState,
  o: RadarObservation,
): RadarState {
  if (o.room < RADAR_MIN_ROOM) return { ...s, mode: "phone" };
  if (s.mode === "phone") {
    return o.room >= s.floor + HYSTERESIS ? { ...s, mode: "radar" } : s;
  }
  if (o.clean === null) return s;
  if (o.clean) {
    const fitsBeside = !o.drawerBeside &&
      o.room - o.drawerSpace >= s.floor + HYSTERESIS;
    const unstack = s.stacked && fitsBeside;
    if (!unstack && s.raise === 0) return s;
    return { ...s, stacked: unstack ? false : s.stacked, raise: 0 };
  }
  if (o.heightLimited) {
    // A step that doubles: a near miss costs a small overshoot, and a short
    // window (a landscape phone) still finds a readable plate in a few
    // solves. Never past the row, where the plate stops growing anyway, and
    // always past the plate.
    const raise = s.raise > 0 ? s.raise * 2 : FLOOR_STEP;
    const reach = Math.min(o.plateWidth + raise, o.available);
    return {
      ...s,
      floor: Math.max(s.floor, reach, o.plateWidth + 1),
      raise,
    };
  }
  const floor = Math.max(s.floor, o.plateWidth + 1);
  if (o.drawerBeside) return { ...s, stacked: true, floor, raise: 0 };
  return { ...s, mode: "phone", floor, raise: 0 };
}
