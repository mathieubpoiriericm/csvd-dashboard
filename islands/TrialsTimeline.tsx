import { useHydratedRef } from "../components/useHydratedRef.ts";
import { Fragment, type Ref } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "preact/hooks";

import { CheckboxFilter } from "../components/CheckboxFilter.tsx";
import { MiniRadar } from "../components/timeline/MiniRadar.tsx";
import { PhaseList } from "../components/timeline/PhaseList.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import {
  measureSvgTextBoxes,
  whenFontsReady,
} from "../components/svgMeasurements.ts";
import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { useEscapeKey } from "../components/useEscapeKey.ts";
import { useModal } from "../components/useModal.ts";
import { DEFAULT_TRIAL_STATUSES, STATUS_CHOICES } from "../lib/constants.ts";
import { fitZoom } from "../lib/drawer_fit.ts";
import { POPULATION_FIELD } from "../lib/disease/populations.ts";
import { RADAR_TITLE } from "../lib/disease/site.ts";
import { trials } from "../lib/data/trials.ts";
import { defaultTrialFilters, filterTrials } from "../lib/filters.ts";
import { resolveTrialStatus } from "../lib/trials.ts";
import {
  type Anchor,
  anchorOffsetX,
  BAND_SEPARATOR_WIDTH,
  type Box,
  CANVAS,
  CENTER,
  computeTimelineLayout,
  DRUG_FONT_SIZE,
  encoding,
  EVIDENCE_RING_RADIUS,
  EVIDENCE_RING_WIDTH,
  LABEL_GAP,
  type LabelShift,
  type Marker,
  MARKER_DRAW_RADIUS,
  MARKER_GAP_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  type MovableBox,
  PHASE_FONT_SIZE,
  placePopulationLabel,
  PLATE,
  type Point,
  POPULATION_FONT_SIZE,
  POPULATION_SUBLINE_SIZE,
  type PopulationLabel,
  type PopulationShift,
  sameBoxes,
  separateLabels,
} from "../lib/timeline.ts";
import {
  countFaults,
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
import type { Trial } from "../lib/types.ts";
import { followSkipLink } from "../lib/skip_link.ts";

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
/** The window the phone list opens a record in. */
const DIALOG_ID = "timeline-dialog";
const LINE_HEIGHT_EM = 1.2;
const HALO_WIDTH = 3.5;
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

/**
 * The viewport width at and below which assets/app.css stacks the drawer
 * above the plate whatever the island decides.
 */
const STACK_BREAKPOINT = 1100;
/** How far a measured plate may sit from the scale it was solved at. */
const SCALE_TOLERANCE = 0.001;

const DRUG_PADDING = { x: 3, y: 1 };
const LABEL_PADDING = { x: 4, y: 2 };

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
  { key: "targetPopulationDetails", label: POPULATION_FIELD.detailsLabel },
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

/**
 * How far a marker reaches: its evidence ring when it has one. `k` is the
 * marker growth on a shrunken plate, which every marker dimension takes.
 */
function hitRadius(marker: Marker, k: number): number {
  return k *
    (marker.evidenceRing
      ? EVIDENCE_RING_RADIUS + EVIDENCE_RING_WIDTH / 2
      : MARKER_DRAW_RADIUS + MARKER_RING_WIDTH / 2);
}

/** Same test the retired timeline.js used: the marker's bounding square. */
function touchesMarker(box: Box, marker: Point, radius: number): boolean {
  return marker.x + radius > box.x &&
    marker.x - radius < box.x + box.width &&
    marker.y + radius > box.y &&
    marker.y - radius < box.y + box.height;
}

/** The square a marker occupies, as an obstacle for the separation pass. */
function markerBox(marker: Marker, k: number): Box {
  const r = hitRadius(marker, k) + 1;
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
  /** The halo's stroke, in user units; unused when the style has no halo. */
  haloWidth: number;
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
  {
    id,
    lines,
    point,
    anchor,
    fontSize,
    haloWidth,
    style,
    subline,
    padding,
    measured,
  }: LabelBoxProps,
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
      "stroke-width": haloWidth,
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
            <Fragment key={i}>
              {
                /* The word space a wrap replaced, for the accessible text:
                  without it a two-word population label was read as one word.
                  Zero-size, so it adds no advance to the line it ends and
                  an end-anchored first line does not shift. */
              }
              {i > 0 && <tspan font-size="0">{WORD_SPACE}</tspan>}
              <tspan
                x={point.x}
                dy={`${i === 0 ? firstDy : LINE_HEIGHT_EM}em`}
                font-size={sub?.size}
                font-weight={sub?.style.weight}
                letter-spacing={sub?.style.tracking}
                fill-opacity={sub?.style.opacity}
              >
                {line}
              </tspan>
            </Fragment>
          );
        })}
      </text>
    </>
  );
}

/**
 * A space as a JSX child. Written as a literal it is whitespace-only text,
 * which the JSX transform and `deno fmt` both drop.
 */
const WORD_SPACE = " ";

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
      label:
        `${marker.populationLabel} · Phase ${marker.trial.clinicalTrialPhase}`,
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

/**
 * Zooms the record down until it fits the drawer's `max-height`, which is the
 * room under the navbar, so the drawer never needs a scrollbar. Where that
 * height is `none` -- stacked above the plate, or in print -- the record has
 * all the room it needs. Past `DRAWER_FIT_FLOOR` the drawer drops its cap
 * (`data-fit="page"`) and grows, and the page scrolls instead.
 *
 * The zoom is on the body rather than the drawer, so the drawer keeps its
 * width and the plate beside it does not move. A zoomed body also lays its
 * lines out wider in its own units, which is what lets a small step down
 * gain a whole line.
 */
function fitDrawer(drawer: HTMLElement, body: HTMLElement) {
  delete drawer.dataset.fit;
  body.style.zoom = "";
  const style = getComputedStyle(drawer);
  const cap = parseFloat(style.maxHeight);
  if (!Number.isFinite(cap)) return;
  // border-box: the cap includes the drawer's own padding and border.
  const room = cap - parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom) - parseFloat(style.borderTopWidth) -
    parseFloat(style.borderBottomWidth);
  const { zoom, fits } = fitZoom((candidate) => {
    body.style.zoom = String(candidate);
    return body.getBoundingClientRect().height;
  }, room);
  body.style.zoom = zoom === 1 ? "" : String(zoom);
  if (!fits) drawer.dataset.fit = "page";
}

/**
 * One trial's whole record: the header with its close button, the flag
 * block and the twelve fields. It has two homes and is the same in both --
 * the drawer beside the plate, and the window the phone list opens.
 */
function TrialRecord(
  { layout, marker, closeRef, onClose }: {
    layout: Layout;
    marker: Marker;
    closeRef: Ref<HTMLButtonElement>;
    onClose: () => void;
  },
) {
  return (
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
            {marker.populationLabel} · Phase {marker.trial.clinicalTrialPhase}
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
  );
}

function TrialDrawer({ layout, marker, closeRef, onClose }: TrialDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // A layout effect, so the record is never painted at the wrong size first.
  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    const body = bodyRef.current;
    if (!marker || !drawer || !body) return;
    const fit = () => fitDrawer(drawer, body);
    fit();
    globalThis.addEventListener("resize", fit);
    return () => globalThis.removeEventListener("resize", fit);
  }, [marker]);

  return (
    <aside
      ref={drawerRef}
      id={DRAWER_ID}
      class="timeline-drawer"
      role="region"
      aria-label="Trial details"
      hidden={!marker}
      inert={!marker}
    >
      {marker && (
        <div ref={bodyRef} class="timeline-drawer-body">
          <TrialRecord
            layout={layout}
            marker={marker}
            closeRef={closeRef}
            onClose={onClose}
          />
        </div>
      )}
    </aside>
  );
}

/**
 * The record as a window over the page, which is how the phone list shows
 * it: stacked in the flow as the drawer is on a tablet, it opened above the
 * small radar and pushed the list that was tapped off the screen. A native
 * modal `<dialog>` through `useModal`, so the browser supplies the top layer,
 * the focus trap, the inert page and the backdrop. It scrolls a record
 * taller than the phone, so nothing is zoomed to fit as in the drawer.
 *
 * Always in the page, closed without a marker: the island hands the open
 * record to this or to the drawer by the layout's mode, so a record open
 * across the switch moves from one to the other.
 */
function TrialDialog({ layout, marker, closeRef, onClose }: TrialDrawerProps) {
  const ref = useModal(marker !== null, onClose);
  /** Whether the press now in progress began, and then ended, on the
   * backdrop. */
  const pressedBackdrop = useRef(false);
  return (
    <dialog
      ref={ref}
      id={DIALOG_ID}
      class="timeline-dialog"
      aria-label="Trial details"
      onCancel={(event) => {
        // Escape (and a phone's back gesture) is reported, not obeyed: the
        // state closes the dialog, so the two cannot drift apart.
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        pressedBackdrop.current &&= event.target === event.currentTarget;
      }}
      onClick={() => {
        // The dialog has no padding of its own, so a press whose target is
        // the dialog itself landed on the backdrop. Both ends of it must,
        // and the click's own target cannot say so: a drag from the record
        // to the backdrop (selecting a value to copy) or back is clicked on
        // the dialog too, as the two ends' common ancestor.
        const onBackdrop = pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (onBackdrop) onClose();
      }}
    >
      {marker && (
        <div class="timeline-dialog-body">
          <TrialRecord
            layout={layout}
            marker={marker}
            closeRef={closeRef}
            onClose={onClose}
          />
        </div>
      )}
    </dialog>
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
interface TrialsTimelineProps {
  /** The trials to draw; the committed table by default. Tests hand in synthetic rows. */
  rows?: readonly Trial[];
}

export default function TrialsTimeline(
  { rows = trials }: TrialsTimelineProps = {},
) {
  const { values, controls, summary } = useCheckboxFilters(RADAR_FILTERS);
  const filtered = useMemo(
    () =>
      filterTrials(rows, {
        ...defaultTrialFilters(),
        statuses: values.statuses,
      }),
    [rows, values],
  );
  // The selection's own figure, at rest. Its identity is what says the
  // selection changed; `layout` below is the same figure with its labels
  // set out from markers grown for the current scale.
  const baseLayout = useMemo(() => computeTimelineLayout(filtered), [
    filtered,
  ]);

  /**
   * The plate's rendered width over its drawn width, in (0, 1], to 3 dp. The
   * plate's CSS fits it to the window; every font size and halo below is
   * divided by this, so the text keeps its design size on screen while the
   * picture shrinks.
   */
  const [scale, setScale] = useState<number>(1);
  /** The same ratio for the phone layout's small radar. */
  const [miniScale, setMiniScale] = useState<number>(1);
  /**
   * Radar or phone layout, the plate's readable-width floor, and whether the
   * drawer stacks above the plate (lib/timeline_scale.ts decides all three).
   * The server renders the radar; the first layout effect corrects it from
   * the room the row actually has, before the first paint.
   */
  const [radar, setRadar] = useState<RadarState>(() =>
    initialRadarState(RADAR_MIN_ROOM)
  );
  // Markers grow to keep their size on screen too, but stop short of the
  // closest pair touching.
  const growthCap = useMemo(
    () => markerGrowthCap(baseLayout.markers, EVIDENCE_RING_RADIUS),
    [baseLayout],
  );
  const k = markerGrowth(scale, growthCap);
  const layout = useMemo(
    () =>
      k === 1 ? baseLayout : computeTimelineLayout(filtered, encoding, {
        labelOffset: (MARKER_RADIUS + LABEL_GAP) * k,
      }),
    [baseLayout, filtered, k],
  );
  const drugFontSize = DRUG_FONT_SIZE / scale;
  const haloWidth = HALO_WIDTH / scale;

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
  const mainRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const markerRefs = useRef<Array<SVGGElement | null>>([]);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** The drawer's width beside the plate, kept for while it is stacked. */
  const besideDrawer = useRef(0);
  /** The trial whose marker or row has keyboard focus, if one does. */
  const focusedTrigger = useRef<number | null>(null);
  const nudgePasses = useRef(0);
  const measureRef = useRef<() => void>(() => {});
  /** A fresh fit after a font load: nudges re-run against the new metrics. */
  const refitRef = useRef<() => void>(() => {});
  /** Cancels the fit `reportSettled` re-armed for a font load, if one is. */
  const fontRefit = useRef<(() => void) | null>(null);
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
  // margin (a population's sector straddling straight-down, for one). Rather than
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

  /**
   * What the row offers the plate right now, for `nextRadarState`. Null
   * before the row has mounted.
   */
  const observe = (): Omit<RadarObservation, "clean"> | null => {
    const main = mainRef.current;
    const scroller = scrollRef.current;
    const drawer = main?.querySelector<HTMLElement>(`#${DRAWER_ID}`);
    const frame = scroller?.parentElement;
    if (!main || !scroller || !drawer || !frame) return null;
    const scrollStyle = getComputedStyle(scroller);
    const padding = parseFloat(scrollStyle.paddingLeft) +
      parseFloat(scrollStyle.paddingRight);
    // The frame's border (and a scrollbar, if one ever shows) between the
    // frame's edge and the scroller's content.
    const chrome = frame.offsetWidth - scroller.clientWidth;
    const room = main.clientWidth - chrome - padding;
    const available = scroller.clientWidth - padding;
    const svg = svgRef.current;
    const plateWidth = svg?.getBoundingClientRect().width ?? 0;
    // Beside the plate the drawer is its own `flex-basis`; stacked, it is
    // full width and says nothing about the room it would take beside, so
    // the last beside width stands in.
    const basis = parseFloat(getComputedStyle(drawer).flexBasis);
    if (Number.isFinite(basis)) besideDrawer.current = basis;
    return {
      room,
      plateWidth,
      available,
      // Against the width the plate actually has, not `room`: with the
      // drawer beside, the plate is narrower than `room` because of the
      // drawer, and that is not the window's height limiting it.
      heightLimited: svg !== null && plateWidth < available - 1 &&
        plateWidth < CANVAS.width - 1,
      drawerBeside: active !== null && !radar.stacked &&
        globalThis.innerWidth > STACK_BREAKPOINT,
      drawerSpace: besideDrawer.current +
        (parseFloat(getComputedStyle(main).columnGap) || 0),
    };
  };

  /** One step of the mode decision, from the row as it is now. */
  const observeRadar = (clean: boolean | null) => {
    const observation = observe();
    if (!observation) return;
    setRadar((state) => {
      const next = nextRadarState(state, { ...observation, clean });
      return next.mode === state.mode && next.floor === state.floor &&
          next.stacked === state.stacked && next.raise === state.raise
        ? state
        : next;
    });
  };
  const observeRadarRef = useRef(observeRadar);
  observeRadarRef.current = observeRadar;

  /**
   * A solve has settled: no pass is pending, and `measured` is the layout on
   * screen. Count what it still gets wrong and let the reducer decide. A
   * solve for a scale the plate has since left, or in fallback type before
   * the web font has loaded, says nothing about this size and is dropped;
   * the resize or the font re-solves and reports again. The mount's font
   * pass runs once; a font load a later render starts (a record's drawer
   * can be the first text in a face) would otherwise drop the report with
   * nothing left to re-solve, so a drop for that reason re-arms a pass of
   * its own for when the fonts are ready.
   */
  const reportSettled = (measured: ReadonlyMap<string, Box>) => {
    const svg = svgRef.current;
    if (!svg) return;
    if (document.fonts?.status === "loading") {
      fontRefit.current ??= whenFontsReady(() => {
        fontRefit.current = null;
        refitRef.current();
      });
      return;
    }
    const actual = plateScale(svg.getBoundingClientRect().width);
    if (Math.abs(actual - scale) > SCALE_TOLERANCE) return;
    const labels: Box[] = [];
    for (const [id, box] of measured) {
      // Drug, population and phase labels alike: the phase labels are
      // obstacles to the drug labels, and the e2e sweeps all three.
      labels.push(
        padded(box, id.startsWith("drug-") ? DRUG_PADDING : LABEL_PADDING),
      );
    }
    const faults = countFaults({
      labels,
      markers: layout.markers.map((marker) => markerBox(marker, k)),
      plate: { x: 0, y: 0, ...CANVAS },
    });
    observeRadar(isClean(faults));
  };

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
    if (sameBoxes(next, boxes)) {
      reportSettled(next);
      return;
    }
    setBoxes(next);

    // A population label sits at a fixed radius from CENTER, at whatever
    // angle its sector's mid-point lands on (lib/timeline.ts). CANVAS was
    // sized to the angles the committed 102 rows produce, with as little as
    // 19 units of margin at the tightest edge, so a status selection that
    // reshapes the sectors can swing a label's angle past that margin --
    // one population's sector straddling straight-down under the default
    // filter is the one that found this. A label whose measured extent falls off the
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
    // Whether this pass moved a label, so that another pass will follow. A
    // pass that moved none is the settled layout, and is what the floor test
    // reads.
    let moved = !popUnchanged;

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
            hitRadius(marker, k),
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
    const fixed: Box[] = layout.markers.map((marker) => markerBox(marker, k));
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
    ) {
      if (!moved) reportSettled(next);
      return;
    }
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
    if (!unchanged) {
      setShifts(separated);
      moved = true;
    }
    if (!moved) reportSettled(next);
  };
  measureRef.current = measure;

  // Fit once on mount and after every nudge or shift; all three change text
  // positions, which changes the boxes.
  useLayoutEffect(() => measureRef.current(), [nudges, shifts, popShifts]);

  // A new selection is a new figure: the drawer's index and every measured
  // box, nudge and shift belong to the old marker set. Reset them all and
  // let the mount pass run again over the new labels.
  const mountedLayout = useRef(baseLayout);
  /** The floor and stacking last measured for; see the effect that reads it. */
  const decided = useRef({ floor: radar.floor, stacked: radar.stacked });
  useLayoutEffect(() => {
    if (mountedLayout.current === baseLayout) return;
    mountedLayout.current = baseLayout;
    restoreFocusTo.current = null;
    nudgePasses.current = 0;
    solvedGeometry.current = undefined;
    dispatchInteraction({ type: "close-drawer" });
    // `hide`, not the bare action: a tooltip still waiting on its open
    // timer would otherwise land on the new figure with the old marker.
    hide();
    setBoxes(new Map());
    setNudges(new Map());
    setShifts(new Map());
    setPopShifts(new Map());
    // The floor was learnt from the old selection's labels.
    const observation = observe();
    if (!observation) return;
    const initial = initialRadarState(observation.room);
    setRadar(initial);
    // The mount pass this reset starts measures the new labels and reports
    // once they are separated. Left out of step, the floor-and-stacking
    // effect below would measure again in the same commit, before that
    // pass's shifts apply, and report the unseparated labels as a fault.
    decided.current = { floor: initial.floor, stacked: initial.stacked };
  }, [baseLayout]);

  // A new scale is the same figure in new type: the markers and the drawer
  // stay, but every box was measured at the old font size and every nudge
  // and shift solved against it. Clear the solve and let the measure pass
  // run again after this render, as a new selection does.
  const solvedScale = useRef(scale);
  useLayoutEffect(() => {
    if (solvedScale.current === scale) return;
    solvedScale.current = scale;
    nudgePasses.current = 0;
    solvedGeometry.current = undefined;
    setBoxes(new Map());
    setNudges(new Map());
    setShifts(new Map());
    setPopShifts(new Map());
  }, [scale]);

  // A new layout mode mounts a new plate or takes the old one away. The
  // drawer and its marker survive, but nothing measured belongs to the new
  // plate: clear the solve, as a new scale does.
  const shownMode = useRef(radar.mode);
  useLayoutEffect(() => {
    if (shownMode.current === radar.mode) return;
    shownMode.current = radar.mode;
    hide();
    nudgePasses.current = 0;
    solvedGeometry.current = undefined;
    setBoxes(new Map());
    setNudges(new Map());
    setShifts(new Map());
    setPopShifts(new Map());
    // The marker or row that had focus went with the old branch, and focus
    // fell to the body: hand it to the same trial in the new one, so a
    // keyboard user who zooms across the switch keeps their place.
    const index = focusedTrigger.current;
    const lost = document.activeElement === null ||
      document.activeElement === document.body;
    if (index !== null && lost) {
      (radar.mode === "phone" ? rowRefs.current : markerRefs.current)[index]
        ?.focus();
    }
    // An open record changed homes with the mode -- the drawer beside the
    // plate, the window on the phone list -- and its close button is a new
    // element: focus follows the record there.
    if (active !== null) closeRef.current?.focus();
  }, [radar.mode]);

  // Which trial's marker or row has focus, kept through the moment a mode
  // switch removes it. A blur from a node that is still in the page clears
  // it; one from a node the switch removed does not, so the effect above
  // can still read it. Checked a microtask later because a removal blurs
  // the node before it leaves the page.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const indexOf = (target: EventTarget | null) => {
      const marker = markerRefs.current.findIndex((el) => el === target);
      return marker >= 0
        ? marker
        : rowRefs.current.findIndex((el) => el === target);
    };
    const onFocusIn = (event: FocusEvent) => {
      const index = indexOf(event.target);
      focusedTrigger.current = index >= 0 ? index : null;
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target as Node;
      queueMicrotask(() => {
        if (target.isConnected && document.activeElement !== target) {
          focusedTrigger.current = null;
        }
      });
    };
    scroller.addEventListener("focusin", onFocusIn);
    scroller.addEventListener("focusout", onFocusOut);
    return () => {
      scroller.removeEventListener("focusin", onFocusIn);
      scroller.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Read the plate's rendered scale as it mounts, and again once a resize
  // has settled: the observer ticks every frame of a window drag, and each
  // settled scale costs a full label solve. A tick arms one animation frame;
  // a frame that finds another tick has landed since re-arms instead, so the
  // scale is read only after a whole frame with no resize. The phone
  // layout's small radar is read the same way, into its own scale.
  useLayoutEffect(() => {
    const phone = radar.mode === "phone";
    const plate = phone
      ? scrollRef.current?.querySelector<SVGSVGElement>(".timeline-mini-figure")
      : svgRef.current;
    if (!plate) return;
    const apply = phone ? setMiniScale : setScale;
    const read = () =>
      apply(
        Math.round(plateScale(plate.getBoundingClientRect().width) * 1000) /
          1000,
      );
    read();
    let frame: number | null = null;
    let ticked = false;
    const settle = () => {
      if (ticked) {
        ticked = false;
        frame = globalThis.requestAnimationFrame(settle);
        return;
      }
      frame = null;
      read();
    };
    const observer = new ResizeObserver(() => {
      ticked = true;
      frame ??= globalThis.requestAnimationFrame(settle);
    });
    observer.observe(plate);
    return () => {
      observer.disconnect();
      if (frame !== null) globalThis.cancelAnimationFrame(frame);
    };
  }, [radar.mode]);

  // Every change in the row's size is a step of the mode decision with no
  // verdict on the labels yet; a solve that settles gives that. This is what
  // returns a phone layout to the radar once the room is back, and what puts
  // a phone in its layout before the first paint.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    observeRadarRef.current(null);
    const observer = new ResizeObserver(() => observeRadarRef.current(null));
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  // The web font arrives after first paint; fit again when it does. A
  // pass `reportSettled` re-armed for a later font load is cancelled with
  // the island.
  refitRef.current = () => {
    nudgePasses.current = 0;
    measureRef.current();
  };
  useEffect(() => {
    const cancel = whenFontsReady(() => refitRef.current());
    return () => {
      cancel();
      fontRefit.current?.();
    };
  }, []);

  // A new floor or stacking resizes the plate, but by as little as a pixel,
  // which can leave the scale -- rounded to 3 dp -- where it was, so nothing
  // re-solves and nothing reports: a faulty layout would stand. Measure
  // again, so the solve on screen is reported for the new size (a scale
  // that did change is re-solved by its own effect, and this report is
  // dropped as stale). A new selection's reset brings the ref into step
  // itself: its own pass measures and reports.
  useLayoutEffect(() => {
    const last = decided.current;
    if (last.floor === radar.floor && last.stacked === radar.stacked) return;
    decided.current = { floor: radar.floor, stacked: radar.stacked };
    measureRef.current();
  }, [radar.floor, radar.stacked]);

  // Runs after the DOM has committed, so the close button exists before focus
  // enters it and the declaratively hidden drawer is committed before focus
  // returns to the marker.
  useEffect(() => {
    if (active !== null) {
      // Not `preventScroll`: at 1100px and below the drawer stacks above
      // the plate, scroll anchoring holds the plate still as it opens, and
      // a focus that may not scroll left the record and its close button
      // wholly above the viewport -- a tap that visibly did nothing.
      closeRef.current?.focus();
      return;
    }
    const restore = restoreFocusTo.current;
    restoreFocusTo.current = null;
    if (restore !== null) {
      // The plate rescales as the drawer closes, which can leave the marker
      // below the fold; let focus bring it back into view. Resolved now, not
      // when the drawer opened: a resize may have swapped the radar for the
      // list (or back) in between, and `active` indexes both.
      (radar.mode === "phone" ? rowRefs.current : markerRefs.current)[restore]
        ?.focus();
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
    if (active === index) closeRef.current?.focus();
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
    const height = (measured?.height ?? drugFontSize * LINE_HEIGHT_EM) +
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
    <div
      ref={hydratedRef}
      class="timeline-layout"
      data-mode={radar.mode}
      data-floor={String(Math.round(radar.floor))}
      style={radar.floor > 0
        ? { "--timeline-floor": `${radar.floor}px` }
        : undefined}
    >
      {
        /* Outside .timeline-main rather than immediately before its
          .blueprint-frame: that div is a flex ROW at >=1100px (drawer, then
          frame), and an inline-block skip link inserted between those two
          flex children would become a third row item on focus. Sitting here
          keeps it order-independent of that row/column switch. */
      }
      <a class="skip-figure" href="#timeline-end" onClick={followSkipLink}>
        Skip the figure
      </a>
      <div class="timeline-controls">
        {controls.map((props) => (
          <CheckboxFilter
            key={props.label}
            {...props}
          />
        ))}
        <p class="timeline-controls-count" role="status">
          Showing {filtered.length} of {rows.length} trials
          {summary.length > 0 ? ` · ${summary.join("; ")}` : ""}
        </p>
      </div>

      <TimelineLegend layout={layout} />

      <div
        ref={mainRef}
        class="timeline-main"
        data-stack={radar.stacked ? "true" : undefined}
      >
        {
          /* One record, two homes: the drawer beside (or stacked over) the
            plate, and on the phone list a window over the page. Only one
            holds the record, so there is one close button to focus. */
        }
        <TrialDrawer
          layout={layout}
          marker={radar.mode === "phone" ? null : activeMarker}
          closeRef={closeRef}
          onClose={close}
        />
        <TrialDialog
          layout={layout}
          marker={radar.mode === "phone" ? activeMarker : null}
          closeRef={closeRef}
          onClose={close}
        />

        {
          /* The scroller is `overflow: auto`, which clips the frame's
            registration marks at their negative inset, so the frame is a
            wrapper rather than the scroller itself. */
        }
        <div class="blueprint-frame">
          <div ref={scrollRef} class="timeline-scroll">
            {radar.mode === "phone"
              ? (
                <>
                  <MiniRadar
                    layout={layout}
                    activeIndex={active}
                    scale={miniScale}
                  />
                  <PhaseList
                    layout={layout}
                    activeIndex={active}
                    onActivate={activate}
                    rowRef={(index, element) => {
                      rowRefs.current[index] = element;
                    }}
                  />
                </>
              )
              : (
                <svg
                  ref={svgRef}
                  class="timeline-figure"
                  viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
                  style={{ "--radar-k": String(k) }}
                  aria-labelledby="timeline-title timeline-desc"
                >
                  <title id="timeline-title">
                    {RADAR_TITLE}
                  </title>
                  <desc id="timeline-desc">
                    Rings are trial phases, Phase {encoding.rings[0].phase}{" "}
                    innermost; sectors are target populations; each marker is
                    one trial, coloured by mechanism of action. Activate a
                    marker for the trial's details.
                  </desc>

                  {
                    /* A white sheet in both themes: the halos, the marker rings and
                  the band separators are all cut from it. rx is the
                  phenogram's 8px plate corner on screen at every scale, so
                  the two plates' corners read as the same radius. */
                  }
                  <rect
                    class="plate"
                    x={0}
                    y={0}
                    width={CANVAS.width}
                    height={CANVAS.height}
                    rx={8 / scale}
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
                          // arc's scale and contradicts it — one population
                          // carries 2 trials across 1 drug on a 30° arc, another
                          // 8 across 5 on 150°.
                          rows: [{
                            label: "Drugs",
                            value: String(
                              layout.sectors.find((s) =>
                                s.key === band.population
                              )
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
                        fontSize={PHASE_FONT_SIZE / scale}
                        haloWidth={haloWidth}
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
                          fontSize={POPULATION_FONT_SIZE / scale}
                          haloWidth={haloWidth}
                          style={POPULATION_STYLE}
                          subline={{
                            size: POPULATION_SUBLINE_SIZE / scale,
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
                        aria-expanded={active === marker.index
                          ? "true"
                          : "false"}
                        aria-label={`${marker.trial.drug}, Phase ${marker.trial.clinicalTrialPhase}, ${marker.populationLabel}${
                          marker.flagReasons.length > 0
                            ? `, ${encoding.recordFlag.label}`
                            : ""
                        }`}
                        onClick={() => activate(marker.index)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") {
                            return;
                          }
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
                          r={MARKER_DRAW_RADIUS * k}
                          fill={marker.color}
                          stroke={PLATE}
                          stroke-width={MARKER_RING_WIDTH * k}
                        />
                        {marker.flagReasons.length > 0 && (
                          <circle
                            class="gap"
                            cx={marker.point.x}
                            cy={marker.point.y}
                            r={MARKER_GAP_RADIUS * k}
                            fill={PLATE}
                          />
                        )}
                        {marker.evidenceRing && (
                          <circle
                            class="evidence"
                            cx={marker.point.x}
                            cy={marker.point.y}
                            r={EVIDENCE_RING_RADIUS * k}
                            fill="none"
                            stroke={marker.evidenceRing}
                            stroke-width={EVIDENCE_RING_WIDTH * k}
                            stroke-dasharray={marker.evidenceDash ?? undefined}
                          />
                        )}
                        <LabelBox
                          id={`drug-${marker.index}`}
                          lines={[marker.trial.drug]}
                          point={anchor}
                          anchor={marker.anchor}
                          fontSize={drugFontSize}
                          haloWidth={haloWidth}
                          style={DRUG_STYLE}
                          padding={DRUG_PADDING}
                          measured={boxes.get(`drug-${marker.index}`)}
                        />
                      </g>
                    );
                  })}
                </svg>
              )}
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
