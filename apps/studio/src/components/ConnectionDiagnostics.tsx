// SPDX-License-Identifier: MIT
//
// What went wrong with the connection, in words, with the next action.
//
// A dead server, a wrong path and a crashed agent used to render as one bare
// "error". They are three different problems: start the server, fix the path,
// read the startup error. So each gets its own name, its own likely cause and
// its own next step — and the one case the studio genuinely cannot tell apart
// says that, instead of picking the likeliest and sounding sure.
//
// The rejected-upgrade case teaches the Cloudflare route shape and names the
// Durable Object classes the workspace actually declares (design rule 6 — never
// hardcode an agent route). Those classes are read from `wrangler.jsonc` at build
// time; when none was readable the shape is taught without naming a class.

import { useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/format";
import { agentRouteCandidates, resumeStatus, type ConnectionFailureKind } from "@/lib/connection-failure";
import type { ConnectionFailure } from "@/hooks/useSyrinxSession";
import { cn } from "@/lib/utils";

const HEADLINE: Record<ConnectionFailureKind, string> = {
  refused: "Nothing is listening at that address",
  "upgrade-rejected": "The server answered, but not on that path",
  "agent-init-failed": "The connection was accepted, then the agent failed to start",
  unclassified: "The connection failed, and the browser did not say why",
};

const CAUSE: Record<ConnectionFailureKind, string> = {
  refused:
    "A plain request to the same address got no answer at all, so the dev server is not running or is on a different port.",
  "upgrade-rejected":
    "A plain request to the same address was answered, so something is running there — it just does not serve a voice session on this path.",
  "agent-init-failed":
    "The address and the path were both right: the socket opened. It closed before the session was ready, which means building the agent failed.",
  unclassified:
    "The socket never opened, and the reachability check could not decide whether anything is running there. A browser is not told why an upgrade was refused.",
};

const NEXT: Record<ConnectionFailureKind, string> = {
  refused: "Start the backend, then connect again. If it is already running, check the port.",
  "upgrade-rejected": "Point the URL at the path that serves a voice session.",
  "agent-init-failed":
    "Read the startup error below and the backend's own log — a missing provider key is the usual cause.",
  unclassified:
    "Check the backend is running and reachable from this page, then look at its log for a refused upgrade.",
};

function ResumeWindow({
  resumeWindowMs,
  disconnectedAtMs,
}: {
  readonly resumeWindowMs?: number;
  readonly disconnectedAtMs?: number;
}): React.JSX.Element | null {
  // The window drains whether or not a message arrives, so re-render on a timer —
  // a countdown frozen at the moment of the drop would be a lie within a second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const resume = resumeStatus({ resumeWindowMs, disconnectedAtMs, nowMs: now });
  if (resume.state === "none") return null;

  return resume.state === "open" ? (
    <p
      className="rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-200"
      data-testid="resume-window-open"
    >
      Reconnecting within the next {formatMs(resume.remainingMs)} picks this session back up, with its
      history intact. After that the server forgets it.
    </p>
  ) : (
    <p
      className="rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground"
      data-testid="resume-window-elapsed"
    >
      The {formatMs(resumeWindowMs ?? 0)} resume window has elapsed. Connecting now starts a new
      session — the previous conversation is gone from the server.
    </p>
  );
}

export function ConnectionDiagnostics({
  failure,
  resumeWindowMs,
  disconnectedAtMs,
  declaredDurableObjects = __SYRINX_DECLARED_DURABLE_OBJECTS__,
  onUseUrl,
}: {
  readonly failure?: ConnectionFailure;
  /** From the server's own `ready`. Absent means there is no window to report. */
  readonly resumeWindowMs?: number;
  readonly disconnectedAtMs?: number;
  /** Read from `wrangler.jsonc` at build time. Empty when none was readable. */
  readonly declaredDurableObjects?: readonly { readonly worker: string; readonly className: string }[];
  /** Applying a suggested route is the next action, so it is one click. */
  readonly onUseUrl?: (url: string) => void;
}): React.JSX.Element | null {
  // Nothing failed and nothing dropped — there is nothing to report, and an
  // empty "no problems" card would be noise on every healthy session.
  if (!failure && disconnectedAtMs === undefined) return null;

  const candidates = failure?.kind === "upgrade-rejected" || failure?.kind === "unclassified"
    ? agentRouteCandidates(failure.wsUrl, declaredDurableObjects)
    : [];

  return (
    <Card className={cn(failure && "border-destructive/50")}>
      <CardHeader>
        <CardTitle data-testid="connection-failure-headline">
          {failure ? HEADLINE[failure.kind] : "The session dropped"}
        </CardTitle>
        <CardDescription>
          {failure
            ? CAUSE[failure.kind]
            : "The socket closed after the session was running. Nothing about the address or the agent is wrong."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {failure && (
          <>
            <p className="text-sm" data-testid="connection-failure-next">
              {NEXT[failure.kind]}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="connection-failure-target">
              Tried <code className="rounded bg-muted px-1">{failure.wsUrl}</code>
              {failure.retryingAttempt !== undefined
                ? ` — still retrying (attempt ${String(failure.retryingAttempt)}).`
                : " — the client has stopped retrying."}
            </p>

            {failure.serverError && (
              // The startup error is the whole answer for an agent that failed to
              // build, so it is shown verbatim rather than summarised.
              <div
                className="rounded bg-destructive/10 px-2 py-1.5 text-xs"
                data-testid="connection-failure-server-error"
              >
                <p className="font-medium">The server said:</p>
                <p className="mt-0.5">{failure.serverError.message}</p>
                {(failure.serverError.component !== undefined ||
                  failure.serverError.category !== undefined) && (
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {[failure.serverError.component, failure.serverError.category]
                      .filter((part) => part !== undefined)
                      .join(" · ")}
                  </p>
                )}
              </div>
            )}

            {(failure.kind === "upgrade-rejected" || failure.kind === "unclassified") && (
              <div className="space-y-2" data-testid="agent-route-hint">
                <p className="text-xs text-muted-foreground">
                  A Cloudflare worker built on the Agents SDK serves each agent at{" "}
                  <code className="rounded bg-muted px-1">/agents/&lt;class-name-kebab&gt;/&lt;id&gt;</code>
                  , where the first segment is the exported Durable Object class in kebab-case and the
                  second is any instance name you choose.
                </p>
                {candidates.length > 0 ? (
                  <ul className="space-y-1" data-testid="agent-route-candidates">
                    {candidates.map((candidate) => (
                      <li
                        key={`${candidate.worker}:${candidate.className}`}
                        className="flex flex-wrap items-center gap-2 text-xs"
                        data-testid="agent-route-candidate"
                      >
                        <code className="rounded bg-muted px-1">{candidate.path}</code>
                        <span className="text-muted-foreground">
                          {candidate.className} in {candidate.worker}
                        </span>
                        {onUseUrl && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-auto"
                            onClick={() => onUseUrl(candidate.url)}
                          >
                            Use this path
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Naming a class we did not read would be a guess. Say what is
                  // missing and where the answer lives instead.
                  <p className="text-xs text-muted-foreground" data-testid="agent-route-unknown">
                    No worker config was readable when this studio was built, so there is no class to
                    name here. Take the class from the Durable Object binding in your
                    <code className="mx-1 rounded bg-muted px-1">wrangler.jsonc</code>— a wrong one
                    fails deploy, so that file cannot drift from what is running.
                  </p>
                )}
              </div>
            )}

            {(failure.closeCode !== undefined || failure.transportMessage !== undefined) && (
              <p className="font-mono text-[11px] text-muted-foreground" data-testid="connection-failure-raw">
                {[
                  failure.closeCode !== undefined ? `close ${String(failure.closeCode)}` : undefined,
                  failure.closeReason !== undefined && failure.closeReason !== ""
                    ? failure.closeReason
                    : undefined,
                  failure.transportMessage,
                ]
                  .filter((part) => part !== undefined)
                  .join(" · ")}
              </p>
            )}
          </>
        )}

        <ResumeWindow resumeWindowMs={resumeWindowMs} disconnectedAtMs={disconnectedAtMs} />
      </CardContent>
    </Card>
  );
}
