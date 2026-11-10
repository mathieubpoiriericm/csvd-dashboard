/**
 * The files under disease/ whose every string ships in a chunk served before
 * the login: the manifest, the radar's timeline, the karyogram's families
 * and the trait vocabulary, which lib/constants.ts reads for the filter
 * choices and the login route imports with it.
 */
export const PUBLIC_DISEASE_FILES = [
  "manifest.json",
  "timeline.json",
  "phenogram.json",
  "vocabulary.json",
] as const;

/**
 * Each place a gene symbol of disease/pipeline.json -- a monogenic gene, an
 * alias or one of its members -- stands as a whole word in a public file,
 * as "<path>: <symbol>". Keys are walked like values: both are in the file.
 */
export function publicSymbolHits(
  pipeline: unknown,
  files: Readonly<Record<string, unknown>>,
): string[] {
  const { monogenicGenes, geneAliases } = pipeline as {
    monogenicGenes: string[];
    geneAliases: Record<string, string[]>;
  };
  const symbols = [
    ...monogenicGenes,
    ...Object.entries(geneAliases).flat(2),
  ].filter((symbol) => symbol.trim() !== "");
  if (symbols.length === 0) return [];
  const escaped = [...new Set(symbols)]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const word = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`,
    "u",
  );
  const hits: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      const hit = word.exec(value);
      if (hit) hits.push(`${path}: ${hit[0]}`);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        walk(key, `${path} key`);
        walk(item, `${path}.${key}`);
      }
    }
  };
  for (const [name, value] of Object.entries(files)) walk(value, name);
  return hits;
}
