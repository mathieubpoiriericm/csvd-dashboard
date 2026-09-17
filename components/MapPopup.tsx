import { valueOrAbsent } from "./Absent.tsx";
import { Icon } from "./Icon.tsx";
import { formatMonthYear } from "../lib/constants.ts";
import {
  formatTrialPlace,
  registryLink,
  resolveTrialStatus,
} from "../lib/trials.ts";
import type { Trial, TrialLocation } from "../lib/types.ts";

interface MapPopupProps {
  location: TrialLocation;
  trials?: readonly Trial[];
}

const uniqueValues = (values: readonly string[]) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

function formatValues(label: string, values: readonly string[]): string | null {
  return values.length > 0 ? `${label}: ${values.join(", ")}` : null;
}

interface PopupValuesProps {
  singular: string;
  plural?: string;
  values: readonly string[];
}

function PopupValues({ singular, plural, values }: PopupValuesProps) {
  if (values.length === 0) return null;
  return (
    <div class="popup-info-row">
      <span class="popup-label">
        {values.length > 1 ? plural ?? `${singular}s` : singular}:
      </span>{" "}
      {values.map((value, index) => (
        <span key={`${value}-${index}`}>
          {index > 0 && ", "}
          {valueOrAbsent(value)}
        </span>
      ))}
    </div>
  );
}

/**
 * Marker popup for one trial facility.
 *
 * Replaces `build_popup_content_vectorized()` — roughly 200 lines of
 * `sprintf`/`ifelse` string assembly in R that lived inside the Shiny app's
 * ClinicalTrials.gov fetcher.
 */
export function MapPopup({ location, trials = [] }: MapPopupProps) {
  const status = resolveTrialStatus(location.status);
  const valuesFor = (key: keyof Trial) =>
    uniqueValues(trials.map((trial) => trial[key]));

  const drugs = valuesFor("drug");
  const phases = valuesFor("clinicalTrialPhase");
  const sponsors = valuesFor("sponsorType");
  const sampleSizes = valuesFor("targetSampleSize");
  const completionDates = valuesFor("estimatedCompletionDate").map(
    formatMonthYear,
  );
  const phaseSponsor = [
    formatValues("Phase", phases),
    formatValues("Sponsor", sponsors),
  ].filter(Boolean).join(" • ");
  const place = formatTrialPlace(location);
  const registry = registryLink(location.nctId);

  return (
    <div class="map-popup">
      {location.trialTitle && (
        <div class="popup-title">{location.trialTitle}</div>
      )}
      {status.raw && (
        <div class={`popup-status ${status.className}`}>
          {status.label}
        </div>
      )}
      {(location.trialTitle || status.raw) &&
        <div class="popup-divider" />}

      <div class="popup-trial-info">
        <PopupValues singular="Drug" values={drugs} />
        {phaseSponsor && <div class="popup-info-row">{phaseSponsor}</div>}
        <PopupValues singular="Sample Size" values={sampleSizes} />
        <PopupValues
          singular="Est. Completion"
          plural="Est. Completion"
          values={completionDates}
        />
      </div>

      <div class="popup-divider" />

      {location.facilityName && (
        <div class="popup-facility">
          <span class="popup-facility-icon">
            <Icon name="mapPin" />
          </span>
          {location.facilityName}
        </div>
      )}
      {place && <div class="popup-location">{place}</div>}

      {registry && (
        <a
          class="popup-link"
          href={registry.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {registry.actionLabel}
        </a>
      )}
    </div>
  );
}
