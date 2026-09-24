/**
 * A structural check of a value against one of the two disease JSON
 * Schemas.
 *
 * No validator is in the import map and neither document is worth adding
 * one for, so this walks the schema beside the value and implements the
 * keywords in KEYWORDS with their JSON Schema 2020-12 meaning: oneOf passes
 * when exactly one branch does, an integer is a number, a string's length
 * counts code points, a pattern is a Unicode regular expression, and a
 * keyword beside $ref or oneOf is checked as well. A keyword outside that
 * set is not silently satisfied: it throws, and unhandledKeywords() lets a
 * test hold both committed schemas to the set.
 */
export type Schema = Record<string, unknown>;

/** The assertions and applicators schemaErrors() evaluates. */
const KEYWORDS = new Set([
  "$ref",
  "oneOf",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "items",
  "required",
  "properties",
  "additionalProperties",
]);
/** Keywords that assert nothing about a value. */
const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
]);

/** Every keyword in `schema`, its $defs and every subschema, not handled. */
export function unhandledKeywords(schema: Schema): string[] {
  const out = new Set<string>();
  const walk = (node: Schema) => {
    for (const [keyword, value] of Object.entries(node)) {
      if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) {
        out.add(keyword);
      }
      if (keyword === "properties" || keyword === "$defs") {
        for (const child of Object.values(value as Record<string, Schema>)) {
          walk(child);
        }
      } else if (keyword === "oneOf") {
        for (const child of value as Schema[]) walk(child);
      } else if (
        (keyword === "items" || keyword === "additionalProperties") &&
        typeof value === "object" && value !== null
      ) {
        walk(value as Schema);
      }
    }
  };
  walk(schema);
  return [...out];
}

function typeOf(value: unknown): string {
  return value === null
    ? "null"
    : Array.isArray(value)
    ? "array"
    : Number.isInteger(value)
    ? "integer"
    : typeof value;
}

const typeMatches = (wanted: string, actual: string) =>
  wanted === actual || (wanted === "number" && actual === "integer");

export function schemaErrors(
  node: Schema,
  value: unknown,
  root: Schema,
  path: string,
): string[] {
  for (const keyword of Object.keys(node)) {
    if (!KEYWORDS.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(`schemaErrors does not handle "${keyword}" (${path})`);
    }
  }
  const errors: string[] = [];
  const ref = node.$ref as string | undefined;
  if (ref !== undefined) {
    const defs = (root.$defs ?? {}) as Record<string, Schema>;
    const name = ref.replace("#/$defs/", "");
    if (!ref.startsWith("#/$defs/") || !Object.hasOwn(defs, name)) {
      throw new Error(`schemaErrors cannot resolve $ref ${ref} (${path})`);
    }
    errors.push(...schemaErrors(defs[name], value, root, path));
  }
  if (Array.isArray(node.oneOf)) {
    const passing = (node.oneOf as Schema[]).filter((branch) =>
      schemaErrors(branch, value, root, path).length === 0
    ).length;
    if (passing === 0) {
      errors.push(`${path}: matches no oneOf branch`);
    }
    if (passing > 1) {
      errors.push(`${path}: matches more than one oneOf branch`);
    }
  }
  const types = node.type === undefined
    ? []
    : Array.isArray(node.type)
    ? node.type as string[]
    : [node.type as string];
  const actual = typeOf(value);
  if (types.length > 0 && !types.some((t) => typeMatches(t, actual))) {
    return [...errors, `${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if ("const" in node && value !== node.const) {
    errors.push(`${path}: must be ${JSON.stringify(node.const)}`);
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === "string") {
    const pattern = node.pattern as string | undefined;
    if (pattern !== undefined && !new RegExp(pattern, "u").test(value)) {
      errors.push(`${path}: does not match ${pattern}`);
    }
    const length = [...value].length;
    const minLength = node.minLength as number | undefined;
    if (minLength !== undefined && length < minLength) {
      errors.push(`${path}: shorter than ${minLength}`);
    }
    const maxLength = node.maxLength as number | undefined;
    if (maxLength !== undefined && length > maxLength) {
      errors.push(`${path}: longer than ${maxLength}`);
    }
  }
  if (typeof value === "number") {
    const bound = (keyword: string, fails: (limit: number) => boolean) => {
      const limit = node[keyword] as number | undefined;
      if (limit !== undefined && fails(limit)) {
        errors.push(`${path}: ${keyword} ${limit}`);
      }
    };
    bound("minimum", (limit) => value < limit);
    bound("maximum", (limit) => value > limit);
    bound("exclusiveMinimum", (limit) => value <= limit);
    bound("exclusiveMaximum", (limit) => value >= limit);
  }
  if (Array.isArray(value)) {
    const minItems = node.minItems as number | undefined;
    if (minItems !== undefined && value.length < minItems) {
      errors.push(`${path}: fewer than ${minItems} items`);
    }
    const maxItems = node.maxItems as number | undefined;
    if (maxItems !== undefined && value.length > maxItems) {
      errors.push(`${path}: more than ${maxItems} items`);
    }
    const items = node.items as Schema | undefined;
    if (items) {
      value.forEach((entry, index) =>
        errors.push(...schemaErrors(items, entry, root, `${path}[${index}]`))
      );
    }
  }
  if (actual === "object") {
    const record = value as Record<string, unknown>;
    const properties = (node.properties ?? {}) as Record<string, Schema>;
    const extra = node.additionalProperties;
    // Own keys only: "constructor" is not a property every object has.
    for (const key of (node.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) {
        errors.push(`${path}.${key}: required, missing`);
      }
    }
    for (const [key, entry] of Object.entries(record)) {
      const child = Object.hasOwn(properties, key)
        ? properties[key]
        : typeof extra === "object" && extra !== null
        ? extra as Schema
        : null;
      if (child) {
        errors.push(...schemaErrors(child, entry, root, `${path}.${key}`));
      } else if (extra === false) {
        errors.push(`${path}.${key}: not allowed`);
      }
    }
  }
  return errors;
}
