// SPDX-License-Identifier: MIT
//
// Telling three connection failures apart.
//
// A browser WebSocket is deliberately blind: a dead port, a wrong path and a
// crashed agent all surface as the same `error` followed by close code 1006, and
// the HTTP status behind a rejected upgrade is never exposed to script. So the
// three states are separated by evidence the studio *can* gather:
//
//   refused           nothing answered a plain HTTP request at the same address
//   upgrade-rejected  something answered, but the socket never opened
//   agent-init-failed the socket opened, then died — usually with a reason
//
// Anything left over is `unclassified` and says so, because "we could not tell"
// is a better answer than a confident wrong one. What is never acceptable is a
// bare "error", which is what these three used to look like.
//
// Pure: every function here is a function of its arguments. The one impure part
// (the reachability probe) is isolated at the bottom and returns `undefined`
// when it cannot decide.

export type ConnectionFailureKind =
  | "refused"
  | "upgrade-rejected"
  | "agent-init-failed"
  | "unclassified";

/** A server-sent error that arrived on the socket before it died. */
export interface ServerSentError {
  readonly component?: string;
  readonly category?: string;
  readonly message: string;
}

/** What the studio observed during one connection attempt. */
export interface ConnectionAttempt {
  /** Did the socket ever reach the open state? */
  readonly everOpened: boolean;
  readonly closeCode?: number;
  readonly closeReason?: string;
  /** The last `error` the server managed to send. */
  readonly serverError?: ServerSentError;
  /**
   * Did a plain HTTP request to the same address get any answer at all?
   * `undefined` when no probe ran or the probe itself was inconclusive.
   */
  readonly reachable?: boolean;
  /** The transport-level message, when one was reported. */
  readonly transportMessage?: string;
}

export function classifyConnectionFailure(attempt: ConnectionAttempt): ConnectionFailureKind {
  // A socket that opened and then died was accepted by the right route — the
  // failure is behind the upgrade, in session startup.
  if (attempt.everOpened) return "agent-init-failed";
  if (attempt.reachable === true) return "upgrade-rejected";
  if (attempt.reachable === false) return "refused";
  return "unclassified";
}

/**
 * Convert a Durable Object class name to the path segment the Agents SDK routes
 * on. Mirrors `camelCaseToKebabCase` in `agents/dist/utils.js` exactly, including
 * its all-caps and trailing-dash cases — a route that disagrees with the SDK's
 * would teach the wrong thing.
 */
export function classNameToRouteSegment(className: string): string {
  if (className === className.toUpperCase() && className !== className.toLowerCase()) {
    return className.toLowerCase().replace(/_/g, "-");
  }
  const kebabified = className.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return (kebabified.startsWith("-") ? kebabified.slice(1) : kebabified)
    .replace(/_/g, "-")
    .replace(/-$/, "");
}

/** Instance name suggested in a candidate route. Any name creates the instance. */
export const AGENT_ROUTE_INSTANCE = "default";

export interface AgentRouteCandidate {
  readonly worker: string;
  readonly className: string;
  /** `/agents/<class-name-kebab>/<id>` */
  readonly path: string;
  /** The current target with that path substituted in, ready to connect to. */
  readonly url: string;
}

/**
 * Rewrite `wsUrl`'s path to the Agents SDK route for each declared class.
 *
 * Returns nothing for a target that is not a URL — a candidate built from a
 * string the studio could not parse would be a guess dressed as a suggestion.
 */
export function agentRouteCandidates(
  wsUrl: string,
  declared: readonly { readonly worker: string; readonly className: string }[],
): readonly AgentRouteCandidate[] {
  const candidates: AgentRouteCandidate[] = [];
  for (const entry of declared) {
    const path = `/agents/${classNameToRouteSegment(entry.className)}/${AGENT_ROUTE_INSTANCE}`;
    let url: string;
    try {
      const parsed = new URL(wsUrl);
      parsed.pathname = path;
      url = parsed.toString();
    } catch {
      continue;
    }
    candidates.push({ worker: entry.worker, className: entry.className, path, url });
  }
  return candidates;
}

export type ResumeState = "none" | "open" | "elapsed";

export interface ResumeStatus {
  readonly state: ResumeState;
  /** Milliseconds left in the window. Zero once it has elapsed. */
  readonly remainingMs: number;
}

/**
 * How much of the server's resume window is left after a drop.
 *
 * The window only means anything for a session that actually existed and a
 * server that told us its length — otherwise there is nothing to resume and
 * saying "resume available" would be an invention.
 */
export function resumeStatus(input: {
  readonly resumeWindowMs?: number;
  readonly disconnectedAtMs?: number;
  readonly nowMs: number;
}): ResumeStatus {
  const { resumeWindowMs, disconnectedAtMs, nowMs } = input;
  if (resumeWindowMs === undefined || resumeWindowMs <= 0 || disconnectedAtMs === undefined) {
    return { state: "none", remainingMs: 0 };
  }
  const remainingMs = resumeWindowMs - (nowMs - disconnectedAtMs);
  return remainingMs > 0 ? { state: "open", remainingMs } : { state: "elapsed", remainingMs: 0 };
}

/** The `http(s)` address matching a `ws(s)` one, for the reachability probe. */
export function httpProbeUrl(wsUrl: string): string | undefined {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Is anything answering at the socket's address?
 *
 * `no-cors` is the point: the response is opaque and its status unreadable, but
 * the distinction that matters — did any HTTP server answer — survives. A
 * WebSocket route asked for plainly answers 400 or 426, which is still an
 * answer, so "reachable" means "the address is live", not "the path is right".
 * Returns `undefined` when the probe cannot decide, so the caller reports
 * uncertainty rather than picking a side.
 */
export async function probeReachable(
  wsUrl: string,
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
): Promise<boolean | undefined> {
  const url = httpProbeUrl(wsUrl);
  if (url === undefined || fetchImpl === undefined) return undefined;
  try {
    await fetchImpl(url, { method: "GET", mode: "no-cors", cache: "no-store" });
    return true;
  } catch (error) {
    // A TypeError is fetch's network-level failure — nothing answered. Anything
    // else (an abort, a runtime restriction) proves nothing either way.
    return error instanceof TypeError ? false : undefined;
  }
}
