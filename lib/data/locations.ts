/** Geocoded trial facilities and their runtime normalization boundary. */

import geocodedJson from "../../data/geocoded_trials.json" with {
  type: "json",
};

import type { TrialLocation } from "../types.ts";
import {
  normalizeRows,
  nullableText,
  numberInRange,
  record,
  text,
} from "./normalize.ts";

const geocoded = record(geocodedJson);

function sanitizedState(
  nctId: string,
  facilityName: string | null,
  city: string | null,
  state: string | null,
  country: string | null,
): string | null {
  // Reviewed CT.gov upstream defect (2026-09-02): this one Amsterdam facility
  // is published with the US state "New Hampshire" despite its Netherlands
  // country and Amsterdam coordinates. Keep the match on the full facility
  // identity so this display-only omission cannot hide a different row or a
  // future corrected value. A general US-state/country rule would require a
  // complete, evolving subdivision vocabulary and could erase valid regions.
  return nctId.toUpperCase() === "NCT06814730" &&
      facilityName === "Amsterdam UMC" &&
      city === "Amsterdam" &&
      state === "New Hampshire" &&
      country === "Netherlands"
    ? null
    : state;
}

export function normalizeTrialLocation(row: unknown): TrialLocation | null {
  if (typeof row !== "object" || row === null) return null;
  const location = row as Partial<TrialLocation>;
  const nctId = nullableText(location.nctId);
  const latitude = numberInRange(location.lat, -90, 90);
  const longitude = numberInRange(location.lon, -180, 180);
  if (!nctId || latitude === null || longitude === null) return null;

  const facilityName = nullableText(location.facilityName);
  const city = nullableText(location.city);
  const state = nullableText(location.state);
  const country = nullableText(location.country);

  return {
    nctId,
    facilityName,
    city,
    state: sanitizedState(nctId, facilityName, city, state, country),
    country,
    trialTitle: nullableText(location.trialTitle),
    status: nullableText(location.status),
    lat: latitude,
    lon: longitude,
  };
}

export function normalizeTrialLocations(value: unknown): TrialLocation[] {
  return normalizeRows(value, normalizeTrialLocation);
}

export const trialLocations = normalizeTrialLocations(geocoded.locations);
export const trialLocationsGeneratedAt = text(geocoded.generatedAt, "");
