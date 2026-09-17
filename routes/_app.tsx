// deno-lint-ignore-file react-no-danger -- the no-flash theme script must be
// inline to run before the first paint; see NO_FLASH below. It is built from a
// module constant and never touches request data.
import { define } from "../utils.ts";
import { Icon } from "../components/Icon.tsx";
import { InstituteLogo } from "../components/InstituteLogo.tsx";
import ThemeToggle from "../islands/ThemeToggle.tsx";
import { LOGIN_PATH, LOGOUT_PATH } from "../lib/auth.ts";
import { SITE_TITLE, TABS } from "../lib/constants.ts";
import { HEADING, INSTITUTE, META_DESCRIPTION } from "../lib/disease/site.ts";
import { THEME_STORAGE_KEY } from "../lib/theme.ts";

// Vite resolves the same assets as CSS in both build environments. Plain Deno
// render tests have no asset pipeline, so retain source URLs only there.
const fontAssets: Record<string, string> = import.meta.env
  ? import.meta.glob<string>("../assets/fonts/*.woff2", {
    eager: true,
    query: "?url",
    import: "default",
  })
  : {};
const fontUrl = (name: string) =>
  fontAssets[`../assets/fonts/${name}`] ??
    new URL(`../assets/fonts/${name}`, import.meta.url).href;
const bodyFont = fontUrl("Barlow-400-latin.woff2");
const headingFont = fontUrl("BarlowCondensed-600-latin.woff2");
const navigationFont = fontUrl("BarlowCondensed-500-latin.woff2");

// Byte-identical to --svd-nav in each theme (assets/app.css, the two dark
// blocks); e2e/tests/theme.spec.ts fails if they diverge.
const THEME_COLORS = {
  light: "#1d2d3d",
  dark: "#14181b",
} as const;

/*
 * Runs before first paint, so a stored choice is on <html> by the time the
 * stylesheet resolves and the page never flashes the wrong theme. With no
 * stored choice nothing is stamped and prefers-color-scheme decides.
 */
const NO_FLASH = `try{var t=localStorage.getItem(${
  JSON.stringify(THEME_STORAGE_KEY)
});if(t==="dark"||t==="light"){document.documentElement.dataset.theme=t;var c=t==="dark"?${
  JSON.stringify(THEME_COLORS.dark)
}:${
  JSON.stringify(THEME_COLORS.light)
};document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",c)})}}catch(e){}`;

function isActiveTab(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function pageTitle(pathname: string): string {
  if (pathname === LOGIN_PATH) return `Sign in | ${SITE_TITLE}`;
  const tab = TABS.find(({ href }) => isActiveTab(pathname, href));
  return tab ? `${tab.label} | ${SITE_TITLE}` : SITE_TITLE;
}

export default define.page(function App({ Component, url, state }) {
  const year = new Date().getFullYear();
  // The login page is a bare sheet: the tabs would only bounce back to it.
  const login = url.pathname === LOGIN_PATH;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{pageTitle(url.pathname)}</title>
        <meta
          name="description"
          content={META_DESCRIPTION}
        />
        {
          /*
          The ICM brain mark, cropped square. This was the full 1430x354
          wordmark lockup, which a browser letterboxes into a ~16x4 sliver.
          `favicon.ico` is not redundant: browsers, feed readers and
          link-preview scrapers request that path directly, whatever is
          declared here.
        */
        }
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* The navbar is dark in both themes, so this matches it. */}
        <meta
          name="theme-color"
          content={THEME_COLORS.light}
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content={THEME_COLORS.dark}
          media="(prefers-color-scheme: dark)"
        />
        {
          /*
          The theme has to be on <html> before the first paint, so this cannot
          be an external file without reintroducing the flash it exists to
          prevent. NO_FLASH is a module constant built from a literal key and
          never touches request data.
        */
        }
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
        {
          /*
          The stylesheet is injected by the Fresh Vite plugin, so the browser
          only discovers these once it parses that CSS. Preloading pulls the
          three faces that render above the fold into the first round trip.
        */
        }
        {[bodyFont, headingFont, navigationFont].map((href) => (
          <link
            key={href}
            rel="preload"
            as="font"
            type="font/woff2"
            href={href}
            crossOrigin="anonymous"
          />
        ))}
      </head>
      <body>
        <a class="skip-link" href="#main-content">Skip to main content</a>
        <div class={login ? "page page-login" : "page"}>
          {!login && (
            <header class="navbar">
              <div class="navbar-inner">
                <a class="navbar-brand" href="/" aria-label="Home">
                  <InstituteLogo dark decorative />
                </a>
                {
                  /* Outside the brand link: the heading is centred against the
                  bar by the grid's outer tracks, which it cannot be while it
                  shares a box with the logo. */
                }
                <span class="navbar-title">{HEADING}</span>

                <nav aria-label="Main">
                  <ul class="navbar-nav">
                    {TABS.map((tab) => {
                      const active = isActiveTab(url.pathname, tab.href);
                      return (
                        <li key={tab.href}>
                          <a
                            class="nav-link"
                            href={tab.href}
                            aria-current={active ? "page" : undefined}
                          >
                            <Icon name={tab.icon} />
                            {tab.label}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
                {
                  /*
                  Below 900px the tab row scrolls as one line (assets/app.css),
                  so a deep-linked or reloaded page can load with the active
                  tab scrolled out of view. Inline for the same reason as
                  NO_FLASH above: it has to run before the user notices, and
                  the string is a module-level literal that never touches
                  request data. The selector keeps `="page"`, deliberately: a
                  bare `[aria-current]` also matches Fresh's own client
                  router, which marks the ancestor of the current URL with
                  its own aria-current="true" -- on this page that is the "/"
                  tab, not the active one, and it sits first in the list, so
                  the script would scroll to the wrong tab or none at all.
                  tests/routes_test.tsx's `<a ... aria-current="page">` regex
                  is scoped to real anchor tags for the same reason: it never
                  needs to change no matter how this literal is quoted.
                */
                }
                <script
                  dangerouslySetInnerHTML={{
                    __html:
                      `(function(){var n=document.querySelector('.navbar-nav');var a=n&&n.querySelector('[aria-current="page"]');if(a&&n.scrollWidth>n.clientWidth)a.scrollIntoView({inline:'center',block:'nearest'});})();`,
                  }}
                />

                <div class="navbar-actions">
                  <ThemeToggle />
                  {state?.authenticated && (
                    <form method="post" action={LOGOUT_PATH}>
                      <button type="submit" class="navbar-signout">
                        Sign out
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </header>
          )}

          <main id="main-content" class="page-main" tabIndex={-1}>
            <Component />
          </main>

          <footer class="page-footer">
            <div class="page-footer-inner">
              <span>
                &copy; {year} {INSTITUTE.copyright}. All rights reserved.
              </span>
              <span aria-hidden="true">|</span>
              <a
                href="https://opensource.org/licenses/MIT"
                target="_blank"
                rel="noopener noreferrer"
              >
                MIT License
              </a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
});
