import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { CheckboxFilter } from "../components/CheckboxFilter.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { MapPopup } from "../components/MapPopup.tsx";
import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { groupBy, uniqueCount } from "../lib/collections.ts";
import {
  DEFAULT_TRIAL_STATUSES,
  formatLongDate,
  STATUS_CHOICES,
} from "../lib/constants.ts";
import {
  trialLocations,
  trialLocationsGeneratedAt,
} from "../lib/data/locations.ts";
import { trials } from "../lib/data/trials.ts";
import type { TrialLocation } from "../lib/types.ts";
import { formatCount } from "../lib/format.ts";
import { filterLocationsByStatus } from "../lib/filters.ts";
import { formatTrialPlace, resolveTrialStatus } from "../lib/trials.ts";
import { observeThemeChanges } from "../lib/theme.ts";

const nctKey = (value: string) => value.trim().toUpperCase();
const MAP_FILTERS = {
  statuses: {
    label: "Study status",
    choices: STATUS_CHOICES,
    initial: DEFAULT_TRIAL_STATUSES,
  },
} as const;
const MAP_DEFAULT_CENTER: [number, number] = [30, 0];
const MAP_DEFAULT_ZOOM = 2;
const MAP_CLUSTER_RADIUS_PX = 50;

const TRIALS_BY_NCT = groupBy(trials, (trial) => nctKey(trial.registryId));
const COUNTRY_COUNT = uniqueCount(
  trialLocations.map((location) => location.country).filter(Boolean),
);
const REGISTERED_TRIAL_COUNT = uniqueCount(
  trialLocations.map((location) => nctKey(location.nctId)),
);
const GENERATED_LABEL = formatLongDate(trialLocationsGeneratedAt);

/**
 * One figure of the map's provenance strip. The noun is pluralised from the
 * count rather than written twice: every number here is derived from the
 * committed data, so a regeneration that leaves one site standing must not
 * leave the strip reading "1 sites".
 */
function MapStat(
  { icon, value, singular, plural }: {
    icon: IconName;
    value: number;
    singular: string;
    plural: string;
  },
) {
  return (
    <span class="map-stat">
      <Icon name={icon} />
      <b class="map-stat-value">{formatCount(value)}</b>
      {value === 1 ? singular : plural}
    </span>
  );
}

/**
 * One-line description of a facility, for the text alternative below the map.
 *
 * Deliberately plain text. The list is `.visually-hidden`, which clips rather
 * than hides, so anchors inside it stay in the tab order — linking every
 * entry would hand sighted keyboard users 173 invisible tab stops on the
 * default selection, and 378 with Show All ticked. The ClinicalTrials.gov
 * links live in the marker popups and on the trials table.
 */
function describeLocation(location: TrialLocation): string {
  return [
    [location.facilityName, formatTrialPlace(location)].filter(Boolean).join(
      ", ",
    ),
    location.trialTitle,
    resolveTrialStatus(location.status).label,
    location.nctId,
  ].filter(Boolean).join(" — ");
}

type CircleMarkerElement = Pick<
  Element,
  "addEventListener" | "removeEventListener" | "setAttribute"
>;

export interface CircleMarkerAccessibilityBinding {
  setExpanded(expanded: boolean): void;
  dispose(): void;
}

/** Decorate the SVG path Leaflet creates for one circle-marker add cycle. */
export function bindCircleMarkerAccessibility(
  element: CircleMarkerElement,
  label: string,
  openPopup: () => void,
): CircleMarkerAccessibilityBinding {
  element.setAttribute("tabindex", "0");
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", label);
  element.setAttribute("aria-expanded", "false");

  const onKeyDown: EventListener = (event) => {
    const { key } = event as KeyboardEvent;
    if (key !== "Enter" && key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    openPopup();
  };
  element.addEventListener("keydown", onKeyDown);

  return {
    setExpanded(expanded) {
      element.setAttribute("aria-expanded", expanded ? "true" : "false");
    },
    dispose() {
      element.removeEventListener("keydown", onKeyDown);
    },
  };
}

/**
 * Screen-reader text alternative for the map.
 *
 * Leaflet gives `tabIndex` only to `Marker` icons, never to
 * `Path`/`CircleMarker`. The effect below augments each SVG path whenever its
 * layer is added, but this list remains the complete non-spatial alternative
 * for virtual navigation and for environments where the interactive map fails.
 *
 * `.visually-hidden` clips rather than hides, so this text stays in
 * `textContent`. Any `toHaveText` on `.map-container` or a wider ancestor
 * needs `{ useInnerText: true }`, the same trap `genes-table.spec.ts` already
 * works around for the tooltip panels.
 */
function LocationList(
  { visible = false, locations }: {
    visible?: boolean;
    locations: readonly TrialLocation[];
  },
) {
  return (
    <div class={visible ? "map-location-list" : "visually-hidden"}>
      <h2>Trial facility locations</h2>
      <ul>
        {locations.map((location, i) => (
          <li key={`${location.nctId}-${i}`}>{describeLocation(location)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Leaflet map of trial facility locations.
 *
 * Leaflet is used directly rather than through an R wrapper, which removes the
 * workarounds the Shiny version needed: `leafletProxy` with a hand-rolled
 * draw-once latch, `outputOptions(suspendWhenHidden = FALSE)` so proxy updates
 * were not dropped while the tab was hidden, and a 100/300/600/1000 ms
 * `invalidateSize()` retry ladder in custom.js. Here the map is created once,
 * in an effect, on a container that is already laid out.
 */
export default function TrialsMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { values, controls, summary } = useCheckboxFilters(MAP_FILTERS);
  const visibleLocations = useMemo(
    () => filterLocationsByStatus(trialLocations, values.statuses),
    [values],
  );
  /** Set once Leaflet is up: rebuilds the cluster layer for a location set. */
  const populateRef = useRef<
    ((locations: readonly TrialLocation[]) => void) | null
  >(null);
  // Read by the mount effect's first `populate` call, which runs after the
  // two dynamic imports resolve. A plain closure over `visibleLocations`
  // there would freeze on whatever the selection was when the effect was
  // scheduled (mount, given the `[]` deps) -- a status box ticked while
  // Leaflet is still loading would then build markers from the stale
  // selection while the controls and hidden list already show the new one,
  // with nothing to re-sync it until the next toggle. Assigning this ref on
  // every render keeps the mount effect's eventual first call current.
  const visibleRef = useRef(visibleLocations);
  visibleRef.current = visibleLocations;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: import("leaflet").Map | undefined;
    let cancelled = false;
    let stopObservingTheme: (() => void) | undefined;
    const markerCleanups: Array<() => void> = [];

    const dispose = () => {
      stopObservingTheme?.();
      stopObservingTheme = undefined;
      for (const cleanup of markerCleanups.splice(0)) cleanup();
      map?.remove();
      map = undefined;
      populateRef.current = null;
    };

    // Leaflet touches `window` at import time, so it is loaded lazily rather
    // than at module scope, which would break server-side rendering.
    (async () => {
      try {
        const leaflet = await import("leaflet");
        // Sequential by necessity: leaflet.markercluster is a UMD bundle that
        // reads the global `L` as its module body evaluates, yet imports nothing
        // from Leaflet, so the module graph does not order the two. It works
        // only because Leaflet's UMD wrapper assigns `window.L` on evaluation;
        // a `Promise.all` here, or a swapped order, breaks the map at runtime.
        await import("leaflet.markercluster");
        if (cancelled) return;

        const L = leaflet.default ?? leaflet;

        map = L.map(container, {
          center: MAP_DEFAULT_CENTER,
          zoom: MAP_DEFAULT_ZOOM,
          scrollWheelZoom: false,
          // The basemap wraps but the markers, being vector layers, are drawn
          // once. Without this, panning past the antimeridian lands in an empty
          // copy of the world; worldCopyJump snaps back to the copy the markers
          // are on.
          worldCopyJump: true,
        });

        // No `{s}` subdomain: the OSMF tile policy discourages the a/b/c aliases
        // now that the server speaks HTTP/2 and HTTP/3, where they no longer buy
        // request concurrency and only fragment the cache.
        //
        // `detectRetina` and `maxZoom` interact. On a retina display Leaflet
        // halves tileSize, bumps zoomOffset and *decrements* maxZoom, so this
        // pair fetches z19 tiles at map zoom 18 — sharper, and never asking for
        // the z20 OSM does not serve. Net zoom reach is unchanged.
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
          detectRetina: true,
        }).addTo(map);

        L.control.scale({ imperial: false }).addTo(map);

        // maxClusterRadius is the only real override here (the default is 80);
        // spiderfyOnMaxZoom and removeOutsideVisibleBounds already default to
        // true, so restating them only made them look like tuning decisions.
        const cluster = L.markerClusterGroup({
          maxClusterRadius: MAP_CLUSTER_RADIUS_PX,
        });

        // circleMarker options are plain JS, so they cannot read a CSS
        // variable. Resolve the tokens once per paint and re-apply them when
        // the theme changes.
        const markerColors = () => {
          const style = getComputedStyle(document.documentElement);
          return {
            color: style.getPropertyValue("--svd-map-marker-stroke").trim(),
            fillColor: style.getPropertyValue("--svd-map-marker-fill").trim(),
          };
        };

        const markers: L.CircleMarker[] = [];

        /**
         * Rebuilds the cluster layer for one location set. Called once on
         * mount and again from the second effect below whenever the study
         * status selection changes -- the per-add accessibility decoration
         * and the popup host lifecycle have to run again for the newly
         * visible markers, which is why they live in this loop rather than
         * in a one-time setup.
         */
        const populate = (locations: readonly TrialLocation[]) => {
          for (const cleanup of markerCleanups.splice(0)) cleanup();
          cluster.clearLayers();
          markers.length = 0;
          const colors = markerColors();

          for (const location of locations) {
            const marker = L.circleMarker([location.lat, location.lon], {
              radius: 7,
              weight: 2,
              fillOpacity: 0.75,
              ...colors,
            });
            markers.push(marker);

            // The popup body is rendered on demand: building a Preact tree per
            // visible site -- 173 by default, 378 with Show All ticked -- would
            // be wasted work for markers most viewers never open.
            // One host per marker, unmounted on close: Leaflet calls this back on
            // every open, so a fresh host each time would leave a Preact root
            // mounted per open, and `MapPopup` need only grow one effect — a
            // `Tooltip`, say, whose cleanup aborts its listeners and stops
            // Floating UI's autoUpdate — for those to start outliving the popup.
            const host = document.createElement("div");
            let popupMounted = false;
            marker.bindPopup(() => {
              render(
                <MapPopup
                  location={location}
                  trials={TRIALS_BY_NCT.get(nctKey(location.nctId))}
                />,
                host,
              );
              popupMounted = true;
              return host;
            });

            // Markercluster repeatedly removes and re-adds a circle layer as it
            // enters or leaves a cluster. Leaflet creates a fresh SVG path on
            // every add, so decorate that lifecycle rather than only the first
            // element returned here.
            let accessibility: CircleMarkerAccessibilityBinding | undefined;
            let disposePopupEvents: (() => void) | undefined;
            const dismissPopup = () => {
              marker.closePopup();
              const element = marker.getElement();
              if (element instanceof SVGElement && element.isConnected) {
                element.focus({ preventScroll: true });
              } else container.focus({ preventScroll: true });
            };
            const decorateMarker = () => {
              accessibility?.dispose();
              const element = marker.getElement();
              if (!element) {
                accessibility = undefined;
                return;
              }
              accessibility = bindCircleMarkerAccessibility(
                element,
                `Open facility details: ${describeLocation(location)}`,
                () => {
                  marker.openPopup();
                  // Popup panes follow every marker in DOM order. Move directly
                  // to the record link instead of tabbing through all the sites.
                  const target = host.querySelector<HTMLElement>("a[href]") ??
                    marker.getPopup()?.getElement()?.querySelector<HTMLElement>(
                      ".leaflet-popup-close-button",
                    );
                  target?.focus();
                },
              );
              accessibility.setExpanded(marker.isPopupOpen());
            };
            const undecorateMarker = () => {
              accessibility?.dispose();
              accessibility = undefined;
            };
            const openPopup = () => {
              accessibility?.setExpanded(true);
              disposePopupEvents?.();
              const popup = marker.getPopup()?.getElement();
              if (!popup) return;
              popup.setAttribute("role", "region");
              popup.setAttribute(
                "aria-label",
                `Facility details: ${describeLocation(location)}`,
              );
              const onKeyDown = (event: KeyboardEvent) => {
                const closeButton = (event.target as Element).closest(
                  ".leaflet-popup-close-button",
                );
                if (
                  event.key !== "Escape" && !(closeButton && event.key === " ")
                ) return;
                event.preventDefault();
                event.stopPropagation();
                dismissPopup();
              };
              const onClick = (event: MouseEvent) => {
                if (
                  !(event.target as Element).closest(
                    ".leaflet-popup-close-button",
                  )
                ) return;
                event.preventDefault();
                event.stopPropagation();
                dismissPopup();
              };
              popup.addEventListener("keydown", onKeyDown);
              // Capture before Leaflet removes the close button and loses focus.
              popup.addEventListener("click", onClick, true);
              disposePopupEvents = () => {
                popup.removeEventListener("keydown", onKeyDown);
                popup.removeEventListener("click", onClick, true);
              };
            };
            const closePopup = () => {
              disposePopupEvents?.();
              disposePopupEvents = undefined;
              accessibility?.setExpanded(false);
              if (!popupMounted) return;
              render(null, host);
              popupMounted = false;
            };

            marker.on("add", decorateMarker);
            marker.on("remove", undecorateMarker);
            marker.on("popupopen", openPopup);
            marker.on("popupclose", closePopup);
            markerCleanups.push(() => {
              marker.off("add", decorateMarker);
              marker.off("remove", undecorateMarker);
              marker.off("popupopen", openPopup);
              marker.off("popupclose", closePopup);
              closePopup();
              undecorateMarker();
            });

            cluster.addLayer(marker);
          }
        };

        populateRef.current = populate;
        // The ref, not the closed-over `visibleLocations`: a selection change
        // while the two dynamic imports above were in flight has already
        // moved `visibleRef.current` on, and this is the first read of it.
        populate(visibleRef.current);
        map.addLayer(cluster);

        const repaint = () => {
          const colors = markerColors();
          for (const marker of markers) marker.setStyle(colors);
        };
        stopObservingTheme = observeThemeChanges(repaint);

        // Guards what is actually being fit: `cluster` holds only the first
        // population, which the status filter can make empty, and
        // `getBounds()` on an empty layer group throws "Bounds are not
        // valid." into the outer catch -- replacing the whole map with the
        // load-error alert over a filter selection that filtered everything
        // out. `trialLocations.length` (the unfiltered 378) would not have
        // caught that.
        if (cluster.getLayers().length > 0) {
          map.fitBounds(
            cluster.getBounds(),
            { padding: [40, 40], maxZoom: 6 },
          );
        }
      } catch (error) {
        dispose();
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    populateRef.current?.(visibleLocations);
  }, [visibleLocations]);

  return (
    <div class="map-container">
      <div class="map-controls">
        {controls.map((props) => (
          <CheckboxFilter
            key={props.label}
            {...props}
          />
        ))}
        <p class="map-controls-count" role="status">
          Showing {visibleLocations.length} of {trialLocations.length} sites
          {summary.length > 0 ? ` · ${summary.join("; ")}` : ""}
        </p>
      </div>
      <div class="map-stats">
        <MapStat
          icon="mapPin"
          value={trialLocations.length}
          singular="site"
          plural="sites"
        />
        <MapStat
          icon="map"
          value={COUNTRY_COUNT}
          singular="country"
          plural="countries"
        />
        <MapStat
          icon="documentText"
          value={REGISTERED_TRIAL_COUNT}
          singular="registered trial"
          plural="registered trials"
        />
        <span class="date-badge">
          <Icon name="calendar" />
          Locations resolved {GENERATED_LABEL ?? "· date unavailable"}
        </span>
      </div>
      {loadError
        ? (
          <div class="map-error" role="alert">
            The interactive map could not be loaded. Browse the trial facility
            list below, or reload the page to try again.
          </div>
        )
        : (
          <div
            ref={containerRef}
            class="trials-map"
            role="application"
            aria-label="Interactive map of trial facility locations"
            onKeyDownCapture={(event) => {
              // Markercluster handles Enter itself, but its button-like
              // cluster icons otherwise let Space scroll the page.
              const target = event.target;
              if (
                event.key !== " " || !(target instanceof HTMLElement) ||
                !target.classList.contains("marker-cluster")
              ) return;
              event.preventDefault();
              event.stopPropagation();
              target.click();
              event.currentTarget.focus({ preventScroll: true });
            }}
          />
        )}

      <LocationList
        visible={loadError !== null}
        locations={visibleLocations}
      />
    </div>
  );
}
