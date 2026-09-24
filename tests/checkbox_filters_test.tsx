import { assertEquals } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { useCheckboxFilters } from "../components/useCheckboxFilters.ts";
import { SHOW_ALL, YES_NO_CHOICES } from "../lib/constants.ts";

Deno.test("filter updates preserve other groups and reset restores their defaults", () => {
  const definitions = {
    evidence: {
      label: "Evidence",
      choices: YES_NO_CHOICES,
      mode: "binary",
    },
    phase: {
      label: "Phase",
      choices: [
        { value: SHOW_ALL, label: "Show All" },
        { value: "II", label: "Phase II" },
      ],
    },
  } as const;
  const snapshots: Array<{
    values: Record<keyof typeof definitions, string[]>;
    summary: string[];
  }> = [];

  // Preact's server renderer settles updates made during rendering. This
  // exercises the real hook without a DOM shim or a second state model.
  function Harness() {
    const { values, controls, summary, reset } = useCheckboxFilters(
      definitions,
    );
    snapshots.push({ values, summary });
    if (snapshots.length === 1) {
      controls[0].onChange(["Yes"]);
      controls[1].onChange(["II"]);
    } else if (snapshots.length === 2) {
      reset();
    }
    return null;
  }

  renderToString(<Harness />);

  const defaults = {
    values: { evidence: ["Yes", "No"], phase: [SHOW_ALL] },
    summary: [],
  };
  assertEquals(snapshots, [
    defaults,
    {
      values: { evidence: ["Yes"], phase: ["II"] },
      summary: ["Evidence: Yes", "Phase: Phase II"],
    },
    defaults,
  ]);
});

Deno.test("a definition's initial selection seeds the group and survives reset", () => {
  const definitions = {
    status: {
      label: "Study status",
      choices: [
        { value: SHOW_ALL, label: "Show All" },
        { value: "RECRUITING", label: "Recruiting" },
        { value: "COMPLETED", label: "Completed" },
      ],
      initial: ["RECRUITING"],
    },
  } as const;
  const snapshots: Array<{ values: { status: string[] }; summary: string[] }> =
    [];

  function Harness() {
    const { values, controls, summary, reset } = useCheckboxFilters(
      definitions,
    );
    snapshots.push({ values, summary });
    assertEquals("initial" in controls[0], false);
    if (snapshots.length === 1) controls[0].onChange([SHOW_ALL]);
    else if (snapshots.length === 2) reset();
    return null;
  }

  renderToString(<Harness />);

  const seeded = {
    values: { status: ["RECRUITING"] },
    summary: ["Study status: Recruiting"],
  };
  assertEquals(snapshots, [
    seeded,
    { values: { status: [SHOW_ALL] }, summary: [] },
    seeded,
  ]);
});
