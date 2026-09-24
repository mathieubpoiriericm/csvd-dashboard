/**
 * The shape a stored value is read back against, and the reading.
 *
 * Every step reads properties off its slice and off every entry of its
 * lists, so one value of the wrong shape -- a hole an array grown by its
 * `length` serialised as null, a hand-edited export, a draft saved before
 * a field existed -- takes the whole page down, with "Start over" inside
 * it. So a stored value is rebuilt against a shape rather than trusted: a
 * field of the wrong kind takes its empty value, a list entry of the wrong
 * kind is dropped (one answer lost rather than the draft), and the path of
 * each value lost is reported, so an import can say what it could not read.
 * A missing or null value held no answer, and is not reported.
 */

export type Shape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "count" }
  | { kind: "nullIfBlank" }
  | { kind: "nullable"; of: Shape }
  | { kind: "list"; of: Shape; aligned: boolean }
  | { kind: "pair" }
  | { kind: "dict" }
  | { kind: "file"; cap: number }
  | { kind: "object"; fields: Record<string, Shape> };

export const str: Shape = { kind: "string" };
/** A finite number; unset is NaN, which JSON writes as null. */
export const num: Shape = { kind: "number" };
export const bool: Shape = { kind: "boolean" };
/** A count a lookup returned: a whole number of at least zero, or null. */
export const count: Shape = { kind: "count" };
/** A string a cleared field stores as null: blank reads as null. */
export const nullIfBlank: Shape = { kind: "nullIfBlank" };
/** Two words, whatever the stored value held. */
export const pair: Shape = { kind: "pair" };
/** Strings under keys of their own, e.g. the prompt's typed sections. */
export const dict: Shape = { kind: "dict" };
export const nullable = (of: Shape): Shape => ({ kind: "nullable", of });
export const list = (of: Shape): Shape => ({
  kind: "list",
  of,
  aligned: false,
});
/**
 * A list whose rows another list's rows are matched to by index. Dropping
 * an unreadable row would move every row below it onto another's entry --
 * a MeSH heading onto a different phrase -- so its place is kept, as its
 * empty value.
 */
export const aligned = (of: Shape): Shape => ({
  kind: "list",
  of,
  aligned: true,
});
/** An uploaded file: a name and base64 that decodes to 1 to `cap` bytes. */
export const file = (cap: number): Shape => ({ kind: "file", cap });
export const obj = (fields: Record<string, Shape>): Shape => ({
  kind: "object",
  fields,
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The number of bytes base64 decodes to, or null when it does not decode. */
function decodedSize(base64: string): number | null {
  try {
    return atob(base64).length;
  } catch {
    return null;
  }
}

/**
 * Whether `value` is of the shape's kind: what a list keeps as an entry,
 * and what a nullable field keeps rather than reading as null.
 */
function fits(shape: Shape, value: unknown): boolean {
  switch (shape.kind) {
    case "string":
      return typeof value === "string";
    case "nullIfBlank":
      return value === null || typeof value === "string";
    case "number":
      return typeof value === "number";
    case "count":
      return value === null || typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "nullable":
      return value === null || fits(shape.of, value);
    case "list":
    case "pair":
      return Array.isArray(value);
    default:
      return isRecord(value);
  }
}

const join = (path: string, key: string) =>
  path === "" ? key : `${path}.${key}`;

function conform(
  shape: Shape,
  value: unknown,
  path: string,
  dropped: string[],
): unknown {
  const absent = value === undefined || value === null;
  const lost = () => {
    if (!absent) dropped.push(path);
  };
  switch (shape.kind) {
    case "string":
      if (typeof value === "string") return value;
      lost();
      return "";
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      lost();
      return NaN;
    case "boolean":
      if (typeof value === "boolean") return value;
      lost();
      return false;
    case "count":
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
      }
      lost();
      return null;
    case "nullIfBlank":
      if (typeof value === "string") return value.trim() === "" ? null : value;
      lost();
      return null;
    case "nullable":
      if (!absent && fits(shape.of, value)) {
        return conform(shape.of, value, path, dropped);
      }
      lost();
      return null;
    case "list": {
      if (!Array.isArray(value)) {
        // One entry where a list belongs is a list of it.
        if (!absent && !shape.aligned && fits(shape.of, value)) {
          return [conform(shape.of, value, path, dropped)];
        }
        lost();
        return [];
      }
      const out: unknown[] = [];
      value.forEach((entry, i) => {
        const at = `${path}[${i}]`;
        if (fits(shape.of, entry)) {
          out.push(conform(shape.of, entry, at, dropped));
          return;
        }
        if (entry !== undefined && entry !== null) dropped.push(at);
        if (shape.aligned) out.push(conform(shape.of, undefined, at, []));
      });
      return out;
    }
    case "pair": {
      if (!Array.isArray(value)) {
        lost();
        return ["", ""];
      }
      if (value.length !== 2) dropped.push(path);
      return [
        conform(str, value[0], `${path}[0]`, dropped),
        conform(str, value[1], `${path}[1]`, dropped),
      ];
    }
    case "dict": {
      if (!isRecord(value)) {
        lost();
        return {};
      }
      const kept: Array<[string, string]> = [];
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") kept.push([key, entry]);
        else if (entry !== undefined && entry !== null) {
          dropped.push(join(path, key));
        }
      }
      // Built from entries, so a key such as "__proto__" stays a key.
      return Object.fromEntries(kept);
    }
    case "file": {
      if (
        isRecord(value) && typeof value.name === "string" &&
        typeof value.base64 === "string"
      ) {
        // The archive decodes the bytes, so a file that cannot be decoded
        // would break the Review step rather than this one field.
        const size = decodedSize(value.base64);
        if (size !== null && size > 0 && size <= shape.cap) {
          return { name: value.name, base64: value.base64 };
        }
      }
      lost();
      return null;
    }
    case "object": {
      if (!isRecord(value)) lost();
      const source = isRecord(value) ? value : {};
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape.fields)) {
        out[key] = conform(
          field,
          Object.hasOwn(source, key) ? source[key] : undefined,
          join(path, key),
          dropped,
        );
      }
      return out;
    }
  }
}

/**
 * `value` rebuilt against `shape`, with the path of every value that was
 * there and could not be kept ("" for the value itself).
 */
export function rebuild(
  shape: Shape,
  value: unknown,
): { value: unknown; dropped: string[] } {
  const dropped: string[] = [];
  return { value: conform(shape, value, "", dropped), dropped };
}
