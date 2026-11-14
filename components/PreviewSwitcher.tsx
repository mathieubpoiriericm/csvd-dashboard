import { currentPreview, PREVIEWS_PATH } from "../lib/previews.ts";
import type { PreviewFeature } from "../lib/previews.ts";
import { Icon } from "./Icon.tsx";

interface PreviewSwitcherProps {
  features: readonly PreviewFeature[];
  pathname: string;
}

/**
 * The strip above a feature page: back to the hub, then the other features,
 * and a second row for the pages inside the current one. Every link states its
 * own `aria-current`, because Fresh marks a link to an ancestor of the page's
 * path by itself and the first row's `/review` would otherwise read as "page"
 * on `/review/progress`.
 */
export function PreviewSwitcher({ features, pathname }: PreviewSwitcherProps) {
  const current = currentPreview(pathname);
  const feature = features.find((f) => f.key === current);
  return (
    <nav class="preview-switcher" aria-label="Feature previews">
      <div class="preview-switcher-row">
        <a
          class="preview-switcher-link preview-switcher-back"
          href={PREVIEWS_PATH}
          aria-current={PREVIEWS_PATH === pathname ? "page" : "false"}
        >
          <Icon name="chevronLeft" />
          All previews
        </a>
        {features.map((f) => {
          const here = f.key === current;
          return (
            <a
              class={`preview-switcher-link${here ? " is-current" : ""}`}
              href={f.href}
              aria-current={f.href === pathname
                ? "page"
                : here
                ? "true"
                : "false"}
            >
              {f.name}
            </a>
          );
        })}
      </div>
      {feature && feature.subpages.length > 0 && (
        <div class="preview-switcher-row preview-switcher-sub">
          {feature.subpages.map((s) => (
            <a
              class={`preview-switcher-link${
                s.href === pathname ? " is-current" : ""
              }`}
              href={s.href}
              aria-current={s.href === pathname ? "page" : "false"}
            >
              {s.label}
            </a>
          ))}
        </div>
      )}
    </nav>
  );
}
