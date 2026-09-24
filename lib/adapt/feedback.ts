/**
 * When a field speaks, and what the wizard counts.
 *
 * validate() decides whether an answer passes. This decides what the
 * researcher sees of that verdict and when: an offending character at once;
 * what an incomplete value still needs as a muted note while it is typed;
 * red only once the field has been left after an edit, or its step or card
 * revealed. The touched state is a set of "step:path" keys held by the
 * island for the session and never saved.
 */
import { type Answers, blankStep, isRecord } from "./answers.ts";
import { diagnose, type Offence, ruleFor } from "./characters.ts";
import { trim } from "./generate/json.ts";
import {
  type Issue,
  issuesFor,
  STEP_ORDER,
  type StepId,
  validate,
} from "./validate.ts";

/**
 * Whether a control named `control` answers for an issue on `path`: its own
 * path and the items and fields under it -- except that a row's first
 * control, which carries the bare row path (`families[0]`), answers for the
 * row and not for the controls beside it, which carry their own
 * (`families[0].label`). Otherwise a blank label marked the key beside it,
 * and Continue focused the key.
 */
export function covers(control: string, path: string): boolean {
  return path === control || path.startsWith(`${control}[`) ||
    (!control.endsWith("]") && path.startsWith(`${control}.`));
}

export const seenKey = (step: StepId, path: string): string =>
  `${step}:${path}`;

export function ownIssues(
  issues: Issue[],
  step: StepId,
  field: string,
): Issue[] {
  return issues.filter((i) => i.step === step && covers(field, i.field));
}

/** Left after an edit, or revealed with its card or its step. */
export function isSeen(
  seen: ReadonlySet<string>,
  step: StepId,
  field: string,
  own: Issue[],
): boolean {
  return seen.has(seenKey(step, field)) ||
    own.some((i) => seen.has(seenKey(step, i.field)));
}

export type FieldState = "idle" | "required" | "note" | "valid" | "error";

export interface FieldView {
  state: FieldState;
  /** The line shown under the control, or null. */
  message: string | null;
  /**
   * validate()'s further messages for the control, one line each: a list
   * answers for every item in it, and each can fail for its own reason.
   */
  more: string[];
  /** A second, muted line: what an incomplete value still needs. */
  note: string | null;
  offences: Offence[];
  /** The corrected value the "Use …" button writes, or null. */
  fix: string | null;
}

export const IDLE_VIEW: FieldView = {
  state: "idle",
  message: null,
  more: [],
  note: null,
  offences: [],
  fix: null,
};

const unique = (values: string[]): string[] => [...new Set(values)];

export function fieldView(input: {
  field: string;
  text: string;
  own: Issue[];
  seen: boolean;
  required: boolean;
  /** The answer at an issue path, to tell which item of a list offends. */
  valueOf?: (path: string) => unknown;
}): FieldView {
  const rule = ruleFor(input.field);
  const d = rule === null ? null : diagnose(rule, input.text);
  // Every distinct message, in validate()'s order: two empty items of one
  // list say the same thing once.
  const messages = unique(input.own.map((i) => i.message));
  const [first = null, ...rest] = messages;
  if (rule !== null && d !== null && d.offences.length > 0) {
    // The characters are named at once, and the offence reads the same
    // after leaving as while typing. validate()'s wording of that fault --
    // on the control's own path, or on an item that itself offends -- would
    // only say it twice; the rest of a list follows once the field is left,
    // so an item failing for another reason is not lost behind it.
    const restates = (issue: Issue) => {
      if (issue.field === input.field) return true;
      const value = input.valueOf?.(issue.field);
      return typeof value === "string" &&
        diagnose(rule, value).offences.length > 0;
    };
    return {
      state: "error",
      message: d.message,
      more: input.seen
        ? unique(input.own.filter((i) => !restates(i)).map((i) => i.message))
        : [],
      note: null,
      offences: d.offences,
      fix: d.fix,
    };
  }
  if (trim(input.text) === "") {
    if (!input.required && first === null) return IDLE_VIEW;
    return input.seen
      ? {
        ...IDLE_VIEW,
        state: "error",
        message: first ?? "This is required.",
        more: rest,
      }
      : { ...IDLE_VIEW, state: "required" };
  }
  if (first !== null) {
    const note = d?.note ?? null;
    return input.seen
      ? {
        ...IDLE_VIEW,
        state: "error",
        message: first,
        more: rest,
        note,
        fix: d?.fix ?? null,
      }
      // A note says what the value still needs in the rule's own words, and
      // stands for the whole verdict until the field is left.
      : {
        ...IDLE_VIEW,
        state: "note",
        message: note ?? first,
        more: note === null ? rest : [],
        fix: d?.fix ?? null,
      };
  }
  return { ...IDLE_VIEW, state: "valid" };
}

export function reveal(
  seen: ReadonlySet<string>,
  step: StepId,
  paths: Iterable<string>,
): Set<string> {
  const next = new Set(seen);
  for (const path of paths) next.add(seenKey(step, path));
  return next;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * What an edit did to a step's lists and records, as far as the touched
 * keys care: a list that lost one row (with the rows that could have been
 * it), or a list or record gone or replaced wholesale.
 */
type Change =
  | { list: string; from: number; to: number }
  | { drop: string };

function* changes(
  before: unknown,
  after: unknown,
  prefix: string,
): Generator<Change> {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length < before.length - 1) {
      // Shrunk by more than one row, or replaced: no row can be told apart.
      yield { drop: prefix };
    } else if (after.length === before.length - 1) {
      let i = 0;
      while (i < after.length && same(before[i], after[i])) i++;
      // Among identical rows any one could have gone; none keeps its state
      // rather than the wrong one keeping another's. The run ends at i:
      // a row after it equal to it would have slid into i unchanged.
      let from = i;
      while (from > 0 && same(before[from - 1], before[i])) from--;
      yield { list: prefix, from, to: i };
    } else if (after.length === before.length) {
      for (const [i, entry] of before.entries()) {
        yield* changes(entry, after[i], `${prefix}[${i}]`);
      }
    }
    // A list that grew was added to at its end; every row keeps its index.
    return;
  }
  if (isRecord(before)) {
    if (!isRecord(after)) {
      if (prefix !== "") yield { drop: prefix };
      return;
    }
    for (const key of Object.keys(before)) {
      yield* changes(
        before[key],
        after[key],
        prefix === "" ? key : `${prefix}.${key}`,
      );
    }
  }
}

/**
 * The keys once rows are removed or replaced: a removed row's go, and the
 * rows below move up one, so a revealed row stays revealed as itself rather
 * than passing its state to the row that took its index. What cannot be
 * told apart -- identical neighbours, a list shrunk by several rows or
 * replaced, a record gone -- keeps no state at all, so a row or field made
 * later at the same path is not red before it is touched.
 */
export function forgetRemoved(
  keys: ReadonlySet<string>,
  before: Answers,
  after: Answers,
): Set<string> {
  let next = new Set(keys);
  for (const step of STEP_ORDER) {
    for (const change of changes(before[step], after[step], "")) {
      const shifted = new Set<string>();
      if ("drop" in change) {
        const path = `${step}:${change.drop}`;
        for (const key of next) {
          if (
            key !== path && !key.startsWith(`${path}[`) &&
            !key.startsWith(`${path}.`)
          ) shifted.add(key);
        }
      } else {
        const head = `${step}:${change.list}[`;
        for (const key of next) {
          if (!key.startsWith(head)) {
            shifted.add(key);
            continue;
          }
          const close = key.indexOf("]", head.length);
          const index = Number(key.slice(head.length, close));
          if (index < change.from) shifted.add(key);
          else if (index > change.to) {
            shifted.add(`${head}${index - 1}${key.slice(close)}`);
          }
        }
      }
      next = shifted;
    }
  }
  return next;
}

/** The value a step-relative issue path names, or undefined. */
export function valueAt(answers: Answers, step: StepId, path: string): unknown {
  if (path.startsWith("sections.")) {
    return answers.prompt.sections[path.slice("sections.".length)];
  }
  let value: unknown = answers[step];
  for (const [, key, index] of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key ?? index];
  }
  return value;
}

/** A family or gene no key can take: see stepRequired(). */
const UNPICKED = "\0";

/**
 * Every question the step asks as it stands, as issue paths.
 *
 * Blanking the step blanks both sides of a cross-reference, and a blank
 * family then matches a blank key: the question a trait's family, a
 * mechanism's family and an OMIM row's gene ask would be asked only while
 * open, so answering one shrank the count instead of raising it. They are
 * asked of a value no key can take instead. A phrase blanked asks nothing
 * of MeSH, so each phrase typed asks it here.
 */
export function stepRequired(answers: Answers, step: StepId): string[] {
  const blanked = blankStep(answers, step);
  for (const trait of blanked.vocabulary.traits) {
    if (step === "vocabulary") trait.family = UNPICKED;
  }
  for (const mechanism of blanked.trials.mechanisms) {
    if (step === "trials") mechanism.family = UNPICKED;
  }
  for (const row of blanked.monogenic.omimRows) {
    if (step === "monogenic") row.geneOrLocus = UNPICKED;
  }
  const paths = issuesFor(validate(blanked), step).map((i) => i.field);
  if (step === "search") {
    answers.search.diseaseTerms.forEach((phrase, i) => {
      if (trim(phrase) !== "") paths.push(`meshTerms[${i}]`);
    });
  }
  return unique(paths);
}

export interface Progress {
  asked: number;
  answered: number;
  /** Answered, but wrongly: an issue of kind "wrong" is open on it. */
  toFix: number;
  /** The issue paths still open, in validate()'s order. */
  open: string[];
}

/**
 * How much of a step (or of the paths `within` keeps) is answered. A path is
 * to fix when validate() calls something on it wrong -- whatever the shape
 * of the value under it -- and open but not to fix when it is still missing
 * or waiting on a lookup.
 */
export function progressOf(
  issues: Issue[],
  step: StepId,
  required: readonly string[],
  within: (path: string) => boolean = () => true,
): Progress {
  const own = issuesFor(issues, step).filter((i) => within(i.field));
  const open = unique(own.map((i) => i.field));
  const wrong = new Set(
    own.filter((i) => i.kind === "wrong").map((i) => i.field),
  );
  const asked = new Set([...required.filter(within), ...open]);
  const toFix = open.filter((path) => wrong.has(path)).length;
  return {
    asked: asked.size,
    answered: asked.size - (open.length - toFix),
    toFix,
    open,
  };
}

export type StepState = "done" | "progress" | "fix" | "todo";

/** Amber only when something typed is wrong: an empty draft is not a fault. */
export function stepState(
  progress: Progress,
): { state: StepState; detail: string } {
  if (progress.open.length === 0) return { state: "done", detail: "Done" };
  if (progress.toFix > 0) {
    return { state: "fix", detail: `${progress.toFix} to fix` };
  }
  if (progress.answered > 0) {
    return {
      state: "progress",
      detail: `${progress.answered}/${progress.asked}`,
    };
  }
  return { state: "todo", detail: "Not started" };
}

/**
 * The first candidate, in the order the page renders them, that answers for
 * any of the given issue paths -- its own, or one it covers. validate()'s
 * emission order is not the page's (a card's fields ask in the order the
 * schema happens to check them, not the order they sit on screen), so the
 * field a researcher meets first reading top to bottom is not always the
 * first path in the list revealed with it.
 */
export function firstInPage(
  candidates: readonly string[],
  paths: readonly string[],
): number {
  return candidates.findIndex((c) =>
    paths.some((path) => c === path || covers(c, path))
  );
}

/**
 * The field an element speaks for: its own `data-field`, or -- for a
 * control that sits beside one instead of carrying one, such as a field's
 * "Use …" fix button -- the field its nearest `.adapt-field` container
 * marks. undefined for an element that answers for no field at all.
 */
export function targetField(control: HTMLElement): string | undefined {
  return control.dataset?.field ??
    control.closest<HTMLElement>(".adapt-field")
      ?.querySelector<HTMLElement>("[data-field]")
      ?.dataset.field;
}
