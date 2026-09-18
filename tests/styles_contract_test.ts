import { assert, assertEquals, assertMatch } from "@std/assert";

/**
 * Contract tests for `assets/app.css`.
 *
 * `deno fmt` checks the stylesheet's formatting, but not its semantics. These
 * assertions keep colour going through the token system, keep the two
 * dark-theme blocks in step, and keep the elevation ramp monotonic.
 */

const css = Deno.readTextFileSync(
  new URL("../assets/app.css", import.meta.url),
);
const lines = css.split("\n");

/** The token region runs from the DESIGN TOKENS banner to the BASE banner. */
const tokenStart = lines.findIndex((l) => l.includes("=== DESIGN TOKENS ==="));
const tokenEnd = lines.findIndex((l) => l.includes("=== BASE ==="));
const tokenRegion = lines.slice(tokenStart, tokenEnd).join("\n");
const ruleRegion = lines.slice(tokenEnd);

/** The ten names that are steps on the type scale, in order. */
const TYPE_STEPS = [
  "2xs",
  "xs",
  "sm",
  "base",
  "md",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
] as const;

/**
 * The type-scale steps the token region declares.
 *
 * Filtered against TYPE_STEPS because `--svd-text-muted` and `--svd-text` are
 * tier-3 colour aliases that share the prefix; without the filter a colour
 * token satisfies `font-size` being "on the scale".
 */
function typeScaleSteps(): Set<string> {
  return new Set(
    [...tokenRegion.matchAll(/--svd-text-([\w-]+):/g)]
      .map((m) => m[1])
      .filter((s) => (TYPE_STEPS as readonly string[]).includes(s)),
  );
}

/**
 * Every CSS colour notation, minus the ones that are legal in a rule.
 *
 * `color-mix(` and `var(` must NOT match: the depth recipe under the
 * "=== CARDS & VALUE BOXES ===" banner (app.css:986-996) mixes tints in every
 * surface rule. `\bcolor\(` cannot match "color-mix(" because a hyphen
 * follows, and `\blab\(` cannot match inside "oklab" because the boundary
 * fails after "ok".
 */
const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|:\s*(?:white|black)\b/;

/** Tier 1, read directly by a rule instead of through a tier-2 alias. */
const PALETTE_REFERENCE =
  /var\(--svd-(?:steel|slate|red|amber|green)-\d+|var\(--svd-white\)/;

/**
 * Blanks every `/* … *\/` span's non-newline characters, rather than
 * deleting the span outright, so every later line keeps its original index
 * -- a line-number computed from the result still points at the real line
 * in `assets/app.css`.
 *
 * Every scan in this file that walks the rule region line by line needs
 * this, not the per-line check it replaced: this file's block
 * comments read as flowing prose, so a continuation line -- one that
 * repeats neither `*` nor `/` -- reads as code to a per-line check. Task 19
 * found this the hard way for `declarationsOf` below, where a continuation
 * line ending in a comma (a dozen or so in the rule region -- e.g. the
 * "...scroll regions," line above `.card, .value-box, .readout-stat,
 * .tip-box {`) fell into its `endsWith(",")` branch as though
 * it were a selector fragment, prepending prose onto whatever rule's
 * selector list followed. The same gap let a continuation line that merely
 * *named* a palette token or a colour literal -- to explain why a rule below
 * it is allowed to use one, say -- read as the rule itself: `ruleLeaks`
 * below is the fix for that one, shared with `declarationsOf` rather than
 * reimplemented, so all three scans see the same comment-free input.
 *
 * The blanking regex has no string or `url()` awareness, so a literal `/*`
 * inside a quoted string or a `url(...)` would be misread as a comment
 * start. Assumed safe rather than guarded against: `recipeSelectorList()`'s
 * own comment-stripping carries the same assumption. Worth a proper
 * string-aware scan only if the stylesheet ever needs one; it does not yet.
 * The one piece of that assumption this file does guard is balance --
 * see "the rule and token regions have balanced comment delimiters" below,
 * which is the safety argument for blanking a span wholesale rather than
 * checking each line for a comment marker.
 */
function blankComments(region: string[]): string[] {
  return region.join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .split("\n");
}

/**
 * Lines of `region` (default the real `ruleRegion`) that match `pattern`
 * once comments are blanked -- the shared walk behind the palette-leak and
 * colour-literal assertions below. `region` is the same seam
 * `declarationsOf`'s parameter of the same name gives: every production
 * caller omits it, and a test passes a synthetic array to exercise the
 * comment-blanking rule without touching the committed stylesheet.
 */
function ruleLeaks(
  pattern: RegExp,
  region: string[] = ruleRegion,
): Array<{ line: number; text: string }> {
  return blankComments(region)
    .map((line, i) => ({ line: tokenEnd + i + 1, text: line }))
    .filter(({ text }) => pattern.test(text));
}

/**
 * The shape of a declaration's opening line: an identifier (custom property
 * or not) at the very start of the line, a colon, then whitespace.
 *
 * The whitespace is the whole discriminator, and it is what separates a
 * declaration from a selector that merely contains a colon. A pseudo-class
 * or pseudo-element colon is *never* followed by whitespace -- `a:visited`,
 * `.card:hover`, `summary::-webkit-details-marker` -- while a declaration
 * colon in this sheet always is. That is checked rather than assumed:
 * `^ident:` with no following space occurs on exactly one line of
 * `assets/app.css` (`a:visited {`), and the `endsWith("{")` branch below
 * claims that line before this pattern is ever consulted. The alternative --
 * counting brace and paren depth -- needs a real tokenizer to survive
 * `url()`, quoted strings and `@supports` conditions; this needs one regex.
 *
 * A line that fails this test is not thereby discarded: the walk still tries
 * `propertyPattern` on it, so a hypothetical `padding:0;` written without the
 * space is recorded rather than silently skipped.
 */
/*
 * A declaration's first line. The trailing `(?:\s|$)` is load-bearing:
 * `deno fmt` breaks a long value onto the line after its property, leaving
 * a bare `background-size:` with nothing after the colon, and the original
 * `:\s` never matched that. Anything declared that way was invisible to
 * every check built on `declarationsOf` -- including the two colour-leak
 * scans, which is the part that mattered. `grid-template-columns:` at
 * app.css:883 was already in that shape before the blueprint frame's three
 * multi-line background layers joined it.
 */
const DECLARATION_START = /^(?:--)?[A-Za-z-][\w-]*:(?:\s|$)/;

/**
 * Walks the rule region tracking the selector each declaration belongs to,
 * and returns every declaration of `property`.
 *
 * Skips comments and blank lines, joins a declaration whose value wraps
 * across lines, gathers multi-line selector lists, and associates each
 * declaration with the nearest preceding selector group. This is the walker
 * `every font-size resolves to a step on the type scale` used inline; later
 * assertions (property, colour or otherwise) share it rather than
 * re-implementing the same walk.
 *
 * A trailing `,` is a selector fragment only on a line that is not itself
 * inside a declaration. It used to be treated as one unconditionally, which
 * got multi-line selector lists right and wrapped declaration *values*
 * wrong: a `transition:` or `color-mix(` value that wrapped with a trailing
 * comma was pushed onto `pending` and prepended to the selector of whatever
 * rule came next, mis-attributing 22 selector records in the committed sheet
 * (`.marker-cluster-small div` reached the assertions as
 * `"background-color: color-mix(in oklab, var(--svd-color-accent) 60%,
 * .marker-cluster-small div"`). Every consequence of that happened to be
 * fail-loud -- a polluted selector misses an allowlist or an exact match --
 * but the mirror image is a false green: the continuation line carrying the
 * *rest* of a wrapped value was never matched against `propertyPattern` at
 * all, so a `padding` / `gap` / `border-radius` / `font-size` that ever
 * wrapped would have gone unrecorded, and "every spacing value is on the 4px
 * scale" would have skipped it in silence. None does today; that was luck.
 *
 * So an open declaration is tracked instead: once `DECLARATION_START` matches
 * a line that does not end in `;`, every following line is part of that
 * value until one does, whatever it ends with, and the joined text is what
 * `propertyPattern` sees. An unterminated value is abandoned at the next
 * line starting `}` rather than swallowing the rest of the sheet -- no such
 * declaration exists in `assets/app.css` today, and this keeps one from
 * costing more than itself.
 *
 * `region` defaults to the real `ruleRegion` and every production caller
 * omits it; a test passes a synthetic array to exercise the comment-blanking
 * rule in isolation without touching the committed stylesheet. See
 * `blankComments` for why comments are blanked wholesale before the walk
 * runs rather than recognised line by line during it.
 */
function declarationsOf(
  property: string,
  region: string[] = ruleRegion,
): Array<{ selector: string; value: string; line: number }> {
  const declarations: Array<
    { selector: string; value: string; line: number }
  > = [];
  let pending: string[] = [];
  /** The declaration whose value is still wrapping, if any. */
  let open: { text: string; line: number } | null = null;
  const propertyPattern = new RegExp(`^${property}:\\s*([^;]+);`);
  const uncommented = blankComments(region);

  const record = (text: string, line: number) => {
    const m = text.match(propertyPattern);
    if (!m) return;
    // the nearest preceding selector we recorded
    const selector =
      declarations.filter((d) => d.value === "").pop()?.selector ??
        "";
    declarations.push({ selector, value: m[1].trim(), line });
  };

  uncommented.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    if (open) {
      open.text += " " + line;
      if (line.endsWith(";")) {
        record(open.text, open.line);
        open = null;
      } else if (line.startsWith("}")) {
        open = null;
      }
      return;
    }
    if (line.endsWith("{")) {
      pending.push(line.slice(0, -1).trim());
      pending = pending.filter(Boolean);
      declarations.push({
        selector: pending.join(" "),
        value: "",
        line: tokenEnd + i + 1,
      });
      pending = [];
      return;
    }
    if (DECLARATION_START.test(line)) {
      if (!line.endsWith(";")) {
        open = { text: line, line: tokenEnd + i + 1 };
        return;
      }
    } else if (line.endsWith(",")) {
      pending.push(line);
      return;
    }
    record(line, tokenEnd + i + 1);
  });
  return declarations.filter((d) => d.value !== "");
}

Deno.test("the rule and token regions have balanced comment delimiters", () => {
  // This is the safety argument for `blankComments` above: it walks the
  // regex-matched `/* ... */` spans wholesale rather than recognising a
  // comment line by line, and that is only safe if every `/*` in the region
  // really does have a matching `*/` -- an unbalanced delimiter would blank
  // real declarations (or leave real comment prose live), and the two
  // colour-leak scans built on `blankComments` would keep reporting green
  // while no longer scanning what they claim to. A narrated count in a
  // comment cannot notice that drift; this assertion can, and is what a
  // stray or deleted `/*` or `*/` anywhere in either region actually fails.
  for (
    const [name, region] of [
      ["rule", ruleRegion.join("\n")],
      ["token", tokenRegion],
    ] as const
  ) {
    const opens = region.match(/\/\*/g)?.length ?? 0;
    const closes = region.match(/\*\//g)?.length ?? 0;
    assertEquals(
      opens,
      closes,
      `${name} region: ${opens} "/*" but ${closes} "*/" -- an unbalanced ` +
        `comment delimiter makes blankComments's wholesale span-blanking ` +
        `unsafe`,
    );
  }
});

Deno.test("declarationsOf blanks a comment's prose, not just its self-marked lines", () => {
  // A per-line comment check only recognises a line that itself starts with
  // `*` or `/`. A prose continuation line inside a block comment does neither, so one
  // that happens to end in a comma used to fall into the `endsWith(",")`
  // branch as though it were a pending selector fragment -- the shape of
  // seven real comments in app.css, e.g. the "...scroll regions," line
  // above `.card, .value-box, .readout-stat, .tip-box {`. Reproduce that
  // shape against a synthetic region and confirm the rule that follows the
  // comment keeps its own selector, with no prose prepended.
  const synthetic = [
    "/* A prose sentence that, for no good reason,",
    "   ends this continuation line with a trailing comma,",
    "   before the comment finally closes. */",
    ".probe-selector {",
    "  color: red;",
    "}",
  ];
  const result = declarationsOf("color", synthetic);
  assertEquals(result.length, 1);
  assertEquals(result[0].selector, ".probe-selector");
  assertEquals(result[0].value, "red");
});

Deno.test("ruleLeaks does not mistake a comment naming a colour for the rule it explains", () => {
  // The shape that tripped the real fix: a block comment's continuation
  // lines -- unprefixed prose, this file's own style -- name both a palette
  // token and a hex literal to explain the rule below them, and neither
  // name may itself start with `*` or `/`. A per-line check that only
  // recognised a self-marked comment line used to read both continuation
  // lines as though they were the declaration.
  const synthetic = [
    "/* Explains why this rule may reference a colour, in prose:",
    "   var(--svd-steel-500) and #14172b, neither of which is a real",
    "   declaration. */",
    ".probe-selector {",
    "  color: var(--svd-ink);",
    "}",
  ];
  assertEquals(ruleLeaks(PALETTE_REFERENCE, synthetic), []);
  assertEquals(ruleLeaks(COLOUR_LITERAL, synthetic), []);
});

Deno.test("ruleLeaks still catches a genuine palette reference and colour literal", () => {
  // The fix above must not have widened into "nothing in a rule is ever
  // flagged" -- a real leak, outside any comment, still has to fail.
  assertEquals(
    ruleLeaks(PALETTE_REFERENCE, [
      ".probe-selector {",
      "  color: var(--svd-steel-500);",
      "}",
    ]).length,
    1,
  );
  assertEquals(
    ruleLeaks(COLOUR_LITERAL, [
      ".probe-selector {",
      "  color: #14172b;",
      "}",
    ]).length,
    1,
  );
});

/**
 * True when `value` is a length on the 4px grid (0.25rem steps), or is a key
 * in `allow` -- an escape hatch for a value that is deliberately off-grid.
 */
export function onFourPxGrid(
  value: string,
  allow: Map<string, string>,
): boolean {
  if (allow.has(value)) return true;
  const rem = value.match(/^(-?[\d.]+)rem$/);
  if (rem) {
    const px = Number(rem[1]) * 16;
    return Number.isFinite(px) && Math.abs(px % 4) < 1e-9;
  }
  const px = value.match(/^(-?[\d.]+)px$/);
  if (px) {
    const n = Number(px[1]);
    return Number.isFinite(n) && Math.abs(n % 4) < 1e-9;
  }
  return false;
}

/**
 * The selectors listed at the head of the `=== CARDS & VALUE BOXES ===`
 * section -- the surfaces that opt into the shared depth recipe.
 */
export function recipeSelectorList(): string[] {
  const start = lines.findIndex((l) =>
    l.includes("=== CARDS & VALUE BOXES ===")
  );
  const braceOffset = lines.slice(start).findIndex((l) => l.includes("{"));
  const block = lines.slice(start, start + braceOffset + 1).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return block
    .split(",")
    .map((s) => s.replace(/\{/g, "").trim())
    .filter(Boolean);
}

/**
 * The application source directories that render JSX -- the only places
 * `class="..."` appears. Flat by construction (none of the three nest
 * subdirectories today); revisit if one grows one.
 */
const MARKUP_DIRS = ["routes", "components", "islands"];

/**
 * The text of every `.tsx` file under MARKUP_DIRS, read fresh on each call.
 * The one production caller of `markupClassLists`/`isRecipeModifier` omits
 * its `sources` parameter and gets this; a test passes a synthetic array of
 * fixture strings instead, the same seam `declarationsOf`'s `region`
 * parameter gives the comment-blanking rule.
 */
function readMarkupSources(): string[] {
  const results: string[] = [];
  for (const dir of MARKUP_DIRS) {
    for (
      const entry of Deno.readDirSync(new URL(`../${dir}/`, import.meta.url))
    ) {
      if (!entry.isFile || !entry.name.endsWith(".tsx")) continue;
      results.push(
        Deno.readTextFileSync(
          new URL(`../${dir}/${entry.name}`, import.meta.url),
        ),
      );
    }
  }
  return results;
}

/** A fresh copy each call -- see the two helpers below for why. */
const classAttrPattern = () => /class=["']([^"']*)["']/g;

/**
 * Every `class="..."` (or `class='...'`) attribute value across `sources`
 * that mentions `className` (without its leading dot) as a whole word --
 * one entry per element carrying it, so a class used three times yields
 * three entries, each the element's complete class list.
 */
function markupClassLists(className: string, sources: string[]): string[] {
  const wordBoundary = new RegExp(`\\b${className}\\b`);
  const results: string[] = [];
  for (const text of sources) {
    for (const m of text.matchAll(classAttrPattern())) {
      if (wordBoundary.test(m[1])) results.push(m[1]);
    }
  }
  return results;
}

/**
 * True when `className` appears in `sources` somewhere a literal
 * `class="..."` attribute is not -- a `class={...}` expression, a template
 * literal, a `classNames(...)` call, or even a comment. All three of this
 * app's `class={` idioms already appear in this codebase today
 * (`TableShell.tsx`, `PipelineRun.tsx`, `PipelineSyncs.tsx`), so a class
 * name can be live inside one of them without `markupClassLists` -- a plain
 * `class="..."` regex -- ever seeing it.
 */
function classNameEscapesLiteralAttrs(
  className: string,
  sources: string[],
): boolean {
  const wordBoundary = new RegExp(`\\b${className}\\b`);
  return sources.some((text) =>
    wordBoundary.test(text.replace(classAttrPattern(), ""))
  );
}

/**
 * True when `selector` is used in markup only as a modifier paired with a
 * recipe member -- every JSX element carrying the class also carries one
 * already in `members`, and the class appears in markup at least once (an
 * unused or renamed class returns false rather than passing by vacuous
 * truth). This is the checked version of "it's always applied alongside
 * `.card`": `.pipeline-record-rejected` tints a surface without being a
 * recipe member itself, and is safe only because PipelineRun.tsx writes it
 * as `pipeline-record pipeline-record-rejected` -- a pairing this stays
 * false the moment anything drops, instead of trusting a name list to still
 * be true. (It declares bare `--svd-tint`, which the pattern below excludes,
 * so nothing needs the exemption today; this is what keeps the contract from
 * failing the first time a modifier does re-declare wash or base.)
 *
 * The check is deliberately asymmetric about what it cannot see.
 * `markupClassLists` only reads literal `class="..."` attributes, so a
 * second, genuinely bare use of the same class hidden behind a
 * `class={...}` expression would be invisible to it -- and silently
 * exempting a selector that has such a use would recreate exactly the
 * false-exemption hole a name list already had. So when
 * `classNameEscapesLiteralAttrs` finds the class anywhere this scan cannot
 * interpret, this returns `false` (not exempt) rather than judging only the
 * literals it could read. A false failure here is loud, and cheap for
 * whoever hits it to resolve by hand; a false exemption renders blank and
 * nobody notices.
 */
function isRecipeModifier(
  selector: string,
  members: string[],
  sources: string[] = readMarkupSources(),
): boolean {
  const className = selector.replace(/^\./, "");
  if (classNameEscapesLiteralAttrs(className, sources)) return false;
  const classLists = markupClassLists(className, sources);
  if (classLists.length === 0) return false;
  return classLists.every((list) =>
    list.split(/\s+/).some((c) => c !== className && members.includes(`.${c}`))
  );
}

Deno.test("isRecipeModifier exempts a class only when every use pairs with a recipe member", () => {
  const members = [".card"];

  // The happy path: one literal use, correctly paired -- the shape
  // `.about-hero` actually has in routes/index.tsx today.
  assertEquals(
    isRecipeModifier(".about-hero", members, [
      '<div class="card about-hero">',
    ]),
    true,
  );

  // A bare literal use, with no recipe member alongside it: not exempt.
  // This is the shape `.pipeline-sync` had, and what a plain name-list
  // exemption (COMBINATOR_MODIFIERS, the arrangement this replaced) could
  // never have caught if `.about-hero` had ever been used this way.
  assertEquals(
    isRecipeModifier(".about-hero", members, [
      '<div class="about-hero">',
    ]),
    false,
  );

  // The false-exemption hole: a correctly-paired literal use alongside a
  // second, genuinely bare use hidden behind a class={...} expression --
  // one of this app's real idioms (TableShell.tsx, PipelineRun.tsx,
  // PipelineSyncs.tsx all use class={ for other classes today).
  // `markupClassLists` only reads literal class="..." attributes, so
  // without `classNameEscapesLiteralAttrs` this would see only the paired
  // literal and return true -- exempt, despite the live unpaired use two
  // lines below it. It must refuse to exempt instead.
  assertEquals(
    isRecipeModifier(".about-hero", members, [
      '<div class="card about-hero">',
      '<div class={bare ? "about-hero" : "card about-hero"}>',
    ]),
    false,
  );

  // A class that never appears in markup at all: not exempt, so a renamed
  // or deleted modifier cannot pass by vacuous truth.
  assertEquals(
    isRecipeModifier(".ghost-modifier", members, ['<div class="card">']),
    false,
  );
});

Deno.test("floating panels retain their cap without exceeding the viewport", () => {
  assertMatch(
    css,
    /\.tooltip-pop\s*\{[^}]*max-width: min\(400px, calc\(100vw - 16px\)\);/s,
  );
  assertMatch(
    css,
    /\.timeline-tooltip\s*\{[^}]*max-width: min\(360px, calc\(100vw - 20px\)\);/s,
  );
  // The phenogram's gene tooltip aligned onto the timeline tooltip's gutter
  // (Task 27) rather than the table panel's -- pinned separately so the two
  // figure tooltips can't quietly drift apart again.
  assertMatch(
    css,
    /\.phenogram-canvas \.tooltip-pop \{[^}]*max-width: min\(360px, calc\(100vw - 20px\)\);/s,
  );
  assertMatch(
    css,
    /\.tooltip-pop-scroll\s*\{[^}]*max-height: calc\(100vh - 16px\);[^}]*overflow-y: auto;[^}]*overflow-wrap: anywhere;/s,
  );
  assertMatch(css, /\.tooltip-pop\s*\{[^}]*overflow: visible;/s);
});

Deno.test("only sticky desktop filters receive the stacked-navbar cap", () => {
  // The panel no longer carries a width-specific top/max-height override of
  // its own: --svd-navbar-h itself changes at the stacked-bar breakpoints,
  // so this one declaration already tracks every band.
  assertMatch(
    css,
    /\.sidebar-section \{[^}]*top: var\(--svd-navbar-h\);\s*max-height: calc\(100vh - var\(--svd-navbar-h\) - var\(--svd-space-6\)\);/s,
  );

  // Mobile filters are un-stuck, which is what exempts them from the cap
  // regardless of --svd-navbar-h's value at that width. `relative`, not
  // `static`: with no offsets the two lay out identically, but the panel's
  // registration marks are an absolutely positioned ::after and `static`
  // detaches them onto the initial containing block. What this asserts is
  // that the panel is not sticky here -- see "no rule un-positions a framed
  // surface" for the other half.
  //
  // `overflow-y: visible` belongs to the same reset: the marks sit 6px
  // outside the box, so an uncapped panel that left `overflow-y: auto` on
  // grew a 6px scrollbar it never needed.
  assertMatch(
    css,
    /@media \(max-width: 900px\) \{[\s\S]*?\.sidebar-section \{\s*position: relative;\s*max-height: none;[\s\S]*?overflow-y: visible;\s*(?:\/\*[\s\S]*?\*\/\s*)?top: auto;\s*\}/,
  );

  // --svd-navbar-h changes at three widths: the base value, plus one
  // override each inside @media (max-width: 1410px), @media
  // (max-width: 900px) and @media (max-width: 600px). The 1410/900 split
  // exists because both sticky panels are static by 900px, so only the
  // (width-independent) skip link still reads the token below that width.
  //
  // The four values are pinned literally, not matched by wildcard: each one
  // is the measured worst-case navbar height in its band (92px / 132px /
  // 108px / 100px) rounded up to the next 0.5rem, and a value too small
  // silently re-opens the bug this task fixed -- twice -- with every other
  // assertion here still green.
  assertMatch(css, /--svd-navbar-h: 6\.5rem;/);
  assertMatch(
    css,
    /@media \(max-width: 1410px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?:root \{\s*--svd-navbar-h: 9\.5rem;\s*\}/,
  );
  assertMatch(
    css,
    /@media \(max-width: 900px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?:root \{\s*--svd-navbar-h: 7rem;\s*\}/,
  );
  assertMatch(
    css,
    /@media \(max-width: 600px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?:root \{\s*--svd-navbar-h: 6\.5rem;\s*\}/,
  );
  const overrides = [...css.matchAll(/--svd-navbar-h:\s*([^;]+);/g)].map(
    (m) => m[1].trim(),
  );
  assertEquals(
    overrides.length,
    4,
    `expected 4 --svd-navbar-h declarations (base + three breakpoint overrides), found ${overrides.length}: ${overrides}`,
  );

  // The <=900px override only wins the cascade over the <=1410px one --
  // both are :root rules of equal specificity -- because it comes later in
  // the file. If a tidy-up ever moves it next to the other <=900px block
  // earlier in the file, every assertion above still passes while the
  // sidebar and drawer park ~76px below the bar again.
  const stackedOverrideIdx = css.indexOf("--svd-navbar-h: 9.5rem");
  const narrowStickyOverrideIdx = css.indexOf("--svd-navbar-h: 7rem");
  assert(
    stackedOverrideIdx >= 0 && narrowStickyOverrideIdx > stackedOverrideIdx,
    "the <=900px --svd-navbar-h override must follow the <=1410px one in source order, or it loses the cascade and sticky panels park below the bar",
  );
});

Deno.test("the sticky identity column is keyed on .col-identity, never :first-child", () => {
  // components/TableShell.tsx never renders a covered cell (see its tbody
  // comment), so in a row-merged table (TrialsView) a `:first-child`
  // selector matches whichever column is first *rendered* in a continuation
  // row -- Mechanism of Action, not Drug -- and pins the wrong cell. Every
  // sticky/stripe rule for the table's identity column has to key off the
  // `col-identity` class TableShell adds instead, which a covered row never
  // carries at all.
  assert(
    !/\btd:first-child\b/.test(css) && !/\bth:first-child\b/.test(css),
    "found a bare td:first-child/th:first-child selector -- the identity " +
      "column must be addressed by .col-identity so a merged block's " +
      "covered cells cannot be mistaken for it",
  );

  // The nine sites that used to read td:first-child/th:first-child: the
  // sticky-column block (app.css, "Sticky identity column") and the
  // drug-group-stripe block ("Drug-group striping") between them declare
  // exactly nine td.col-identity/th.col-identity selectors.
  const identitySelectors =
    [...css.matchAll(/\b(?:td|th)\.col-identity\b/g)].length;
  assertEquals(
    identitySelectors,
    9,
    `expected exactly 9 td.col-identity/th.col-identity selectors ` +
      `(sticky column: 5, drug-group stripe: 4); found ${identitySelectors}`,
  );
});

Deno.test("every background on the identity column stays opaque", () => {
  // A selector matching :first-child isn't the only way to mispin the
  // identity column: --svd-bg-row-stripe and --svd-bg-hover-accent both mix
  // into transparent, so applying either directly to .col-identity reads
  // through the scrolled columns underneath it -- exactly what F15 was.
  // --svd-bg-hover-accent slipped past the first fix because the brief's
  // Step 3 named only the base group-odd stripe rule, not the hover rule a
  // few lines below it: on hover the pinned Drug cell measured 90%
  // transparent (alpha 0.1) despite the rest-state fix being correct.
  const TRANSLUCENT_TOKENS = ["--svd-bg-row-stripe", "--svd-bg-hover-accent"];

  const offenders = declarationsOf("background")
    .filter((d) => /\bcol-identity\b/.test(d.selector))
    .filter((d) => TRANSLUCENT_TOKENS.some((token) => d.value.includes(token)));

  assertEquals(
    offenders,
    [],
    offenders
      .map((d) =>
        `${d.selector} (app.css:${d.line}) sets background: ${d.value}, ` +
        `which mixes into transparent -- the identity column must resolve ` +
        `an opaque token (one that mixes into var(--svd-surface))`
      )
      .join("\n"),
  );
});

Deno.test("every surface that declares recipe parameters joins the recipe", () => {
  // A rule that sets --svd-tint-wash or --svd-tint-base is asking for the
  // shared depth recipe: those two custom properties are read back nowhere
  // in the sheet except the recipe rule's own `background` declaration
  // (app.css:989 and :992), so a selector outside recipeSelectorList() that
  // declares either one paints no background, border or shadow -- exactly
  // what F23 found in
  // .pipeline-sync, which re-declared both and had its own comment assert
  // it was "on the same recipe `.pipeline-record` uses".
  //
  // Bare --svd-tint is deliberately excluded from the pattern: unlike wash
  // and base, it is reused throughout the sheet for unrelated local
  // formulas that have nothing to do with the surface recipe (e.g.
  // `.pagination button`'s hover border-color, `.phenogram-pill`'s own
  // border, every `.pipeline-tint-*` chip-ink helper). Matching it too
  // would flag every one of those as a false positive.
  //
  // :root sets the tier-4 defaults every recipe surface inherits, and is
  // excluded for that reason. Every other declarer today is a recipe member
  // outright. A *modifier* -- a class that tints a surface it is always
  // written alongside, the shape `.pipeline-record-rejected` has in
  // PipelineRun.tsx -- is the other way through, and it is checked rather
  // than assumed: `isRecipeModifier` scans the app's JSX and only exempts a
  // selector when every element carrying it also carries a recipe member, so
  // a modifier used bare -- today or after some future edit -- fails here
  // exactly like `.pipeline-sync` did, instead of quietly rendering blank.
  const RECIPE_PARAM = "--svd-tint(?:-wash|-base)";

  const declarers = [
    ...new Set(declarationsOf(RECIPE_PARAM).map((d) => d.selector)),
  ];
  const members = recipeSelectorList();

  const offenders = declarers.filter((s) =>
    s !== ":root" &&
    !members.includes(s) &&
    !isRecipeModifier(s, members)
  );

  assertEquals(
    offenders,
    [],
    offenders
      .map((s) =>
        `${s} declares a depth-recipe parameter but is not in the ` +
        `recipeSelectorList() under the "=== CARDS & VALUE BOXES ===" ` +
        `banner (app.css:962), and is not used in markup ` +
        `exclusively as a modifier paired with a recipe member -- add it ` +
        `beside .pipeline-record, or pair every element carrying it with ` +
        `a class already in the list, or it paints no background, border ` +
        `or shadow`
      )
      .join("\n"),
  );
});

Deno.test("sticky timeline drawers clear either navbar and scroll internally", () => {
  // Same token, same reasoning as .sidebar-section above: no width-specific
  // override needed on the drawer itself any more.
  assertMatch(
    css,
    /\.timeline-drawer\s*\{\s*flex: 0 0 20rem;\s*position: sticky;[^}]*top: var\(--svd-navbar-h\);\s*max-height: calc\(100vh - var\(--svd-navbar-h\) - var\(--svd-space-6\)\);\s*overflow-y: auto;/s,
  );
  // Un-stuck, not un-positioned -- see `.sidebar-section` above. This is the
  // rule that found the distinction: with `static`, at 390px with a record
  // open, the drawer's marks measured 402px against a 390px viewport.
  assertMatch(
    css,
    /@media \(max-width: 1100px\) \{[^}]*\.timeline-drawer \{[^}]*position: relative;\s*max-height: none;\s*overflow-y: visible;\s*(?:\/\*[\s\S]*?\*\/\s*)?top: auto;/s,
  );
});

Deno.test("the table header sticks as one unit, and its scrollport has a height floor", () => {
  // .table-scroll must be bounded, or overflow-x: auto's paired overflow-y:
  // auto has nothing to scroll within -- the sticky thead below would have
  // no scrollport to stick against. The base measure matches .sidebar-section
  // and .timeline-drawer; the 400px floor is a *height* guard, not a width
  // one -- a viewport under ~400px tall (320x320, not any real phone: every
  // one measured from 375x667 up clears the calc alone) is what starves the
  // calc, regardless of viewport width, so gating this by width (as an
  // earlier revision of this rule did) switched the sticky header off across
  // every phone and tablet to dodge a failure only that narrow band of
  // heights produces. 400px is 78px (the tallest thead measured, on either
  // table -- header text never wraps, so this holds at every width) plus 3 *
  // 101px (the taller of the two tables' smallest measured row), rounded up.
  //
  // The `\s*` before var(--svd-space-6) is load-bearing, not slack: `deno fmt`
  // does format CSS, and it wraps this calc after the `-`. Without it the
  // pattern stops matching the file the formatter produces. It tolerates the
  // wrap and nothing else -- every token in the expression is still required.
  assertMatch(
    css,
    /\.table-scroll \{\s*overflow-x: auto;[^}]*max-height: max\(400px, calc\(100vh - var\(--svd-navbar-h\) -\s*var\(--svd-space-6\)\)\);\s*\}/s,
  );

  // Sticky lands on <thead> itself, not on the individual <th>s: /genes
  // renders two header rows (group labels, then leaf headers) in one
  // <thead>, and sticking each th independently to top: 0 would stack row 2
  // on top of row 1 instead of under it. A sticky thead keeps both rows in
  // normal table flow -- row 2 stays directly below row 1 at whatever height
  // row 1 renders -- and moves the pair together. /trials' single-row header
  // is just the one-row case of the same rule. z-index: 2 keeps the whole
  // header above the body's sticky identity column (z-index: 1) at their
  // intersection while scrolling -- thead's own sticky positioning promotes
  // it into the table's stacking order, where z-index: auto would otherwise
  // lose to the column's positive z-index.
  assertMatch(
    css,
    /\.data-table thead \{\s*position: sticky;\s*top: 0;\s*z-index: 2;\s*\}/,
  );

  // .table-scroll must NOT rejoin .sidebar-section's 900px width fallback --
  // that breakpoint exists because the *layout* changes there (the sidebar
  // stacks), which is unrelated to whether a scrollport is tall enough. A
  // width gate here would switch the sticky header off across every real
  // phone to dodge a failure that only occurs under ~400px of viewport
  // height; the floor above is what actually guards that case.
  //
  // Brace-matched rather than a bounded [^}]*: the block itself nests a
  // :root { ... } rule, whose own closing brace would end a [^}]* scan
  // before it ever reached a .table-scroll rule added after it -- exactly
  // the shape a careless regression would take, and exactly what let this
  // assertion pass once already with a [^}]* version while the regression
  // was live.
  const navbarBlockStart = css.indexOf(
    "@media (max-width: 900px) {\n  :root {\n    --svd-navbar-h: 7rem;",
  );
  assert(navbarBlockStart >= 0, "the 900px --svd-navbar-h override moved");
  let depth = 0;
  let i = navbarBlockStart;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const navbarBlock = css.slice(navbarBlockStart, i + 1);
  assert(
    !navbarBlock.includes(".table-scroll"),
    ".table-scroll must not read a width-gated override -- its floor (above) " +
      "is a height guard and belongs in the rule itself, not behind a " +
      "breakpoint tied to the sidebar's layout change",
  );
});

Deno.test("every --svd- token referenced is also declared", () => {
  const declared = new Set(
    [...css.matchAll(/^\s*(--svd-[a-z0-9-]+):/gm)].map((m) => m[1]),
  );
  const undeclared = [
    ...new Set([...css.matchAll(/var\((--svd-[a-z0-9-]+)/g)].map((m) => m[1])),
  ].filter((t) => !declared.has(t));

  assertEquals(undeclared, [], `undeclared tokens referenced: ${undeclared}`);
});

Deno.test("every declared --svd- token is used", () => {
  const declared = new Set(
    [...css.matchAll(/^\s*(--svd-[a-z0-9-]+):/gm)].map((m) => m[1]),
  );
  const referenced = new Set(
    [...css.matchAll(/var\((--svd-[a-z0-9-]+)/g)].map((m) => m[1]),
  );

  // Leaflet circle-marker options are JavaScript values, so these two tokens
  // are read through getComputedStyle rather than var() in the stylesheet.
  referenced.add("--svd-map-marker-stroke");
  referenced.add("--svd-map-marker-fill");

  const unused = [...declared].filter((token) => !referenced.has(token)).sort();
  assertEquals(unused, [], `unused tokens declared: ${unused}`);
});

Deno.test("palette tokens are never referenced outside the token region", () => {
  // Tier 1 is raw material. Rules must go through a tier-2 semantic alias so
  // that the dark-theme blocks can swap them.
  const leaks = ruleLeaks(PALETTE_REFERENCE);

  assertEquals(
    leaks.map(({ line, text }) => `${line}: ${text.trim()}`),
    [],
    "palette tokens must not be used directly by a rule",
  );
});

Deno.test("no raw oklch value appears outside the palette ramps", () => {
  // Tier 1 is where ramps live (app.css:16-17). A raw oklch in tier 2 is a
  // palette step that skipped the ramp, and the two dark blocks must stay
  // byte-identical, so every one of them is maintained twice.
  const rampNames = /^--svd-(?:steel|slate|red|amber|green)-\d+:/;
  const leaks = tokenRegion
    .split("\n")
    .map((line, i) => [tokenStart + i + 1, line.trim()] as const)
    .filter(([, l]) =>
      /^--svd-[\w-]+:\s*oklch\(/.test(l) && !rampNames.test(l)
    );
  assertEquals(leaks.map(([n, l]) => `${n}: ${l}`), []);
});

Deno.test("every palette ramp is monotonic in lightness", () => {
  // A ramp's number is its position on the lightness axis: rising `n` must
  // mean falling `L`. Task 8's first pass named two steps by their numeric
  // gap without checking that, and got indigo-300/450 swapped and
  // teal-600 darker than teal-800.
  const step = /^--svd-(steel|slate|red|amber|green)-(\d+):\s*oklch\(([\d.]+)/;
  const steps = tokenRegion
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l.match(step))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, ramp, n, lightness]) => ({
      ramp,
      n: Number(n),
      lightness: Number(lightness),
    }));

  const byRamp = new Map<string, { n: number; lightness: number }[]>();
  for (const s of steps) {
    const list = byRamp.get(s.ramp) ?? [];
    list.push(s);
    byRamp.set(s.ramp, list);
  }

  const violations: string[] = [];
  for (const [ramp, list] of byRamp) {
    const sorted = [...list].sort((a, b) => a.n - b.n);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr.lightness >= prev.lightness) {
        violations.push(
          `${ramp}: -${prev.n} (L ${prev.lightness}) is not lighter than ` +
            `-${curr.n} (L ${curr.lightness})`,
        );
      }
    }
  }

  assertEquals(violations, []);
});

Deno.test("status swatches are ramp steps, not hex", () => {
  // The trial-status family was the one colour group still maintained as
  // hand-picked hex, in three duplicated blocks (45 declarations, 36 of them
  // hex -- the `unknown` trio's transparent/var() pair in each block already
  // passes). Every hex declaration must become a var() onto a palette ramp.
  const hex = tokenRegion
    .split("\n")
    .map((line, i) => [tokenStart + i + 1, line.trim()] as const)
    .filter(([, l]) => /^--svd-status-[\w-]+:\s*#/.test(l));
  assertEquals(hex.map(([n, l]) => `${n}: ${l}`), []);
});

Deno.test("no colour literal appears outside the token region", () => {
  const leaks = ruleLeaks(COLOUR_LITERAL);

  assertEquals(
    leaks.map(({ line, text }) => `${line}: ${text.trim()}`),
    [],
    "colours must be declared as tokens, not inlined into rules",
  );
});

Deno.test("the two dark-theme blocks declare exactly the same values", () => {
  // Dark mode is declared twice — once under prefers-color-scheme for the
  // default, once under [data-theme='dark'] for the toggle. `light-dark()`
  // needs Firefox 120 and the build targets 114, so the duplication is
  // unavoidable; this keeps the copies from drifting.
  //
  // Every non-blank line is compared, not just the ones that *start* with
  // `--svd-`: --svd-tile-filter's value wraps onto a second line
  // (`contrast(0.9) saturate(0.85);`), which begins with neither the prefix
  // nor anything else recognisable, so a prefix filter dropped that
  // continuation from BOTH sides before comparing them. A mutation applied
  // to one copy's continuation alone -- the toggle and the system default
  // filtering the map tiles differently -- reported green. Blank lines trim
  // to "" and `Boolean` is what removes them.
  const blocks = [...css.matchAll(/color-scheme:\s*dark;([\s\S]*?)\n\s*\}/g)]
    .map((m) =>
      m[1].split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n")
    );

  assertEquals(blocks.length, 2, "expected exactly two dark-theme blocks");
  assert(blocks[0].length > 0, "dark blocks declared no tokens");
  assertEquals(
    blocks[0],
    blocks[1],
    "the dark-theme blocks have drifted apart",
  );
});

Deno.test("shadow tokens form a monotonic ramp in both themes", () => {
  // --svd-shadow-md used to be tighter than --svd-shadow-sm while being the
  // hover state on cards, so hovering visibly shrank them. Order by the
  // largest blur radius each token declares.
  const order = ["xs", "sm", "md", "lg"];

  for (
    const [theme, region] of [
      ["light", tokenRegion.split("=== DARK THEME ===")[0]],
      ["dark", tokenRegion.split("=== DARK THEME ===")[1] ?? ""],
    ] as const
  ) {
    const blurs = order.map((step) => {
      const m = region.match(
        new RegExp(`--svd-shadow-${step}:\\s*([^;]+);`),
      );
      assert(m, `${theme}: --svd-shadow-${step} is not declared`);
      const radii = [...m[1].matchAll(/(-?\d+(?:\.\d+)?)px/g)]
        .map((x) => Math.abs(Number(x[1])));
      return radii.length ? Math.max(...radii) : 0;
    });

    for (let i = 1; i < blurs.length; i++) {
      assert(
        blurs[i] > blurs[i - 1],
        `${theme}: --svd-shadow-${order[i]} (${blurs[i]}px) is not larger ` +
          `than --svd-shadow-${order[i - 1]} (${blurs[i - 1]}px)`,
      );
    }
  }
});

Deno.test("no rule un-positions a framed surface", () => {
  // The marks are an absolutely positioned ::after at a negative inset, so
  // they resolve against the nearest *positioned* ancestor. A framed surface
  // reset to `position: static` hands its marks to the initial containing
  // block instead: at 390px with a trial record open, `.timeline-drawer`'s
  // marks measured 402px against a 390px viewport and the document grew a
  // horizontal scrollbar. `position: relative` with no offsets is what those
  // rules actually meant -- "not sticky" -- and keeps the containing block.
  const members = new Set(recipeSelectorList());
  const offenders = declarationsOf("position")
    .filter(({ selector, value }) =>
      value === "static" &&
      selector.split(",").some((s) => members.has(s.trim()))
    )
    .map((d) => `${d.line}: ${d.selector}`);

  assertEquals(
    offenders,
    [],
    "a framed surface is reset to position: static, which detaches its " +
      "registration marks from it -- use position: relative instead",
  );
});

Deno.test("the registration marks are drawn from the mark tokens", () => {
  // The blueprint frame replaced the aurora recipe, and its four "+" corner
  // crosses are eight background layers on one ::after overlay rather than
  // four <i class="corner"> children per surface. That is only safe while
  // the geometry stays in one place: --svd-mark-len is the arm, --svd-mark-out
  // how far the overlay sits outside the box, and --svd-mark-arm the offset
  // that puts each cross centre exactly on the panel's corner. A rule that
  // hard-codes one of those numbers has forked the geometry the way ten
  // hand-tuned halo copies once did -- which is the bug the test this
  // replaced was written for.
  const layers = [
    ...declarationsOf("background-size"),
    ...declarationsOf("background-position"),
  ].filter(({ selector }) => selector.includes("::after"));
  assert(
    layers.length > 0,
    "no registration-mark background layers found -- has the overlay rule " +
      "been renamed?",
  );

  // 1px is the arm's thickness and is legitimately a literal: it is one
  // device pixel, not a scale value. 11px, 6px and 5px are the three tokens.
  const forked = layers.filter(({ value }) => /\b(?:11|6|5)px\b/.test(value));
  assertEquals(
    forked.map((d) => `${d.line}: ${d.selector}`),
    [],
    "a mark layer hard-codes geometry instead of reading --svd-mark-*",
  );

  // Every surface in the recipe must draw the marks: the design system's
  // one "don't" about the frame is "do not drop the registration marks from
  // a framed element".
  const framed = recipeSelectorList();
  const marked = new Set(
    layers.flatMap(({ selector }) =>
      selector.split(",").map((s) => s.trim().replace("::after", ""))
    ),
  );
  const bare = framed.filter((s) => !marked.has(s));
  assertEquals(
    bare,
    [],
    "these surfaces wear the frame but not its corner marks",
  );
});

/** Every declaration of `line-height`. */
function leadingDeclarations(): Array<
  { selector: string; value: string; line: number }
> {
  return declarationsOf("line-height");
}

/** Every declaration of `letter-spacing`. */
function trackingDeclarations(): Array<
  { selector: string; value: string; line: number }
> {
  return declarationsOf("letter-spacing");
}

/** Every declaration of `font-weight`. */
function weightDeclarations(): Array<
  { selector: string; value: string; line: number }
> {
  return declarationsOf("font-weight");
}

Deno.test("every line-height is on the leading scale", () => {
  // `line-height: 1` stays exempt: it is the "no leading" case on the
  // drawer-close button's single glyph (.timeline-drawer-close,
  // .pipeline-drawer-close), not a step.
  const off = leadingDeclarations().filter(({ value }) =>
    !/var\(--svd-leading-/.test(value) && value.trim() !== "1" &&
    value.trim() !== "inherit"
  );
  assertEquals(off.map((d) => `${d.line}: ${d.selector} { ${d.value} }`), []);
});

Deno.test("every letter-spacing is on the tracking scale", () => {
  const off = trackingDeclarations().filter(({ value }) =>
    !/var\(--svd-tracking-/.test(value) && value.trim() !== "normal"
  );
  assertEquals(off.map((d) => `${d.line}: ${d.selector} { ${d.value} }`), []);
});

Deno.test("every font-weight comes from the weight scale", () => {
  const off = weightDeclarations().filter(({ value }) =>
    !/var\(--svd-weight-/.test(value) && value.trim() !== "inherit"
  );
  assertEquals(off.map((d) => `${d.line}: ${d.selector} { ${d.value} }`), []);
});

Deno.test("no font-weight is used that the shipped font cannot render", () => {
  // Raleway shipped at 400 and 700 only while the stylesheet asked for 500
  // and 600, so the browser synthesized them and the two were visually
  // indistinguishable. The variable face covers 100-700, closing the gap.
  // This must stay empty.
  // A variable face declares a range ("font-weight: 100 700"); a static one
  // declares a single value. Both have to count as covered.
  const covered: Array<[number, number]> = [
    ...tokenRegion.matchAll(/@font-face\s*\{[^}]*\}/g),
  ].flatMap((face) => {
    const m = face[0].match(/font-weight:\s*(\d+)(?:\s+(\d+))?/);
    if (!m) return [];
    return [[Number(m[1]), Number(m[2] ?? m[1])] as [number, number]];
  });

  const used = new Set(
    [...ruleRegion.join("\n").matchAll(/font-weight:\s*(\d+)/g)]
      .map((m) => Number(m[1])),
  );
  const synthesized = [...used]
    .filter((w) => !covered.some(([lo, hi]) => w >= lo && w <= hi))
    .sort((a, b) => a - b);

  assert(covered.length > 0, "no @font-face declares a weight");

  assertEquals(
    synthesized,
    [],
    "a font-weight is being used that no @font-face declares",
  );
});

Deno.test("every font-size resolves to a step on the type scale", () => {
  // Before this guard, five sizes were doing one job across the table and
  // filter areas -- 13.6px, 14.08px, 14.4px, 14.72px and 14px -- and
  // .card-title sat 1.6px off .sidebar-title while filling the same role.
  // `deno fmt` cannot see any of that, and neither could the other cases
  // here, which only ever policed colour, weight and the elevation ramp.
  // Two rules independently wanted 12px (.filter-count and .popup-status);
  // both map to --svd-text-2xs rather than earning a new step, because
  // 11/12/13/14 would be four steps inside 3px -- noise, not a scale.
  const declared = typeScaleSteps();
  assert(declared.size > 0, "the token region declares no type scale");

  /**
   * The rules where `font-size` is not type.
   *
   * `components/Icon.tsx` renders every glyph at width/height 1em, so a rule
   * that sets font-size on an icon -- or on the badge wrapping one -- is
   * setting geometry, and pinning it to a *type* token would assert it is
   * text. The 9px rule is a figure tick label, which sits below
   * --svd-text-2xs deliberately, since the scale's floor is a reading size.
   */
  const notType = new Map<string, string>([
    [".about-kpi-badge", "sizes the Icon inside the badge (1em)"],
    [".about-row > .icon", "icon geometry"],
    [".about-source-head > .icon", "icon geometry"],
    [".readout-bar-label", "figure tick label, below the scale floor"],
  ]);

  const sizes = declarationsOf("font-size");
  assert(sizes.length > 20, "found no font-size declarations to check");

  const onScale = (value: string): boolean => {
    if (value === "inherit") return true;
    if (value.startsWith("clamp(")) {
      // a fluid step is fine as long as both ends are scale tokens and no
      // bare length sneaks into the middle
      const refs = [...value.matchAll(/var\(--svd-text-([\w-]+)\)/g)].map((m) =>
        m[1]
      );
      const bare = value.replace(/var\(--svd-text-[\w-]+\)/g, "");
      return refs.length >= 2 && refs.every((r) => declared.has(r)) &&
        !/[\d.]\s*(rem|px)\b/.test(bare);
    }
    const m = value.match(/^var\(--svd-text-([\w-]+)\)$/);
    return m !== null && declared.has(m[1]);
  };

  const offenders = sizes
    .filter((d) => !notType.has(d.selector) && !onScale(d.value))
    .map((d) => `  app.css:${d.line}  ${d.selector} { font-size: ${d.value} }`);

  assertEquals(
    offenders,
    [],
    "these font-size values are not on the type scale declared in the token " +
      "region. Map each to its nearest --svd-text-* step, or, if the rule is " +
      "sizing an icon (1em) rather than text, add it to `notType` with the " +
      "reason:\n" + offenders.join("\n"),
  );

  // The allowlist must not outlive the rules it excuses.
  const seen = new Set(sizes.map((d) => d.selector));
  const stale = [...notType.keys()].filter((s) => !seen.has(s));
  assertEquals(
    stale,
    [],
    `these \`notType\` entries no longer match a font-size rule: ${
      stale.join(", ")
    }`,
  );
});

Deno.test("the type scale's declared set excludes colour aliases", () => {
  // --svd-text-muted is a tier-3 colour alias, declared in the LEGACY ALIASES
  // block (app.css:412). The old pattern /--svd-text-([\w-]+):/g matched it,
  // so `font-size: var(--svd-text-muted)` satisfied the on-scale assertion.
  assertEquals(
    typeScaleSteps().has("muted"),
    false,
    "--svd-text-muted is a colour alias, not a step on the type scale",
  );
});

/**
 * Every `padding`/`margin` longhand direction, alongside the two shorthands
 * and `gap`/`row-gap`/`column-gap`. This is what the sweep's "266
 * declarations" counted -- `padding-top`, `margin-inline-start` and friends
 * carry as many raw literals as the shorthands do, and the mapping table in
 * the brief covers them the same way.
 */
const SPACING_DIRECTIONS = [
  "top",
  "right",
  "bottom",
  "left",
  "inline",
  "inline-start",
  "inline-end",
  "block",
  "block-start",
  "block-end",
] as const;

const SPACING_PROPERTIES = [
  "padding",
  "margin",
  "gap",
  "row-gap",
  "column-gap",
  ...SPACING_DIRECTIONS.map((d) => `padding-${d}`),
  ...SPACING_DIRECTIONS.map((d) => `margin-${d}`),
];

/** Every declaration of a spacing property, across the whole family above. */
function spacingDeclarations(): Array<
  { selector: string; value: string; line: number }
> {
  return SPACING_PROPERTIES.flatMap((property) => declarationsOf(property));
}

/**
 * Spacing values deliberately kept off the 4px scale, with the reason each
 * one is geometry rather than rhythm. Consumed only by the assertion below.
 */
const SPACING_ALLOWLIST = new Map<string, string>([
  [
    "1px",
    "the 0.1rem (1.6px) chip padding rounds here, not to a token step -- " +
    ".filter-count, .about-chip, .tooltip-box, .timeline-drawer-tag, " +
    ".phenogram-pill",
  ],
  [
    "2px",
    "the 0.15rem (2.4px) hairline rounds here, not to a token step -- " +
    "the density-readout bar gaps (`.readout-bars` and `.readout-bar`, " +
    "app.css:1418, 1430) and " +
    ".pipeline-method, .about-row, .pipeline-note-subjects, .pipeline-stat",
  ],
  ["-1px", "the visually-hidden clip trick's negative offset, not rhythm"],
  ["0.25em", "font-relative, not rhythm (.timeline-legend-dot)"],
  ["0.06em", "font-relative, not rhythm (.timeline-tooltip-row .icon)"],
]);

Deno.test("every spacing value is on the 4px scale", () => {
  // Design spec §11.2. It could not be written until the scale reached 48px:
  // 116 of 266 declarations were raw largely because nothing above 24px existed.
  //
  // Sub-grid values are real: a 1px hairline nudge and the 2px gap between the
  // density-readout bars are geometry, not rhythm. They are allowlisted with a
  // reason, the way case 11's `notType` map already works, and the allowlist is
  // asserted to be live so it cannot outlive the rules it excuses.
  const declarations = spacingDeclarations();
  const offScale = declarations.filter(({ value }) =>
    !/var\(--svd-space-/.test(value) && !/^0$|^auto$/.test(value.trim()) &&
    !onFourPxGrid(value, SPACING_ALLOWLIST)
  );
  assertEquals(
    offScale.map((d) => `${d.line}: ${d.selector} { ${d.value} }`),
    [],
  );

  // The allowlist must not outlive the rules it excuses. Checked word by
  // word, not against the whole declaration value: an allowlisted length can
  // sit inside an otherwise-tokenized shorthand ("1px var(--svd-space-2)"),
  // where it never equals a declaration's full value but is still live.
  const seenTokens = new Set(
    declarations.flatMap((d) => d.value.split(/\s+/)),
  );
  const stale = [...SPACING_ALLOWLIST.keys()].filter((v) => !seenTokens.has(v));
  assertEquals(
    stale,
    [],
    `these SPACING_ALLOWLIST entries no longer match a spacing declaration: ${
      stale.join(", ")
    }`,
  );
});

/** Every declaration of `border-radius`. */
function radiusDeclarations(): Array<
  { selector: string; value: string; line: number }
> {
  return declarationsOf("border-radius");
}

Deno.test("every border-radius is on the radius scale", () => {
  // The sweep found 49 border-radius declarations, 34 on a --svd-radius-*
  // token and 15 raw -- and every one of the 15 was 999px or 50%, the
  // pill/circle step the scale was specified with and never got. `inherit`
  // is legitimate: .pipeline-drawer deliberately takes its card's radius.
  const offScale = radiusDeclarations().filter(({ value }) =>
    !/var\(--svd-radius-/.test(value) && value.trim() !== "inherit"
  );
  assertEquals(offScale.map((d) => `${d.line}: ${d.selector}`), []);
});

/**
 * The breakpoints this stylesheet is allowed to use.
 *
 * Each is a real layout change, and the derived ones carry their derivation
 * in a comment beside the query, which must stay there: the timeline's
 * 1300px was 41px below its own derived value and produced a band where the
 * radar shrank and gained a scrollbar it did not have at 1300.
 *
 * 1453 and 1482 are gone. Both were the width at which a 1072px or 1100px
 * plate stopped fitting beside an 18rem key, and both figures put their key
 * below the plate at every width now, so neither has a rail to fall out of.
 */
const BREAKPOINTS = new Set([480, 600, 900, 1100, 1410]);

Deno.test("every breakpoint is on the documented set", () => {
  const used = [...css.matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)]
    .map((m) => Number(m[1]));
  const undocumented = [...new Set(used)].filter((n) => !BREAKPOINTS.has(n));
  assertEquals(
    undocumented,
    [],
    `breakpoints not in the documented set: ${undocumented.join(", ")}`,
  );
});

Deno.test("the colour-literal pattern catches every colour notation", () => {
  for (
    const s of [
      "color: oklch(0.5 0.1 270)",
      "background: hsl(200 50% 50%)",
      "fill: lab(50% 20 30)",
      "color: #abc",
      "background: rgb(1 2 3)",
    ]
  ) assert(COLOUR_LITERAL.test(s), `${s} must be caught`);

  for (
    const s of [
      "background: color-mix(in oklab, var(--svd-tint) 20%, transparent)",
      "color: var(--svd-ink)",
    ]
  ) {
    assertEquals(COLOUR_LITERAL.test(s), false, `${s} must be allowed`);
  }
});

/**
 * F19's six mono/tabular-nums identifier columns (gene symbols, a
 * cytogenetic band, a registry ID, a sample-size count, a date, a trial
 * phase). Restated here rather than derived, the same way BREAKPOINTS is: a
 * change to this list is a deliberate edit to the test, not something the
 * test should infer from the stylesheet it is checking.
 */
const F19_MONO_COLUMNS = [
  "gene",
  "chromosomalLocation",
  "registryId",
  "targetSampleSize",
  "estimatedCompletionDate",
  "clinicalTrialPhase",
];

Deno.test("F19's mono rule stays scoped to data cells, not headers", () => {
  // Task 13 puts col-<columnId> on both the leaf <th> and its <td>. An
  // earlier revision's `.data-table .col-<id>` descendant selector matched
  // both, so two of /genes' twelve header labels rendered in IBM Plex Mono
  // while the other ten stayed sans -- caught by eye during review, not by
  // any gate. `td`-qualifying the selector (fix round 2) is what makes F19
  // apply to data cells only; this pins that it stays that way.
  for (const column of F19_MONO_COLUMNS) {
    assert(
      css.includes(`.data-table td.col-${column}`),
      `.data-table td.col-${column} must be declared -- F19's mono rule for this column is missing`,
    );
    assert(
      !css.includes(`.data-table .col-${column}`),
      `.col-${column} must not appear as an unqualified .data-table descendant ` +
        `selector -- that also matches the <th> that shares the class, and puts a header label in mono`,
    );
  }
});

Deno.test("F24's collapsed endpoint disclosure reports as hidden, not just as small", () => {
  // A closed `<details>` keeps its body out of page layout no matter what
  // the body's own `display` says -- `.pipeline-apis ul` ("Steps") sets
  // `display: flex` unconditionally, for the run widget's
  // `<section class="pipeline-apis">`, which is never closed, and that costs
  // PipelineSyncs' `<details>` no page height even without this rule. But
  // the size containment that gives it that free pass is invisible from
  // CSS: without this override, each closed row still measures its normal,
  // non-zero `getBoundingClientRect()` -- confirmed against a build with
  // this rule removed -- rather than the 0x0 a plain `display: none`
  // produces. The contrast probe's clipped-content check walks an
  // element's ancestors testing exactly that box, with no separate case for
  // a collapsed disclosure, so an unhidden `<ul>` here is text the reader
  // cannot see but the probe can still measure.
  const collapse = declarationsOf("display").find((d) =>
    /^details\.pipeline-apis:not\(\[open\]\)\s*>\s*ul$/.test(d.selector)
  );
  assert(
    collapse !== undefined && collapse.value === "none",
    "expected `details.pipeline-apis:not([open]) > ul { display: none; }` " +
      "so a closed disclosure's rows measure 0x0 -- without it the contrast " +
      "probe's clipped-content check cannot tell them from visible text",
  );
});

Deno.test("F25's funnel figures match the totals row, family and weight", () => {
  // .pipeline-stat-value (the ten funnel numbers) and .value-box-value (the
  // totals row a few hundred pixels above them) are the same idea told
  // twice on one page; before this they read two different ways -- one
  // mono at --svd-weight-bold, the other plain body ink at
  // --svd-weight-bold with no font-family at all. `.about-kpi-value` is
  // the page's third headline figure and is the reference both were brought
  // into line with.
  //
  // This asserts they AGREE, rather than naming the family they agree on.
  // The family has moved once already -- IBM Plex Mono to Barlow Condensed,
  // when the Industry import retired the mono face and the seven
  // tabular-numeral sites went to the condensed face with tabular-nums --
  // and pinning the literal made this test fail for a change that kept the
  // invariant perfectly. What must not drift is the three reading alike.
  const families = declarationsOf("font-family");
  const weights = declarationsOf("font-weight");

  const familyOf = (selector: string) =>
    families.find((d) => d.selector.includes(selector))?.value;
  const weightOf = (selector: string) =>
    weights.find((d) => d.selector === selector)?.value;

  const reference = familyOf(".about-kpi-value");
  assert(
    reference !== undefined,
    ".about-kpi-value must declare a font-family -- it is the reference the " +
      "other two headline figures are held to",
  );

  for (
    const selector of [
      ".pipeline-stat-value",
      ".value-box-value",
      ".about-kpi-value",
    ]
  ) {
    assertEquals(
      familyOf(selector),
      reference,
      `${selector} must resolve to the same family as .about-kpi-value`,
    );
    assertEquals(
      weightOf(selector),
      "var(--svd-weight-medium)",
      `${selector} must sit at --svd-weight-medium`,
    );
  }
});

Deno.test("the About notice is not a framed surface", () => {
  // The warning used to be `.card` + `.warning-card`, which inherited the
  // recipe's registration marks. A notice is not a panel: it carries the
  // danger tint and a left stripe, and nothing else from the recipe.
  const members = recipeSelectorList();
  assert(!members.includes(".notice"), ".notice must not join the recipe");
  assert(!css.includes(".warning-card"), ".warning-card is gone");
  const notice = css.match(/\.notice\s*\{([^}]*)\}/)?.[1] ?? "";
  assert(notice !== "", "no bare `.notice` rule found");
  // Every read of the colour carries the danger fallback, so a `.notice`
  // with no modifier still draws its stripe and its wash rather than
  // resolving the border to currentColor and the color-mix to nothing.
  const reads = notice.match(/var\(--svd-notice-color[^)]*\)/g) ?? [];
  assertEquals(reads.length, 2, `two reads of the colour: ${notice}`);
  assert(
    reads.every((read) =>
      read === "var(--svd-notice-color, var(--svd-color-danger)"
    ),
    `each read needs the danger fallback: ${reads.join(" ")}`,
  );
  assert(
    /border-left:\s*4px solid var\(--svd-notice-color,/.test(notice),
    `the stripe reads the colour: ${notice}`,
  );
  // And the modifier is what names it, so the two cannot drift apart.
  const warning = css.match(/\.notice-warning\s*\{([^}]*)\}/)?.[1] ?? "";
  assertMatch(warning, /--svd-notice-color:\s*var\(--svd-color-danger\);/);
  assert(!/--svd-tint/.test(notice), "the notice reads no recipe parameter");
  assert(!/\.notice(?:-warning)?::after/.test(css), "no corner marks");
});

Deno.test("F16's drawer trigger reads as a button at rest and lifts on hover and focus-visible", () => {
  // It used to rest as a bare link -- no border, no fill -- which read as
  // text. It now wears the drawer-close treatment at rest (a visible
  // border on the light fill) and takes the accent fill and ring on
  // :hover and :focus-visible together, so a keyboard user sees the same
  // engaged state a pointer does.
  const restBlock = ruleRegion.join("\n").match(
    /\.pipeline-drawer-trigger\s*\{([^}]*)\}/,
  )?.[1] ?? "";
  assert(restBlock !== "", "no bare `.pipeline-drawer-trigger` rule found");
  assert(
    /border:\s*1px solid var\(--svd-border\);/.test(restBlock),
    `rest state must draw its border: ${restBlock}`,
  );
  assert(
    /background:\s*var\(--svd-bg-light\);/.test(restBlock),
    `rest state must have the light fill: ${restBlock}`,
  );
  assert(
    !restBlock.includes("--svd-ring-accent") &&
      !restBlock.includes("--svd-bg-hover-accent"),
    `rest state must not wear the hover tokens: ${restBlock}`,
  );

  const engagedFill = declarationsOf("background").find((d) =>
    d.selector.includes(".pipeline-drawer-trigger:hover") &&
    d.selector.includes(".pipeline-drawer-trigger:focus-visible")
  );
  assert(
    engagedFill !== undefined,
    "no rule pairs :hover with :focus-visible on the trigger",
  );
  assertEquals(engagedFill?.value, "var(--svd-bg-hover-accent)");

  const engagedRing = declarationsOf("border-color").find((d) =>
    d.selector === engagedFill?.selector
  );
  assertEquals(engagedRing?.value, "var(--svd-ring-accent)");
});

Deno.test("F26's title row lays the trigger out beside the heading, not below it, once there is room", () => {
  // Paired with "the drawer trigger sits on the title row..." in
  // pipeline_widget_test.tsx, which checks the markup actually nests both
  // elements in `.pipeline-title-row`. This is the CSS half: the row must
  // be a flex row with the heading and the trigger pulled to opposite
  // ends, and it must be allowed to wrap -- 390px does not have room for
  // both the heading and "View everything this run recorded" on one line
  // (the brief measured the title ink ending around x=180 of 390), so the
  // trigger has to be free to drop to its own line there rather than the
  // row overflowing or the label being rewritten.
  const restBlock = ruleRegion.join("\n").match(
    /\.pipeline-title-row\s*\{([^}]*)\}/,
  )?.[1] ?? "";
  assert(restBlock !== "", "no bare `.pipeline-title-row` rule found");
  assert(
    /display:\s*flex;/.test(restBlock),
    `.pipeline-title-row must be a flex row: ${restBlock}`,
  );
  assert(
    /justify-content:\s*space-between;/.test(restBlock),
    `.pipeline-title-row must pull its children to opposite ends: ${restBlock}`,
  );
  assert(
    /flex-wrap:\s*wrap;/.test(restBlock),
    `.pipeline-title-row must allow the trigger to wrap below the heading: ${restBlock}`,
  );
});

/**
 * The full text of the `@media` block that contains `marker` -- found by
 * walking forward from `marker` and matching braces, rather than by line
 * range, since two other `@media (max-width: 600px)` blocks exist elsewhere
 * in the file and a naive string search for the query text alone would not
 * say which one a given declaration landed in.
 */
function mediaBlockContaining(marker: string): string {
  const text = ruleRegion.join("\n");
  const markerIndex = text.indexOf(marker);
  assert(markerIndex > -1, `marker not found in the rule region: ${marker}`);
  const mediaIndex = text.lastIndexOf("@media", markerIndex);
  assert(mediaIndex > -1, `no @media precedes the marker: ${marker}`);
  const openBrace = text.indexOf("{", mediaIndex);
  let depth = 0;
  let i = openBrace;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return text.slice(mediaIndex, i + 1);
}

Deno.test("F27's source-detail row wraps below 600px the same way the api-detail row does", () => {
  // .pipeline-source-detail carried `margin-left: auto` with no override,
  // which is what right-aligned its count onto an orphaned second line once
  // the row could no longer fit both columns. `.pipeline-api-detail` is the
  // identically-built row type that already had the fix; the two must wrap
  // the same way, in the same breakpoint -- not just somewhere, which is
  // why this reads the actual `@media` block rather than searching the
  // whole file for the property names.
  // The joined selector pair, not the bare class name: `.pipeline-step-head`
  // and `.pipeline-step-glyph` each have a *base* rule elsewhere in the
  // file too, so a marker that matches either of those finds the wrong
  // (earlier) `@media (max-width: 600px)` block -- this exact two-line
  // selector list exists nowhere but inside the block this test means to
  // read.
  const block = mediaBlockContaining(
    ".pipeline-step-glyph,\n  .pipeline-step-time {",
  );
  assert(
    /\.pipeline-api-detail,\s*\.pipeline-source-detail\s*\{\s*margin-left:\s*0;\s*width:\s*100%;\s*\}/
      .test(block),
    `expected \`.pipeline-api-detail,\\n  .pipeline-source-detail { ` +
      `margin-left: 0; width: 100%; }\` inside the 600px block: ${block}`,
  );
});

Deno.test("every control that lights on hover lights on focus-visible too", () => {
  const selectors = [
    ".theme-toggle",
    ".navbar-signout",
    ".sidebar-toggle",
    ".filter-option",
    ".pipeline-apis summary",
    ".phenogram-genes .tooltip-box",
    ".empty-state-clear",
  ];
  for (const selector of selectors) {
    const escaped = selector.replace(
      /[.\s]/g,
      (c) => c === "." ? "\\." : "\\s+",
    );
    assertMatch(
      css,
      new RegExp(`${escaped}:hover,\\s*${escaped}:focus-visible\\s*\\{`),
      `${selector} lights on hover alone`,
    );
  }
  // .timeline-drawer-close's hover rule already shares a selector list with
  // .pipeline-drawer-close (same declarations, two triggers) -- the generic
  // pattern above assumes a bare `X:hover, X:focus-visible {` list, which
  // would false-negative here since `.pipeline-drawer-close`'s own pair sits
  // between `.timeline-drawer-close:focus-visible` and the closing `{`. This
  // proves the same thing the generic loop proves -- that X:focus-visible
  // sits immediately beside X:hover, sharing its declarations -- without
  // requiring the `{` to follow directly.
  assertMatch(
    css,
    /\.timeline-drawer-close:hover,\s*\.timeline-drawer-close:focus-visible,\s*\.pipeline-drawer-close:hover,\s*\.pipeline-drawer-close:focus-visible\s*\{/,
    ".timeline-drawer-close lights on hover alone",
  );
  // .pipeline-step-head's hover rule already carries a `:not(:disabled)`
  // qualifier (a step with nothing to expand is not a control), so the bare
  // `X:hover,\s*X:focus-visible` pattern never matches -- ":not(:disabled)"
  // sits between ":hover" and the comma. Same proof, selector list extended
  // with the qualifier preserved on both triggers.
  assertMatch(
    css,
    /\.pipeline-step-head:hover:not\(:disabled\),\s*\.pipeline-step-head:focus-visible:not\(:disabled\)\s*\{/,
    ".pipeline-step-head lights on hover alone",
  );
  assertMatch(
    css,
    /\.data-table thead th\.sortable:hover,\s*\.data-table thead th\.sortable:has\(\.sort-button:focus-visible\)\s*\{/,
  );
  // The one surviving focus-colour override (F40's phenogram tooltip) is gone.
  assert(!/\.tooltip-link-btn:focus-visible\s*\{[^}]*outline-color/.test(css));
});

Deno.test("the figures re-parameterise --svd-focus-color for their fixed white plate", () => {
  // Not a second exception to "focus reads --svd-focus-*": every
  // :focus-visible rule underneath still resolves the same custom property,
  // this scopes what it resolves to. Needed because dark mode's light-steel
  // focus colour measured 1.99:1 on the figures' plate, which stays white in
  // both themes.
  assertMatch(
    css,
    /\.phenogram-canvas,\s*\.timeline-figure\s*\{\s*--svd-focus-color: var\(--svd-figure-ink\);/,
  );
});

Deno.test("printing drops the chrome and un-clips the tables and plates", () => {
  assertMatch(css, /@media print \{[\s\S]*?\.navbar[\s\S]*?display: none;/);
  assertMatch(
    css,
    /@media print \{[\s\S]*?\.table-scroll,[\s\S]*?max-height: none;/,
  );
  // Framed surfaces may be un-stuck but never `static` (their marks detach) --
  // `.data-table thead` is not framed, and its own rule in this same block
  // legitimately sets `position: static`, so a bare "no position: static
  // anywhere in the block" check would false-positive on it. This scopes the
  // check to the framed surfaces' own rule instead of finding the whole
  // block's end, which is what makes it robust to that legitimate exception
  // rather than to where the block happens to end.
  const framedRule = css.match(
    /\.sidebar-section,\s*\.timeline-drawer\s*\{([^}]*)\}/,
  );
  assert(framedRule, "expected a .sidebar-section, .timeline-drawer rule");
  assert(!/position:\s*static/.test(framedRule[1]));
});
