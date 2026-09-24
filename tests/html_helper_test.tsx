import { assertEquals } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { escapeHtml } from "./helpers/html.ts";

Deno.test("escapeHtml writes text exactly as the renderer does", () => {
  const text = `Brigham & Women's "Neuro" <38 m/s> Hospital`;
  assertEquals(
    renderToString(<img alt={text} />),
    `<img alt="${escapeHtml(text)}"/>`,
  );
  assertEquals(renderToString(<p>{text}</p>), `<p>${escapeHtml(text)}</p>`);
  assertEquals(
    escapeHtml(text),
    "Brigham &amp; Women's &quot;Neuro&quot; &lt;38 m/s> Hospital",
  );
});
