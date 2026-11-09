import { assertEquals } from "@std/assert";

import type { Box, Marker } from "../lib/timeline.ts";
import {
  countFaults,
  isClean,
  markerGrowth,
  markerGrowthCap,
  plateScale,
} from "../lib/timeline_scale.ts";

const at = (x: number, y: number) => ({ point: { x, y } }) as Marker;
const box = (x: number, y: number, width = 10, height = 10): Box => ({
  x,
  y,
  width,
  height,
});
const PLATE = box(0, 0, 100, 100);

Deno.test("plateScale is the rendered over the drawn width, within (0, 1]", () => {
  assertEquals(plateScale(536), 0.5);
  assertEquals(plateScale(2000), 1);
  assertEquals(plateScale(0), 1);
});

Deno.test("markerGrowthCap is half the closest pair over the radius", () => {
  assertEquals(markerGrowthCap([at(0, 0), at(30, 0), at(300, 0)], 12), 1.25);
  assertEquals(markerGrowthCap([at(0, 0)], 12), Infinity);
  assertEquals(markerGrowthCap([], 12), Infinity);
});

Deno.test("markerGrowth restores rest size, capped and never below 1", () => {
  assertEquals(markerGrowth(0.5, 1.25), 1.25);
  assertEquals(markerGrowth(0.5, 5), 2);
  assertEquals(markerGrowth(1, 0.5), 1);
});

Deno.test("countFaults counts each fault kind once", () => {
  assertEquals(
    countFaults({
      labels: [box(0, 0), box(5, 5)],
      markers: [],
      plate: PLATE,
    }),
    { labelPairs: 1, clipped: 0, touching: 0, markerPairs: 0 },
  );
  assertEquals(
    countFaults({ labels: [box(92, 50)], markers: [], plate: PLATE }).clipped,
    1,
  );
  assertEquals(
    countFaults({ labels: [box(-2, 50)], markers: [], plate: PLATE }).clipped,
    1,
  );
  assertEquals(
    countFaults({ labels: [box(50, -2)], markers: [], plate: PLATE }).clipped,
    1,
  );
  assertEquals(
    countFaults({ labels: [box(50, 92)], markers: [], plate: PLATE }).clipped,
    1,
  );
  assertEquals(
    countFaults({
      labels: [box(20, 20)],
      markers: [box(25, 25)],
      plate: PLATE,
    }),
    { labelPairs: 0, clipped: 0, touching: 1, markerPairs: 0 },
  );
  assertEquals(
    countFaults({
      labels: [],
      markers: [box(60, 60), box(65, 65)],
      plate: PLATE,
    }),
    { labelPairs: 0, clipped: 0, touching: 0, markerPairs: 1 },
  );
});

Deno.test("boxes that only share an edge are not faults", () => {
  assertEquals(
    countFaults({
      labels: [box(0, 0), box(10, 0)],
      markers: [box(0, 10), box(10, 10)],
      plate: PLATE,
    }),
    { labelPairs: 0, clipped: 0, touching: 0, markerPairs: 0 },
  );
});

Deno.test("empty inputs have no faults", () => {
  assertEquals(
    countFaults({ labels: [], markers: [], plate: PLATE }),
    { labelPairs: 0, clipped: 0, touching: 0, markerPairs: 0 },
  );
});

Deno.test("isClean is true only for all zeros", () => {
  const zero = { labelPairs: 0, clipped: 0, touching: 0, markerPairs: 0 };
  assertEquals(isClean(zero), true);
  for (const k of Object.keys(zero) as (keyof typeof zero)[]) {
    assertEquals(isClean({ ...zero, [k]: 1 }), false);
  }
});
