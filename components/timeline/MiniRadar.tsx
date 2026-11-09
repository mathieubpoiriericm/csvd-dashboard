import {
  BAND_SEPARATOR_WIDTH,
  CANVAS,
  encoding,
  EVIDENCE_RING_RADIUS,
  EVIDENCE_RING_WIDTH,
  MARKER_DRAW_RADIUS,
  MARKER_GAP_RADIUS,
  MARKER_RING_WIDTH,
  PHASE_FONT_SIZE,
  PLATE,
  type TimelineLayout,
} from "../../lib/timeline.ts";
import { markerGrowth, markerGrowthCap } from "../../lib/timeline_scale.ts";

interface MiniRadarProps {
  layout: TimelineLayout;
  activeIndex: number | null;
  /** The plate's rendered width over its drawn width, in (0, 1]. */
  scale: number;
}

/**
 * The radar as a picture, for a window too narrow to read it as a figure:
 * wedges, rim bands, phase labels and the markers, with no drug or population
 * names, no focus stops and no handlers. The list under it names every trial.
 * Markers are drawn larger than at rest in step with the shrunken plate (as
 * the full radar's are), up to the point where the closest pair would touch.
 */
export function MiniRadar({ layout, activeIndex, scale }: MiniRadarProps) {
  const k = markerGrowth(
    scale,
    markerGrowthCap(layout.markers, EVIDENCE_RING_RADIUS),
  );
  const populations = new Set(layout.markers.map((m) => m.population)).size;
  const n = layout.markers.length;
  return (
    <div class="timeline-mini">
      <svg
        class="timeline-mini-figure"
        viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
        style={{ "--radar-k": String(k) }}
        role="img"
        aria-label={`${n} trials across ${populations} populations; the list below names each one`}
      >
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
            d={cell.path}
            fill={cell.color}
            fill-opacity={cell.opacity}
            stroke={encoding.boundary.color}
            stroke-opacity={encoding.boundary.opacity}
            stroke-width={encoding.boundary.width}
            stroke-linejoin="round"
          />
        ))}
        {layout.rimBands.map((band) => (
          <path
            key={band.population}
            class="rim-band"
            d={band.path}
            fill={band.color}
            stroke={PLATE}
            stroke-width={BAND_SEPARATOR_WIDTH}
            stroke-linejoin="round"
          />
        ))}
        {layout.phaseLabels.map((label) => (
          <text
            key={label.phase}
            class="label-ink phase-label"
            x={label.point.x}
            y={label.point.y}
            font-size={PHASE_FONT_SIZE / scale}
            font-weight={600}
            letter-spacing="0.12em"
            fill-opacity={0.72}
            text-anchor="middle"
            dy="0.35em"
            paint-order="stroke"
            stroke={PLATE}
            stroke-width={3.5 / scale}
            stroke-linejoin="round"
          >
            {`PHASE ${label.phase}`}
          </text>
        ))}
        {layout.markers.map((marker) => {
          const active = marker.index === activeIndex ? " active" : "";
          return (
            <g key={marker.index} class="drug" data-phase={marker.phase}>
              <circle
                class={`marker${active}`}
                cx={marker.point.x}
                cy={marker.point.y}
                r={MARKER_DRAW_RADIUS * k}
                fill={marker.color}
                stroke={PLATE}
                stroke-width={MARKER_RING_WIDTH * k}
              />
              {marker.flagReasons.length > 0 && (
                <circle
                  class={`gap${active}`}
                  cx={marker.point.x}
                  cy={marker.point.y}
                  r={MARKER_GAP_RADIUS * k}
                  fill={PLATE}
                />
              )}
              {marker.evidenceRing && (
                <circle
                  class={`evidence${active}`}
                  cx={marker.point.x}
                  cy={marker.point.y}
                  r={EVIDENCE_RING_RADIUS * k}
                  fill="none"
                  stroke={marker.evidenceRing}
                  stroke-width={EVIDENCE_RING_WIDTH * k}
                  stroke-dasharray={marker.evidenceDash ?? undefined}
                />
              )}
            </g>
          );
        })}
      </svg>
      <ul class="timeline-mini-legend">
        {layout.sectors.filter((s) => s.drugCount > 0).map((sector) => (
          <li key={sector.key}>
            <span
              class="timeline-mini-swatch"
              style={{ background: sector.band }}
              aria-hidden="true"
            />
            {sector.label.join(" ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
