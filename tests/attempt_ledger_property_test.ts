import { seeded } from "./helpers/seeded.ts";

import {
  AttemptLedger,
  type AttemptOutcome,
  type ResolvedOptions,
} from "../server/login_post_limiter.ts";

// The model is the limiter's documented rules, restated as a plain list of
// live attempts; it shares nothing with the ledger but the clock, so the two
// agreeing over random histories means two statements of the rules agree.
const PER_CLIENT = 2;
const GLOBAL = 5;
const WINDOW_MS = 1000;
const TRACKED_CLIENTS = 3;
const CLIENTS = ["a", "b", "c", "d", "e"] as const;
const OUTCOMES: readonly AttemptOutcome[] = [
  "auth-failure",
  "success",
  "other",
];

interface ModelAttempt {
  id: number;
  client: string;
  createdAt: number;
  state: "pending" | "failed";
}

interface Held {
  id: number;
  state: "held" | "settled";
  settle(outcome: AttemptOutcome): void;
}

type Refusal = "per client" | "global" | "tracked clients";

// Every path the histories must reach, so a change to the odds, the limits
// or the clients cannot quietly leave a rule untested.
type Path =
  | `refused: ${Refusal}`
  | "allowed"
  | `settle: ${AttemptOutcome}`
  | "second settle"
  | "settle of an expired attempt";

const PATHS: readonly Path[] = [
  "refused: per client",
  "refused: global",
  "refused: tracked clients",
  "allowed",
  "settle: auth-failure",
  "settle: success",
  "settle: other",
  "second settle",
  "settle of an expired attempt",
];

type Step =
  | { op: "advance"; ms: number }
  | {
    op: "reserve";
    client: string;
    perClientOnly: boolean;
    allowed: boolean;
    id?: number;
  }
  | { op: "settle" | "settle again"; id: number; outcome: AttemptOutcome };

Deno.test("the ledger answers as its rules say over 50 seeded histories of 400 steps", () => {
  const reached = new Map<Path, number>(PATHS.map((path) => [path, 0]));
  const tally = (path: Path) => reached.set(path, reached.get(path)! + 1);

  for (let seed = 1; seed <= 50; seed++) {
    const rand = seeded(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

    let clock = 0;
    const options: ResolvedOptions = {
      perClientLimit: PER_CLIENT,
      globalLimit: GLOBAL,
      windowMs: WINDOW_MS,
      maxTrackedClients: TRACKED_CLIENTS,
      now: () => clock,
      trustedClientIpHeader: undefined,
    };
    const ledger = new AttemptLedger(options);

    let live: ModelAttempt[] = [];
    const held: Held[] = [];
    const history: Step[] = [];
    let nextId = 1;

    const fail = (step: number, what: string): never => {
      const lines = history.map((s, i) => `  ${i}: ${JSON.stringify(s)}`);
      throw new Error(
        `seed ${seed}, step ${step}: ${what}\n` +
          `clock ${clock}, model ${JSON.stringify(live)}\n` +
          `history:\n${lines.join("\n")}`,
      );
    };

    // The reasons the model refuses a reservation; none means it is allowed.
    const modelRefusals = (client: string, perClientOnly: boolean) => {
      // Rule 1: an attempt is gone once its window has passed.
      live = live.filter((a) => a.createdAt + WINDOW_MS > clock);
      // Rule 2: the three limits, the last two waived for perClientOnly.
      const own = live.filter((a) => a.client === client).length;
      const clients = new Set(live.map((a) => a.client)).size;
      const reasons: Refusal[] = [];
      if (own >= PER_CLIENT) reasons.push("per client");
      if (!perClientOnly && live.length >= GLOBAL) reasons.push("global");
      if (!perClientOnly && own === 0 && clients >= TRACKED_CLIENTS) {
        reasons.push("tracked clients");
      }
      return reasons;
    };

    const modelSettle = (record: Held, outcome: AttemptOutcome) => {
      // Rule 3: only the first settle of an attempt still listed counts.
      if (record.state === "settled") return tally("second settle");
      record.state = "settled";
      const attempt = live.find((a) => a.id === record.id);
      if (!attempt) return tally("settle of an expired attempt");
      tally(`settle: ${outcome}`);
      if (outcome === "auth-failure") attempt.state = "failed";
      else if (outcome === "other") live = live.filter((a) => a !== attempt);
      else {
        live = live.filter((a) =>
          a !== attempt &&
          !(a.client === attempt.client && a.id <= attempt.id &&
            a.state === "failed")
        );
      }
    };

    for (let step = 0; step < 400; step++) {
      const pending = held.filter((h) => h.state === "held");
      const settled = held.filter((h) => h.state === "settled");
      const roll = rand();

      if (roll < 0.25) {
        const ms = Math.floor(rand() * 401);
        clock += ms;
        history.push({ op: "advance", ms });
      } else if (roll < 0.55 && pending.length > 0) {
        const record = pick(pending);
        const outcome = pick(OUTCOMES);
        history.push({ op: "settle", id: record.id, outcome });
        record.settle(outcome);
        modelSettle(record, outcome);
      } else if (roll < 0.65 && settled.length > 0) {
        const record = pick(settled);
        const outcome = pick(OUTCOMES);
        history.push({ op: "settle again", id: record.id, outcome });
        record.settle(outcome);
        modelSettle(record, outcome);
      } else {
        const client = pick(CLIENTS);
        const perClientOnly = rand() < 0.5;
        const refusals = modelRefusals(client, perClientOnly);
        const expected = refusals.length === 0;
        if (expected) tally("allowed");
        for (const reason of refusals) tally(`refused: ${reason}`);
        const reservation = ledger.reserve(client, perClientOnly);
        const entry: Step = {
          op: "reserve",
          client,
          perClientOnly,
          allowed: reservation.allowed,
        };
        history.push(entry);
        if (reservation.allowed !== expected) {
          fail(
            step,
            `ledger allowed ${reservation.allowed}, model ${expected}`,
          );
        }
        if (reservation.allowed) {
          const id = nextId++;
          entry.id = id;
          live.push({ id, client, createdAt: clock, state: "pending" });
          held.push({ id, state: "held", settle: reservation.settle });
        } else if (reservation.retryAfterSeconds !== 1) {
          fail(
            step,
            `retryAfterSeconds ${reservation.retryAfterSeconds}, expected 1`,
          );
        }
      }
    }
  }

  for (const [path, count] of reached) {
    if (count === 0) {
      throw new Error(`no history of the 50 seeds reaches "${path}"`);
    }
  }
});
