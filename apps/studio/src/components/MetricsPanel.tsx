import type { SessionRecord } from "@kuralle-syrinx/browser-client/record";
import { buildSessionMetrics } from "@kuralle-syrinx/browser-client/session-metrics";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

export function MetricsPanel({ record }: { record: SessionRecord }): React.JSX.Element {
  const m = buildSessionMetrics(record.turns);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session metrics</CardTitle>
        <CardDescription>
          Median and p95 per stage. A one-off spike and a real regression look the same on a single
          turn.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {m.unavailable ? (
          // Say why rather than render a table of zeroes, which would read as
          // "everything is instant".
          <p className="text-sm text-muted-foreground" data-testid="metrics-unavailable">
            {m.turnCount === 0
              ? "No turns yet."
              : `${m.turnCount} turn${m.turnCount === 1 ? "" : "s"} recorded, but this backend sent no per-turn timings, so there is nothing to aggregate.`}
          </p>
        ) : (
          <>
            <table className="w-full text-xs" data-testid="metrics-table">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal">Stage</th>
                  <th className="text-right font-normal">n</th>
                  <th className="text-right font-normal">median</th>
                  <th className="text-right font-normal">p95</th>
                  <th className="text-right font-normal">max</th>
                </tr>
              </thead>
              <tbody>
                {m.stages.map((s) => (
                  <tr key={s.stage} data-testid={`metrics-row-${s.stage}`}>
                    <td className="py-0.5">{s.label}</td>
                    <td className="py-0.5 text-right tabular-nums text-muted-foreground">{s.count}</td>
                    <td className="py-0.5 text-right tabular-nums">{fmt(s.medianMs)}</td>
                    <td className="py-0.5 text-right tabular-nums">{fmt(s.p95Ms)}</td>
                    <td className="py-0.5 text-right tabular-nums text-muted-foreground">{fmt(s.maxMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {m.measuredTurnCount < m.turnCount && (
              <p className="text-xs text-muted-foreground" data-testid="metrics-partial">
                Based on {m.measuredTurnCount} of {m.turnCount} turns — the rest carried no timings.
              </p>
            )}

            {m.suspiciouslyFastTurnIds.length > 0 && (
              <p
                className="rounded bg-rose-500/10 px-2 py-1 text-xs text-rose-700 dark:text-rose-300"
                data-testid="metrics-fast-warning"
              >
                {m.suspiciouslyFastTurnIds.length} turn
                {m.suspiciouslyFastTurnIds.length === 1 ? "" : "s"} replied under {fmt(m.floorMs)} (
                {m.suspiciouslyFastTurnIds.join(", ")}). That is usually the endpointer firing while
                the caller is still speaking — not a fast agent.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
