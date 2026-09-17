import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";
import { useTable } from "@tanstack/preact-table";
import { createColumnHelper } from "@tanstack/table-core";

import {
  CheckboxFilter,
  nextSelection,
} from "../components/CheckboxFilter.tsx";
import {
  COMPACT_BUCKET_CEILING,
  DensityReadout,
} from "../components/DensityReadout.tsx";
import GenesView, { BrainCellTypesCell } from "../islands/GenesView.tsx";
import TrialsView, { GeneticTargets } from "../islands/TrialsView.tsx";
import { InstituteLogo } from "../components/InstituteLogo.tsx";
import { Icon } from "../components/Icon.tsx";
import { MapPopup } from "../components/MapPopup.tsx";
import { Page } from "../components/Page.tsx";
import {
  ariaSort,
  pageWindow,
  selectShellState,
  SHELL_FEATURES,
  type ShellFeatures,
  TableShell,
} from "../components/TableShell.tsx";
import { TipBox } from "../components/TipBox.tsx";
import { Tooltip, TooltipDetails } from "../components/Tooltip.tsx";
import { ValueBox } from "../components/ValueBox.tsx";
import { SHOW_ALL, YES_NO_CHOICES } from "../lib/constants.ts";
import { trials } from "../lib/data.ts";
import type { TrialLocation } from "../lib/types.ts";
import vocabulary from "../disease/vocabulary.json" with { type: "json" };

const render = (node: preact.VNode) => renderToString(node);

interface ShellRow {
  name: string;
}

const shellColumn = createColumnHelper<ShellFeatures, ShellRow>();
const SHELL_COLUMNS = shellColumn.columns([
  shellColumn.accessor("name", { header: "Name" }),
]);

function TableHarness({
  data,
  globalFilter,
  descending = false,
  pageIndex = 0,
  onClearFilters,
}: {
  data: ShellRow[];
  globalFilter?: string;
  descending?: boolean;
  pageIndex?: number;
  onClearFilters?: () => void;
}) {
  const table = useTable({
    features: SHELL_FEATURES,
    data,
    columns: SHELL_COLUMNS,
    initialState: {
      globalFilter,
      pagination: { pageIndex, pageSize: 10 },
      sorting: descending ? [{ id: "name", desc: true }] : [],
    },
    enableCellSpanning: false,
  }, selectShellState);
  return (
    <TableShell
      table={table}
      filterSummary={["Fixture: active"]}
      totalRows={data.length}
      tableLabel="Fixture rows"
      searchLabel="Search fixture rows"
      onClearFilters={onClearFilters}
    />
  );
}

Deno.test("nextSelection enforces binary and Show All checkbox rules", () => {
  assertEquals(
    nextSelection("binary", YES_NO_CHOICES, ["Yes"], "Yes", false),
    ["Yes", "No"],
  );
  assertEquals(
    nextSelection("binary", YES_NO_CHOICES, ["Yes"], "No", true),
    ["Yes", "No"],
  );

  const choices = [
    { label: "Show All", value: SHOW_ALL },
    { label: "A", value: "a" },
    { label: "B", value: "b" },
  ];
  assertEquals(nextSelection("showAll", choices, ["a"], SHOW_ALL, true), [
    SHOW_ALL,
  ]);
  assertEquals(nextSelection("showAll", choices, [SHOW_ALL], "a", true), [
    "a",
  ]);
  assertEquals(nextSelection("showAll", choices, ["a", "b"], "a", false), [
    "b",
  ]);
  assertEquals(nextSelection("showAll", choices, ["a"], "a", false), [
    SHOW_ALL,
  ]);
});

Deno.test("CheckboxFilter renders selection state and its visible count", () => {
  const all = render(
    <CheckboxFilter
      label="Evidence"
      choices={[{ label: "Show All", value: SHOW_ALL }, ...YES_NO_CHOICES]}
      selected={[SHOW_ALL]}
      onChange={() => {}}
    />,
  );
  assertStringIncludes(
    all,
    '<span class="filter-count" aria-hidden="true">All</span>',
  );
  assertEquals((all.match(/checked/g) ?? []).length, 1);
  assertMatch(all, /checked[^>]*><span>Show All<\/span>/);

  const one = render(
    <CheckboxFilter
      label="Evidence"
      choices={YES_NO_CHOICES}
      selected={["Yes"]}
      mode="binary"
      onChange={() => {}}
    />,
  );
  assertStringIncludes(
    one,
    '<span class="filter-count" aria-hidden="true">1</span>',
  );
  assertEquals((one.match(/checked/g) ?? []).length, 1);
  assertMatch(one, /checked[^>]*><span>Yes<\/span>/);
});

Deno.test("CheckboxFilter announces its active count to assistive tech, but only while constrained", () => {
  const choices = [{ label: "Show All", value: SHOW_ALL }, {
    label: "a",
    value: "a",
  }, { label: "b", value: "b" }];

  const active = render(
    <CheckboxFilter
      label="X"
      choices={choices}
      selected={["a"]}
      onChange={() => {}}
    />,
  );
  assertStringIncludes(active, ", 1 selected");

  const unconstrained = render(
    <CheckboxFilter
      label="X"
      choices={choices}
      selected={[SHOW_ALL]}
      onChange={() => {}}
    />,
  );
  assertNotMatch(unconstrained, /, \d+ selected/);
});

Deno.test("presentational shells render their optional variants", () => {
  const html = render(
    <Page
      contained
      title="A title"
      description={<span>A description</span>}
    >
      <TipBox>Default guidance</TipBox>
      <TipBox label="Note:">Specific guidance</TipBox>
      <ValueBox label="Records" value={12345} />
      <InstituteLogo />
      <Icon name="info" />
      <Icon name="dna" />
    </Page>,
  );

  assertStringIncludes(html, 'class="page-shell page-shell-contained"');
  assertStringIncludes(html, "<h1>A title</h1>");
  assertStringIncludes(html, "<strong>Tip:</strong>");
  assertStringIncludes(html, "<strong>Note:</strong>");
  assertStringIncludes(html, "12,345");
  assertStringIncludes(html, 'alt="Paris Brain Institute"');
  assertEquals((html.match(/class="icon"/g) ?? []).length, 2);
  // InstituteLogo is an <img>, so every <path> here comes from the two
  // Icon glyphs: "info" (one) and the multi-path "dna" (three).
  assertEquals((html.match(/<path/g) ?? []).length, 4);
});

Deno.test("InstituteLogo renders the manifest's logo and swaps the file on dark", () => {
  const light = renderToString(<InstituteLogo />);
  assertStringIncludes(light, 'src="/institute/logo-light.svg"');
  assertStringIncludes(light, 'alt="Paris Brain Institute"');
  const dark = renderToString(<InstituteLogo dark />);
  assertStringIncludes(dark, 'src="/institute/logo-dark.svg"');
  const decorative = renderToString(<InstituteLogo decorative />);
  // preact-render-to-string serialises an empty string attribute as the
  // bare attribute name rather than `alt=""` -- valid HTML5 parses `<img
  // alt>` as `alt=""` either way, so this checks the same emptiness the
  // literal form would.
  assertStringIncludes(decorative, 'alt aria-hidden="true"');
});

Deno.test("DensityReadout renders totals and zero-height buckets safely", () => {
  const html = render(
    <DensityReadout
      axisLabel="Rows by group"
      stats={[
        { label: "Shown", value: 1200, of: 1500 },
        { label: "Selected", value: 2 },
      ]}
      buckets={[
        { label: "A", total: 4, shown: 2 },
        { label: "B", total: 0, shown: 0 },
      ]}
    />,
  );

  assertStringIncludes(html, "1,200");
  assertStringIncludes(html, "/ 1,500");
  assertStringIncludes(html, "2 of 4");
  assertStringIncludes(html, "height:50%");
  assertStringIncludes(html, "height:0%");
  assertStringIncludes(html, "B: 0 of 0");
  assertMatch(
    html,
    /<ul class="visually-hidden"><li[^>]*>A: 2 of 4<\/li><li[^>]*>B: 0 of 0<\/li><\/ul>/,
  );
});

/** `n` throwaway buckets, only their count matters to the test below. */
function bucketsOfLength(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    label: `${i}`,
    total: 1,
    shown: 1,
  }));
}

Deno.test("DensityReadout hides its bars below 600px only past COMPACT_BUCKET_CEILING", () => {
  // This pins the predicate itself -- see COMPACT_BUCKET_CEILING's own
  // comment in components/DensityReadout.tsx for why it is a plain number
  // and what its value is bound to. A bucket count at the ceiling keeps the
  // sub-600px bars; one past it drops them.
  const atCeiling = render(
    <DensityReadout
      axisLabel="Rows by group"
      stats={[]}
      buckets={bucketsOfLength(COMPACT_BUCKET_CEILING)}
    />,
  );
  assertMatch(atCeiling, /class="readout-bars readout-bars--compact"/);

  const pastCeiling = render(
    <DensityReadout
      axisLabel="Rows by group"
      stats={[]}
      buckets={bucketsOfLength(COMPACT_BUCKET_CEILING + 1)}
    />,
  );
  assertStringIncludes(pastCeiling, 'class="readout-bars"');
  assertNotMatch(pastCeiling, /readout-bars--compact/);
});

const LOCATION: TrialLocation = {
  nctId: "NCT05755997",
  facilityName: " Hôpital Test ",
  city: "Paris",
  state: null,
  country: "France",
  trialTitle: "A trial title",
  status: "RECRUITING",
  lat: 48.8,
  lon: 2.3,
};

Deno.test("MapPopup deduplicates trial facts and renders facility details", () => {
  const html = render(
    <MapPopup
      location={LOCATION}
      trials={[
        { ...trials[0], drug: " Drug A ", targetSampleSize: "100" },
        {
          ...trials[0],
          registryId: "NCT05755997",
          drug: "Drug B",
          clinicalTrialPhase: "III",
          sponsorType: "Industry",
          targetSampleSize: "200",
          estimatedCompletionDate: "1/2030",
        },
        { ...trials[0], drug: "Drug A", targetSampleSize: "100" },
      ]}
    />,
  );

  assertStringIncludes(html, "A trial title");
  assertStringIncludes(html, "Recruiting");
  assertStringIncludes(
    html,
    "Drugs:</span> <span >Drug A</span><span >, Drug B</span>",
  );
  assertStringIncludes(html, "Sample Sizes:");
  assertStringIncludes(html, "<span >100</span><span >, 200</span>");
  assertStringIncludes(html, "Paris, France");
  assertStringIncludes(html, "View on ClinicalTrials.gov");
  assertEquals((html.match(/Drug A/g) ?? []).length, 1);
});

Deno.test("MapPopup omits unavailable optional sections", () => {
  const html = render(
    <MapPopup
      location={{
        ...LOCATION,
        nctId: "UNSUPPORTED1",
        facilityName: null,
        city: null,
        country: null,
        trialTitle: null,
        status: null,
      }}
    />,
  );
  assertNotMatch(html, /popup-title|popup-status|popup-facility|popup-link/);
  assertStringIncludes(html, 'class="map-popup"');
});

Deno.test("MapPopup uses singular labels for one trial", () => {
  const html = render(
    <MapPopup
      location={LOCATION}
      trials={[{ ...trials[0], drug: "Drug A", targetSampleSize: "100" }]}
    />,
  );

  assertStringIncludes(html, "Drug:</span> <span >Drug A</span>");
  assertStringIncludes(html, "Sample Size:</span> <span >100</span>");
});

Deno.test("Tooltip renders plain children or a stable deferred popover shell", () => {
  assertEquals(render(<Tooltip content={null}>plain</Tooltip>), "plain");

  const html = render(
    <Tooltip
      italic
      content={{
        rows: [{ label: "Field", value: "Value" }],
        link: { href: "https://example.com", label: "Open record" },
      }}
    >
      Trigger
    </Tooltip>,
  );
  assertStringIncludes(html, "tooltip-box-italic");
  assertStringIncludes(html, 'popovertargetaction="show"');
  assertStringIncludes(html, 'popover="auto"');
  assertNotMatch(html, /tooltip-pop-scroll|<strong>Field|Open record/);

  const withoutLink = render(
    <Tooltip content={{ rows: [{ label: "Only", value: "Row" }] }}>
      Trigger
    </Tooltip>,
  );
  assertNotMatch(withoutLink, /tooltip-link-btn/);
});

Deno.test("table shell helpers expose every sort state and page-window edge", () => {
  assertEquals(ariaSort(false, false), undefined);
  assertEquals(ariaSort(true, false), "none");
  assertEquals(ariaSort(true, "asc"), "ascending");
  assertEquals(ariaSort(true, "desc"), "descending");

  assertEquals(pageWindow(0, 0), []);
  assertEquals(pageWindow(0, 1), []);
  assertEquals(pageWindow(0, 4), [0, 1, 2, 3]);
  assertEquals(pageWindow(5, 10), [2, 3, 4, 5, 6, 7, 8]);
  assertEquals(pageWindow(9, 10), [3, 4, 5, 6, 7, 8, 9]);
});

Deno.test("TableShell renders descending and empty filtered states", () => {
  const descending = render(
    <TableHarness data={[{ name: "Beta" }, { name: "Alpha" }]} descending />,
  );
  assertStringIncludes(descending, 'aria-sort="descending"');
  assertStringIncludes(descending, "Alpha");
  assertStringIncludes(descending, "Beta");
  assertStringIncludes(descending, "Fixture: active");

  const empty = render(
    <TableHarness data={[{ name: "Alpha" }]} globalFilter=" missing " />,
  );
  assertStringIncludes(empty, "Search: “missing”");
  assertStringIncludes(empty, "No rows match the current filters.");
  assertStringIncludes(empty, "No entries");
  assertNotMatch(empty, /Clear all filters/);

  const emptyWithClear = render(
    <TableHarness
      data={[{ name: "Alpha" }]}
      globalFilter=" missing "
      onClearFilters={() => {}}
    />,
  );
  assertStringIncludes(emptyWithClear, "Clear all filters");
  assertStringIncludes(emptyWithClear, 'class="empty-state-clear"');

  const secondPage = render(
    <TableHarness
      data={Array.from({ length: 11 }, (_, index) => ({
        name: `Row ${index + 1}`,
      }))}
      pageIndex={1}
    />,
  );
  assertStringIncludes(secondPage, 'aria-current="page" aria-label="Page 2"');
  assertEquals((secondPage.match(/disabled/g) ?? []).length, 1);
});

Deno.test("TableShell tags every cell with its column id", () => {
  const html = render(<GenesView />);
  // Matched within the class attribute rather than anchored at its start:
  // neither column is a group-start column today, so a literal
  // `class="col-gene` prefix check would happen to pass, but it would quietly
  // start failing the moment a class that sorts earlier (e.g. `col-identity`)
  // is ever added ahead of it.
  assertMatch(html, /class="[^"]*\bcol-gene\b[^"]*"/);
  assertMatch(html, /class="[^"]*\bcol-chromosomalLocation\b[^"]*"/);
});

Deno.test("GenesView: absent values render as an em dash, not the export sentinel", () => {
  const html = render(<GenesView />);
  assertStringIncludes(html, 'class="cell-absent"');
  const cells = [...html.matchAll(/<td[^>]*>[\s\S]*?<\/td>/g)].map((m) => m[0]);
  assert(cells.length > 0);
  for (const cell of cells) {
    assertNotMatch(cell, /\(none found\)/);
  }
});

Deno.test("GeneticTargets renders an em dash for the absent sentinel, before splitting", () => {
  const absent = render(<GeneticTargets value="(none)" />);
  assertStringIncludes(absent, 'class="cell-absent"');
  assertNotMatch(absent, /\(none\)/);

  const present = render(<GeneticTargets value="COL4A1, COL4A2" />);
  assertStringIncludes(present, "COL4A1");
  assertStringIncludes(present, "COL4A2");

  // A leading separator produces an empty piece, which renders as itself
  // rather than an empty tooltip trigger.
  const leadingSeparator = render(<GeneticTargets value=",COL4A2" />);
  assertStringIncludes(leadingSeparator, "COL4A2");
});

Deno.test("BrainCellTypesCell renders an em dash for the absent sentinel, before splitting", () => {
  const absent = render(<BrainCellTypesCell value="(unknown)" />);
  assertStringIncludes(absent, 'class="cell-absent"');
  assertNotMatch(absent, /\(unknown\)/);

  const present = render(<BrainCellTypesCell value="FB>PC>SMC" />);
  assertStringIncludes(present, "FB");
  assertStringIncludes(present, "PC");

  // Not absent, but nothing to split either -- separators with no
  // abbreviations between them -- falls back to the raw value. SSR escapes
  // the "<" the same way it would in any other plain-text cell.
  const empty = render(<BrainCellTypesCell value="<>" />);
  assertEquals(empty, "&lt;>");

  // An abbreviation the vocabulary does not know renders plain rather than a
  // broken tooltip, but no longer sinks the whole cell to raw text: its
  // neighbour keeps rendering normally either side of it.
  const unmapped = render(<BrainCellTypesCell value="ZZ>QQ" />);
  assertStringIncludes(unmapped, "ZZ");
  assertStringIncludes(unmapped, "QQ");
  assertNotMatch(unmapped, /tooltip-box/);

  // One known type and one unknown type in the same chain: the known one
  // still gets its tooltip, the unknown one renders plain beside it -- one
  // `tooltip-box`, not zero and not two.
  const mixed = render(<BrainCellTypesCell value="FB>QQ" />);
  assertStringIncludes(mixed, "FB");
  assertStringIncludes(mixed, "QQ");
  assertEquals(mixed.match(/tooltip-box/g)?.length, 1);
});

// -----------------------------------------------------------------------------
// F57: every filter group must use the same term in its sidebar legend and in
// the "Active Filters:" readout built from it. `CheckboxFilterConfig` carries
// only `label` (see components/CheckboxFilter.tsx) and `checkboxFilterSummary`
// reads that same field, so the two cannot drift the way five of nine groups
// once had -- these pin the legend half of that against real rendered markup,
// the way every other island test in this file does.
// -----------------------------------------------------------------------------

const filterGroupLegends = (html: string) =>
  [...html.matchAll(/<span class="filter-group-label">([^<]+)<\/span>/g)]
    .map((match) => match[1]);

Deno.test("GenesView: every filter group's legend is its one true name", () => {
  const legends = filterGroupLegends(render(<GenesView />));
  assertEquals(legends, [
    "Mendelian randomization performed",
    "GWAS Traits",
    "Evidence From Other Omics Studies",
  ]);
});

Deno.test("GenesView: a GWAS trait choice carries its long name as a visually-hidden description", () => {
  const html = render(<GenesView />);
  assertStringIncludes(
    html,
    `class="visually-hidden">, ${vocabulary.traits[0].name}`,
  );
});

Deno.test("TrialsView: every filter group's legend is its one true name", () => {
  const html = render(<TrialsView />);
  const legends = filterGroupLegends(html);
  assertEquals(legends, [
    "Genetic evidence",
    "Clinical Trial Registry",
    "Clinical Trial Phase",
    "SVD Population",
    "Sponsor Type",
    "Study status",
  ]);
});

Deno.test("tooltip details preserve rows and secure external links when opened", () => {
  const markup = render(
    <TooltipDetails
      content={{
        rows: [{ label: "Gene", value: "COL4A1" }],
        link: { label: "NCBI", href: "https://www.ncbi.nlm.nih.gov/gene/1282" },
      }}
    />,
  );
  assertStringIncludes(markup, "<strong>Gene</strong>");
  assertStringIncludes(markup, "COL4A1");
  assertStringIncludes(markup, 'target="_blank"');
  assertStringIncludes(markup, 'rel="noopener noreferrer"');
  assertStringIncludes(markup, "https://www.ncbi.nlm.nih.gov/gene/1282");
  const rowsOnly = render(
    <TooltipDetails content={{ rows: [{ label: "Only", value: "Row" }] }} />,
  );
  assertStringIncludes(rowsOnly, "<strong>Only</strong>");
  assertNotMatch(rowsOnly, /<a[ >]/);
});
