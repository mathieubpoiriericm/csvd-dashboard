import type { ComponentChildren } from "preact";

interface PageProps {
  /**
   * Heading and lead for the default header block. Both are omitted by a route
   * that supplies its own `header`.
   */
  title?: string;
  description?: ComponentChildren;
  /**
   * Replaces the default `.page-header` block. The About page passes its hero
   * card, which carries the heading, the lead and the totals on one surface.
   */
  header?: ComponentChildren;
  /** Constrain the shell to a fixed measure rather than the full width. */
  contained?: boolean;
  children: ComponentChildren;
}

/**
 * The shell every route renders into.
 *
 * Routes used to return a bare fragment, so vertical rhythm was whatever each
 * top-level block declared on itself — eight different margin rules that
 * disagreed, which is why the gap under the heading differed between routes.
 * The shell is a flex column with a single gap, so blocks inside it carry no
 * outer margin of their own.
 */
export function Page(
  { title, description, header, contained = false, children }: PageProps,
) {
  return (
    <div class={`page-shell${contained ? " page-shell-contained" : ""}`}>
      {header ?? (
        <div class="page-header">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      )}
      {children}
    </div>
  );
}
