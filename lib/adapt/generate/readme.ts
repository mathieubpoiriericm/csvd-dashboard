import type { Answers } from "../answers.ts";
import { titleCase } from "../site_drafts.ts";
import { clean, wrap80 } from "./json.ts";
import { meshHeadings } from "./pipeline.ts";

/**
 * Researcher text as Markdown shows it: every character Markdown would read
 * as markup escaped -- "HLA-B*27 and HLA-B*57" is no emphasis, "<stage>"
 * no tag -- and the pipe with them, which would end a table cell.
 */
const md = (value: string): string =>
  clean(value).replace(/[\\`*_<>[\]|]/g, "\\$&");

/**
 * A key as a code span, fenced with one backtick more than the longest run
 * inside it (and padded when it starts or ends with one), so no key can
 * close its own span. Only the pipe is escaped inside: a table reads it
 * before the span does.
 */
function code(value: string): string {
  const text = clean(value).replace(/\|/g, "\\|");
  const run = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(run + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** An address in an autolink, which reads no escapes: nothing may close it. */
const link = (value: string): string =>
  clean(value).replace(/[<>\s]/g, encodeURIComponent);

/**
 * A Markdown table with every column padded to its widest cell, the way
 * `deno fmt` normalises one -- including the all-dashes separator row,
 * whose width follows the same padding.
 */
function markdownTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => row[i].length))
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ];
}

export function generateReadme(answers: Answers): string {
  const { disease, institute, maintainer } = answers.identity;
  const name = clean(disease.name);
  const url = link(institute.url);
  const instituteLine = url === ""
    ? `- **Institute:** ${md(institute.name)} (${md(institute.short)})`
    : `- **Institute:** ${md(institute.name)} (${
      md(institute.short)
    }), <${url}>`;
  const traitTable = markdownTable(
    ["Key", "Name", "Family"],
    answers.vocabulary.traits.map((
      t,
    ) => [code(t.key), md(t.name), code(t.family)]),
  );
  const populations = answers.trials.populations.map((p) =>
    `**${md(p.label)}**`
  ).join(", ");
  const headings = meshHeadings(answers).map((m) => m.heading);
  const query = [
    `The PubMed query anchors on ${
      answers.search.diseaseTerms.map((t) => `"${md(t)}"`).join(", ")
    }`,
    `and the MeSH heading${headings.length === 1 ? "" : "s"} ${
      headings.map((h) => `"${md(h)}"`).join(", ")
    };`,
    `the marker terms are ${
      answers.search.markerTerms.map((m) => `"${md(m.term)}"`).join(", ")
    }.`,
  ].join(" ");
  return wrap80([
    `# ${md(titleCase(name))} (${md(disease.abbreviation)})`,
    "",
    `The disease this repository's \`disease/\` describes. The code, the pipeline and the tests hold for any disease; everything on this page is specific to ${
      md(name)
    }.`,
    "",
    instituteLine,
    `- **Maintainer:** ${md(maintainer.name)}, <${link(maintainer.email)}>`,
    "- **Hosted at:** not yet hosted",
    "",
    "## Traits",
    "",
    ...traitTable,
    "",
    "## Populations",
    "",
    `The trials are filed under ${answers.trials.populations.length} population${
      answers.trials.populations.length === 1 ? "" : "s"
    } (\`manifest.json\`, \`populations\`), shown on the trials pages as the "${
      md(answers.trials.populationField.label)
    }" column: ${populations}.`,
    "",
    "## The PubMed query",
    "",
    query,
    "",
    "## How to cite",
    "",
    "How to cite: pending.",
    "",
  ].join("\n"));
}
