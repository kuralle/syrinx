import { useMemo, useState } from "react";

import { AudioVisualizer } from "@/components/AudioVisualizer";
import { ConnectionBar } from "@/components/ConnectionBar";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSyrinxSession } from "@/hooks/useSyrinxSession";
import {
  DEFAULT_LOCAL_WS_URL,
  resolveInitialWsUrl,
  wsUrlForTarget,
  type WsTarget,
} from "@/lib/ws-url";

export function SessionView() {
  const initial = useMemo(() => resolveInitialWsUrl(), []);
  const [target, setTarget] = useState<WsTarget>(initial.target);
  const [localUrl, setLocalUrl] = useState(
    initial.target === "local" ? initial.url : DEFAULT_LOCAL_WS_URL,
  );
  const [customUrl, setCustomUrl] = useState(
    initial.target === "custom" ? initial.url : "",
  );

  const wsUrl = useMemo(
    () => (target === "custom" ? customUrl.trim() : wsUrlForTarget(target, localUrl)),
    [customUrl, localUrl, target],
  );

  const session = useSyrinxSession(wsUrl);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <ConnectionBar
        target={target}
        localUrl={localUrl}
        customUrl={customUrl}
        status={session.status}
        sessionId={session.sessionId}
        errorMessage={session.errorMessage}
        onTargetChange={setTarget}
        onLocalUrlChange={setLocalUrl}
        onCustomUrlChange={setCustomUrl}
        onConnect={() => void session.connect()}
        onDisconnect={session.disconnect}
        onClearTranscript={session.clearTranscript}
        onPlaySample={() => void session.playSample()}
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <TranscriptPanel state={session.transcript} />

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Audio</CardTitle>
              <CardDescription>
                Mic uplink at {session.inputSampleRateHz} Hz · assistant playback with jitter buffer.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AudioVisualizer
                micAnalyser={session.micAnalyser}
                playbackLevel={session.playbackLevel}
                active={session.micActive || session.playbackLevel > 0}
              />
              <p className="text-xs text-muted-foreground">
                {session.micActive
                  ? "Microphone streaming — server VAD decides turn boundaries."
                  : session.status === "connected"
                    ? "Waiting for microphone…"
                    : "Connect to start a session."}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
