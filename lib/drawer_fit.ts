/**
 * Fitting a trial record into the radar's drawer without a scrollbar.
 *
 * The drawer is never a scrollport: its registration marks sit 6px outside
 * its edge, and a scrollport counts them as overflow, so every record
 * scrolled both ways by exactly that much. A record taller than the room
 * under the navbar is zoomed down instead, as far as `DRAWER_FIT_FLOOR`;
 * past that the drawer grows and the page scrolls. The island measures; this
 * module only decides.
 */

/** The smallest zoom a record is drawn at: a 13px value stays about 11px. */
export const DRAWER_FIT_FLOOR = 0.85;

/** Halvings of the [floor, 1] interval: a step of 0.15 / 64, under 0.3%. */
const STEPS = 6;

export interface DrawerFit {
  zoom: number;
  /** False when the record overflows `room` even at the floor. */
  fits: boolean;
}

/**
 * The largest zoom in [`DRAWER_FIT_FLOOR`, 1] at which the record fits.
 *
 * `heightAt` lays the record out at a zoom and returns its height in the
 * same units as `room`. Text rewraps in steps as it shrinks, so height is
 * not a smooth function of zoom; the search therefore only ever returns a
 * zoom it has measured to fit.
 */
export function fitZoom(
  heightAt: (zoom: number) => number,
  room: number,
): DrawerFit {
  if (heightAt(1) <= room) return { zoom: 1, fits: true };
  if (heightAt(DRAWER_FIT_FLOOR) > room) {
    return { zoom: DRAWER_FIT_FLOOR, fits: false };
  }
  let fitting = DRAWER_FIT_FLOOR;
  let overflowing = 1;
  for (let step = 0; step < STEPS; step++) {
    const zoom = (fitting + overflowing) / 2;
    if (heightAt(zoom) <= room) fitting = zoom;
    else overflowing = zoom;
  }
  return { zoom: fitting, fits: true };
}
