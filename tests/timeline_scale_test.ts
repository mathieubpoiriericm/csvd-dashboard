import { assertEquals } from "@std/assert";

import {
  type Box,
  computeTimelineLayout,
  encoding,
  LABEL_GAP,
  type Marker,
  MARKER_RADIUS,
} from "../lib/timeline.ts";
import { sampleTrial } from "./fixtures/rows.ts";
import {
  countFaults,
  FLOOR_STEP,
  HYSTERESIS,
  initialRadarState,
  isClean,
  markerGrowth,
  markerGrowthCap,
  nextRadarState,
  plateScale,
  RADAR_MIN_ROOM,
  type RadarObservation,
  type RadarState,
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

const obs = (o: Partial<RadarObservation> = {}): RadarObservation => ({
  room: 900,
  plateWidth: 800,
  heightLimited: false,
  drawerBeside: false,
  drawerSpace: 340,
  clean: true,
  ...o,
});
const radar = (s: Partial<RadarState> = {}): RadarState => ({
  mode: "radar",
  floor: 0,
  stacked: false,
  ...s,
});

Deno.test("initialRadarState starts in phone mode below the minimum room", () => {
  assertEquals(initialRadarState(RADAR_MIN_ROOM - 1), {
    mode: "phone",
    floor: 0,
    stacked: false,
  });
  assertEquals(initialRadarState(RADAR_MIN_ROOM), radar());
});

Deno.test("rule 1: a room below the minimum is phone mode, floor kept", () => {
  assertEquals(
    nextRadarState(radar({ floor: 600, stacked: true }), obs({ room: 479 })),
    { mode: "phone", floor: 600, stacked: true },
  );
});

Deno.test("rule 2: phone mode returns to radar once the room clears the floor", () => {
  const phone = radar({ mode: "phone", floor: 600 });
  assertEquals(
    nextRadarState(phone, obs({ room: 600 + HYSTERESIS })),
    radar({ floor: 600 }),
  );
  assertEquals(
    nextRadarState(phone, obs({ room: 600 + HYSTERESIS - 1 })),
    phone,
  );
});

Deno.test("rule 3: an unsettled solve changes nothing", () => {
  const s = radar({ floor: 100, stacked: true });
  assertEquals(nextRadarState(s, obs({ clean: null })), s);
});

Deno.test("rule 4: a clean radar stays, and unstacks only with room to spare", () => {
  const s = radar({ floor: 500, stacked: true });
  assertEquals(nextRadarState(radar(), obs()), radar());
  const roomy = obs({ room: 500 + HYSTERESIS + 340 });
  assertEquals(nextRadarState(s, roomy), radar({ floor: 500 }));
  assertEquals(nextRadarState(s, obs({ room: 500 + HYSTERESIS + 339 })), s);
  assertEquals(nextRadarState(s, { ...roomy, drawerBeside: true }), s);
  assertEquals(
    nextRadarState(radar({ floor: 500 }), roomy),
    radar({ floor: 500 }),
  );
});

Deno.test("rule 5: a height-limited fault raises the floor and stays radar", () => {
  assertEquals(
    nextRadarState(
      radar({ floor: 100 }),
      obs({ clean: false, heightLimited: true, drawerBeside: true }),
    ),
    radar({ floor: 800 + FLOOR_STEP }),
  );
});

Deno.test("rule 6: a faulty radar with the drawer beside stacks it", () => {
  const faulty = obs({ clean: false, drawerBeside: true });
  assertEquals(
    nextRadarState(radar({ floor: 100 }), faulty),
    radar({ floor: 801, stacked: true }),
  );
  assertEquals(
    nextRadarState(radar({ floor: 900 }), faulty),
    radar({ floor: 900, stacked: true }),
  );
});

Deno.test("rule 7: any other fault is phone mode, floor at least the plate", () => {
  assertEquals(
    nextRadarState(radar({ floor: 100 }), obs({ clean: false })),
    { mode: "phone", floor: 801, stacked: false },
  );
  assertEquals(
    nextRadarState(radar({ floor: 900 }), obs({ clean: false })),
    { mode: "phone", floor: 900, stacked: false },
  );
});

Deno.test("fonts arriving late: fault, phone, then the room widens", () => {
  const phone = nextRadarState(
    radar(),
    obs({ clean: false, plateWidth: 600, room: 640 }),
  );
  assertEquals(phone.mode, "phone");
  const back = nextRadarState(phone, obs({ room: phone.floor + HYSTERESIS }));
  assertEquals(back.mode, "radar");
});

Deno.test("short window: height-limited fault, raised floor, then clean", () => {
  const raised = nextRadarState(
    radar(),
    obs({ clean: false, heightLimited: true, plateWidth: 700 }),
  );
  assertEquals(raised, radar({ floor: 700 + FLOOR_STEP }));
  assertEquals(nextRadarState(raised, obs({ plateWidth: 748 })), raised);
});

Deno.test("drawer beside: a fault stacks it and never reaches phone mode", () => {
  const s = nextRadarState(
    radar(),
    obs({ clean: false, drawerBeside: true, plateWidth: 560 }),
  );
  assertEquals(s, radar({ floor: 561, stacked: true }));
  assertEquals(nextRadarState(s, obs({ plateWidth: 700 })), s);
});

Deno.test("computeTimelineLayout's labelOffset moves only the label anchors", () => {
  const rows = [
    sampleTrial({
      targetPopulation: encoding.populations[0].key,
      clinicalTrialPhase: encoding.rings[0].phase,
      mechanismOfAction: Object.keys(encoding.mechanisms)[0],
    }),
  ];
  const [rest] = computeTimelineLayout(rows).markers;
  const [grown] = computeTimelineLayout(rows, encoding, {
    labelOffset: (MARKER_RADIUS + LABEL_GAP) * 2,
  }).markers;
  assertEquals(grown.point, rest.point);
  const side = rest.anchor === "start" ? 1 : -1;
  assertEquals(
    rest.labelPoint.x - rest.point.x,
    side * (MARKER_RADIUS + LABEL_GAP),
  );
  assertEquals(
    grown.labelPoint.x - grown.point.x,
    side * (MARKER_RADIUS + LABEL_GAP) * 2,
  );
  assertEquals(grown.labelPoint.y, rest.labelPoint.y);
});
