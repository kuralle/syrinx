import { useEffect, useRef } from "react";

import { transcriptLines, type TranscriptState } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface TranscriptPanelProps {
  readonly state: TranscriptState;
}

export function TranscriptPanel({ state }: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = transcriptLines(state);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader>
        <CardTitle>Live transcript</CardTitle>
        <CardDescription>User STT and assistant streaming text update in real time.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="min-h-[420px] flex-1 space-y-3 overflow-y-auto rounded-md border bg-background p-4"
          data-testid="transcript-panel"
        >
          {lines.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              Connect and speak — transcripts appear here as the session progresses.
            </p>
          ) : (
            lines.map((line) => (
              <div
                key={line.id}
                data-testid={`transcript-${line.role}${line.interim ? "-interim" : ""}`}
                className={cn(
                  "max-w-[85%] rounded-lg border px-3 py-2 text-sm leading-relaxed",
                  line.role === "user" && "mr-auto border-sky-200 bg-sky-50",
                  line.role === "assistant" && "ml-auto border-emerald-200 bg-emerald-50",
                  line.interim && "opacity-70 italic",
                )}
              >
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {line.role === "user" ? "You" : "Assistant"}
                  {line.interim ? " · listening" : ""}
                </div>
                {line.text}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
