// SPDX-License-Identifier: MIT
//
// Every error the server reported, kept for as long as the session lasts.
//
// Not a toast. A toast is exactly wrong here: the failure a developer needs is
// usually the one that happened ninety seconds ago, while they were listening
// rather than watching. So these persist, stay correlated to their turn, and are
// still there when the session ends.
//
// A survivable blip and a crash must not look the same. The session's own rule is
// that a non-recoverable error closes it, so that is the line drawn here — and
// where the studio cannot re-derive the verdict it says "not known" rather than
// colouring it in on a guess.
//
// Design rule 1 — never a packet name in the prose. The headline says which part
// failed in words; the raw `component · category` stays as machine detail beside
// it, the same way the event log keeps raw type strings inside a row.

import type { SessionRecord } from "@kuralle-syrinx/browser-client/record";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMs } from "@/lib/format";
import { baseComponent, collectAgentErrors, type ErrorSeverity } from "@/lib/agent-errors";
import { cn } from "@/lib/utils";

/** What failed, in words. Anything unrecognised keeps its own name rather than becoming "something". */
const SUBJECT: Record<string, string> = {
  stt: "Transcription failed",
  tts: "Speech synthesis failed",
  llm: "The reasoner failed",
  vad: "Speech detection failed",
  eos: "Turn-end detection failed",
  denoiser: "Noise suppression failed",
  bridge: "The realtime bridge failed",
  pipeline: "A pipeline handler failed",
  iu_ledger: "The turn ledger failed",
  session: "The session could not start",
  transport: "The connection rejected something",
};

/** Why, and what to do about it. */
const CAUSE: Record<string, string> = {
  rate_limit: "The provider is rate limiting or the quota is used up. It will be retried.",
  network_timeout: "The connection to the provider timed out. It will be retried.",
  authentication: "The provider rejected the credentials — check the API key for this component.",
  invalid_input: "The input was rejected as invalid — check the audio format and sample rate.",
  internal_fault: "The provider returned an unexpected failure. Its own status page is the next place to look.",
  resource_exhausted: "The provider's credits or quota are gone. Top up or switch provider.",
  initialization: "Building the agent threw before the session was ready — usually a missing key or a bad provider option.",
  startup_timeout: "Building the agent took longer than the startup budget allows.",
  session_timeout: "The session ran past its maximum duration and the server ended it.",
  idle_timeout: "Nothing arrived from this page for longer than the idle limit, so the server ended it.",
};

const SEVERITY_LABEL: Record<ErrorSeverity, string> = {
  recoverable: "Session survived",
  fatal: "Ended the session",
  unknown: "Effect not known",
};

const SEVERITY_TONE: Record<ErrorSeverity, string> = {
  recoverable: "border-amber-500/40 bg-amber-500/10",
  fatal: "border-destructive/50 bg-destructive/10",
  unknown: "border-border bg-muted",
};

const SEVERITY_BADGE: Record<ErrorSeverity, string> = {
  recoverable: "bg-amber-500/20 text-amber-900 dark:text-amber-200",
  fatal: "bg-destructive/20 text-destructive",
  unknown: "bg-muted-foreground/15 text-muted-foreground",
};

export function AgentErrorPanel({ record }: { record: SessionRecord }): React.JSX.Element | null {
  const errors = collectAgentErrors(record);
  // No card on a clean session: an empty "no errors" panel would be a permanent
  // fixture nobody reads, and this one has to earn attention when it appears.
  if (errors.length === 0) return null;

  const fatal = errors.filter((error) => error.severity === "fatal").length;
  const recoverable = errors.filter((error) => error.severity === "recoverable").length;

  return (
    <Card className="border-destructive/50" data-testid="agent-errors">
      <CardHeader>
        <CardTitle>Errors</CardTitle>
        <CardDescription data-testid="agent-errors-summary">
          {errors.length} reported this session
          {fatal > 0 ? `, ${String(fatal)} of which ended it` : ""}
          {recoverable > 0 ? `, ${String(recoverable)} the session survived` : ""}. Newest first, and
          they stay here for the rest of the session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {errors.map((error, index) => {
            const base = baseComponent(error.component);
            const subject = (base !== undefined ? SUBJECT[base] : undefined) ?? "Something failed";
            const cause = error.category !== undefined ? CAUSE[error.category] : undefined;
            return (
              <li
                key={`${String(error.atMs)}-${error.turnId ?? "session"}-${String(index)}`}
                className={cn("space-y-1 rounded border px-2 py-1.5", SEVERITY_TONE[error.severity])}
                data-testid="agent-error"
                data-severity={error.severity}
                data-component={base}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium" data-testid="agent-error-subject">
                    {subject}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      SEVERITY_BADGE[error.severity],
                    )}
                    data-testid="agent-error-severity"
                  >
                    {SEVERITY_LABEL[error.severity]}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground" data-testid="agent-error-where">
                    {error.turnId !== undefined ? `turn ${error.turnId}` : "outside any turn"} · +
                    {formatMs(error.atMs)}
                  </span>
                </div>

                {cause !== undefined && (
                  <p className="text-xs" data-testid="agent-error-cause">
                    {cause}
                  </p>
                )}
                {error.severity === "unknown" && (
                  <p className="text-xs text-muted-foreground" data-testid="agent-error-unknown">
                    This combination is not one the studio can map to "the session carried on" or
                    "the session ended" — check whether the session is still live before trusting it.
                  </p>
                )}

                {/* The server's own words, verbatim: it is the only part that names
                    the actual failing call. */}
                <p className="text-xs" data-testid="agent-error-message">
                  {error.message}
                </p>
                {(error.component !== undefined || error.category !== undefined) && (
                  <p
                    className="font-mono text-[11px] text-muted-foreground"
                    data-testid="agent-error-raw"
                  >
                    {[error.component, error.category].filter((part) => part !== undefined).join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
