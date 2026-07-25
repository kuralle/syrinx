// SPDX-License-Identifier: MIT
//
// What the server said this session is. Read-only.
//
// The problem it fixes: a sample-rate or codec mismatch is a common cause of
// silent audio and there was nowhere to see either value, even though the server
// states both in its opening message.
//
// It is also the runtime-drift canary. Node and Workers are one engine with two
// runtimes and neither is privileged, so a field one sends and the other does not
// is a bug rather than a tier — which only holds if absence is reported as absence.
// Nothing here substitutes a zero, a `false` or a dash for a value the server never
// sent, and nothing here is editable: it reports, it does not negotiate.

import type { SessionRecord } from "@kuralle-syrinx/browser-client/record";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hasSessionDetails, sessionInfoRows } from "@/lib/session-info";

export function SessionInfoPanel({ record }: { record: SessionRecord }): React.JSX.Element {
  const rows = sessionInfoRows(record.config);
  const ready = hasSessionDetails(record.config);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session info</CardTitle>
        <CardDescription>
          What the server negotiated when this session opened. A mismatch between these numbers and
          what your agent produces is the usual cause of audio that plays as silence.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!ready ? (
          <p className="text-sm text-muted-foreground" data-testid="session-info-waiting">
            The server has not described this session yet. Connect, and every value it negotiates
            appears here.
          </p>
        ) : (
          <dl className="space-y-1.5 text-xs" data-testid="session-info">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex flex-wrap items-baseline gap-x-2"
                data-testid={`session-info-${row.key}`}
                data-stated={row.value === undefined ? "false" : "true"}
              >
                <dt className="w-44 shrink-0 text-muted-foreground">{row.label}</dt>
                {row.value === undefined ? (
                  // Absent is absent. A placeholder here would read as a measurement.
                  <dd className="italic text-muted-foreground">not stated by this server</dd>
                ) : (
                  <dd className="font-mono break-all">{row.value}</dd>
                )}
                {row.value !== undefined && row.note !== undefined && (
                  <dd className="text-muted-foreground">— {row.note}</dd>
                )}
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
