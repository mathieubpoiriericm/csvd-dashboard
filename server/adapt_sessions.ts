/**
 * Saved adaptation-guide sessions: one JSON file per session in the
 * directory ADAPT_SESSIONS_DIR names, and the app's only server-side state.
 *
 * The resume code is never stored. A session's file is named by the SHA-256
 * of its normalised code, so the directory alone cannot be turned back into
 * codes, and nothing here logs one. What is stored is what "Export answers"
 * downloads: answers handed over as text go through parseExport() first, and
 * every write goes through exportableAnswers(), the step of exportText() that
 * blanks the NCBI email and API key whatever a client sent. The blanking
 * stays here rather than with the caller, so that no caller can bypass it.
 *
 * One machine holds the sessions -- the only one today (fly.toml), or the one
 * ADAPT_SESSIONS_MACHINE names (server/adapt_session_holder.ts) -- so
 * read-check-write is serialised per file by an in-process promise chain
 * rather than a file lock, and every write is atomic: a temporary file, then
 * a rename.
 */

import type { Answers } from "../lib/adapt/answers.ts";
import {
  exportableAnswers,
  exportText,
  type Imported,
  parseExport,
} from "../lib/adapt/bundle.ts";
import { sessionHolder } from "./adapt_session_holder.ts";
import {
  generateCode,
  normaliseCode,
  SESSION_TTL_MS,
} from "../lib/adapt/session_code.ts";

export const SESSIONS_DIR_VAR = "ADAPT_SESSIONS_DIR";
/**
 * How many sessions the directory holds at most. Typical sessions are under
 * 100 KB; SESSION_BYTES_BUDGET bounds the rest.
 *
 * Both are checked against a listing taken under the new file's own chain,
 * not a lock on the directory, so creates in flight at once can each see
 * room for one more and overshoot either bound by the number in flight. The
 * session limiter's global limit (server/adapt_session_limiter.ts) bounds
 * how many those can be.
 */
export const SESSION_CAP = 500;
/**
 * The most bytes the directory's session files may hold together. The volume
 * is 1 GB (fly.toml); the rest is room for temporary files mid-write and for
 * the filesystem itself. Without it one signed-in user could fill the volume
 * well under the file cap (two 1 MB logos make an export of about 2.7 MB),
 * and then every save by anyone would fail.
 */
export const SESSION_BYTES_BUDGET = 750_000_000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionMeta {
  revision: number;
  savedAt: number;
}
export type CreateResult = ({ code: string } & SessionMeta) | {
  error: "full" | "failed";
};
export type SaveResult =
  | (SessionMeta & { revived: boolean })
  | { error: "conflict"; savedAt: number }
  | { error: "full" | "failed" };
export type LoadResult = (SessionMeta & { text: string }) | {
  error: "unknown" | "unreadable";
  message?: string;
};
/**
 * The copy a save was made over, as the browser last saw it. `savedAt` is
 * optional only because a request may omit it; save() treats one that does
 * as a conflict whenever a file exists.
 */
export interface SaveBase {
  revision: number;
  savedAt?: number;
}
/**
 * What a create or a save stores: the answers as the API already parsed
 * them, or an export's text, which the store parses itself.
 */
export type SessionAnswers = Answers | string;
export interface SessionStore {
  create(answers: SessionAnswers): Promise<CreateResult>;
  save(
    code: string,
    base: SaveBase,
    answers: SessionAnswers,
    force: boolean,
  ): Promise<SaveResult>;
  load(code: string): Promise<LoadResult>;
  /** Removes expired sessions and abandoned temporary files; the count removed. */
  sweep(): Promise<number>;
}

interface StoreOptions {
  now?: () => number;
  /** Reads an export's text; a test passes one that counts its calls. */
  parse?: (text: string) => Imported;
  cap?: number;
  budget?: number;
}

const FILE_VERSION = 1;
const SESSION_FILE = /^[0-9a-f]{64}\.json$/;
const TEMP_MARK = ".tmp-";
/** A temporary file this old belongs to a write that died, not one in flight. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** What a session file holds, read without trusting it. */
type Stored =
  | { kind: "absent" }
  /** `revision` when the envelope still names one, though the rest is not a session. */
  | { kind: "damaged"; modifiedAt: number; revision?: number }
  | { kind: "valid"; revision: number; savedAt: number; answers: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A revision as a file stores it: a safe integer above 0. */
function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * The revision after the highest of `known`, bounded so it stays a safe
 * integer: at the limit it repeats, which savedAt still tells apart, rather
 * than becoming a number the next read would refuse as damaged.
 */
function nextRevision(...known: number[]): number {
  return Math.min(Math.max(0, ...known) + 1, Number.MAX_SAFE_INTEGER);
}

async function fileName(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex}.json`;
}

/** What a session file holds, as written. */
function fileBody(revision: number, savedAt: number, answers: unknown): string {
  return JSON.stringify({ version: FILE_VERSION, revision, savedAt, answers });
}

/**
 * A failure the caller turns into "failed" or "unreadable", logged so that
 * a volume that fills or turns read-only leaves a line in the logs. The file
 * is named by the first 12 characters of its hash, also inside the error's
 * message, which names the path: enough to find the file, and never the
 * code or the answers.
 */
function logFailure(operation: string, name: string, error: unknown): void {
  const hash = name.slice(0, 64);
  const short = hash.slice(0, 12);
  const kind = error instanceof Error ? error.name : typeof error;
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll(hash, short);
  console.error(
    `Adapt session ${operation} failed for ${short}: ${kind}: ${message}`,
  );
}

/**
 * Whether a sweep at `now` removes the file `name`, last modified at
 * `modifiedAt`. A session's mtime is set to its savedAt on every write, so
 * the sweep never reads a file to learn its age.
 */
function sweepable(name: string, modifiedAt: number, now: number): boolean {
  if (name.includes(TEMP_MARK)) return modifiedAt + STALE_TEMP_MS <= now;
  return SESSION_FILE.test(name) && modifiedAt + SESSION_TTL_MS <= now;
}

class FileSessionStore implements SessionStore {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #cap: number;
  readonly #budget: number;
  readonly #parse: (text: string) => Imported;
  readonly #chains = new Map<string, Promise<void>>();
  #lastSweep: number;

  constructor(dir: string, options: StoreOptions) {
    this.#dir = dir;
    this.#now = options.now ?? Date.now;
    this.#cap = options.cap ?? SESSION_CAP;
    this.#budget = options.budget ?? SESSION_BYTES_BUDGET;
    this.#parse = options.parse ?? parseExport;
    this.#lastSweep = this.#now();
    this.#sweepSync(this.#lastSweep);
  }

  async create(input: SessionAnswers): Promise<CreateResult> {
    await this.#sweepIfDue();
    const answers = this.#sanitised(input);
    if (answers === null) return { error: "failed" };
    // 100 bits make a collision all but impossible; a retry costs nothing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateCode();
      const name = await fileName(code);
      const result = await this.#serial(
        name,
        async (): Promise<CreateResult | null> => {
          const stored = await this.#read(name);
          if (stored === null) return { error: "failed" };
          if (stored.kind !== "absent") return null;
          const savedAt = this.#now();
          const body = fileBody(1, savedAt, answers);
          if (await this.#full(name, body, true)) return { error: "full" };
          return await this.#write(name, savedAt, body)
            ? { code, revision: 1, savedAt }
            : { error: "failed" };
        },
      );
      if (result !== null) return result;
    }
    return { error: "failed" };
  }

  async save(
    code: string,
    base: SaveBase,
    input: SessionAnswers,
    force: boolean,
  ): Promise<SaveResult> {
    await this.#sweepIfDue();
    const normalised = normaliseCode(code);
    const answers = this.#sanitised(input);
    if (normalised === null || answers === null) return { error: "failed" };
    const name = await fileName(normalised);
    return await this.#serial(name, async (): Promise<SaveResult> => {
      const stored = await this.#read(name);
      if (stored === null) return { error: "failed" };
      const savedAt = this.#now();
      let revision: number;
      let revived = false;
      if (stored.kind === "damaged") {
        // Nothing to compare a revision with, and something a person may
        // still want: overwrite only when asked to. The new revision passes
        // both the one the envelope still names and the browser's, so no
        // copy another browser holds can match it.
        if (!force) return { error: "conflict", savedAt: stored.modifiedAt };
        revision = nextRevision(stored.revision ?? 0, base.revision);
      } else if (stored.kind === "valid" && !this.#expired(stored, savedAt)) {
        // Both must match. A revival continues past the highest revision it
        // can know of, but a swept file takes its revision with it, so after
        // one a browser still holding the old copy's revision can meet the
        // same number again; the time it was saved it cannot. A save with no
        // savedAt is therefore a conflict whenever a file exists. No deployed
        // page predates savedAt (sessions first shipped with it), so that
        // refuses only a hand-made request; falling back to the revision
        // alone would reopen the overwrite this check exists to stop.
        if (
          !force &&
          (base.revision !== stored.revision ||
            base.savedAt !== stored.savedAt)
        ) {
          return { error: "conflict", savedAt: stored.savedAt };
        }
        revision = nextRevision(stored.revision);
      } else {
        // Gone, or expired and not yet swept: the holder of the code has
        // the whole draft, so it is saved again under the same code. Never
        // at a revision another browser may hold: past the expired copy's,
        // when the file is still there to say it, and past the browser's.
        revived = true;
        revision = nextRevision(
          stored.kind === "valid" ? stored.revision : 0,
          base.revision,
        );
      }
      const body = fileBody(revision, savedAt, answers);
      if (await this.#full(name, body, stored.kind === "absent")) {
        return { error: "full" };
      }
      return await this.#write(name, savedAt, body)
        ? { revision, savedAt, revived }
        : { error: "failed" };
    });
  }

  async load(code: string): Promise<LoadResult> {
    await this.#sweepIfDue();
    const normalised = normaliseCode(code);
    if (normalised === null) return { error: "unknown" };
    const stored = await this.#read(await fileName(normalised));
    if (stored === null || stored.kind === "damaged") {
      return { error: "unreadable" };
    }
    // An expired file the sweep has not reached yet answers exactly as a
    // deleted one, and as one that never existed.
    if (stored.kind === "absent" || this.#expired(stored, this.#now())) {
      return { error: "unknown" };
    }
    const parsed = parseExport(JSON.stringify(stored.answers));
    if ("error" in parsed) {
      return { error: "unreadable", message: parsed.error };
    }
    return {
      revision: stored.revision,
      savedAt: stored.savedAt,
      text: exportText(parsed.answers),
    };
  }

  async sweep(): Promise<number> {
    const now = this.#now();
    this.#lastSweep = now;
    let removed = 0;
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (!entry.isFile) continue;
        const { name } = entry;
        if (!(await this.#sweepableNow(name, now))) continue;
        const gone = name.includes(TEMP_MARK)
          ? await this.#remove(name)
          // Under the file's own chain, and checked again there, so a save
          // that lands between the listing and the removal is kept.
          : await this.#serial(
            name,
            async () =>
              await this.#sweepableNow(name, now) && await this.#remove(name),
          );
        if (gone) removed++;
      }
    } catch {
      // A directory that cannot be listed loses nothing by waiting for the
      // next sweep; the writes report their own failures.
    }
    return removed;
  }

  #sweepSync(now: number): void {
    try {
      for (const entry of Deno.readDirSync(this.#dir)) {
        if (!entry.isFile) continue;
        const path = `${this.#dir}/${entry.name}`;
        const modifiedAt = Deno.statSync(path).mtime?.getTime();
        if (
          modifiedAt !== undefined && sweepable(entry.name, modifiedAt, now)
        ) {
          Deno.removeSync(path);
        }
      }
    } catch {
      // As in sweep(): the next one tries again.
    }
  }

  async #sweepIfDue(): Promise<void> {
    if (this.#now() - this.#lastSweep >= SWEEP_INTERVAL_MS) await this.sweep();
  }

  async #sweepableNow(name: string, now: number): Promise<boolean> {
    try {
      const modifiedAt = (await Deno.stat(`${this.#dir}/${name}`)).mtime
        ?.getTime();
      return modifiedAt !== undefined && sweepable(name, modifiedAt, now);
    } catch {
      return false;
    }
  }

  async #remove(name: string): Promise<boolean> {
    try {
      await Deno.remove(`${this.#dir}/${name}`);
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logFailure("remove", name, error);
      }
      return false;
    }
  }

  /**
   * The answers as written, with the NCBI pair blanked, or null for a text
   * that is not an export. A text is parsed here, once; answers the API has
   * parsed are not parsed again. The object is what JSON.parse(exportText())
   * would give, without serialising the whole export and reading it back.
   */
  #sanitised(input: SessionAnswers): Answers | null {
    if (typeof input !== "string") return exportableAnswers(input);
    const parsed = this.#parse(input);
    return "error" in parsed ? null : exportableAnswers(parsed.answers);
  }

  #expired(stored: { savedAt: number }, now: number): boolean {
    return stored.savedAt + SESSION_TTL_MS <= now;
  }

  /**
   * Whether writing `body` as the file `name` would take the directory past
   * the file cap or the byte budget. `adds` says the write makes a new file,
   * which the cap counts. A write over an existing file is refused only when
   * it grows the total past the budget, so a save that keeps or shrinks a
   * session always passes. The sizes come from stat, so nothing is read.
   */
  async #full(name: string, body: string, adds: boolean): Promise<boolean> {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (entry.isFile && SESSION_FILE.test(entry.name)) {
          names.push(entry.name);
        }
      }
    } catch {
      // A directory that cannot be listed will not take the write either,
      // and the write reports that as "failed".
      return false;
    }
    // Every save runs this, so the stats go out together rather than one
    // after another. The directory stays the only source of the total: a
    // running count kept in memory would drift from files removed by hand.
    const sizes = await Promise.all(names.map(async (entry) => {
      try {
        return (await Deno.stat(`${this.#dir}/${entry}`)).size;
      } catch {
        // Removed by a sweep since the listing: it holds nothing now.
        return 0;
      }
    }));
    let total = 0;
    let own = 0;
    names.forEach((entry, i) => {
      total += sizes[i];
      if (entry === name) own = sizes[i];
    });
    if (adds && names.length >= this.#cap) return true;
    const after = total - own + new TextEncoder().encode(body).byteLength;
    return after > this.#budget && after > total;
  }

  /** The file read back, or null when it exists but cannot be read at all. */
  async #read(name: string): Promise<Stored | null> {
    const path = `${this.#dir}/${name}`;
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
      logFailure("read", name, error);
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    if (
      isRecord(raw) && raw.version === FILE_VERSION &&
      isRevision(raw.revision) &&
      Number.isSafeInteger(raw.savedAt) && isRecord(raw.answers)
    ) {
      return {
        kind: "valid",
        revision: raw.revision,
        savedAt: raw.savedAt as number,
        answers: raw.answers,
      };
    }
    const revision = isRecord(raw) && isRevision(raw.revision)
      ? raw.revision
      : undefined;
    try {
      const modifiedAt = (await Deno.stat(path)).mtime?.getTime();
      return {
        kind: "damaged",
        modifiedAt: modifiedAt ?? this.#now(),
        revision,
      };
    } catch (error) {
      logFailure("read", name, error);
      return null;
    }
  }

  async #write(name: string, savedAt: number, body: string): Promise<boolean> {
    const path = `${this.#dir}/${name}`;
    const temp = `${path}${TEMP_MARK}${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(temp, body);
      // The sweep reads the age from here; rename keeps it.
      await Deno.utime(temp, new Date(savedAt), new Date(savedAt));
      await Deno.rename(temp, path);
      return true;
    } catch (error) {
      logFailure("write", name, error);
      // Most often there is no temporary file to remove; one left behind is
      // the sweep's after an hour.
      await Deno.remove(temp).catch(() => {});
      return false;
    }
  }

  /** Runs `task` after every earlier task for the same file has settled. */
  #serial<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(name) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => {}, () => {});
    this.#chains.set(name, tail);
    tail.then(() => {
      if (this.#chains.get(name) === tail) this.#chains.delete(name);
    });
    return run;
  }
}

type Opened = { store: SessionStore } | { store: null; reason: string };

function open(dir: string | undefined, options: StoreOptions): Opened {
  if (!dir) return { store: null, reason: `${SESSIONS_DIR_VAR} is not set` };
  try {
    // Synchronous, so that a page can ask whether sessions are on without
    // awaiting: the directory must exist and take a file.
    Deno.mkdirSync(dir, { recursive: true });
    const probe = `${dir}/.probe-${crypto.randomUUID()}`;
    Deno.writeTextFileSync(probe, "");
    Deno.removeSync(probe);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { store: null, reason: `${dir} cannot be written (${why})` };
  }
  return { store: new FileSessionStore(dir, options) };
}

/** null when `dir` is undefined, empty, or cannot be created and written. */
export function openSessionStore(
  dir: string | undefined,
  options: StoreOptions = {},
): SessionStore | null {
  return open(dir, options).store;
}

let processStore: { store: SessionStore | null } | undefined;

/**
 * The process's store, opened once from the environment, and only on the
 * machine that holds the sessions: any other one leaves the directory
 * untouched, since its volume is not where the sessions live.
 */
export function sessionStore(): SessionStore | null {
  if (processStore === undefined && sessionHolder().kind === "elsewhere") {
    console.info("Adapt sessions are held by another machine.");
    processStore = { store: null };
  }
  if (processStore === undefined) {
    const dir = Deno.env.get(SESSIONS_DIR_VAR);
    const opened = open(dir, {});
    if (opened.store === null) {
      console.info(`Adapt sessions are off: ${opened.reason}.`);
    } else {
      console.info(`Adapt sessions are on, kept in ${dir}.`);
    }
    processStore = { store: opened.store };
  }
  return processStore.store;
}
