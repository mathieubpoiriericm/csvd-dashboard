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
  client: string;
  createdAt: number;
  state: "held" | "settled";
  settle(outcome: AttemptOutcome): void;
}

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

    const modelAllows = (client: string, perClientOnly: boolean) => {
      // Rule 1: an attempt is gone once its window has passed.
      live = live.filter((a) => a.createdAt + WINDOW_MS > clock);
      // Rule 2: the three limits, the last two waived for perClientOnly.
      const own = live.filter((a) => a.client === client).length;
      if (own >= PER_CLIENT) return false;
      if (perClientOnly) return true;
      if (live.length >= GLOBAL) return false;
      const clients = new Set(live.map((a) => a.client)).size;
      return !(own === 0 && clients >= TRACKED_CLIENTS);
    };

    const modelSettle = (record: Held, outcome: AttemptOutcome) => {
      // Rule 3: only the first settle of an attempt still listed counts.
      if (record.state === "settled") return;
      record.state = "settled";
      const attempt = live.find((a) => a.id === record.id);
      if (!attempt) return;
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
        const expected = modelAllows(client, perClientOnly);
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
          held.push({
            id,
            client,
            createdAt: clock,
            state: "held",
            settle: reservation.settle,
          });
        } else if (reservation.retryAfterSeconds !== 1) {
          fail(
            step,
            `retryAfterSeconds ${reservation.retryAfterSeconds}, expected 1`,
          );
        }
      }
    }
  }
});
