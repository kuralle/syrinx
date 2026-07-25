import { useEffect, useMemo, useState } from "react";

import type { RecordedEvent, SessionRecord } from "@kuralle-syrinx/browser-client/record";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ALL = "__all__";
const SESSION = "__session__";

// The per-frame streams, each with the plain-language noun used in the hidden
// count. Design rule 1 — no packet names in prose — is why this map exists at
// all: the line reads "142 audio frames hidden", never "142 tts_chunk hidden".
// Inside a row the type string *is* the data, so it stays raw there.
// Only types that actually reach the record belong here, and every high-volume
// one must. `ping` and `playout_progress` were listed originally but are
// client→server only (browser-client:477 and :514) — they can never appear in a
// SessionRecord, so suppressing them was dead configuration. `agent_chunk` was
// missing and is emitted once per LLM delta (server-websocket:513), making it
// the largest noise source after audio frames.
const PER_FRAME: Record<string, string> = {
  tts_chunk: "audio frames",
  agent_chunk: "reply tokens",
  stt_chunk: "partial transcripts",
};

const fmt = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

interface Row {
  /** Merge order, so equal timestamps still have a stable, reproducible sort. */
  readonly seq: number;
  readonly atMs: number;
  readonly type: string;
  readonly turnId?: string;
  readonly message: RecordedEvent["message"];
}

/** Every event in the record as one newest-first stream. */
function flatten(record: SessionRecord): readonly Row[] {
  const rows: Row[] = [];
  const push = (ev: RecordedEvent, turnId?: string): void => {
    rows.push({ seq: rows.length, atMs: ev.atMs, type: ev.message.type, turnId, message: ev.message });
  };
  for (const turn of record.turns) for (const ev of turn.events) push(ev, turn.turnId);
  for (const ev of record.sessionEvents) push(ev);
  return rows.sort((a, b) => b.atMs - a.atMs || b.seq - a.seq);
}

/** "142 audio frames, 30 partial transcripts" — counted, never summarised away. */
function describeHidden(counts: ReadonlyMap<string, number>): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${PER_FRAME[type] ?? type}`)
    .join(", ");
}

function EventRow({ row }: { row: Row }): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <li className="border-b border-border/60 last:border-0" data-testid="event-row" data-type={row.type}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 py-1 text-left text-xs hover:bg-muted/50"
      >
        <span className="w-16 shrink-0 tabular-nums text-muted-foreground">+{fmt(row.atMs)}</span>
        <span className="font-mono">{row.type}</span>
        {row.turnId !== undefined && (
          <span className="ml-auto shrink-0 text-muted-foreground" data-testid="event-turn">
            turn {row.turnId}
          </span>
        )}
      </button>
      {open && (
        <pre
          className="overflow-x-auto rounded bg-muted p-2 text-[11px] leading-tight"
          data-testid="event-payload"
        >
          {JSON.stringify(row.message, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function EventLog({ record }: { record: SessionRecord }): React.JSX.Element {
  const [turnFilter, setTurnFilter] = useState<string>(ALL);
  const [typeFilter, setTypeFilter] = useState<string>(ALL);
  const [showPerFrame, setShowPerFrame] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const rows = useMemo(() => flatten(record), [record]);

  // A turnId belongs to one session, so a selection cannot outlive a reconnect —
  // keeping it would filter the new session down to nothing forever. The type
  // filter is session-independent and deliberately does survive.
  const turnIds = useMemo(() => record.turns.map((t) => t.turnId), [record]);
  const turn = turnFilter !== ALL && turnFilter !== SESSION && !turnIds.includes(turnFilter) ? ALL : turnFilter;

  const byTurn = rows.filter((r) =>
    turn === ALL ? true : turn === SESSION ? r.turnId === undefined : r.turnId === turn,
  );
  const byType = byTurn.filter((r) => (typeFilter === ALL ? true : r.type === typeFilter));

  // Asking for a per-frame type by name is an explicit request to see it — the
  // default hide must not turn that into an empty panel.
  const suppressing = !showPerFrame && !(typeFilter in PER_FRAME);
  const perFrame = new Map<string, number>();
  for (const r of byType) if (r.type in PER_FRAME) perFrame.set(r.type, (perFrame.get(r.type) ?? 0) + 1);
  const visible = suppressing ? byType.filter((r) => !(r.type in PER_FRAME)) : byType;

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return counts;
  }, [rows]);
  // Keep a filter the current record has no events for, so the selection is still
  // visible (and reversible) after a reconnect clears the stream.
  const typeOptions = [...new Set([...types.keys(), ...(typeFilter === ALL ? [] : [typeFilter])])].sort();

  const droppedEvents = record.turns.reduce((n, t) => n + t.droppedEvents, 0);

  useEffect(() => {
    if (copied === null) return;
    const id = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copyTurn = (): void => {
    const selected = record.turns.find((t) => t.turnId === turn);
    if (!selected) return;
    // Ship the negotiated config with the turn. A turn pasted into a bug report
    // without its sample rate and endpointing owner is silently misleading —
    // the same reason a captured fixture carries its capture config.
    void navigator.clipboard?.writeText(
      JSON.stringify({ config: record.config, turn: selected }, null, 2),
    );
    setCopied(selected.turnId);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Event log</CardTitle>
        <CardDescription>
          Everything the server sent, newest first. The timeline answers most questions faster — reach
          here for the ones it does not cover.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="Filter by turn"
            value={turn}
            onChange={(e) => setTurnFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2"
          >
            <option value={ALL}>All turns</option>
            <option value={SESSION}>Session-wide only</option>
            {turnIds.map((id) => (
              <option key={id} value={id}>
                Turn {id}
              </option>
            ))}
          </select>

          {/* The options list raw type strings on purpose: this filters the raw
              stream, so the vocabulary is the data's, not the reader's. */}
          <select
            aria-label="Filter by message type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 font-mono"
          >
            <option value={ALL}>All types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t} ({types.get(t) ?? 0})
              </option>
            ))}
          </select>

          <Button
            variant="outline"
            size="sm"
            onClick={copyTurn}
            disabled={turn === ALL || turn === SESSION}
            title={
              turn === ALL || turn === SESSION
                ? "Pick a turn first — this copies everything that turn recorded, ready to paste into a bug report."
                : undefined
            }
            data-testid="copy-turn"
          >
            {copied !== null ? `Copied turn ${copied}` : "Copy turn as JSON"}
          </Button>
        </div>

        {perFrame.size > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="per-frame-count">
              {describeHidden(perFrame)} {suppressing ? "hidden" : "shown"}
            </span>
            <button
              type="button"
              onClick={() => setShowPerFrame((v) => !v)}
              className="underline underline-offset-2 hover:text-foreground"
              data-testid="per-frame-toggle"
            >
              {suppressing ? "Show" : "Hide"}
            </button>
          </div>
        )}

        {(record.droppedTurns > 0 || droppedEvents > 0) && (
          <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="event-log-dropped">
            Oldest entries were discarded to bound memory ({record.droppedTurns} turns,{" "}
            {droppedEvents} events). What is below is the most recent.
          </p>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="event-log-empty">
            Nothing on the wire yet. Connect and speak — or send a text turn — and every message the
            server sends lands here in order, with its full payload one click away.
          </p>
        ) : visible.length === 0 && perFrame.size > 0 ? (
          // Entries DO match — they are suppressed. Saying "no match" here while
          // the line above reads "142 audio frames hidden" contradicts itself and
          // sends the reader looking for a filter bug that does not exist.
          <p className="text-sm text-muted-foreground" data-testid="event-log-all-suppressed">
            Everything here is a per-frame stream, hidden by default. Use Show above to see it.
          </p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="event-log-no-match">
            No entries match these filters. Widen them to see the rest of the stream.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {visible.map((r) => (
              <EventRow key={`${r.turnId ?? "session"}-${r.seq}`} row={r} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
