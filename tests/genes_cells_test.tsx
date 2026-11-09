import { assertEquals } from "@std/assert";
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";

import { AcronymText } from "../components/AcronymText.tsx";
import { OmicsEntryView } from "../components/OmicsEntryView.tsx";

// TWAS is a generic glossary term, so these hold for any disease's manifest;
// "Q" and the tissues are in no glossary.

/** The text of every tooltip trigger, in order. */
const triggers = (html: string) =>
  [...html.matchAll(
    /<button[^>]*class="tooltip-box[^"]*"[^>]*>(.*?)<\/button>/g,
  )]
    .map((match) => match[1]);

/** What the cell reads as: every tag gone (closed panels render empty). */
const text = (html: string) => html.replace(/<[^>]+>/g, "");

Deno.test("an omics entry prints the format and boxes only acronyms", () => {
  const html = renderToString(
    <OmicsEntryView value="TWAS;Q: artery aorta*, nerve tibial" />,
  );
  assertEquals(triggers(html), ["TWAS"]);
  assertEquals(text(html), "TWAS (Q: artery aorta, nerve tibial)");
});

Deno.test("an omics entry with nothing to explain renders plain text", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;Q: a" />);
  assertEquals(triggers(html), []);
  assertEquals(text(html), "Qomics (Q: a)");
});

Deno.test("a starred entry whose type the glossary lacks still boxes the type", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;Q: a*" />);
  assertEquals(triggers(html), ["Qomics"]);
});

Deno.test("a starred type the glossary lacks keeps its own acronym boxed", () => {
  // MR is a generic glossary term; "Proteogenomic MR" as a whole is not.
  const html = renderToString(
    <OmicsEntryView value="Proteogenomic MR;Q: plasma*" />,
  );
  assertEquals(triggers(html), ["MR"]);
  assertEquals(text(html), "Proteogenomic MR (Q: plasma)");
});

/**
 * The first element of component `name` under `node`, unrendered. Under
 * `jsx: "precompile"` a template keeps its components in `props.exprs`.
 */
function findComponent(node: unknown, name: string): VNode | undefined {
  if (Array.isArray(node)) {
    return node.map((child) => findComponent(child, name)).find(Boolean);
  }
  if (!node || typeof node !== "object") return undefined;
  const vnode = node as VNode<{ children?: unknown; exprs?: unknown }>;
  if (typeof vnode.type === "function" && vnode.type.name === name) {
    return vnode;
  }
  return findComponent([vnode.props.children, vnode.props.exprs], name);
}

Deno.test("each acronym in such a type lists the colocalized tissues", () => {
  // Server rendering leaves a closed panel empty, so this reads the props
  // the type hands its acronyms rather than the HTML.
  const type = findComponent(
    OmicsEntryView({ value: "Proteogenomic MR;Q: plasma*, liver, brain*" }),
    "StudyType",
  )!;
  const rendered = (type.type as (props: unknown) => VNode)(type.props);
  assertEquals(rendered.type, AcronymText as unknown);
  assertEquals(
    (rendered.props as { colocalizedIn?: string }).colocalizedIn,
    "plasma, brain",
  );
});

Deno.test("an acronym inside an item is boxed", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;TWAS: a, TWAS*" />);
  assertEquals(triggers(html), ["Qomics", "TWAS", "TWAS"]);
  assertEquals(text(html), "Qomics (TWAS: a, TWAS)");
});

Deno.test("a term awaiting clarification prints as written, followed by a ? mark", () => {
  const html = renderToString(
    <OmicsEntryView value="Qomics;[?]: a, QQ-RR[?] b*" />,
  );
  assertEquals(triggers(html), ["Qomics", "?", "?"]);
  assertEquals(text(html), "Qomics (?: a, QQ-RR? b)");
});

Deno.test("a boxed study type keeps its ? mark out of its chip", () => {
  // The colocalized item boxes a type the glossary lacks; the mark is a chip
  // of its own, never the storage form `[?]` inside the type's chip.
  const marked = renderToString(<OmicsEntryView value="Qomics[?];Q: a*" />);
  assertEquals(triggers(marked), ["Qomics", "?"]);
  assertEquals(text(marked), "Qomics? (Q: a)");
  const bare = renderToString(<OmicsEntryView value="[?];a*" suffix="," />);
  assertEquals(triggers(bare), ["?"]);
  assertEquals(text(bare), "? (a),");
  const typeOnly = renderToString(
    <OmicsEntryView value="Qomics[?] x;Q: a*" />,
  );
  assertEquals(triggers(typeOnly), ["Qomics", "?"]);
  assertEquals(text(typeOnly), "Qomics? x (Q: a)");
});

Deno.test("a server-rendered tooltip trigger says it is collapsed", () => {
  const html = renderToString(<OmicsEntryView value="TWAS;Q: a" />);
  assertEquals(html.includes('aria-expanded="false"'), true);
});

Deno.test("plain text beside an acronym is escaped once, not twice", () => {
  const html = renderToString(<AcronymText text="a & TWAS > b" />);
  const text = html.replace(/<[^>]+>/g, "");
  // `&` escaped once; `>` needs no escape in HTML text and gets none.
  assertEquals(text, "a &amp; TWAS > b");
});

Deno.test("the ? mark is a button named for what it means", () => {
  const html = renderToString(<AcronymText text="QQ[?]" />);
  assertEquals(html.includes('aria-label="Needs clarification"'), true);
});

Deno.test("an acronym keeps the punctuation right after it on its line", () => {
  const html = renderToString(<AcronymText text="(all TWAS, and more)" />);
  assertEquals(
    /<span[^>]*class="acronym-glue"[^>]*><button[^>]*>TWAS<\/button>.*?,<\/span>/
      .test(html),
    true,
  );
  assertEquals(html.includes('class="acronym-text"'), true);
});

Deno.test("an opening parenthesis and a trailing hyphenated word stay with their acronym", () => {
  const html = renderToString(<AcronymText text="x (TWAS-based y" />);
  assertEquals(text(html), "x (TWAS-based y");
  assertEquals(
    /class="acronym-glue"[^>]*>\(<button[^>]*>TWAS<\/button>.*?-based<\/span>/
      .test(html),
    true,
  );
});

Deno.test("the separator after a whole value stays with the acronym it follows", () => {
  const entries = renderToString(
    <>
      <OmicsEntryView value="Qomics;Q: TWAS" suffix="," />{" "}
      <OmicsEntryView value="TWAS" />
    </>,
  );
  assertEquals(text(entries), "Qomics (Q: TWAS), TWAS");
  assertEquals(
    /class="acronym-glue"[^>]*><button[^>]*>TWAS<\/button>.*?\),<\/span>/
      .test(entries),
    true,
  );
  const typeOnly = renderToString(<OmicsEntryView value="TWAS" suffix="," />);
  assertEquals(
    /class="acronym-glue"[^>]*><button[^>]*>TWAS<\/button>.*?,<\/span>/
      .test(typeOnly),
    true,
  );
});

Deno.test("an item list and the biomarker colon stay with their acronyms", () => {
  const html = renderToString(
    <OmicsEntryView value="Qomics;TWAS: TWAS, TWAS" />,
  );
  assertEquals(text(html), "Qomics (TWAS: TWAS, TWAS)");
  // "(TWAS:", "TWAS," and "TWAS)" -- every chip holds its punctuation.
  assertEquals(
    [...html.matchAll(/class="acronym-glue"/g)].length,
    3,
  );
});

Deno.test("the ? mark holds its punctuation like an acronym does", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;[?]: a" />);
  assertEquals(text(html), "Qomics (?: a)");
  assertEquals(
    /class="acronym-glue"[^>]*>\(<button[^>]*>\?<\/button>.*?:<\/span>/
      .test(html),
    true,
  );
});

Deno.test("a study type the glossary names is padded like any other chip", () => {
  const html = renderToString(<OmicsEntryView value="TWAS;Q: a" />);
  assertEquals(
    /^<span class="acronym-text"><button[^>]*>TWAS<\/button>/.test(html),
    true,
  );
});

Deno.test("AcronymText boxes each acronym and leaves the words around it", () => {
  const html = renderToString(<AcronymText text="multi-trait TWAS and more" />);
  assertEquals(triggers(html), ["TWAS"]);
  assertEquals(text(html), "multi-trait TWAS and more");
});
