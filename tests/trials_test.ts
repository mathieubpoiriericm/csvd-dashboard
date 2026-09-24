import { assert, assertEquals, assertMatch } from "@std/assert";

import {
  formatTrialPlace,
  registryLink,
  registryOf,
  resolveTrialStatus,
} from "../lib/trials.ts";
import { STATUS_NOT_STATED, TRIAL_STATUSES } from "../lib/trial_status.ts";

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
