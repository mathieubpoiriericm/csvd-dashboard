/**
 * Saved adaptation-guide sessions: one JSON file per session in the
 * directory ADAPT_SESSIONS_DIR names, and the app's only server-side state.
 *
 * The resume code is never stored. A session's file is named by the SHA-256
 * of its normalised code, so the directory alone cannot be turned back into
 * codes, and nothing here logs one. What is stored is what "Export answers"
 * downloads: every text goes through parseExport() and back out through
 * exportText(), which blanks the NCBI email and API key whatever a client
 * sent.
 *
 * One machine holds the sessions -- the only one today (fly.toml), or the one
 * ADAPT_SESSIONS_MACHINE names (server/adapt_session_holder.ts) -- so
 * read-check-write is serialised per file by an in-process promise chain
 * rather than a file lock, and every write is atomic: a temporary file, then
 * a rename.
 */

import { exportText, parseExport } from "../lib/adapt/bundle.ts";
import { sessionHolder } from "./adapt_session_holder.ts";
import {
  generateCode,
  normaliseCode,
  SESSION_TTL_MS,
} from "../lib/adapt/session_code.ts";

export const SESSIONS_DIR_VAR = "ADAPT_SESSIONS_DIR";
/**
 * Files, not bytes. Typical sessions are under 100 KB, so 500 of them leave
 * a 1 GB volume most of its room; the worst case (two 1 MB logos make an
 * export of about 2.7 MB) is above 1 GB, and a volume that fills before the
 * cap does answers "failed" on the write rather than losing data silently.
 */
export const SESSION_CAP = 500;
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
export interface SessionStore {
  create(exportText: string): Promise<CreateResult>;
  save(
    code: string,
    baseRevision: number,
    exportText: string,
    force: boolean,
  ): Promise<SaveResult>;
  load(code: string): Promise<LoadResult>;
  /** Removes expired sessions and abandoned temporary files; the count removed. */
  sweep(): Promise<number>;
}

interface StoreOptions {
  now?: () => number;
  cap?: number;
}

const FILE_VERSION = 1;
const SESSION_FILE = /^[0-9a-f]{64}\.json$/;
const TEMP_MARK = ".tmp-";
/** A temporary file this old belongs to a write that died, not one in flight. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** What a session file holds, read without trusting it. */
type Stored =
  | { kind: "absent" }
  | { kind: "damaged"; modifiedAt: number }
  | { kind: "valid"; revision: number; savedAt: number; answers: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** The export a text holds, with the NCBI pair blanked, or null if it is not one. */
function sanitised(text: string): unknown {
  const parsed = parseExport(text);
  return "error" in parsed ? null : JSON.parse(exportText(parsed.answers));
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
  readonly #chains = new Map<string, Promise<void>>();
  #lastSweep: number;

  constructor(dir: string, options: StoreOptions) {
    this.#dir = dir;
    this.#now = options.now ?? Date.now;
    this.#cap = options.cap ?? SESSION_CAP;
    this.#lastSweep = this.#now();
    this.#sweepSync(this.#lastSweep);
  }

  async create(text: string): Promise<CreateResult> {
    await this.#sweepIfDue();
    const answers = sanitised(text);
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
          if (await this.#full()) return { error: "full" };
          const savedAt = this.#now();
          return await this.#write(name, 1, savedAt, answers)
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
    baseRevision: number,
    text: string,
    force: boolean,
  ): Promise<SaveResult> {
    await this.#sweepIfDue();
    const normalised = normaliseCode(code);
    const answers = sanitised(text);
    if (normalised === null || answers === null) return { error: "failed" };
    const name = await fileName(normalised);
    return await this.#serial(name, async (): Promise<SaveResult> => {
      const stored = await this.#read(name);
      if (stored === null) return { error: "failed" };
      const savedAt = this.#now();
      let revision = 1;
      let revived = false;
      if (stored.kind === "damaged") {
        // Nothing to compare a revision with, and something a person may
        // still want: overwrite only when asked to.
        if (!force) return { error: "conflict", savedAt: stored.modifiedAt };
      } else if (stored.kind === "valid" && !this.#expired(stored, savedAt)) {
        if (!force && baseRevision !== stored.revision) {
          return { error: "conflict", savedAt: stored.savedAt };
        }
        revision = stored.revision + 1;
      } else {
        // Gone, or expired and not yet swept: the holder of the code has
        // the whole draft, so it is saved again under the same code.
        revived = true;
        if (stored.kind === "absent" && await this.#full()) {
          return { error: "full" };
        }
      }
      return await this.#write(name, revision, savedAt, answers)
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
    } catch {
      return false;
    }
  }

  #expired(stored: { savedAt: number }, now: number): boolean {
    return stored.savedAt + SESSION_TTL_MS <= now;
  }

  async #full(): Promise<boolean> {
    let count = 0;
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (entry.isFile && SESSION_FILE.test(entry.name)) count++;
      }
    } catch {
      // A directory that cannot be listed will not take the write either,
      // and the write reports that as "failed".
      return false;
    }
    return count >= this.#cap;
  }

  /** The file read back, or null when it exists but cannot be read at all. */
  async #read(name: string): Promise<Stored | null> {
    const path = `${this.#dir}/${name}`;
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? { kind: "absent" } : null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    if (
      isRecord(raw) && raw.version === FILE_VERSION &&
      Number.isSafeInteger(raw.revision) && (raw.revision as number) > 0 &&
      Number.isSafeInteger(raw.savedAt) && isRecord(raw.answers)
    ) {
      return {
        kind: "valid",
        revision: raw.revision as number,
        savedAt: raw.savedAt as number,
        answers: raw.answers,
      };
    }
    try {
      const modifiedAt = (await Deno.stat(path)).mtime?.getTime();
      return { kind: "damaged", modifiedAt: modifiedAt ?? this.#now() };
    } catch {
      return null;
    }
  }

  async #write(
    name: string,
    revision: number,
    savedAt: number,
    answers: unknown,
  ): Promise<boolean> {
    const path = `${this.#dir}/${name}`;
    const temp = `${path}${TEMP_MARK}${crypto.randomUUID()}`;
    const body = JSON.stringify({
      version: FILE_VERSION,
      revision,
      savedAt,
      answers,
    });
    try {
      await Deno.writeTextFile(temp, body);
      // The sweep reads the age from here; rename keeps it.
      await Deno.utime(temp, new Date(savedAt), new Date(savedAt));
      await Deno.rename(temp, path);
      return true;
    } catch {
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
