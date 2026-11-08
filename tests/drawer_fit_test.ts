import { assert, assertEquals } from "@std/assert";
import { DRAWER_FIT_FLOOR, fitZoom } from "../lib/drawer_fit.ts";

/** A record whose height scales with the zoom, as a panel of text does. */
const linear = (natural: number) => (zoom: number) => natural * zoom;

Deno.test("a record that fits keeps its natural size and is measured once", () => {
  const seen: number[] = [];
  const result = fitZoom((zoom) => {
    seen.push(zoom);
    return 500;
  }, 600);
  assertEquals(result, { zoom: 1, fits: true });
  assertEquals(seen, [1]);
});

Deno.test("a record that only fits smaller gets the largest zoom that fits", () => {
  // 600 units of record in 540 of room: 0.9 is the exact answer.
  const { zoom, fits } = fitZoom(linear(600), 540);
  assert(fits);
  assert(zoom <= 0.9, `${zoom} overflows`);
  assert(zoom > 0.9 - (1 - DRAWER_FIT_FLOOR) / 2 ** 6, `${zoom} is too small`);
});

Deno.test("the zoom returned was measured to fit, even when height is not smooth", () => {
  // Text rewraps in steps: a line drops off only past some zoom.
  const stepped = (
    zoom: number,
  ) => (zoom > 0.93 ? 640 : zoom > 0.88 ? 560 : 520);
  const { zoom, fits } = fitZoom(stepped, 560);
  assert(fits);
  assert(stepped(zoom) <= 560);
  assert(zoom > 0.88 && zoom <= 0.93, `${zoom}`);
});

Deno.test("a record too tall even at the floor stops at the floor and says so", () => {
  assertEquals(fitZoom(linear(1000), 500), {
    zoom: DRAWER_FIT_FLOOR,
    fits: false,
  });
});

Deno.test("the floor keeps a 13px value at about 11px", () => {
  assertEquals(DRAWER_FIT_FLOOR, 0.85);
});
