import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import { Icon } from "./Icon.tsx";

/** Remembers the collapsed rail across a navigation between /genes and /trials. */
const STORAGE_KEY = "svd-filters-collapsed";

/**
 * The filter sidebar and the table beside it, as one collapsible pair.
 *
 * Both data pages laid this out themselves and drew the same three elements,
 * which is why it moved here: the collapsed state has to reach the grid
 * wrapper as well as the panel, so the two cannot be styled from the panel
 * alone.
 *
 * Collapsing folds the panel to a rail rather than unmounting it. The rail
 * keeps the heading -- "Filters" set vertically beside the funnel -- and the
 * toggle stays one button in one place, so a press never moves the control out
 * from under the pointer or drops the keyboard back to the top of the page.
 *
 * Nothing is hidden by hiding the filters: `TableShell` prints the
 * `Active Filters: ... - showing N of M rows` line above the table, so a
 * constraint set before collapsing is still reported while the controls are
 * away.
 */
interface FilterPanelProps {
  /** Id for the panel heading, which is what names the `<aside>`. */
  titleId: string;
  /** The filter controls, hidden as a block when the panel is collapsed. */
  filters: ComponentChildren;
  /** The readout and table that take the freed column. */
  children: ComponentChildren;
}

export function FilterPanel(
  { titleId, filters, children }: FilterPanelProps,
) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = `${titleId}-body`;

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch { /* blocked storage */ }
  }, []);

  const toggle = () =>
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch { /* blocked storage */ }
      return next;
    });

  return (
    <div class={`layout-sidebar${collapsed ? " is-collapsed" : ""}`}>
      <aside class="sidebar-section" aria-labelledby={titleId}>
        <div class="sidebar-header">
          <h2 id={titleId} class="sidebar-title">
            <Icon name="funnel" />
            <span class="sidebar-title-text">Filters</span>
          </h2>
          <button
            type="button"
            class="sidebar-toggle"
            aria-expanded={collapsed ? "false" : "true"}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronLeft"} />
            <span class="visually-hidden">
              {collapsed ? "Show filters" : "Hide filters"}
            </span>
          </button>
        </div>

        <div id={bodyId} hidden={collapsed}>
          {filters}
        </div>
      </aside>

      <div class="layout-main">{children}</div>
    </div>
  );
}
