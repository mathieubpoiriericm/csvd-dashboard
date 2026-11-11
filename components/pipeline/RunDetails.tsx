/**
 * What the run details dialog holds: a row of tabs and the selected tab's
 * panel.
 *
 * The dialog itself, with its heading and close button, is the island's
 * (`islands/PipelineRun.tsx`); this mounts inside it the first time it
 * opens. One section shows at a time. As one scroll, the same record was a
 * 686px window onto 9,469px of it, with nothing to say where the papers
 * began or how far down the services were.
 *
 * A real tablist: one tab stop, the arrows move between tabs (`nextTab`),
 * and each tab names the panel it controls. A panel mounts when its tab is
 * first selected and then stays, hidden, so going back to a tab does not
 * rebuild a thousand records or lose its place.
 */

import { memo } from "preact/compat";
import { useRef, useState } from "preact/hooks";

import { ApiList } from "../ApiList.tsx";
import { detailTabs, nextTab, type TabId } from "../../lib/pipeline_details.ts";
import { formatCount } from "../../lib/pipeline_display.ts";
import type { PipelineRun } from "../../lib/types.ts";
import { FindingsPanel } from "./FindingsPanel.tsx";
import { PapersPanel } from "./PapersPanel.tsx";
import { SetupPanel } from "./SetupPanel.tsx";

const tabId = (id: TabId) => `pipeline-run-tab-${id}`;
const panelId = (id: TabId) => `pipeline-run-panel-${id}`;

function Tab(
  { id, label, count, selected, mounted, onSelect, register }: {
    id: TabId;
    label: string;
    count: number | null;
    selected: boolean;
    /** Whether this tab's panel is in the page yet. */
    mounted: boolean;
    onSelect: () => void;
    register: (element: HTMLButtonElement | null) => void;
  },
) {
  return (
    <button
      ref={register}
      type="button"
      role="tab"
      id={tabId(id)}
      class="pipeline-tab"
      aria-selected={selected ? "true" : "false"}
      // A panel mounts when its tab is first selected. Until then the id
      // would name nothing, so the tab does not claim to control it.
      aria-controls={mounted ? panelId(id) : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
    >
      {label}
      {count !== null && (
        <span class="pipeline-tab-count">{formatCount(count)}</span>
      )}
    </button>
  );
}

function PanelContent({ id, run }: { id: TabId; run: PipelineRun }) {
  switch (id) {
    case "findings":
      return <FindingsPanel run={run} />;
    case "papers":
      return <PapersPanel run={run} />;
    case "services":
      return (
        <section class="pipeline-apis">
          <ApiList apis={run.apis} />
        </section>
      );
    case "setup":
      return <SetupPanel run={run} />;
  }
}

function Panel(
  { id, run, selected }: { id: TabId; run: PipelineRun; selected: boolean },
) {
  return (
    <div
      role="tabpanel"
      id={panelId(id)}
      class="pipeline-panel"
      aria-labelledby={tabId(id)}
      hidden={!selected}
      // A panel scrolls, so it takes focus: the keyboard has to be able to
      // reach it to scroll a tab with no link in it.
      tabIndex={0}
    >
      <PanelContent id={id} run={run} />
    </div>
  );
}

export const RunDetails = memo(
  function RunDetails(
    { run, tab }: {
      run: PipelineRun;
      /** The tab to open on. Tests only: the dialog opens on the first. */
      tab?: TabId;
    },
  ) {
    const tabs = detailTabs(run);
    const ids = tabs.map((entry) => entry.id);
    const [selected, setSelected] = useState<TabId>(tab ?? ids[0]);
    const [shown, setShown] = useState<ReadonlySet<TabId>>(
      () => new Set([selected]),
    );
    const buttons = useRef(new Map<TabId, HTMLButtonElement | null>());

    const select = (id: TabId) => {
      setSelected(id);
      setShown((current) => new Set(current).add(id));
    };

    return (
      <>
        <div
          class="pipeline-tabs"
          role="tablist"
          // Named for what it lists: the dialog round it is already
          // "Run details".
          aria-label="Sections"
          onKeyDown={(event) => {
            const next = nextTab(ids, selected, event.key);
            if (next === selected) return;
            event.preventDefault();
            select(next);
            buttons.current.get(next)?.focus();
          }}
        >
          {tabs.map((entry) => (
            <Tab
              key={entry.id}
              id={entry.id}
              label={entry.label}
              count={entry.count}
              selected={entry.id === selected}
              mounted={shown.has(entry.id)}
              onSelect={() => select(entry.id)}
              register={(element) => buttons.current.set(entry.id, element)}
            />
          ))}
        </div>
        <div class="pipeline-panels">
          {tabs.filter((entry) => shown.has(entry.id)).map((entry) => (
            <Panel
              key={entry.id}
              id={entry.id}
              run={run}
              selected={entry.id === selected}
            />
          ))}
        </div>
      </>
    );
  },
);
