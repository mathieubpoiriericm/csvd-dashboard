import type { Answers, ExampleAnswer } from "../answers.ts";
import { SECTION_IDS } from "../prompt_sections.ts";
import { clean, trim } from "./json.ts";
import { grouped } from "./vocabulary.ts";

/**
 * A value on one line of an example block. A sentence copied from a fetched
 * abstract carries the abstract's print layout -- a line break every eighty
 * columns, a space before each -- and every one of them would reach the
 * model; the words stay as typed, the whitespace between them one space.
 */
const line = (value: string): string => clean(value).replace(/\s+/g, " ");

/**
 * A value going inside the double quotes of an example line. The block is
 * read by the model as written, and an unescaped quote inside a quoted
 * field closes it early.
 */
const quoted = (value: string): string => line(value).replace(/"/g, '\\"');

const PREAMBLE = `# Disease sections of the extraction prompt

Rendered into the v7 template in \`pipeline/prompts.py\`. Each \`## id\` is one
slot; the body is the text between headings with surrounding blank lines
stripped. \`disease.name\` and \`disease.abbreviation\` come from manifest.json.

Lines in this file are deliberately not wrapped. Every newline inside a section reaches the model verbatim, so a reflow is a change to the prompt; \`deno.json\` excludes this file from \`deno fmt\` for that reason. Only the text above the first \`## \` heading is ignored by the parser, which is what makes this note safe to edit.

\`## strategy.disease_steps\` is the one section with a shape of its own: one step per paragraph, paragraphs separated by a blank line, each rendered as its own numbered step in the extraction strategy.

Written by the adapt wizard from the researcher's own sentences; every example cites a PMID they supplied.
`;

function exampleBlock(example: ExampleAnswer): string {
  const traits = example.traits.map((t) => `"${quoted(t)}"`).join(", ");
  return [
    `<example type="${clean(example.type)}">`,
    `Paper states: "${quoted(example.sentence)}"`,
    `Result: gene_symbol="${
      quoted(example.gene)
    }", gwas_trait=[${traits}], confidence=${example.confidence}`,
    // Not quoted, so a quote in it is the model's to read as written.
    `Reasoning: ${line(example.reasoning)}`,
    "</example>",
  ].join("\n");
}

/**
 * The disease steps, one paragraph each, separated by exactly one blank
 * line. pipeline/prompts.py splits them on "\n\n" alone, so a separating
 * line holding a space would join two steps under one number; such a line
 * is read as the blank line it looks like.
 */
export const diseaseSteps = (body: string): string[] =>
  body.split(/\n[ \t]*\n/).map((step) => step.trim()).filter((step) =>
    step !== ""
  );

/**
 * The body of each section: computed for three, the researcher's for the
 * rest, trimmed -- a space or a line break around a typed body would reach
 * the model at the seam of the sentence it is spliced into.
 */
export function promptBodies(answers: Answers): Record<string, string> {
  const bodies: Record<string, string> = {};
  for (const id of SECTION_IDS) {
    bodies[id] = trim(answers.prompt.sections[id] ?? "");
  }
  bodies["strategy.disease_steps"] = diseaseSteps(
    bodies["strategy.disease_steps"],
  ).join("\n\n");
  bodies["strategy.monogenic_genes"] = answers.monogenic.genes.map((g) =>
    clean(g.symbol)
  ).join(", ");
  // In vocabulary.json's order, which groups the traits by family.
  bodies["traits.canonical"] = grouped(answers).map((t) => clean(t.key))
    .join(", ");
  bodies["examples"] = answers.prompt.examples.length < 2
    ? "<!-- examples: none yet -->"
    : answers.prompt.examples.map(exampleBlock).join("\n\n");
  return bodies;
}

export function generatePrompt(answers: Answers): string {
  const bodies = promptBodies(answers);
  const sections = SECTION_IDS.map((id) => {
    const body = bodies[id];
    return `## ${id}\n\n${body}${body === "" ? "" : "\n"}`;
  });
  return `${PREAMBLE}\n${sections.join("\n")}`;
}
