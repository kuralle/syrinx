// SPDX-License-Identifier: MIT
//
// TranscriptPanel — renders the conversation from `SessionRecord.turns`, not from a
// parallel fold of the messages. The record is the single source of "what happened";
// this panel is a view of it. Everything it shows — interim text, confidence, the
// barge-in marker with its elapsed time, and all four tool-cue phases — is already on
// the TurnRecord. If something is missing, it belongs in session-record.ts, not here.
//
// Design rule (syrinx-studio design doc): never packet names in the UI. The reader does
// not know what `tool_call_delayed` or a `barge_in` reason is, so this file translates
// every phase and reason into plain language.

import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Octagon,
  Timer,
} from "lucide-react";
import type { SessionRecord, ToolCall, TurnRecord } from "@kuralle-syrinx/browser-client/record";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";

interface TranscriptPanelProps {
  readonly record: SessionRecord;
}

// The record's `phase` arrives from the `tool_call_*` cues. A backend that only sends
// `agent_tool_call` / `agent_tool_result` never sets a phase — derive one there so the
// indicator still arms and clears instead of hanging on "working" forever.
type ToolPhase = "started" | "delayed" | "complete" | "failed";

function toolPhase(tool: ToolCall): ToolPhase {
  if (tool.phase) return tool.phase;
  return tool.result === undefined ? "started" : "complete";
}

// The only interruption reason the server emits today is `barge_in`. Translate the ones
// we know; for anything new, fall back to underscores-as-spaces rather than showing raw
// snake_case. Known reasons stay plain language; unknown ones stay honest, not fabricated.
function interruptionReason(reason?: string): string {
  if (!reason) return "you started speaking";
  if (reason === "barge_in") return "you started speaking";
  return reason.replace(/_/g, " ");
}

interface PhaseStyle {
  readonly label: string;
  readonly variant: "default" | "warning" | "success" | "destructive";
  readonly Icon: typeof Loader2;
  /** Active cues keep moving (a spinner); settled cues are static. */
  readonly spin: boolean;
}

const PHASE_STYLE: Record<ToolPhase, PhaseStyle> = {
  started: { label: "working", variant: "default", Icon: Loader2, spin: true },
  delayed: { label: "slow", variant: "warning", Icon: Timer, spin: false },
  complete: { label: "done", variant: "success", Icon: CheckCircle2, spin: false },
  failed: { label: "failed", variant: "destructive", Icon: AlertTriangle, spin: false },
};

function ToolCue({ tool }: { readonly tool: ToolCall }): React.JSX.Element {
  const phase = toolPhase(tool);
  const style = PHASE_STYLE[phase];
  const name = tool.name ?? "tool";
  const { Icon } = style;

  return (
    <div
      className="ml-auto max-w-[85%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900/40"
      data-testid="transcript-tool"
      data-tool-name={name}
      data-phase={phase}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          className={cn("h-3.5 w-3.5 shrink-0", style.spin && "animate-spin")}
          aria-hidden
        />
        <code className="text-xs font-semibold">{name}</code>
        <Badge variant={style.variant}>
          {style.label}
          {phase === "delayed" && tool.afterMs !== undefined ? (
            <> · {formatMs(tool.afterMs)}</>
          ) : null}
        </Badge>
      </div>
      {(tool.args !== undefined || tool.result !== undefined) && (
        <div className="mt-2 space-y-1">
          {tool.args !== undefined && (
            <details className="text-xs" data-testid="transcript-tool-args">
              <summary className="cursor-pointer text-muted-foreground">arguments</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-[11px] leading-snug">
                {safeJson(tool.args)}
              </pre>
            </details>
          )}
          {tool.result !== undefined && (
            <details className="text-xs" data-testid="transcript-tool-result">
              <summary className="cursor-pointer text-muted-foreground">result</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-[11px] leading-snug">
                {safeJson(tool.result)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function InterruptionMarker({ turn }: { readonly turn: TurnRecord }): React.JSX.Element | null {
  if (!turn.interrupted) return null;
  // atMs is ms-since-record-start; startedAtMs is when this turn's first message landed.
  // The difference is how far into the turn the agent got before yielding — the number
  // that decides whether barge-in felt responsive.
  const elapsedMs = Math.max(0, turn.interrupted.atMs - turn.startedAtMs);
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
      data-testid="transcript-interruption"
      data-turn={turn.turnId}
    >
      <Octagon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Interrupted — {interruptionReason(turn.interrupted.reason)} after{" "}
        <span className="font-semibold tabular-nums" data-testid="transcript-interruption-elapsed">
          {formatMs(elapsedMs)}
        </span>
      </span>
    </div>
  );
}

function TurnGroup({ turn }: { readonly turn: TurnRecord }): React.JSX.Element {
  const hasUserText = turn.userTranscript !== undefined || turn.userInterim !== undefined;
  const interim = turn.userTranscript === undefined && turn.userInterim !== undefined;
  const hasAgentText = turn.agentText.length > 0;
  const hasTools = turn.toolCalls.length > 0;
  const agentStreaming = hasAgentText && !turn.complete;

  return (
    <div className="space-y-2" data-testid="transcript-turn" data-turn={turn.turnId}>
      {hasUserText && (
        <div
          data-testid={interim ? "transcript-user-interim" : "transcript-user"}
          className={cn(
            "max-w-[85%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
            "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40",
            interim && "opacity-60 italic",
          )}
        >
          <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>You{interim ? " · listening" : ""}</span>
            {turn.userConfidence !== undefined && !interim && (
              <span className="font-normal normal-case tabular-nums">
                {Math.round(turn.userConfidence * 100)}% confident
              </span>
            )}
          </div>
          {interim ? turn.userInterim : turn.userTranscript}
        </div>
      )}

      {hasTools && (
        <div className="space-y-1.5">
          {turn.toolCalls.map((tool, i) => (
            <ToolCue key={tool.id ?? `${tool.name ?? "tool"}-${i}`} tool={tool} />
          ))}
        </div>
      )}

      {hasAgentText && (
        <div
          data-testid="transcript-assistant"
          className={cn(
            "ml-auto max-w-[85%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
            "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40",
            agentStreaming && "opacity-90",
          )}
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Assistant{agentStreaming ? " · speaking" : ""}
          </div>
          {turn.agentText}
        </div>
      )}

      <InterruptionMarker turn={turn} />
    </div>
  );
}

export function TranscriptPanel({ record }: TranscriptPanelProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const turns = record.turns;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    // Re-scroll whenever the turn count, any turn's text, or the cue/interruption
    // state changes — i.e. whenever the panel's height could grow.
  }, [turns]);

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader>
        <CardTitle>Live transcript</CardTitle>
        <CardDescription>
          What was heard, what the agent is doing, and where it yielded — straight from the session record.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="min-h-[420px] flex-1 space-y-3 overflow-y-auto rounded-md border bg-background p-4"
          data-testid="transcript-panel"
        >
          {turns.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              Connect and speak — transcripts, tool calls, and barge-ins appear here as the session
              progresses.
            </p>
          ) : (
            turns.map((turn) => <TurnGroup key={turn.turnId} turn={turn} />)
          )}
        </div>
      </CardContent>
    </Card>
  );
}
