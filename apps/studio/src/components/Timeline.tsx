import { buildTurnTimeline, type TurnTimeline } from "@kuralle-syrinx/browser-client/turn-timeline";
import type { SessionRecord, TurnRecord } from "@kuralle-syrinx/browser-client/record";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";

function Lane({ timeline }: { timeline: TurnTimeline }): React.JSX.Element {
  const span = Math.max(
    timeline.totalMs,
    ...timeline.segments.map((s) => s.startMs + s.durationMs),
    1,
  );

  return (
    <div className="space-y-1" data-testid="timeline-lane" data-turn={timeline.turnId}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">Turn {timeline.turnId}</span>
        {timeline.unavailable ? (
          <span className="text-muted-foreground">
            {timeline.unavailable === "no-metrics"
              ? "no timing data from this backend"
              : "not enough timing marks"}
          </span>
        ) : (
          <span className="tabular-nums text-muted-foreground">{formatMs(timeline.totalMs)}</span>
        )}
      </div>

      {timeline.suspiciouslyFast && (
        <p
          className="rounded bg-rose-500/10 px-2 py-1 text-xs text-rose-700 dark:text-rose-300"
          data-testid="fast-turn-warning"
        >
          Replied in {formatMs(timeline.suspiciouslyFast.totalMs)} — below the{" "}
          {formatMs(timeline.suspiciouslyFast.floorMs)} floor. The endpointer probably fired while you
          were still speaking. Check <code>minSpeechMs</code> and the endpointing owner.
        </p>
      )}

      {timeline.unavailable === "no-metrics" ? (
        // Never draw an empty bar here — it would read as a zero-latency turn.
        <p className="text-xs text-muted-foreground">
          This backend does not send per-turn timings, so there is nothing to chart.
        </p>
      ) : (
        <div className="space-y-0.5">
          {timeline.segments.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <span className="w-56 shrink-0 truncate text-muted-foreground" title={s.label}>
                {s.label}
              </span>
              <span className="relative h-3 flex-1 overflow-hidden rounded bg-muted">
                <span
                  className={cn(
                    "absolute inset-y-0 rounded",
                    s.slowest ? "bg-amber-500/70" : "bg-sky-500/50",
                  )}
                  style={{
                    left: `${(s.startMs / span) * 100}%`,
                    width: `${Math.max(0.5, (s.durationMs / span) * 100)}%`,
                  }}
                />
              </span>
              <span
                className={cn("w-16 shrink-0 text-right tabular-nums", s.slowest && "font-semibold")}
              >
                {formatMs(s.durationMs)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A typed turn skips being *heard*, not being *spoken*: sending text pushes an
// immediate end-of-turn into the same pipeline, so the reasoner and the voice both
// run for real (verified live — a typed turn returns ~108KB of speech).
//
// So there is nothing to strip. The server omits a mark it never measured rather
// than sending a zero, and the lane below already renders only the marks present —
// which for a typed turn is a genuine "text ready → first audio → done" waterfall.
// Deleting those would hide a real measurement, which is the same lie as a fake one
// pointed the other way.
function TypedTurnNote(): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground" data-testid="timeline-text-turn">
      Typed turn — nothing transcribed you and nothing judged when you finished, so those steps are
      absent below. The reply was still spoken, so the voice timings are real.
    </p>
  );
}

export function Timeline({
  record,
  textTurnIds,
}: {
  record: SessionRecord;
  /** Turns the user typed. Only the studio knows — the wire cannot tell them apart. */
  textTurnIds?: ReadonlySet<string>;
}): React.JSX.Element {
  const timelines = record.turns.map((turn) => ({
    turn,
    isText: textTurnIds?.has(turn.turnId) ?? false,
    timeline: buildTurnTimeline(turn),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Turn timeline</CardTitle>
        <CardDescription>Where each turn spent its time. The slowest step is highlighted.</CardDescription>
      </CardHeader>
      <CardContent>
        {timelines.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="timeline-empty">
            No turns yet. Speak, or send a text turn — each one gets a lane here showing how long it
            took to hear you, decide you were done, think, and reply.
          </p>
        ) : (
          <div className="space-y-4">
            {timelines.map(({ turn, isText, timeline }) => (
              <div key={turn.turnId} className="space-y-1" data-mode={isText ? "text" : "voice"}>
                {isText && <TypedTurnNote />}
                <Lane timeline={timeline} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
