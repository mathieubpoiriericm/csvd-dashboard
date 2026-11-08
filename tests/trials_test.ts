import { assert, assertEquals, assertMatch } from "@std/assert";

import {
  formatTrialPlace,
  locationsWithTableStatus,
  phaseBarLabel,
  registryLink,
  registryOf,
  resolveTrialStatus,
  splitTargetQualifier,
} from "../lib/trials.ts";
import { GOLD_ONLY } from "../lib/gold_only.ts";
import { STATUS_NOT_STATED, TRIAL_STATUSES } from "../lib/trial_status.ts";

Deno.test("phaseBarLabel names a missing phase rather than printing the sentinel", () => {
  assertEquals(phaseBarLabel("II/III"), "II/III");
  assertEquals(phaseBarLabel("(unknown)"), "Not stated");
  assertEquals(phaseBarLabel(""), "Not stated");
});

Deno.test("registryOf rejects malformed and unsupported identifiers", () => {
  assertEquals(registryOf("12345"), null);
  assertEquals(registryOf("EUCTR2026-000001"), null);
});

Deno.test("registryLink encodes record identifiers and supports search-only registries", () => {
  assertEquals(registryLink(" NCT1234/5 "), {
    registryLabel: "ClinicalTrials.gov",
    href: "https://clinicaltrials.gov/study/NCT1234%2F5",
    actionLabel: "View on ClinicalTrials.gov",
  });
  assertEquals(registryLink("chictr2500109773"), {
    registryLabel: "ChiCTR",
    href: "https://www.chictr.org.cn/searchprojEN.html",
    actionLabel: "Search ChiCTR",
  });
  assertEquals(registryLink("unknown"), null);
});

Deno.test("resolveTrialStatus normalizes known statuses and preserves unknown ones", () => {
  assertEquals(resolveTrialStatus(" enrolling_by_invitation "), {
    raw: "enrolling_by_invitation",
    label: "Enrolling by Invitation",
    className: "popup-status-recruiting",
    kind: "recruiting",
  });
  assertEquals(resolveTrialStatus("ACTIVE_NOT_RECRUITING"), {
    raw: "ACTIVE_NOT_RECRUITING",
    label: "Active (not recruiting)",
    className: "popup-status-active",
    kind: "active",
  });
  assertEquals(resolveTrialStatus("completed"), {
    raw: "completed",
    label: "Completed",
    className: "popup-status-completed",
    kind: "completed",
  });
  assertEquals(resolveTrialStatus("withdrawn"), {
    raw: "withdrawn",
    label: "Withdrawn",
    className: "popup-status-terminated",
    kind: "terminated",
  });
  assertEquals(resolveTrialStatus("not in the registry"), {
    raw: "not in the registry",
    label: "not in the registry",
    className: "popup-status-unknown",
    kind: "unknown",
  });
  assertEquals(resolveTrialStatus(null), {
    raw: "",
    label: "",
    className: "popup-status-unknown",
    kind: "unknown",
  });
});

Deno.test("every configured status resolves to a safe popup class", () => {
  for (
    const value of [
      "RECRUITING",
      "ENROLLING_BY_INVITATION",
      "ACTIVE_NOT_RECRUITING",
      "NOT_YET_RECRUITING",
      "COMPLETED",
      "TERMINATED",
      "WITHDRAWN",
      "SUSPENDED",
      "UNKNOWN",
    ]
  ) {
    const status = resolveTrialStatus(value);
    assertMatch(status.className, /^popup-status-[a-z]+$/);
  }
});

Deno.test("formatTrialPlace handles a completely absent address", () => {
  assertEquals(
    formatTrialPlace({ city: null, state: null, country: null }),
    "",
  );
});

Deno.test("every ClinicalTrials.gov status carries a kind, and UNKNOWN is the not-stated choice", () => {
  for (const [token, status] of Object.entries(TRIAL_STATUSES)) {
    assertMatch(token, /^[A-Z_]+$/);
    assert(
      ["recruiting", "active", "completed", "terminated", "unknown"].includes(
        status.kind,
      ),
    );
  }
  assertEquals(STATUS_NOT_STATED, "UNKNOWN");
});

Deno.test("splitTargetQualifier separates a leading label from the symbol", () => {
  assertEquals(splitTargetQualifier("GWAS for ischemic stroke: PDE3A"), {
    qualifier: "GWAS for ischemic stroke: ",
    symbol: "PDE3A",
  });
  assertEquals(splitTargetQualifier("monogenic disease: APP"), {
    qualifier: "monogenic disease: ",
    symbol: "APP",
  });
  // No label, or a colon inside the symbol itself, leaves the piece whole.
  assertEquals(splitTargetQualifier("GLP1R"), {
    qualifier: "",
    symbol: "GLP1R",
  });
  assertEquals(splitTargetQualifier("PVRL2:CTB-129P6.4"), {
    qualifier: "",
    symbol: "PVRL2:CTB-129P6.4",
  });
});

Deno.test("map facilities take their trial's table status only under gold-only", () => {
  const site = {
    facilityName: "A",
    city: "B",
    state: null,
    country: "C",
    trialTitle: "T",
    lat: 0,
    lon: 0,
  };
  const locations = [
    { ...site, nctId: "NCT00000001", status: "COMPLETED" },
    { ...site, nctId: "nct00000002 ", status: "RECRUITING" },
    { ...site, nctId: "NCT00000003", status: "RECRUITING" },
    { ...site, nctId: "NCT00000004", status: "ACTIVE_NOT_RECRUITING" },
  ];
  const table = [
    { registryId: "NCT00000001", overallStatus: "RECRUITING" },
    { registryId: "NCT00000001", overallStatus: "COMPLETED" },
    { registryId: "NCT00000002", overallStatus: "(unknown)" },
    { registryId: "NCT00000003", overallStatus: "SUSPENDED" },
  ];

  // Otherwise the geocoder's per-site status stands, untouched.
  assertEquals(locationsWithTableStatus(locations, table, false), locations);

  // Under gold-only: the trial's first table row, the table's unstated
  // sentinel as null, and null for a trial the table does not list.
  assertEquals(
    locationsWithTableStatus(locations, table, true).map((l) => l.status),
    ["RECRUITING", null, "SUSPENDED", null],
  );
  // The dashboard as built follows GOLD_ONLY.
  assertEquals(
    locationsWithTableStatus(locations, table),
    locationsWithTableStatus(locations, table, GOLD_ONLY),
  );
  // Nothing else about a facility changes.
  assertEquals(
    locationsWithTableStatus(locations, table, true).map((l) => l.nctId),
    locations.map((l) => l.nctId),
  );
});
