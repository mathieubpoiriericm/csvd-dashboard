/**
 * ClinicalTrials.gov's overall-status vocabulary, as both `data/table2.json`
 * (`overallStatus`, one per trial row) and `data/geocoded_trials.json`
 * (`status`, one per facility) carry it. It is its own module because
 * `lib/constants.ts` derives `STATUS_CHOICES` from it and `lib/trials.ts`
 * imports `lib/constants.ts`; a cycle between the two would evaluate the
 * choice list before the vocabulary existed.
 */

export type StatusKind =
  | "recruiting"
  | "active"
  | "completed"
  | "terminated"
  | "unknown";

export interface TrialStatus {
  label: string;
  className: string;
  kind: StatusKind;
}

function defineStatus(label: string, kind: StatusKind): TrialStatus {
  return { label, className: `popup-status-${kind}`, kind };
}

export const TRIAL_STATUSES: Readonly<Record<string, TrialStatus>> = {
  RECRUITING: defineStatus("Recruiting", "recruiting"),
  ENROLLING_BY_INVITATION: defineStatus(
    "Enrolling by Invitation",
    "recruiting",
  ),
  // Parenthesised rather than CT.gov's own "Active, not recruiting": these
  // labels are joined with ", " into the `Active Filters:` line, where a
  // comma inside one made six selected choices read as eight.
  ACTIVE_NOT_RECRUITING: defineStatus("Active (not recruiting)", "active"),
  NOT_YET_RECRUITING: defineStatus("Not Yet Recruiting", "active"),
  COMPLETED: defineStatus("Completed", "completed"),
  TERMINATED: defineStatus("Terminated", "terminated"),
  WITHDRAWN: defineStatus("Withdrawn", "terminated"),
  SUSPENDED: defineStatus("Suspended", "terminated"),
  UNKNOWN: defineStatus("Unknown", "unknown"),
};

/**
 * The choice that also answers for a trial with no ClinicalTrials.gov record
 * at all -- the export's "(unknown)" sentinel and a facility with a null
 * status. CT.gov's own UNKNOWN means "the sponsor stopped updating"; from the
 * dashboard's side both are "status not stated".
 */
export const STATUS_NOT_STATED = "UNKNOWN";

export interface ResolvedTrialStatus extends TrialStatus {
  raw: string;
}

/** Display label and badge class for a ClinicalTrials.gov status. */
export function resolveTrialStatus(value: string | null): ResolvedTrialStatus {
  const raw = value?.trim() ?? "";
  const status = TRIAL_STATUSES[raw.toUpperCase()];
  return {
    raw,
    label: status?.label ?? raw,
    className: status?.className ?? "popup-status-unknown",
    kind: status?.kind ?? "unknown",
  };
}
