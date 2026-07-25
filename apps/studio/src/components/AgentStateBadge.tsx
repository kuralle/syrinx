import { useEffect, useState } from "react";

import { isStalled, type AgentStateSnapshot, type AgentState } from "@kuralle-syrinx/browser-client/agent-state";

import { cn } from "@/lib/utils";

// Plain language, never packet names — the reader does not know what
// `eos.turn_complete` is. "deciding you're done" is the endpointing window, and
// naming it is what makes a premature cut-off legible rather than mysterious.
const LABEL: Record<AgentState, string> = {
  idle: "Idle",
  listening: "Listening to you",
  endpointing: "Deciding you're done",
  thinking: "Thinking",
  speaking: "Speaking",
  interrupted: "Interrupted",
};

const TONE: Record<AgentState, string> = {
  idle: "bg-muted text-muted-foreground",
  listening: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  endpointing: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  thinking: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  speaking: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  interrupted: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

export function AgentStateBadge({ snapshot }: { snapshot: AgentStateSnapshot }): React.JSX.Element {
  // The badge must age even when no message arrives — a stuck state is exactly
  // the case where the stream has gone quiet, so re-render on a timer.
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const heldMs = Math.max(0, now - snapshot.sinceMs);
  const stalled = isStalled(snapshot, now);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        TONE[snapshot.state],
        stalled && "ring-2 ring-rose-500/60",
      )}
      title={stalled ? "Held far longer than expected — likely stalled" : undefined}
      data-testid="agent-state-badge"
      data-state={snapshot.state}
      data-stalled={stalled ? "true" : "false"}
    >
      <span className="relative flex h-2 w-2">
        {snapshot.state !== "idle" && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
      {LABEL[snapshot.state]}
      {snapshot.state !== "idle" && (
        <span className="tabular-nums opacity-70">{(heldMs / 1000).toFixed(1)}s</span>
      )}
    </span>
  );
}
