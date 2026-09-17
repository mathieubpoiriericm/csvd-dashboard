/**
 * Layout for the trials radar: population sectors × phase rings × drug
 * markers. Pure functions over `Trial` rows; no DOM, so the same code runs on
 * the server, in the island, and under `deno test`.
 *
 * `scripts/timeline_figure.py` implements this rule a second time for print.
 * Both read `lib/timeline_encoding.json` for the rings and chrome and
 * `disease/timeline.json` for populations, mechanisms and families — keep the
 * *rule* here in step with the Python twin (same names, same constants) if
 * either changes.
 *
 * Angles are degrees clockwise from 12 o'clock. Cartesian conversion uses
 * `x = cx + r·sin θ`, `y = cy − r·cos θ`, so θ = 0 is straight up on an SVG
 * canvas whose y axis points down. pyCirclize shares this convention.
 */

import appearanceJson from "./timeline_encoding.json" with { type: "json" };
import diseaseJson from "../disease/timeline.json" with { type: "json" };
import { groupBy, uniqueCount } from "./collections.ts";
import type { Trial } from "./types.ts";
import { NONE, UNKNOWN } from "./sentinels.ts";

export interface PopulationEncoding {
  key: string;
  label: string[];
  /** Wedge fill at Phase III; the outer rings take it at their ring opacity. */
  color: string;
  /** A deeper step of the same hue for the rim band. */
  band: string;
}

export interface RingEncoding {
  phase: string;
  innerRadius: number;
  outerRadius: number;
  opacity: number;
}

/** Both as fractions of the outer radius, like the ring radii. */
export interface RimBandEncoding {
  gap: number;
  width: number;
}

/** The hairline between every cell; `width` is in SVG user units. */
export interface BoundaryEncoding {
  color: string;
  opacity: number;
  width: number;
}

/**
 * One state of what is known about a drug's genetics, and how the marker says
 * so. A ring means somebody assessed this drug: solid when evidence was found,
 * dashed when it was looked for and not found. No ring means nobody looked.
 *
 * The two-state encoding this replaces drew those last two identically, so 90
 * of the 111 committed rows read as a negative finding when they are an absent
 * one -- see `resolveEvidenceState`.
 */
export interface EvidenceStateEncoding {
  key: string;
  ring: string | null;
  /** SVG `stroke-dasharray`, or none for a solid ring. */
  dash: string | null;
  /** How the drawer's Genetic Evidence row reads for this state. */
  field: string;
  legend: string;
}

/**
 * The mark for a record too thin to read at face value, and the wording of the
 * reasons that earn it. `gapRadius` is a fraction of the marker radius, like
 * every other radius here, so each renderer scales it to its own canvas.
 */
export interface RecordFlagEncoding {
  label: string;
  legend: string;
  gapRadius: number;
  reasons: Record<string, string>;
}

export interface FamilyEncoding {
  key: string;
  label: string;
  /** Members from the darkest step to the lightest. */
  mechanisms: string[];
}

export interface TimelineEncoding {
  populations: PopulationEncoding[];
  rings: RingEncoding[];
  rimBand: RimBandEncoding;
  boundary: BoundaryEncoding;
  emptyCell: { opacity: number };
  evidenceStates: EvidenceStateEncoding[];
  recordFlag: RecordFlagEncoding;
  mechanisms: Record<string, string>;
  unknownMechanism: string;
  families: FamilyEncoding[];
}

export const encoding: TimelineEncoding = { ...appearanceJson, ...diseaseJson };

/**
 * SVG user units. The plate is 1.3x the radius of the retired static figure
 * it inherited (320 -> 416) against an unchanged 12-unit drug label, which is
 * what buys the labels the arc length they need. It does not clear them on
 * its own -- the committed rows collide in 123 label pairs at 320 and still
 * in 63 here -- but it is what makes clearing them cheap: `separateLabels`
 * settles either figure, and on this one it moves a label a median 18 units
 * and leaves 55 far enough out to need a leader line, against 68 and 86 on
 * the small plate.
 *
 * The canvas is sized to the label extents the layout actually produces --
 * measured at 1030 x 862 on the committed rows -- leaving 19 units of margin
 * at the tightest edge for the macOS/Linux font-metric spread. `CENTER.x` is
 * the canvas centre; `CENTER.y` is not, because the populated sectors reach
 * further above the centre than below it, and centring y would spend that on
 * empty plate. The 20-unit offset the retired figure carried in x is gone:
 * the measured extents are symmetric there to within four units.
 */
export const CANVAS = { width: 1072, height: 940 } as const;
export const CENTER = { x: 536, y: 484 } as const;
export const OUTER_RADIUS = 416;
export const MARKER_RADIUS = 9;
/** Gap between a marker's edge and the start of its label. */
export const LABEL_GAP = 10;
/** Alternate marker radii by this fraction of the ring thickness. */
export const STAGGER_FRACTION = 0.18;
/** How far beyond the rim band's outer edge population labels are anchored. */
export const POPULATION_LABEL_OFFSET = 24;
/** |sin θ| below this, a population label is centred rather than side-anchored. */
const SIDE_THRESHOLD = 0.2;

/**
 * Which side of the plate a population label reads from, by the angle it sits
 * at. Exported because `placePopulationLabel` may re-place a label at another
 * angle in its own sector, and a label that changes side has to change anchor
 * by the same rule the layout used -- restating the threshold there is how
 * the two would drift.
 */
export function populationAnchor(thetaDeg: number): Anchor {
  const sine = Math.sin(toRadians(thetaDeg));
  return sine > SIDE_THRESHOLD
    ? "start"
    : sine < -SIDE_THRESHOLD
    ? "end"
    : "middle";
}

/**
 * The rim band's radii, as fractions of `OUTER_RADIUS` resolved against an
 * encoding. Exported for the same reason as `populationAnchor`: the plate
 * placement below has to know where the band ends to keep a label off it.
 */
export function rimBandRadii(
  enc: TimelineEncoding,
): { inner: number; outer: number } {
  const inner = OUTER_RADIUS * (1 + enc.rimBand.gap);
  return { inner, outer: inner + OUTER_RADIUS * enc.rimBand.width };
}

export interface Point {
  x: number;
  y: number;
}

export type Anchor = "start" | "middle" | "end";

export interface Sector {
  key: string;
  label: string[];
  color: string;
  band: string;
  startDeg: number;
  endDeg: number;
  drugCount: number;
}

export interface Cell {
  population: string;
  phase: string;
  path: string;
  color: string;
  opacity: number;
  filled: boolean;
}

export interface Marker {
  index: number;
  trial: Trial;
  population: string;
  populationLabel: string;
  phase: string;
  thetaDeg: number;
  r: number;
  point: Point;
  color: string;
  /** Which of the encoding's evidence states this trial resolved to. */
  evidenceState: string;
  /** Colour of the genetic-evidence ring around the marker, or none. */
  evidenceRing: string | null;
  /** `stroke-dasharray` for that ring, or none when it is solid. */
  evidenceDash: string | null;
  /** Reason keys flagging this record as incomplete; empty when it is not. */
  flagReasons: readonly FlagReason[];
  anchor: "start" | "end";
  labelPoint: Point;
}

export interface PopulationLabel {
  key: string;
  lines: string[];
  point: Point;
  anchor: Anchor;
}

export interface PhaseLabel {
  phase: string;
  point: Point;
}

export interface LegendEntry {
  label: string;
  color: string;
}

export interface EvidenceLegendEntry {
  key: string;
  label: string;
  ring: string | null;
  dash: string | null;
}

/** The record-completeness key, with how many markers currently carry it. */
export interface FlagLegend {
  legend: string;
  count: number;
}

/** The arc just outside the rings that carries a population's hue. */
export interface RimBand {
  population: string;
  path: string;
  color: string;
}

/** One mechanism family and the members that appear in the data. */
export interface FamilyLegend {
  key: string;
  label: string;
  entries: LegendEntry[];
}

export interface TimelineLayout {
  sectors: Sector[];
  cells: Cell[];
  rimBands: RimBand[];
  markers: Marker[];
  populationLabels: PopulationLabel[];
  phaseLabels: PhaseLabel[];
  familyLegend: FamilyLegend[];
  evidenceLegend: EvidenceLegendEntry[];
  flagLegend: FlagLegend;
}

const toRadians = (deg: number) => (deg * Math.PI) / 180;

export function polarToPoint(thetaDeg: number, r: number): Point {
  const rad = toRadians(thetaDeg);
  return { x: CENTER.x + r * Math.sin(rad), y: CENTER.y - r * Math.cos(rad) };
}

const fixed = (n: number) => n.toFixed(2);
const at = (p: Point) => `${fixed(p.x)} ${fixed(p.y)}`;

/**
 * SVG path for the annular sector between two angles. With `rInner` at zero it
 * degenerates to a wedge from the centre. Ported from the retired generator's
 * `annular_sector_path`, whose output the layout test pins byte for byte.
 */
export function annularSectorPath(
  rInner: number,
  rOuter: number,
  theta0Deg: number,
  theta1Deg: number,
): string {
  // A sector that closes on itself is not a sector: SVG omits an elliptical
  // arc whose endpoints coincide (SVG 1.1 F.6.2), so the single arc this would
  // otherwise emit draws nothing and the cell collapses to a zero-area line.
  // One population — `computeTimelineLayout(trials.filter(one population))`,
  // which the layout test already builds — gives that population all 360°, so
  // without this the whole plate paints empty. Two half-arcs each have
  // distinct endpoints; the annulus draws its hole by running the inner circle
  // the other way round, which the default nonzero fill rule cuts out.
  if (theta1Deg - theta0Deg >= 360) {
    const opposite = theta0Deg + 180;
    const circle = (r: number, sweep: 0 | 1) => {
      const from = polarToPoint(theta0Deg, r);
      const half = polarToPoint(opposite, r);
      const halfArc = (to: Point) =>
        `A ${fixed(r)} ${fixed(r)} 0 0 ${sweep} ${at(to)}`;
      return `M ${at(from)} ${halfArc(half)} ${halfArc(from)} Z`;
    };
    return rInner <= 0
      ? circle(rOuter, 1)
      : `${circle(rOuter, 1)} ${circle(rInner, 0)}`;
  }

  const largeArc = theta1Deg - theta0Deg > 180 ? 1 : 0;
  const outer0 = polarToPoint(theta0Deg, rOuter);
  const outer1 = polarToPoint(theta1Deg, rOuter);
  const arc = (r: number, sweep: 0 | 1, to: Point) =>
    `A ${fixed(r)} ${fixed(r)} 0 ${largeArc} ${sweep} ${at(to)}`;

  if (rInner <= 0) {
    return `M ${at(CENTER)} L ${at(outer0)} ${arc(rOuter, 1, outer1)} Z`;
  }
  const inner1 = polarToPoint(theta1Deg, rInner);
  const inner0 = polarToPoint(theta0Deg, rInner);
  return `M ${at(outer0)} ${arc(rOuter, 1, outer1)} L ${at(inner1)} ${
    arc(rInner, 0, inner0)
  } Z`;
}

/** Radial offset for the j-th of m markers in one cell; zero for a lone marker. */
export function stagger(j: number, m: number, ringThickness: number): number {
  if (m < 2) return 0;
  return (j % 2 === 0 ? -1 : 1) * STAGGER_FRACTION * ringThickness;
}

/**
 * Reason keys `resolveRecordFlag` can emit, in the order the drawer lists them.
 * `tests/timeline_encoding_test.ts` reconciles this against the encoding's
 * `recordFlag.reasons`, so a rule added here without its wording fails the
 * suite rather than rendering a bare key.
 */
export const FLAG_REASONS = [
  "mechanism-uncharacterised",
  "enrolment-unstated",
  "completion-unstated",
] as const;

export type FlagReason = typeof FLAG_REASONS[number];

/**
 * What is known about this drug's genetics.
 *
 * `geneticEvidence` alone cannot say. The ClinicalTrials.gov sweep that added
 * most of the committed rows left `genetic_target` NULL and defaulted
 * `genetic_evidence` to "No", so a bare "No" covers both "assessed, nothing
 * found" and "never assessed". The target is what separates them: it is the
 * column a curator fills in to record that they looked.
 */
export function resolveEvidenceState(trial: Trial): string {
  if (trial.geneticEvidence === "Yes") return "supported";
  return trial.geneticTarget === NONE ? "unassessed" : "unsupported";
}

/**
 * Why this record is too thin to read at face value, or an empty list.
 *
 * Every rule is exact -- a sentinel, a numeric zero, or membership of the
 * encoding's `uncharacterised` family. None is a fuzzy judgement about whether
 * a stated value is *right*: `pipeline/opentargets_drugs.py` measured that
 * every textual-agreement rule it tried flagged a pair known to agree, and
 * refuses to emit a machine verdict for that reason. This flag says a record
 * is thin or self-declared uncharacterised, never that a value is wrong.
 */
export function resolveRecordFlag(
  trial: Trial,
  enc: TimelineEncoding = encoding,
): FlagReason[] {
  const reasons: FlagReason[] = [];
  const uncharacterised = enc.families.find((f) => f.key === "uncharacterised");
  if (uncharacterised?.mechanisms.includes(trial.mechanismOfAction)) {
    reasons.push("mechanism-uncharacterised");
  }
  // A stated enrolment of zero is as absent as no enrolment at all, and two
  // committed rows carry it.
  const enrolment = Number(trial.targetSampleSize);
  if (
    trial.targetSampleSize === UNKNOWN ||
    (Number.isFinite(enrolment) && enrolment === 0)
  ) {
    reasons.push("enrolment-unstated");
  }
  if (trial.estimatedCompletionDate === UNKNOWN) {
    reasons.push("completion-unstated");
  }
  return reasons;
}

const uniqueDrugCount = (rows: readonly Trial[]) =>
  uniqueCount(rows.map((row) => row.drug));

export function computeTimelineLayout(
  rows: readonly Trial[],
  enc: TimelineEncoding = encoding,
): TimelineLayout {
  const rowsByPopulation = groupBy(rows, (row) => row.svdPopulation);

  const counts = enc.populations.map((p) =>
    uniqueDrugCount(rowsByPopulation.get(p.key) ?? [])
  );
  const total = counts.reduce((sum, n) => sum + n, 0) || 1;

  let cursor = 0;
  const sectors: Sector[] = enc.populations.map((p, i) => {
    const startDeg = cursor;
    cursor += (counts[i] / total) * 360;
    return {
      key: p.key,
      label: p.label,
      color: p.color,
      band: p.band,
      startDeg,
      endDeg: cursor,
      drugCount: counts[i],
    };
  });

  const cells: Cell[] = [];
  const markers: Marker[] = [];
  const evidenceByKey = new Map(
    enc.evidenceStates.map((state) => [state.key, state]),
  );

  for (const sector of sectors) {
    const populationRows = rowsByPopulation.get(sector.key) ?? [];
    for (const ring of enc.rings) {
      const inCell = populationRows.filter((row) =>
        row.clinicalTrialPhase === ring.phase
      );
      const filled = inCell.length > 0;
      cells.push({
        population: sector.key,
        phase: ring.phase,
        path: annularSectorPath(
          ring.innerRadius * OUTER_RADIUS,
          ring.outerRadius * OUTER_RADIUS,
          sector.startDeg,
          sector.endDeg,
        ),
        color: sector.color,
        opacity: filled ? ring.opacity : enc.emptyCell.opacity,
        filled,
      });

      const thickness = (ring.outerRadius - ring.innerRadius) * OUTER_RADIUS;
      const midRadius = ((ring.innerRadius + ring.outerRadius) / 2) *
        OUTER_RADIUS;
      inCell.forEach((trial, j) => {
        const evidenceState = resolveEvidenceState(trial);
        const state = evidenceByKey.get(evidenceState);
        const fraction = (j + 1) / (inCell.length + 1);
        const thetaDeg = sector.startDeg +
          fraction * (sector.endDeg - sector.startDeg);
        const r = midRadius + stagger(j, inCell.length, thickness);
        const point = polarToPoint(thetaDeg, r);
        const anchor = point.x >= CENTER.x ? "start" : "end";
        const dx = (MARKER_RADIUS + LABEL_GAP) * (anchor === "start" ? 1 : -1);
        markers.push({
          index: markers.length,
          trial,
          population: sector.key,
          populationLabel: sector.label.join(" "),
          phase: ring.phase,
          thetaDeg,
          r,
          point,
          color: enc.mechanisms[trial.mechanismOfAction] ??
            enc.unknownMechanism,
          evidenceState,
          evidenceRing: state?.ring ?? null,
          evidenceDash: state?.dash ?? null,
          flagReasons: resolveRecordFlag(trial, enc),
          anchor,
          labelPoint: { x: point.x + dx, y: point.y },
        });
      });
    }
  }

  const { inner: bandInner, outer: bandOuter } = rimBandRadii(enc);
  const populatedSectors = sectors.filter((sector) => sector.drugCount > 0);
  const rimBands: RimBand[] = populatedSectors
    .map((sector) => ({
      population: sector.key,
      path: annularSectorPath(
        bandInner,
        bandOuter,
        sector.startDeg,
        sector.endDeg,
      ),
      color: sector.band,
    }));

  // Populated sectors only, like `rimBands` above and like the print twin,
  // which iterates the sectors it handed to Circos. An empty population spans
  // zero degrees, so labelling it would stack its name on its neighbours' at
  // the sector boundary with no band beneath it.
  const populationLabels: PopulationLabel[] = populatedSectors
    .map((sector) => {
      const midDeg = (sector.startDeg + sector.endDeg) / 2;
      return {
        key: sector.key,
        lines: sector.label,
        point: polarToPoint(midDeg, bandOuter + POPULATION_LABEL_OFFSET),
        anchor: populationAnchor(midDeg),
      };
    });

  const phaseLabels: PhaseLabel[] = enc.rings.map((ring) => ({
    phase: ring.phase,
    point: polarToPoint(
      sectors[0].startDeg,
      ((ring.innerRadius + ring.outerRadius) / 2) * OUTER_RADIUS,
    ),
  }));

  // Grouped by family, darkest step first; a family none of the rows use is
  // left out, so the key never lists a colour the plate does not show.
  const present = new Set(rows.map((row) => row.mechanismOfAction));
  const familyLegend: FamilyLegend[] = enc.families
    .map((family) => ({
      key: family.key,
      label: family.label,
      entries: family.mechanisms
        .filter((mechanism) => present.has(mechanism))
        .map((mechanism) => ({
          label: mechanism,
          color: enc.mechanisms[mechanism] ?? enc.unknownMechanism,
        })),
    }))
    .filter((family) => family.entries.length > 0);
  // File order is legend order, as it is for populations, rings and families.
  // The object this replaced ordered its legend by `Object.entries`, which
  // nothing enforced.
  const evidenceLegend: EvidenceLegendEntry[] = enc.evidenceStates.map((
    state,
  ) => ({
    key: state.key,
    label: state.legend,
    ring: state.ring,
    dash: state.dash,
  }));
  const flagLegend: FlagLegend = {
    legend: enc.recordFlag.legend,
    count: markers.filter((marker) => marker.flagReasons.length > 0).length,
  };

  return {
    sectors,
    cells,
    rimBands,
    markers,
    populationLabels,
    phaseLabels,
    familyLegend,
    evidenceLegend,
    flagLegend,
  };
}

// -----------------------------------------------------------------------------
// LABEL SEPARATION
// -----------------------------------------------------------------------------

/** An axis-aligned box in whatever units the renderer measured it in. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A label box the separation pass may move, and the direction it may move it
 * in besides straight up and down: a unit vector pointing away from the
 * figure's centre. Without one a box is confined to the vertical axis, which
 * is what every caller had before the placement pass below existed.
 */
export interface MovableBox extends Box {
  outward?: Point;
}

/** How far, and in which direction, one label had to move to come clear. */
export interface LabelShift {
  dx: number;
  dy: number;
}

/**
 * Whether two measured box maps describe the same layout.
 *
 * `measureSvgTextBoxes` allocates a fresh `Map` on every pass, so storing its
 * result unconditionally re-renders the whole figure even when no text moved --
 * and the figure is ~700 SVG nodes. The nudge and separation passes are pure
 * functions of the measured boxes, so a pass that measures the same boxes
 * reaches the same result and sets nothing: comparing is what lets it cost
 * nothing instead of a full reconcile.
 */
export function sameBoxes(
  a: ReadonlyMap<string, Box>,
  b: ReadonlyMap<string, Box>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, box] of a) {
    const other = b.get(key);
    if (
      other === undefined || other.x !== box.x || other.y !== box.y ||
      other.width !== box.width || other.height !== box.height
    ) {
      return false;
    }
  }
  return true;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;

/** `a` grown by `gap` on every side still clear of `b`. */
const overlapsWithGap = (a: Box, b: Box, gap: number) =>
  a.x - gap < b.x + b.width && a.x + a.width + gap > b.x &&
  a.y - gap < b.y + b.height && a.y + a.height + gap > b.y;

/**
 * Rounds of the placement pass. Each one re-places every label still caught
 * in an overlap against the labels that are already clear, so a label that
 * moved into somebody else's slot gets another turn. Eight is four more than
 * the committed rows have ever needed.
 */
const PLACEMENT_ROUNDS = 8;
/*
 * The placement pass's search grid, as multiples of the median label height,
 * so the same four numbers mean the same thing to a renderer measuring in SVG
 * user units and to one measuring in display pixels.
 * `scripts/timeline_figure.py` carries all four, and the two `separateLabels`
 * cases in `tests/timeline_layout_test.ts` pin each of them from both sides.
 */

/**
 * How far apart the vertical offsets the pass tries are. Resolution, not
 * reach: a coarser grid overshoots the nearest free slot and settles the
 * label further from its marker than it had to go. Halving it to 0.5 and
 * doubling it to 1 both still clear the committed figure, but leave 59 and 58
 * labels beyond the leader threshold rather than 55; 0.125 finds the same 55,
 * so this is the coarsest step that reaches the minimum.
 */
const PLACEMENT_STEP = 0.25;
/**
 * How far up and down the pass will look. This one is a cliff rather than a
 * cost: at 12 and below the committed figure keeps one colliding pair in
 * Cognitive Impairment's phase IV ring, the densest cell on the plate, and 13
 * is the first value that clears it. Fourteen is that plus a box-height of
 * headroom for the macOS/Linux metric spread.
 */
const PLACEMENT_REACH = 14;
/**
 * How far apart the radial offsets are. Resolution again, and the search is
 * greedy, so neither direction is monotone: 1 and 0.25 both clear the figure
 * and both settle 56 labels beyond the leader threshold against this value's
 * 55.
 */
const RADIAL_STEP = 0.5;
/**
 * How far out along `outward` the pass will look, and a cliff like
 * `PLACEMENT_REACH`. Five box-heights cleared the figure of label-on-label
 * overlaps but left one pair in that same phase IV ring once labels stuck on
 * a marker joined the pass. Eight clears both.
 */
const RADIAL_REACH = 8;

/** One offset the placement pass may try: `radial` runs along `outward`. */
interface PlacementOffset {
  dy: number;
  radial: number;
}

/** Offsets to try, nearest first; radial ties lose to vertical ones. */
function placementCandidates(
  height: number,
  outward: boolean,
): PlacementOffset[] {
  const step = height * PLACEMENT_STEP;
  const reach = height * PLACEMENT_REACH;
  const radialStep = height * RADIAL_STEP;
  const radialReach = outward ? height * RADIAL_REACH : 0;
  const out: PlacementOffset[] = [];
  for (let radial = 0; radial <= radialReach + 1e-9; radial += radialStep) {
    for (let k = 0; k * step <= reach + 1e-9; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        out.push({ dy: sign * k * step, radial });
      }
    }
  }
  out.sort((a, b) =>
    (Math.abs(a.dy) + a.radial) - (Math.abs(b.dy) + b.radial) ||
    a.radial - b.radial ||
    Math.abs(a.dy) - Math.abs(b.dy) ||
    b.dy - a.dy
  );
  return out;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Spatial broad phase; oversized/non-finite geometry uses bounded linear checks. */
class ObstacleGrid {
  private cells = new Map<string, Box[]>();
  private fallback: Box[] = [];

  constructor(private cellSize: number, boxes: readonly Box[]) {
    for (const box of boxes) this.add(box);
  }

  private range(box: Box, gap = 0): number[] | null {
    const coordinates = [
      box.x,
      box.y,
      box.width,
      box.height,
      gap,
      this.cellSize,
    ];
    if (
      !coordinates.every(Number.isFinite) || this.cellSize <= 0 ||
      box.width < 0 || box.height < 0
    ) return null;
    const x0 = Math.floor((box.x - Math.max(0, gap)) / this.cellSize);
    const y0 = Math.floor((box.y - Math.max(0, gap)) / this.cellSize);
    const x1 = Math.floor(
      (box.x + box.width + Math.max(0, gap)) / this.cellSize,
    );
    const y1 = Math.floor(
      (box.y + box.height + Math.max(0, gap)) / this.cellSize,
    );
    if (
      ![x0, y0, x1, y1].every(Number.isSafeInteger) ||
      (x1 - x0 + 1) * (y1 - y0 + 1) > 4096
    ) return null;
    return [x0, y0, x1, y1];
  }

  private all: Box[] = [];

  add(box: Box): void {
    this.all.push(box);
    const range = this.range(box);
    if (!range) {
      this.fallback.push(box);
      return;
    }
    const [x0, y0, x1, y1] = range;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(box);
        else this.cells.set(key, [box]);
      }
    }
  }

  intersects(box: Box, gap = 0): boolean {
    const test = (other: Box) => overlapsWithGap(box, other, gap);
    const range = this.range(box, gap);
    if (!range) return this.all.some(test);
    if (this.fallback.some(test)) return true;
    const [x0, y0, x1, y1] = range;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (this.cells.get(`${x},${y}`)?.some(test)) return true;
      }
    }
    return false;
  }
}

/**
 * Where each label box has to go to come clear of its neighbours, one shift
 * per `movable` box. The stagger keeps markers that share a cell apart, but
 * labels from neighbouring cells still meet — two Isosorbide trials in Stroke
 * III, THN391 against Tranexamic acid at the SVD rim — so renderers measure
 * their boxes and run this over them.
 *
 * Two passes, and the second is why a shift has a `dx`. The first relaxes
 * the boxes vertically: two movable boxes split the overlap between them, the
 * lower one moving down, and a movable box that overlaps a `fixed` one
 * (population and phase labels, and every marker) moves the whole way, away
 * from the fixed box's centre. That alone settles most of the figure, and on
 * the committed rows it leaves 63 pairs still touching, and 53 labels lying
 * across a marker they do not belong to: relaxation deadlocks against those
 * markers, which a label may not settle across, and no number of passes moves
 * it — 12 passes and 1000 reach the same count.
 *
 * So the second pass re-places the labels still caught in one. Each is moved
 * to the nearest free offset on a grid of vertical and radial steps, radial
 * meaning along the box's own `outward` vector, and the renderer draws a
 * leader line back to the marker for any label that ends up further away than
 * its own height. The radial axis is load-bearing rather than decorative:
 * placement confined to the vertical clears this data down to two pairs still
 * touching and thirteen labels still lying on a marker, and with the radial
 * axis it clears both to zero.
 *
 * The result depends only on the input order, so the island and the print
 * script agree on the same boxes. `scripts/timeline_figure.py` carries the
 * twin.
 */
export function separateLabels(
  movable: readonly MovableBox[],
  fixed: readonly Box[] = [],
  gap = 2,
  maxPasses = 12,
): LabelShift[] {
  const shifts: LabelShift[] = movable.map(() => ({ dx: 0, dy: 0 }));
  const working = movable.map(({ x, y, width, height }) => ({
    x,
    y,
    width,
    height,
  }));
  const current = (i: number): Box => {
    const box = working[i];
    box.x = movable[i].x + shifts[i].dx;
    box.y = movable[i].y + shifts[i].dy;
    return box;
  };
  const overlapHeight = (a: Box, b: Box) =>
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + gap;
  const centreY = (box: Box) => box.y + box.height / 2;

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < movable.length; i++) {
      for (const obstacle of fixed) {
        const a = current(i);
        if (!overlaps(a, obstacle)) continue;
        const push = overlapHeight(a, obstacle);
        shifts[i].dy += centreY(a) >= centreY(obstacle) ? push : -push;
        moved = true;
      }
      for (let j = i + 1; j < movable.length; j++) {
        const a = current(i);
        const b = current(j);
        if (!overlaps(a, b)) continue;
        const half = overlapHeight(a, b) / 2;
        const aLower = centreY(a) > centreY(b);
        shifts[i].dy += aLower ? half : -half;
        shifts[j].dy += aLower ? -half : half;
        moved = true;
      }
    }
    if (!moved) break;
  }

  if (movable.length === 0) return shifts;
  // Degenerate measurements must not create a zero-step search loop.
  const heights = movable.map((box) => box.height).filter((height) =>
    Number.isFinite(height) && height >= 1e-6 && height <= 1e100
  );
  const height = heights.length > 0 ? median(heights) : 1;
  const anyOutward = movable.some((box) => box.outward !== undefined);
  const candidates = placementCandidates(height, anyOutward);
  const fixedGrid = new ObstacleGrid(height * 4, fixed);

  for (let round = 0; round < PLACEMENT_ROUNDS; round++) {
    const boxes = movable.map((_, i) => current(i));
    const caught = new Set<number>();
    for (let i = 0; i < boxes.length; i++) {
      // Relaxation gives up after `maxPasses`, so a box can be left sitting on
      // an obstacle as well as on a neighbour. Both are overlaps this pass can
      // place its way out of, and a label lying across somebody else's marker
      // is the worse of the two -- it reassigns the marker.
      if (fixedGrid.intersects(boxes[i])) caught.add(i);
      for (let j = i + 1; j < boxes.length; j++) {
        if (!overlaps(boxes[i], boxes[j])) continue;
        caught.add(i);
        caught.add(j);
      }
    }
    if (caught.size === 0) break;

    const settled = new ObstacleGrid(
      height * 4,
      boxes.filter((_, i) => !caught.has(i)),
    );
    for (const i of [...caught].sort((a, b) => a - b)) {
      const outward = movable[i].outward ?? { x: 0, y: 0 };
      for (const { dy: vertical, radial } of candidates) {
        const dx = outward.x * radial;
        const dy = vertical + outward.y * radial;
        const box = {
          width: movable[i].width,
          height: movable[i].height,
          x: movable[i].x + dx,
          y: movable[i].y + dy,
        };
        if (fixedGrid.intersects(box)) continue;
        if (settled.intersects(box, gap)) continue;
        shifts[i] = { dx, dy };
        break;
      }
      settled.add(current(i));
    }
  }
  return shifts;
}

// -----------------------------------------------------------------------------
// POPULATION LABEL PLACEMENT
// -----------------------------------------------------------------------------

/**
 * Air kept between a re-placed population label and the plate edge. The
 * figure's margin elsewhere is two orders of magnitude bigger
 * (`CANVAS / 2 - OUTER_RADIUS` = 120 units), so this is not trying to match
 * it -- it exists so a corrected label doesn't sit flush on the boundary,
 * 0.01 units from re-tripping the same edge check on the next measurement's
 * subpixel jitter.
 */
export const PLATE_MARGIN = 10;

/** The radius `computeTimelineLayout` anchors every population label at. */
const POPULATION_LABEL_RADIUS = rimBandRadii(encoding).outer +
  POPULATION_LABEL_OFFSET;

/**
 * How close to the rim band a population label may be moved. Half the offset
 * the layout anchored it at, so a correction can never spend more than half
 * the air the layout gave the label over its own band.
 */
const BAND_CLEARANCE = rimBandRadii(encoding).outer +
  POPULATION_LABEL_OFFSET / 2;

/** Angular step of the tangential slide, in degrees. */
const POPULATION_SLIDE_STEP = 0.5;

/**
 * Where a population label ended up once `placePopulationLabel` has had its
 * say: how far it moved, and the side the name now reads from.
 */
export interface PopulationShift extends LabelShift {
  anchor: Anchor;
}

/** A box's left edge relative to its anchor point, as a fraction of its width. */
const ANCHOR_FRACTION: Record<Anchor, number> = {
  start: 0,
  middle: 0.5,
  end: 1,
};

/**
 * How far a box's left edge travels when the same text is re-anchored.
 * Exported because a renderer measuring an already-shifted label has to undo
 * the anchor as well as the offset to recover the box the layout placed.
 */
export function anchorOffsetX(
  from: Anchor,
  to: Anchor,
  width: number,
): number {
  return (ANCHOR_FRACTION[from] - ANCHOR_FRACTION[to]) * width;
}

/** Whether a box sits wholly inside the plate, `PLATE_MARGIN` short of it. */
function fitsPlate(box: Box): boolean {
  return box.x >= PLATE_MARGIN &&
    box.x + box.width <= CANVAS.width - PLATE_MARGIN &&
    box.y >= PLATE_MARGIN &&
    box.y + box.height <= CANVAS.height - PLATE_MARGIN;
}

/**
 * Distance from the plate's centre to the nearest point of a box -- a corner,
 * unless the centre is level with the box on one axis, where it is a point on
 * the near edge. That is the part of a label that reaches the rim band first.
 */
function distanceToCenter(box: Box): number {
  const x = Math.min(Math.max(CENTER.x, box.x), box.x + box.width);
  const y = Math.min(Math.max(CENTER.y, box.y), box.y + box.height);
  return Math.hypot(x - CENTER.x, y - CENTER.y);
}

/**
 * The nearest angle inside a label's own sector at which its box fits the
 * plate, at the radius the layout anchored it at. `base` is the box as the
 * layout places it and `textWidth` its unpadded width, which is what
 * re-anchoring moves the box by.
 */
function slideWithinSector(
  label: PopulationLabel,
  base: Box,
  textWidth: number,
  sectors: readonly Sector[],
): PopulationShift | undefined {
  const sector = sectors.find((candidate) => candidate.key === label.key);
  if (!sector) return undefined;
  const midDeg = (sector.startDeg + sector.endDeg) / 2;
  const halfSpan = (sector.endDeg - sector.startDeg) / 2;
  const offsetX = base.x - label.point.x;
  const offsetY = base.y - label.point.y;
  for (
    let step = POPULATION_SLIDE_STEP;
    step <= halfSpan;
    step += POPULATION_SLIDE_STEP
  ) {
    // Anticlockwise first, so a sector whose two sides fit at the same
    // distance from its mid-point always resolves the same way.
    for (const thetaDeg of [midDeg - step, midDeg + step]) {
      const anchor = populationAnchor(thetaDeg);
      const point = polarToPoint(thetaDeg, POPULATION_LABEL_RADIUS);
      const box = {
        ...base,
        x: point.x + offsetX + anchorOffsetX(label.anchor, anchor, textWidth),
        y: point.y + offsetY,
      };
      if (fitsPlate(box)) {
        return {
          dx: point.x - label.point.x,
          dy: point.y - label.point.y,
          anchor,
        };
      }
    }
  }
  return undefined;
}

/**
 * How a population label whose measured box falls off the plate is brought
 * back onto it; nothing, when the layout's own placement already fits.
 *
 * CANVAS is sized to the angles the committed rows produce, so a status
 * selection that reshapes the sectors can swing a label's angle past that
 * margin -- Stroke's sector straddling straight-down under the radar's
 * default selection is the one that found this.
 *
 * Pulling such a label straight back in is not enough. The shortest way in
 * from an edge points at the figure's centre, and `POPULATION_LABEL_OFFSET`
 * units inside the label lies its own population's rim band -- the one
 * element a population name may not cross, and what three of the four names
 * were dragged onto under that default selection. So a pull that would bring
 * the box's nearest point within `BAND_CLEARANCE` of the centre is rejected
 * and the label slides tangentially instead: same radius, nearest angle in
 * its own sector at which the box fits, re-anchored by `populationAnchor`
 * because a name that crosses to the other side of the plate has to read
 * from that side. The pull stays as the fallback for a label no angle in its
 * sector can fit -- on the plate and over the band still beats off the plate.
 *
 * `base` is the box as the layout places it, so a renderer that has already
 * applied a shift has to undo it (`anchorOffsetX` included) before calling:
 * the answer is then the same on every pass and the measure loop settles.
 * `textWidth` is the unpadded measured width, which is what re-anchoring
 * moves the box by.
 *
 * `scripts/timeline_figure.py` carries no twin of this. It draws only the
 * committed, unfiltered rows, where nothing falls off the plate --
 * `e2e/tests/timeline.spec.ts` reruns its label sweep over that layout and
 * pins it, so the claim is tested rather than assumed.
 */
export function placePopulationLabel(
  label: PopulationLabel,
  base: Box,
  textWidth: number,
  sectors: readonly Sector[],
): PopulationShift | undefined {
  if (fitsPlate(base)) return undefined;
  const dx = base.x < PLATE_MARGIN
    ? PLATE_MARGIN - base.x
    : base.x + base.width > CANVAS.width - PLATE_MARGIN
    ? CANVAS.width - PLATE_MARGIN - (base.x + base.width)
    : 0;
  const dy = base.y < PLATE_MARGIN
    ? PLATE_MARGIN - base.y
    : base.y + base.height > CANVAS.height - PLATE_MARGIN
    ? CANVAS.height - PLATE_MARGIN - (base.y + base.height)
    : 0;
  const pulled = { ...base, x: base.x + dx, y: base.y + dy };
  const straight: PopulationShift = { dx, dy, anchor: label.anchor };
  if (distanceToCenter(pulled) >= BAND_CLEARANCE) return straight;
  return slideWithinSector(label, base, textWidth, sectors) ?? straight;
}
