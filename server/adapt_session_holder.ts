/**
 * Which machine holds the adaptation guide's sessions.
 *
 * Sessions are files on a Fly volume, and a volume belongs to one machine,
 * so with more than one machine every session request has to reach the same
 * one. ADAPT_SESSIONS_MACHINE names it. Unset -- local development, CI, the
 * e2e server, a deployment of one machine -- every machine is its own holder
 * and nothing here changes a request.
 *
 * The page tells the guide which machine to name, and the guide sends every
 * session request with Fly's fly-force-instance-id header (lib/adapt/
 * session.ts). A request that reaches another machine without it, from a
 * page served before the designation, is handed over with fly-replay.
 * Fly sets FLY_MACHINE_ID in every machine's environment, which is how a
 * machine knows whether it is the one named.
 */

import { FORCE_INSTANCE_HEADER } from "../lib/adapt/session.ts";
import type { SessionStore } from "./adapt_sessions.ts";

export { FORCE_INSTANCE_HEADER };

/** The holder's machine id; unset means this machine. */
export const HOLDER_VAR = "ADAPT_SESSIONS_MACHINE";
export const MACHINE_VAR = "FLY_MACHINE_ID";
/** The response header Fly's proxy acts on to replay a request elsewhere. */
export const REPLAY_HEADER = "fly-replay";

/**
 * A Fly machine id as `fly status` prints it. The id is no secret, but it
 * reaches a header and the page's HTML, so nothing else is let through.
 */
const MACHINE_ID = /^[0-9a-f]{6,32}$/i;

export type Holder =
  | { kind: "here" } // no designation, or this machine is the designated one
  | { kind: "elsewhere"; machine: string };

type Env = (name: string) => string | undefined;

const processEnv: Env = (name) => Deno.env.get(name);

/**
 * The designated machine, or undefined when none is. A set value that is
 * not a machine id throws: a typo must stop the server at start-up rather
 * than split the sessions between machines.
 */
function readDesignated(env: Env): string | undefined {
  const value = env(HOLDER_VAR)?.trim();
  if (!value) return undefined;
  if (!MACHINE_ID.test(value)) {
    throw new TypeError(
      `${HOLDER_VAR} must be a Fly machine id (6 to 32 hexadecimal characters)`,
    );
  }
  // Validated case-insensitively, so compared and printed in one case: an
  // id pasted in upper case would otherwise match no machine, and every
  // machine would hand over while none held.
  return value.toLowerCase();
}

function readHolder(env: Env): Holder {
  const designated = readDesignated(env);
  const own = env(MACHINE_VAR)?.trim().toLowerCase();
  if (designated === undefined || designated === own) {
    return { kind: "here" };
  }
  // FLY_MACHINE_ID unset with a designation set is a machine that cannot
  // tell it is the holder, so it holds nothing rather than a second copy.
  return { kind: "elsewhere", machine: designated };
}

let processHolder: { holder: Holder; designated: string | undefined } | null =
  null;

/** The process's reading, taken once, as sessionStore() opens its store once. */
function fromProcess() {
  processHolder ??= {
    designated: readDesignated(processEnv),
    holder: readHolder(processEnv),
  };
  return processHolder;
}

/**
 * Reads the two variables through `env`; without one, reads the process's
 * environment once and keeps the answer. main.ts calls it at load, so a
 * malformed ADAPT_SESSIONS_MACHINE fails the start, not a visitor's request.
 */
export function sessionHolder(env?: Env): Holder {
  return env === undefined ? fromProcess().holder : readHolder(env);
}

/** The validated ADAPT_SESSIONS_MACHINE, read as sessionHolder() reads it. */
export function designatedMachine(env?: Env): string | undefined {
  return env === undefined ? fromProcess().designated : readDesignated(env);
}

/**
 * What the page tells the island: whether sessions are on, and which machine
 * to name. The designated machine names itself, so a page it serves pins its
 * own requests too. Another machine cannot see whether the holder's volume
 * is writable and says sessions are on; the deploy smoke test checks that.
 */
export function sessionsForPage(
  holder: Holder,
  store: SessionStore | null,
  designated: string | undefined,
): { sessions: boolean; machine: string | null } {
  if (holder.kind === "elsewhere") {
    return { sessions: true, machine: holder.machine };
  }
  return { sessions: store !== null, machine: designated ?? null };
}

/**
 * The hand-over for a session POST that reached a machine that does not hold
 * the sessions.
 *
 * Fly's documentation (https://docs.fly.io/networking/dynamic-request-routing,
 * read 2026-11-10): "When your app responds to a request with a fly-replay
 * response, Fly Proxy will automatically replay the original request
 * according to your specified routing rules." The `instance` field is "The
 * ID of a specific Machine to route to", written `fly-replay:
 * instance=00bb33ff`. And: "Requests larger than 1MB cannot be replayed".
 *
 * The proxy consumes this response and replays the request, which covers a
 * resume and a small save. The page names no status for it, so the status
 * matters only when nothing consumes the header: the app is not behind Fly's
 * proxy, or the request is over the 1 MB replay limit (a save with logos,
 * from a page that did not send fly-force-instance-id). Then the browser
 * sees this response, and 503 with `failed` is what lib/adapt/session.ts
 * reads as "The session could not be reached". Not 409, which the client
 * reads as a save conflict, and not a 3xx, which its `redirect: "manual"`
 * reads as signed out.
 */
export function replayToHolder(machine: string): Response {
  return new Response(JSON.stringify({ error: "failed" }), {
    status: 503,
    headers: {
      [REPLAY_HEADER]: `instance=${machine}`,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
