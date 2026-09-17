import { useHydratedRef } from "../components/useHydratedRef.ts";
import type { Ref } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";

import { CheckboxFilter } from "../components/CheckboxFilter.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import {
  measureSvgTextBoxes,
  whenFontsReady,
} from "../components/svgMeasurements.ts";
import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { useEscapeKey } from "../components/useEscapeKey.ts";
import { DEFAULT_TRIAL_STATUSES, STATUS_CHOICES } from "../lib/constants.ts";
import { POPULATION_FIELD } from "../lib/disease/populations.ts";
import { trials } from "../lib/data/trials.ts";
import { defaultTrialFilters, filterTrials } from "../lib/filters.ts";
import { resolveTrialStatus } from "../lib/trials.ts";
import {
  type Anchor,
  anchorOffsetX,
  type Box,
  CANVAS,
  CENTER,
  computeTimelineLayout,
  encoding,
  type LabelShift,
  type Marker,
  type MovableBox,
  placePopulationLabel,
  type Point,
  type PopulationLabel,
  type PopulationShift,
  sameBoxes,
  separateLabels,
} from "../lib/timeline.ts";
import type { Trial } from "../lib/types.ts";

const RADAR_FILTERS = {
  statuses: {
    label: "Study status",
    choices: STATUS_CHOICES,
    initial: DEFAULT_TRIAL_STATUSES,
  },
} as const;

type Layout = ReturnType<typeof computeTimelineLayout>;

/** A sector's display title, falling back to its raw key. */
const populationTitle = (layout: Layout, key: string) =>
  layout.sectors.find((s) => s.key === key)?.label.join(" ") ?? key;

const DRAWER_ID = "timeline-drawer";
const DRUG_FONT_SIZE = 12;
const POPULATION_FONT_SIZE = 14;
const POPULATION_SUBLINE_SIZE = 12;
const PHASE_FONT_SIZE = 11;
const LINE_HEIGHT_EM = 1.2;
/** Drawn radius; `MARKER_RADIUS` in lib/timeline.ts is the layout's spacing. */
const MARKER_DRAW_RADIUS = 8;
const MARKER_RING_WIDTH = 2;
/** The genetic-evidence ring drawn around a marker. */
const EVIDENCE_RING_RADIUS = 12;
const EVIDENCE_RING_WIDTH = 1.5;
/** The plate is white; marker rings, band separators and halos are cut from it. */
const PLATE = "#ffffff";
const HALO_WIDTH = 3.5;
const BAND_SEPARATOR_WIDTH = 1.5;
/** Radial push when a fitted drug label still touches its marker. */
const NUDGE = 10;
const MAX_NUDGE_PASSES = 3;
/**
 * Pre-hydration placeholder only. Every box is refitted from `getBBox()` as
 * soon as the island mounts, and again once the web font has loaded.
 */
const PLACEHOLDER_EM = 0.55;
const TOOLTIP_MARGIN = 10;
const TOOLTIP_CURSOR_GAP = 12;
const TOOLTIP_CLOSE_DELAY_MS = 180;

const DRUG_PADDING = { x: 3, y: 1 };
const LABEL_PADDING = { x: 4, y: 2 };

/**
 * Radius of the plate-coloured hole punched in a flagged marker. It sits
 * inside the marker's own disc, so it joins no collision pass and costs the
 * label layout nothing.
 */
const MARKER_GAP_RADIUS = encoding.recordFlag.gapRadius * MARKER_DRAW_RADIUS;

/** How the drawer's Genetic Evidence row reads, per resolved state. */
const EVIDENCE_FIELD = new Map(
  encoding.evidenceStates.map((state) => [state.key, state.field]),
);

/**
 * What a drawer row prints. Two of the twelve fields are not their stored
 * value: Genetic Evidence reads the resolved state's wording, because a ring
 * means somebody assessed the drug rather than that the column says "No";
 * and Study Status is a ClinicalTrials.gov token, shown the way the trials
 * table and the map popup show it. `resolveTrialStatus` hands back a token
 * it does not know verbatim -- the export's "(unknown)" sentinel included --
 * which is how every other absent value reads here.
 */
const drawerValue = (marker: Marker, key: keyof Trial): string =>
  key === "geneticEvidence"
    ? EVIDENCE_FIELD.get(marker.evidenceState) ?? marker.trial[key]
    : key === "overallStatus"
    ? resolveTrialStatus(marker.trial[key]).label
    : marker.trial[key];

/** Why a record is flagged, in the encoding's wording. */
const flagWording = (reasons: readonly string[]) =>
  reasons.map((reason) => encoding.recordFlag.reasons[reason] ?? reason);

interface TrialField {
  key: keyof Trial;
  label: string;
  /** Fields carrying an icon also appear in the compact hover tooltip. */
  icon?: IconName;
}

/** One field registry drives both the complete drawer and its tooltip subset. */
const DRUG_FIELDS: readonly TrialField[] = [
  {
    key: "mechanismOfAction",
    label: "Mechanism of Action",
    icon: "molecule",
  },
  { key: "geneticTarget", label: "Genetic Target", icon: "dna" },
  { key: "geneticEvidence", label: "Genetic Evidence" },
  { key: "trialName", label: "Clinical Trial Name" },
  { key: "registryId", label: "Registry ID", icon: "identification" },
  // The field the radar itself filters on. No icon: the tooltip is the
  // glance, and a status is not what identifies a trial at one.
  { key: "overallStatus", label: "Study Status" },
  { key: "clinicalTrialPhase", label: "Clinical Trial Phase" },
  { key: "svdPopulationDetails", label: POPULATION_FIELD.detailsLabel },
  { key: "targetSampleSize", label: "Target Sample Size", icon: "userGroup" },
  {
    key: "estimatedCompletionDate",
    label: "Estimated Completion Date",
    icon: "calendar",
  },
  { key: "primaryOutcome", label: "Primary Outcome" },
  { key: "sponsorType", label: "Sponsor Type" },
];

interface Padding {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface TooltipRow {
  /**
   * Set on the drug tooltip, whose rows are icon-labelled. The wedge and band
   * tooltips leave it unset and render `label` as text: they are single-row,
   * so a glyph would carry the whole meaning with nothing to compare it to.
   */
  icon?: IconName;
  label: string;
  value: string;
}

export interface TooltipState {
  title: string;
  /** The marker's mechanism colour, beside the title as in the drawer. */
  swatch?: string;
  /** The drawer's population-and-phase pill, on its band colour. */
  tag?: { label: string; color: string | undefined };
  rows: readonly TooltipRow[];
}

interface TooltipRequest extends TooltipState {
  x: number;
  y: number;
}

export interface TimelineInteractionState {
  active: number | null;
  tooltip: TooltipState | null;
}

export type TimelineInteractionAction =
  | { type: "show-tooltip"; tooltip: TooltipState }
  | { type: "hide-tooltip" }
  | { type: "activate-marker"; index: number }
  | { type: "close-drawer" };

/** One transition owns the mutually exclusive transient and detail states. */
export function timelineInteractionReducer(
  state: TimelineInteractionState,
  action: TimelineInteractionAction,
): TimelineInteractionState {
  switch (action.type) {
    case "show-tooltip":
      return { ...state, tooltip: action.tooltip };
    case "hide-tooltip":
      return state.tooltip === null ? state : { ...state, tooltip: null };
    case "activate-marker":
      return { active: action.index, tooltip: null };
    case "close-drawer":
      return { active: null, tooltip: null };
  }
}

function placeholderBox(
  lines: readonly string[],
  fontSize: number,
  point: Point,
  anchor: Anchor,
): Box {
  const longest = Math.max(...lines.map((line) => line.length));
  const width = longest * fontSize * PLACEHOLDER_EM;
  const height = lines.length * fontSize * LINE_HEIGHT_EM;
  const x = anchor === "start"
    ? point.x
    : anchor === "end"
    ? point.x - width
    : point.x - width / 2;
  return { x, y: point.y - height / 2, width, height };
}

function padded(box: Box, pad: Padding): Box {
  return {
    x: box.x - pad.x,
    y: box.y - pad.y,
    width: box.width + pad.x * 2,
    height: box.height + pad.y * 2,
  };
}

/** How far a marker reaches: its evidence ring when it has one. */
function hitRadius(marker: Marker): number {
  return marker.evidenceRing
    ? EVIDENCE_RING_RADIUS + EVIDENCE_RING_WIDTH / 2
    : MARKER_DRAW_RADIUS + MARKER_RING_WIDTH / 2;
}

/** Same test the retired timeline.js used: the marker's bounding square. */
function touchesMarker(box: Box, marker: Point, radius: number): boolean {
  return marker.x + radius > box.x &&
    marker.x - radius < box.x + box.width &&
    marker.y + radius > box.y &&
    marker.y - radius < box.y + box.height;
}

/** The square a marker occupies, as an obstacle for the separation pass. */
function markerBox(marker: Marker): Box {
  const r = hitRadius(marker) + 1;
  return {
    x: marker.point.x - r,
    y: marker.point.y - r,
    width: 2 * r,
    height: 2 * r,
  };
}

/** Unit vector from the plate's centre through a marker. */
function outwardUnit(marker: Marker): Point {
  const dx = marker.point.x - CENTER.x;
  const dy = marker.point.y - CENTER.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/** The label anchor pushed `amount` units further from the centre. */
function nudgedLabelPoint(marker: Marker, amount: number): Point {
  if (!amount) return marker.labelPoint;
  const out = outwardUnit(marker);
  return {
    x: marker.labelPoint.x + out.x * amount,
    y: marker.labelPoint.y + out.y * amount,
  };
}

/**
 * Clamp a fixed-position tooltip to the viewport: centred above the cursor
 * when that fits, otherwise beside it (never below — a panel under the cursor
 * would sit over what the pointer is about to move onto).
 */
export function placeTooltip(
  size: Size,
  cursor: Point,
  viewport: Size,
): Point {
  const margin = TOOLTIP_MARGIN;
  const clampAxis = (
    position: number,
    panelExtent: number,
    viewportExtent: number,
  ) => {
    // If the panel is larger than the viewport there is no position that can
    // keep both edges inside. Pin it to zero instead of letting a negative
    // upper clamp push the leading edge off-screen; CSS can then constrain the
    // physical size independently.
    const available = Math.max(viewportExtent - panelExtent, 0);
    const inset = Math.min(margin, available / 2);
    return Math.min(Math.max(position, inset), available - inset);
  };
  let x = cursor.x - size.width / 2;
  let y = cursor.y - size.height - TOOLTIP_CURSOR_GAP;

  if (y < margin) {
    x = cursor.x + TOOLTIP_CURSOR_GAP;
    y = cursor.y - size.height / 2;
    if (x + size.width > viewport.width - margin) {
      x = cursor.x - size.width - TOOLTIP_CURSOR_GAP;
    }
  }
  return {
    x: clampAxis(x, size.width, viewport.width),
    y: clampAxis(y, size.height, viewport.height),
  };
}

interface TextStyle {
  weight: number;
  /** `letter-spacing`, for the tracked caps. */
  tracking?: string;
  opacity?: number;
  /** Cut a plate-coloured contour around the glyphs. */
  halo?: boolean;
}

interface LabelBoxProps {
  id: string;
  lines: readonly string[];
  point: Point;
  anchor: Anchor;
  fontSize: number;
  style: TextStyle;
  /** Every line after the first, when it is set smaller (population names). */
  subline?: { size: number; style: TextStyle };
  padding: Padding;
  measured: Box | undefined;
}

/**
 * A text label and the box it was measured into. Nothing paints the box: it
 * is the fit the separation pass and the tests read, sized from the text the
 * browser actually rendered — the reason the old generator's glyph-width
 * table could go. The label itself is ink with a plate-coloured halo where it
 * has to read over a wedge.
 */
function LabelBox(
  { id, lines, point, anchor, fontSize, style, subline, padding, measured }:
    LabelBoxProps,
) {
  const box = padded(
    measured ?? placeholderBox(lines, fontSize, point, anchor),
    padding,
  );
  const firstDy = 0.35 - (LINE_HEIGHT_EM * (lines.length - 1)) / 2;
  const halo = style.halo
    ? {
      "paint-order": "stroke",
      stroke: PLATE,
      "stroke-width": HALO_WIDTH,
      "stroke-linejoin": "round",
    } as const
    : {};
  return (
    <>
      <rect
        class="label-bg"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        fill="none"
        pointer-events="none"
      />
      <text
        data-label={id}
        class="label-ink"
        x={point.x}
        y={point.y}
        font-size={fontSize}
        font-weight={style.weight}
        letter-spacing={style.tracking}
        fill-opacity={style.opacity}
        text-anchor={anchor}
        {...halo}
      >
        {lines.map((line, i) => {
          const sub = i > 0 ? subline : undefined;
          return (
            <tspan
              key={i}
              x={point.x}
              dy={`${i === 0 ? firstDy : LINE_HEIGHT_EM}em`}
              font-size={sub?.size}
              font-weight={sub?.style.weight}
              letter-spacing={sub?.style.tracking}
              fill-opacity={sub?.style.opacity}
            >
              {line}
            </tspan>
          );
        })}
      </text>
    </>
  );
}

const DRUG_STYLE: TextStyle = { weight: 500, halo: true };
const POPULATION_STYLE: TextStyle = { weight: 600 };
const POPULATION_SUBLINE: TextStyle = { weight: 400, opacity: 0.7 };
const PHASE_STYLE: TextStyle = {
  weight: 600,
  tracking: "0.12em",
  opacity: 0.72,
  halo: true,
};

function drugTooltip(
  layout: Layout,
  marker: Marker,
  x: number,
  y: number,
): TooltipRequest {
  return {
    title: marker.trial.drug,
    swatch: marker.color,
    tag: {
      label: `${marker.populationLabel} · Phase ${marker.phase}`,
      color: layout.sectors.find((s) => s.key === marker.population)?.band,
    },
    rows: [
      // Ahead of the fields, because it qualifies all of them.
      ...(marker.flagReasons.length > 0
        ? [{
          icon: "exclamationTriangle" as IconName,
          label: encoding.recordFlag.label,
          value: flagWording(marker.flagReasons).join("; "),
        }]
        : []),
      ...DRUG_FIELDS.flatMap(({ key, label, icon }) =>
        icon ? [{ icon, label, value: marker.trial[key] }] : []
      ),
    ],
    x,
    y,
  };
}

/**
 * The key, rendered above the plate, collapsed -- the phenogram's
 * arrangement. It was a right-hand rail once; assets/app.css records why the
 * rail and its breakpoints went.
 */
function TimelineLegend({ layout }: { layout: Layout }) {
  return (
    <details class="figure-key" id="timeline-key">
      <summary class="figure-key-summary">Key</summary>
      <div class="timeline-legend">
        <section class="timeline-legend-panel">
          <h2 class="timeline-legend-title">Genetic evidence</h2>
          {
            /* No CSS rule reads .timeline-legend-evidence -- both keys share
            .timeline-legend-list for their styling. It stays as the e2e's
            disambiguating hook: e2e/tests/timeline.spec.ts's dark-mode
            contrast check needs to select this key's `.timeline-legend-item`
            apart from the mechanism key's, which carries no second class of
            its own. */
          }
          <ul class="timeline-legend-list timeline-legend-evidence">
            {layout.evidenceLegend.map((entry) => (
              <li key={entry.label} class="timeline-legend-item">
                <svg
                  class="timeline-legend-sample"
                  viewBox="0 0 32 20"
                  aria-hidden="true"
                >
                  <circle
                    cx={16}
                    cy={10}
                    r={6}
                    fill="currentColor"
                    stroke={PLATE}
                    stroke-width={1.5}
                  />
                  {entry.ring && (
                    <circle
                      cx={16}
                      cy={10}
                      r={9}
                      fill="none"
                      stroke={entry.ring}
                      stroke-width={1.25}
                      stroke-dasharray={entry.dash ?? undefined}
                    />
                  )}
                </svg>
                {entry.label}
              </li>
            ))}
          </ul>
        </section>
        <section class="timeline-legend-panel">
          <h2 class="timeline-legend-title">Record completeness</h2>
          <ul class="timeline-legend-list">
            <li class="timeline-legend-item">
              <svg
                class="timeline-legend-sample"
                viewBox="0 0 32 20"
                aria-hidden="true"
              >
                <circle
                  cx={16}
                  cy={10}
                  r={6}
                  fill="currentColor"
                  stroke={PLATE}
                  stroke-width={1.5}
                />
                <circle
                  cx={16}
                  cy={10}
                  r={6 * encoding.recordFlag.gapRadius}
                  fill={PLATE}
                />
              </svg>
              {layout.flagLegend.legend} ({layout.flagLegend.count} of{" "}
              {layout.markers.length})
            </li>
          </ul>
        </section>
        <section class="timeline-legend-panel">
          <h2 class="timeline-legend-title">Mechanism of action</h2>
          <div class="timeline-legend-families">
            {layout.familyLegend.map((family) => (
              <div key={family.key} class="timeline-legend-family">
                <h3 class="timeline-legend-family-title">{family.label}</h3>
                <ul class="timeline-legend-list">
                  {family.entries.map((entry) => (
                    <li key={entry.label} class="timeline-legend-item">
                      <span
                        class="timeline-legend-dot"
                        style={{ background: entry.color }}
                        aria-hidden="true"
                      />
                      {entry.label}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}

interface TrialDrawerProps {
  layout: Layout;
  marker: Marker | null;
  closeRef: Ref<HTMLButtonElement>;
  onClose: () => void;
}

function TrialDrawer({ layout, marker, closeRef, onClose }: TrialDrawerProps) {
  return (
    <aside
      id={DRAWER_ID}
      class="timeline-drawer"
      role="region"
      aria-label="Trial details"
      hidden={!marker}
      inert={!marker}
    >
      {marker && (
        <>
          <div class="timeline-drawer-head">
            <div>
              <h2>
                <span
                  class="timeline-drawer-swatch"
                  style={{ background: marker.color }}
                  aria-hidden="true"
                />
                {marker.trial.drug}
              </h2>
              <span
                class="timeline-drawer-tag"
                style={{
                  background: layout.sectors.find((s) =>
                    s.key === marker.population
                  )?.band,
                }}
              >
                {marker.populationLabel} · Phase {marker.phase}
              </span>
            </div>
            <button
              ref={closeRef}
              type="button"
              class="timeline-drawer-close"
              aria-label="Close trial details"
              onClick={onClose}
            >
              ×
            </button>
          </div>
          {marker.flagReasons.length > 0 && (
            <div class="timeline-drawer-flag">
              <p class="timeline-drawer-flag-head">
                <Icon name="exclamationTriangle" />
                {encoding.recordFlag.label}
              </p>
              <ul>
                {flagWording(marker.flagReasons).map((wording) => (
                  <li key={wording}>{wording}</li>
                ))}
              </ul>
            </div>
          )}
          <dl class="timeline-drawer-fields">
            {DRUG_FIELDS.map(({ key, label }) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{drawerValue(marker, key)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </aside>
  );
}

interface TimelineTooltipProps {
  state: TooltipState | null;
  panelRef: Ref<HTMLDivElement>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

function TimelineTooltip(
  { state, panelRef, onPointerEnter, onPointerLeave }: TimelineTooltipProps,
) {
  if (!state) return null;
  return (
    <div
      ref={panelRef}
      class="timeline-tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      aria-hidden="true"
      style={{
        left: "0px",
        top: "0px",
        visibility: "hidden",
      }}
    >
      <div class="timeline-tooltip-head">
        <div class="timeline-tooltip-title">
          {state.swatch && (
            <span
              class="timeline-tooltip-swatch"
              style={{ background: state.swatch }}
              aria-hidden="true"
            />
          )}
          {state.title}
        </div>
        {state.tag && (
          <span
            class="timeline-tooltip-tag"
            style={{ background: state.tag.color }}
          >
            {state.tag.label}
          </span>
        )}
      </div>
      {state.rows.map((row) =>
        row.icon
          ? (
            <span key={row.label} class="timeline-tooltip-row">
              <Icon name={row.icon} />
              {row.value}
            </span>
          )
          : (
            <span key={row.label} class="tooltip-row">
              <strong>{row.label}</strong> {row.value}
            </span>
          )
      )}
    </div>
  );
}

/**
 * The trials radar: population sectors × phase rings × one marker per trial.
 *
 * Replaces the sandboxed iframe around a pre-rendered SVG. The layout is
 * `lib/timeline.ts`; this island only renders it, fits the label boxes to the
 * text the browser actually drew, and carries the interaction the old
 * `static/timeline.js` had — pointer tooltips, a details drawer, and a
 * keyboard path through the marker groups.
 */
export default function TrialsTimeline() {
  const { values, controls, summary } = useCheckboxFilters(RADAR_FILTERS);
  const filtered = useMemo(
    () =>
      filterTrials(trials, {
        ...defaultTrialFilters(),
        statuses: values.statuses,
      }),
    [values],
  );
  const layout = useMemo(() => computeTimelineLayout(filtered), [filtered]);

  const svgRef = useRef<SVGSVGElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipCursor = useRef<Point | null>(null);
  const tooltipTarget = useRef<Element | null>(null);
  const tooltipDismissed = useRef(false);
  const tooltipFrame = useRef<number | null>(null);
  const tooltipCloseTimer = useRef<ReturnType<typeof setTimeout>>();
  const tooltipOpenTimer = useRef<ReturnType<typeof setTimeout>>();
  const hydratedRef = useHydratedRef<HTMLDivElement>();
  const markerRefs = useRef<Array<SVGGElement | null>>([]);
  const nudgePasses = useRef(0);
  const measureRef = useRef<() => void>(() => {});
  const solvedGeometry = useRef<
    { movable: MovableBox[]; fixed: Box[]; indices: number[] }
  >();
  /** Marker to hand focus back to once the drawer has actually closed. */
  const restoreFocusTo = useRef<number | null>(null);

  const [boxes, setBoxes] = useState<ReadonlyMap<string, Box>>(new Map());
  const [nudges, setNudges] = useState<ReadonlyMap<number, number>>(
    new Map(),
  );
  const [shifts, setShifts] = useState<ReadonlyMap<number, LabelShift>>(
    new Map(),
  );
  // Population labels sit at a fixed radius the layout computes from the
  // sector's mid-angle (lib/timeline.ts, pinned by tests/timeline_layout_test.ts).
  // CANVAS was sized to the angles the committed 102 rows produce; a status
  // selection reshapes the sectors and can swing a label's angle past that
  // margin (Stroke's sector straddling straight-down, for one). Rather than
  // resize the plate -- which the pinned CENTER/CANVAS geometry above would
  // break -- a label that lands off the plate is re-placed on it by
  // `placePopulationLabel`, which slides it round its own sector rather than in over
  // its own rim band.
  const [popShifts, setPopShifts] = useState<
    ReadonlyMap<string, PopulationShift>
  >(
    new Map(),
  );
  const [{ active, tooltip }, dispatchInteraction] = useReducer(
    timelineInteractionReducer,
    { active: null, tooltip: null },
  );

  const measure = () => {
    const svg = svgRef.current;
    if (!svg) return;

    const next = measureSvgTextBoxes(
      svg,
      "text[data-label]",
      (text) => text.dataset.label ?? "",
    );
    // Everything below is a pure function of `next`, so a pass that measured
    // the same boxes would reach the same nudges and shifts and set no state --
    // but `setBoxes` on a fresh Map would still reconcile the whole figure.
    // Mount measures twice and `document.fonts.ready` measures again; on a
    // warm font cache those later passes measure exactly this.
    if (sameBoxes(next, boxes)) return;
    setBoxes(next);

    // A population label sits at a fixed radius from CENTER, at whatever
    // angle its sector's mid-point lands on (lib/timeline.ts). CANVAS was
    // sized to the angles the committed 102 rows produce, with as little as
    // 19 units of margin at the tightest edge, so a status selection that
    // reshapes the sectors can swing a label's angle past that margin --
    // Stroke's sector straddling straight-down under the default filter is
    // the one that found this. A label whose measured extent falls off the
    // plate is re-placed by `placePopulationLabel`: `PLATE_MARGIN` short of the edge
    // rather than flush against it, and round its own sector rather than in
    // across its own rim band, which is what pulling it straight back did to
    // three of the four names under the default selection.
    //
    // Both moves are computed against the box as it would sit *without* the
    // placement already applied -- undoing the anchor as well as the offset,
    // since a slide that crossed sides re-anchored the text -- the same undo
    // `movable` below does, so a second pass finds the same answer and the
    // measure loop settles.
    //
    // `scripts/timeline_figure.py` gets no twin of this pass. It draws only
    // the unfiltered, committed rows -- the print figure has no status
    // filter to recompute against -- and on that one layout the clamp never
    // fires: `e2e/tests/timeline.spec.ts`'s "ticking Show All..." test reruns
    // the label-fit sweep (misfit/clipped/touching) over the full 102-row
    // figure and pins `clipped: []` there too, which is what keeps this
    // claim a tested fact rather than an assumption the two renderers could
    // quietly stop sharing.
    const nextPopShifts = new Map<string, PopulationShift>();
    for (const label of layout.populationLabels) {
      const box = next.get(`pop-${label.key}`);
      if (!box) continue;
      const fitted = padded(box, LABEL_PADDING);
      const applied = popShifts.get(label.key);
      const base = {
        ...fitted,
        x: fitted.x - (applied?.dx ?? 0) -
          anchorOffsetX(
            label.anchor,
            applied?.anchor ?? label.anchor,
            box.width,
          ),
        y: fitted.y - (applied?.dy ?? 0),
      };
      const placed = placePopulationLabel(
        label,
        base,
        box.width,
        layout.sectors,
      );
      if (placed) nextPopShifts.set(label.key, placed);
    }
    const popUnchanged = nextPopShifts.size === popShifts.size &&
      [...nextPopShifts].every(([key, shift]) => {
        const applied = popShifts.get(key);
        return applied !== undefined &&
          applied.anchor === shift.anchor &&
          Math.abs(applied.dx - shift.dx) <= 0.01 &&
          Math.abs(applied.dy - shift.dy) <= 0.01;
      });
    if (!popUnchanged) setPopShifts(nextPopShifts);

    // Push any label that still touches its marker one more step outward.
    //
    // No committed marker reaches its label: `labelPoint` sits MARKER_RADIUS +
    // LABEL_GAP = 19 out, DRUG_PADDING pulls the box edge back 3, and the
    // widest `hitRadius` is 12.75 — 3.25 units of clearance, so `touchesMarker`
    // returns false for all 16 and this whole branch is currently a net rather
    // than a live pass. Keep it correct anyway: the print twin
    // (`scripts/timeline_figure.py:_nudge_labels`) measures in display pixels
    // with its own constants and *can* fire, and either side's spacing may
    // change.
    //
    // `touching` — not the map's size — is what says a pass did something: a
    // label nudged once and still touching keeps the same key, so comparing
    // sizes discarded every push after the first and made the pass count depend
    // on whether some *other* label happened to join the map. The guard scopes
    // only the nudging, so exhausting it cannot skip `separateLabels` below.
    if (nudgePasses.current < MAX_NUDGE_PASSES) {
      const pushed = new Map(nudges);
      let touching = false;
      for (const marker of layout.markers) {
        const box = next.get(`drug-${marker.index}`);
        if (
          box &&
          touchesMarker(
            padded(box, DRUG_PADDING),
            marker.point,
            hitRadius(marker),
          )
        ) {
          pushed.set(marker.index, (pushed.get(marker.index) ?? 0) + NUDGE);
          touching = true;
        }
      }
      if (touching) {
        nudgePasses.current += 1;
        setNudges(pushed);
        return;
      }
    }

    // Labels from neighbouring cells can still meet. Separate them from the
    // boxes as they would sit *without* the current shifts, so the result is
    // the same on every pass and the loop settles after one re-render.
    const movable: MovableBox[] = [];
    const movableIndex: number[] = [];
    for (const marker of layout.markers) {
      const box = next.get(`drug-${marker.index}`);
      if (!box) continue;
      const fitted = padded(box, DRUG_PADDING);
      const applied = shifts.get(marker.index);
      movable.push({
        ...fitted,
        x: fitted.x - (applied?.dx ?? 0),
        y: fitted.y - (applied?.dy ?? 0),
        outward: outwardUnit(marker),
      });
      movableIndex.push(marker.index);
    }
    // Population and phase labels stay put, and so does every marker: a
    // label may not settle across a neighbouring marker's ring.
    const fixed: Box[] = layout.markers.map(markerBox);
    for (const [id, box] of next) {
      if (!id.startsWith("drug-")) fixed.push(padded(box, LABEL_PADDING));
    }
    // getBBox reports shifted positions; compare the unshifted solver input,
    // allowing the same subpixel tolerance used when applying its result.
    const previous = solvedGeometry.current;
    const sameGeometry = (a: readonly Box[], b: readonly Box[]) =>
      a.length === b.length &&
      a.every((box, i) =>
        ["x", "y", "width", "height"].every((key) =>
          Math.abs(box[key as keyof Box] - b[i][key as keyof Box]) <= 0.01
        )
      );
    if (
      previous && sameGeometry(movable, previous.movable) &&
      sameGeometry(fixed, previous.fixed) &&
      movableIndex.every((index, i) => index === previous.indices[i])
    ) return;
    solvedGeometry.current = { movable, fixed, indices: movableIndex };
    const separated = new Map<number, LabelShift>();
    separateLabels(movable, fixed).forEach((shift, k) => {
      if (Math.abs(shift.dx) > 0.01 || Math.abs(shift.dy) > 0.01) {
        separated.set(movableIndex[k], shift);
      }
    });
    const unchanged = separated.size === shifts.size &&
      [...separated].every(([index, shift]) => {
        const applied = shifts.get(index);
        return applied !== undefined &&
          Math.abs(applied.dx - shift.dx) <= 0.01 &&
          Math.abs(applied.dy - shift.dy) <= 0.01;
      });
    if (!unchanged) setShifts(separated);
  };
  measureRef.current = measure;

  // Fit once on mount and after every nudge or shift; all three change text
  // positions, which changes the boxes.
  useLayoutEffect(() => measureRef.current(), [nudges, shifts, popShifts]);

  // A new selection is a new figure: the drawer's index and every measured
  // box, nudge and shift belong to the old marker set. Reset them all and
  // let the mount pass run again over the new labels.
  const mountedLayout = useRef(layout);
  useLayoutEffect(() => {
    if (mountedLayout.current === layout) return;
    mountedLayout.current = layout;
    restoreFocusTo.current = null;
    nudgePasses.current = 0;
    solvedGeometry.current = undefined;
    dispatchInteraction({ type: "close-drawer" });
    dispatchInteraction({ type: "hide-tooltip" });
    setBoxes(new Map());
    setNudges(new Map());
    setShifts(new Map());
    setPopShifts(new Map());
  }, [layout]);

  // The web font arrives after first paint; fit again when it does.
  useEffect(() =>
    whenFontsReady(() => {
      nudgePasses.current = 0;
      measureRef.current();
    }), []);

  // Runs after the DOM has committed, so the close button exists before focus
  // enters it and the declaratively hidden drawer is committed before focus
  // returns to the marker.
  useEffect(() => {
    if (active !== null) {
      closeRef.current?.focus({ preventScroll: true });
      return;
    }
    const restore = restoreFocusTo.current;
    restoreFocusTo.current = null;
    if (restore !== null) {
      markerRefs.current[restore]?.focus({ preventScroll: true });
    }
  }, [active]);

  const close = () => {
    restoreFocusTo.current = active;
    dispatchInteraction({ type: "close-drawer" });
  };

  useEscapeKey(active !== null || tooltip !== null, () => {
    tooltipDismissed.current = true;
    if (active !== null) close();
    hide();
  });

  const cancelTooltipFrame = () => {
    if (tooltipFrame.current === null) return;
    globalThis.cancelAnimationFrame(tooltipFrame.current);
    tooltipFrame.current = null;
  };

  const positionTooltip = () => {
    const panel = tooltipRef.current;
    const cursor = tooltipCursor.current;
    if (!panel || !cursor) return;

    const rect = panel.getBoundingClientRect();
    const point = placeTooltip(
      { width: rect.width, height: rect.height },
      cursor,
      { width: globalThis.innerWidth, height: globalThis.innerHeight },
    );
    panel.style.left = `${point.x}px`;
    panel.style.top = `${point.y}px`;
    panel.style.visibility = "visible";
  };

  useLayoutEffect(() => {
    if (tooltip) positionTooltip();
  }, [tooltip]);

  // Pointer movement can outpace the display refresh rate. Move the fixed
  // panel at most once per frame without reconciling the entire SVG for every
  // pointer event, and keep it bounded if the viewport changes underneath it.
  useEffect(() => {
    const onResize = () => positionTooltip();
    const onPointerMove = () => {
      tooltipDismissed.current = false;
    };
    const onScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        tooltipRef.current?.contains(event.target)
      ) return;
      // A scroll event queued before pointerenter can arrive after the
      // tooltip opens. Keep it if its original target is still under the
      // pointer; dismiss only when scrolling actually moves that target away.
      const cursor = tooltipCursor.current;
      if (
        cursor && tooltipTarget.current?.contains(
          document.elementFromPoint(cursor.x, cursor.y),
        )
      ) return;
      hide();
    };
    globalThis.addEventListener("resize", onResize);
    globalThis.addEventListener("pointermove", onPointerMove, true);
    globalThis.addEventListener("scroll", onScroll, true);
    return () => {
      globalThis.removeEventListener("resize", onResize);
      globalThis.removeEventListener("pointermove", onPointerMove, true);
      globalThis.removeEventListener("scroll", onScroll, true);
      cancelTooltipFrame();
      cancelTooltipClose();
      cancelTooltipOpen();
    };
  }, []);

  const cancelTooltipClose = () => clearTimeout(tooltipCloseTimer.current);

  const cancelTooltipOpen = () => {
    clearTimeout(tooltipOpenTimer.current);
    tooltipOpenTimer.current = undefined;
  };

  const showTooltip = ({ x, y, ...next }: TooltipRequest) => {
    // Removing a hovered panel exposes the SVG beneath it and generates a
    // pointerenter without user movement. Escape must not open that tooltip.
    if (tooltipDismissed.current) return;
    cancelTooltipClose();
    cancelTooltipOpen();
    cancelTooltipFrame();
    const target = document.elementFromPoint(x, y)?.closest(
      ".drug, .wedge, .rim-band",
    ) ?? null;
    const show = () => {
      tooltipOpenTimer.current = undefined;
      tooltipCursor.current = { x, y };
      tooltipTarget.current = target;
      dispatchInteraction({ type: "show-tooltip", tooltip: next });
    };
    // Crossing the gap to a panel can pass over a wedge. Give the pointer
    // time to reach the panel before replacing the record it was reading.
    if (tooltip) {
      tooltipOpenTimer.current = setTimeout(show, TOOLTIP_CLOSE_DELAY_MS);
    } else show();
  };

  const follow = (event: PointerEvent) => {
    if (tooltipOpenTimer.current !== undefined) return;
    tooltipCursor.current = { x: event.clientX, y: event.clientY };
    if (tooltipFrame.current !== null) return;
    tooltipFrame.current = globalThis.requestAnimationFrame(() => {
      tooltipFrame.current = null;
      positionTooltip();
    });
  };

  const hide = () => {
    cancelTooltipOpen();
    cancelTooltipClose();
    cancelTooltipFrame();
    tooltipCursor.current = null;
    tooltipTarget.current = null;
    dispatchInteraction({ type: "hide-tooltip" });
  };

  const hideSoon = () => {
    cancelTooltipOpen();
    cancelTooltipFrame();
    cancelTooltipClose();
    tooltipCloseTimer.current = setTimeout(hide, TOOLTIP_CLOSE_DELAY_MS);
  };

  const activate = (index: number) => {
    cancelTooltipOpen();
    cancelTooltipClose();
    cancelTooltipFrame();
    tooltipCursor.current = null;
    dispatchInteraction({ type: "activate-marker", index });
    if (active === index) closeRef.current?.focus({ preventScroll: true });
  };

  const activeMarker = active === null ? null : layout.markers[active];

  /**
   * A label the separation pass moved further than its own height no longer
   * reads as belonging to the marker beside it, so the figure draws the line
   * that says which one it is. `scripts/timeline_figure.py` applies the same
   * rule to the same shifts. Below the threshold the label is still adjacent
   * and a line would be ink for nothing.
   *
   * Every leader those produce is drawn in one `g.leaders` ahead of the
   * marker groups rather than one inside each `g.drug`. A leader drawn inside
   * its own group paints over the halo and the glyphs of every group before
   * it in document order, and there are 55 of them, up to 276 units long; one
   * group puts the whole channel under every marker and every label, which is
   * where the print twin has it — zorder 4.5, under the markers at 5 and the
   * label halos at 6.9.
   */
  const needsLeader = (marker: Marker): boolean => {
    const shift = shifts.get(marker.index);
    if (!shift) return false;
    const measured = boxes.get(`drug-${marker.index}`);
    const height = (measured?.height ?? DRUG_FONT_SIZE * LINE_HEIGHT_EM) +
      DRUG_PADDING.y * 2;
    return Math.hypot(shift.dx, shift.dy) > height;
  };

  const labelPoint = (marker: Marker): Point => {
    const point = nudgedLabelPoint(marker, nudges.get(marker.index) ?? 0);
    const shift = shifts.get(marker.index);
    return shift ? { x: point.x + shift.dx, y: point.y + shift.dy } : point;
  };

  /** A population label re-placed onto the plate, when its edge clamp fired. */
  const popLabelPlacement = (
    label: PopulationLabel,
  ): { point: Point; anchor: Anchor } => {
    const shift = popShifts.get(label.key);
    return shift
      ? {
        point: { x: label.point.x + shift.dx, y: label.point.y + shift.dy },
        anchor: shift.anchor,
      }
      : { point: label.point, anchor: label.anchor };
  };

  return (
    <div ref={hydratedRef} class="timeline-layout">
      {
        /* Outside .timeline-main rather than immediately before its
          .blueprint-frame: that div is a flex ROW at >=1100px (drawer, then
          frame), and an inline-block skip link inserted between those two
          flex children would become a third row item on focus. Sitting here
          keeps it order-independent of that row/column switch. */
      }
      <a class="skip-figure" href="#timeline-end">Skip the figure</a>
      <div class="timeline-controls">
        {controls.map((props) => (
          <CheckboxFilter
            key={props.label}
            {...props}
          />
        ))}
        <p class="timeline-controls-count" role="status">
          Showing {filtered.length} of {trials.length} trials
          {summary.length > 0 ? ` · ${summary.join("; ")}` : ""}
        </p>
      </div>

      <TimelineLegend layout={layout} />

      <div class="timeline-main">
        <TrialDrawer
          layout={layout}
          marker={activeMarker}
          closeRef={closeRef}
          onClose={close}
        />

        {
          /* The scroller is `overflow: auto`, which clips the frame's
            registration marks at their negative inset, so the frame is a
            wrapper rather than the scroller itself. */
        }
        <div class="blueprint-frame">
          <div class="timeline-scroll">
            <svg
              ref={svgRef}
              class="timeline-figure"
              viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
              aria-labelledby="timeline-title timeline-desc"
            >
              <title id="timeline-title">
                Cerebral SVD clinical trials by population and phase
              </title>
              <desc id="timeline-desc">
                Rings are trial phases, Phase III innermost; sectors are target
                populations; each marker is one trial, coloured by mechanism of
                action. Activate a marker for the trial's details.
              </desc>

              {
                /* A white sheet in both themes: the halos, the marker rings and
                  the band separators are all cut from it. rx matches the
                  phenogram's plate inside the identical card -- 9 SVG user
                  units at this canvas's ~1.11x scale at 1440 is the phenogram's
                  8px, so the corners read as the same radius. */
              }
              <rect
                class="plate"
                x={0}
                y={0}
                width={CANVAS.width}
                height={CANVAS.height}
                rx={9}
                fill={PLATE}
              />

              {layout.cells.map((cell) => (
                <path
                  key={`${cell.population}/${cell.phase}`}
                  class="wedge"
                  data-pop={cell.population}
                  data-phase={cell.phase}
                  d={cell.path}
                  fill={cell.color}
                  fill-opacity={cell.opacity}
                  stroke={encoding.boundary.color}
                  stroke-opacity={encoding.boundary.opacity}
                  stroke-width={encoding.boundary.width}
                  stroke-linejoin="round"
                  onPointerEnter={(event) =>
                    showTooltip({
                      title: populationTitle(layout, cell.population),
                      rows: [{ label: "Phase", value: cell.phase }],
                      x: event.clientX,
                      y: event.clientY,
                    })}
                  onPointerMove={follow}
                  onPointerLeave={hideSoon}
                />
              ))}

              {layout.rimBands.map((band) => (
                <path
                  key={band.population}
                  class="rim-band"
                  data-pop={band.population}
                  d={band.path}
                  fill={band.color}
                  stroke={PLATE}
                  stroke-width={BAND_SEPARATOR_WIDTH}
                  stroke-linejoin="round"
                  onPointerEnter={(event) =>
                    showTooltip({
                      title: populationTitle(layout, band.population),
                      // Drugs, not trials: the band's angular width is
                      // `uniqueDrugCount`, so a trial count here reads as the
                      // arc's scale and contradicts it — Cognitive Impairment
                      // carries 2 trials across 1 drug on a 30° arc, Stroke 8
                      // across 5 on 150°.
                      rows: [{
                        label: "Drugs",
                        value: String(
                          layout.sectors.find((s) => s.key === band.population)
                            ?.drugCount ?? 0,
                        ),
                      }],
                      x: event.clientX,
                      y: event.clientY,
                    })}
                  onPointerMove={follow}
                  onPointerLeave={hideSoon}
                />
              ))}

              {layout.phaseLabels.map((label) => (
                <g
                  key={label.phase}
                  class="phase-label"
                  data-phase={label.phase}
                >
                  <LabelBox
                    id={`phase-${label.phase}`}
                    lines={[`PHASE ${label.phase}`]}
                    point={label.point}
                    anchor="middle"
                    fontSize={PHASE_FONT_SIZE}
                    style={PHASE_STYLE}
                    padding={LABEL_PADDING}
                    measured={boxes.get(`phase-${label.phase}`)}
                  />
                </g>
              ))}

              {layout.populationLabels.map((label) => {
                const placement = popLabelPlacement(label);
                return (
                  <g key={label.key} class="pop-label" data-pop={label.key}>
                    <LabelBox
                      id={`pop-${label.key}`}
                      lines={label.lines}
                      point={placement.point}
                      anchor={placement.anchor}
                      fontSize={POPULATION_FONT_SIZE}
                      style={POPULATION_STYLE}
                      subline={{
                        size: POPULATION_SUBLINE_SIZE,
                        style: POPULATION_SUBLINE,
                      }}
                      padding={LABEL_PADDING}
                      measured={boxes.get(`pop-${label.key}`)}
                    />
                  </g>
                );
              })}

              <g class="leaders">
                {layout.markers.filter(needsLeader).map((marker) => {
                  const anchor = labelPoint(marker);
                  return (
                    <line
                      key={marker.index}
                      class="leader"
                      data-drug={marker.trial.drug}
                      x1={marker.point.x}
                      y1={marker.point.y}
                      x2={anchor.x}
                      y2={anchor.y}
                    />
                  );
                })}
              </g>

              {layout.markers.map((marker) => {
                const anchor = labelPoint(marker);
                return (
                  <g
                    key={marker.index}
                    ref={(element) => {
                      markerRefs.current[marker.index] = element;
                    }}
                    class="drug"
                    data-drug={marker.trial.drug}
                    data-pop={marker.population}
                    data-phase={marker.phase}
                    tabindex={0}
                    role="button"
                    aria-controls={DRAWER_ID}
                    aria-expanded={active === marker.index ? "true" : "false"}
                    aria-label={`${marker.trial.drug}, Phase ${marker.phase}, ${marker.populationLabel}${
                      marker.flagReasons.length > 0
                        ? `, ${encoding.recordFlag.label}`
                        : ""
                    }`}
                    onClick={() => activate(marker.index)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      activate(marker.index);
                    }}
                    onPointerEnter={(event) =>
                      showTooltip(
                        drugTooltip(
                          layout,
                          marker,
                          event.clientX,
                          event.clientY,
                        ),
                      )}
                    onPointerMove={follow}
                    onPointerLeave={hideSoon}
                  >
                    <circle
                      class="marker"
                      cx={marker.point.x}
                      cy={marker.point.y}
                      r={MARKER_DRAW_RADIUS}
                      fill={marker.color}
                      stroke={PLATE}
                      stroke-width={MARKER_RING_WIDTH}
                    />
                    {marker.flagReasons.length > 0 && (
                      <circle
                        class="gap"
                        cx={marker.point.x}
                        cy={marker.point.y}
                        r={MARKER_GAP_RADIUS}
                        fill={PLATE}
                      />
                    )}
                    {marker.evidenceRing && (
                      <circle
                        class="evidence"
                        cx={marker.point.x}
                        cy={marker.point.y}
                        r={EVIDENCE_RING_RADIUS}
                        fill="none"
                        stroke={marker.evidenceRing}
                        stroke-width={EVIDENCE_RING_WIDTH}
                        stroke-dasharray={marker.evidenceDash ?? undefined}
                      />
                    )}
                    <LabelBox
                      id={`drug-${marker.index}`}
                      lines={[marker.trial.drug]}
                      point={anchor}
                      anchor={marker.anchor}
                      fontSize={DRUG_FONT_SIZE}
                      style={DRUG_STYLE}
                      padding={DRUG_PADDING}
                      measured={boxes.get(`drug-${marker.index}`)}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>

      <p class="figure-end" id="timeline-end" tabIndex={-1}>
        End of the trials radar
      </p>

      <TimelineTooltip
        state={tooltip}
        panelRef={tooltipRef}
        onPointerEnter={() => {
          cancelTooltipOpen();
          cancelTooltipClose();
          cancelTooltipFrame();
        }}
        onPointerLeave={hideSoon}
      />
    </div>
  );
}
