// SPDX-License-Identifier: MIT
//
// Conversation mode and the typed-turn composer. Most iteration is on prompts and
// tools, which needs no audio — but every voice iteration pays transcription and
// speech-synthesis latency and cost. Typing skips both.
//
// It skips them at a price, and this card is where that price is stated. Typing
// replaces the *input* half only — verified live: a typed turn still synthesises and
// returns speech. So nothing transcribes you and nothing decides when you stopped,
// but the reply is spoken for real. A developer who only ever types has tested the
// agent's thinking and its voice, and never tested it being heard.
//
// Design rule (syrinx-studio design doc): never packet names in the UI. Nothing
// here names a message type; it says what the machine did, in words.
//
// The mode toggle lives here rather than in the connection bar on purpose — mode
// decides whether the microphone is open, and the microphone's state is shown two
// inches away from the control that changed it.

import { useState } from "react";
import { Mic, MicOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ConversationMode } from "@/hooks/useSyrinxSession";

interface TextComposerProps {
  readonly mode: ConversationMode;
  readonly connected: boolean;
  readonly micActive: boolean;
  readonly onModeChange: (mode: ConversationMode) => void;
  readonly onSend: (text: string) => void;
}

export function TextComposer({
  mode,
  connected,
  micActive,
  onModeChange,
  onSend,
}: TextComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const sendable = connected && draft.trim() !== "";

  const send = (): void => {
    if (!sendable) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation mode</CardTitle>
        <CardDescription>
          Talk to the agent, or type to it. Switching keeps the same session — the transcript,
          timeline and metrics above carry straight on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Conversation mode">
          <Button
            size="sm"
            variant={mode === "voice" ? "default" : "outline"}
            aria-pressed={mode === "voice"}
            data-testid="mode-voice"
            onClick={() => onModeChange("voice")}
          >
            Voice
          </Button>
          <Button
            size="sm"
            variant={mode === "text" ? "default" : "outline"}
            aria-pressed={mode === "text"}
            data-testid="mode-text"
            onClick={() => onModeChange("text")}
          >
            Text
          </Button>
          {/* A silently hot microphone is the failure this line exists to prevent. */}
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 text-xs",
              micActive ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground",
            )}
            data-testid="mic-status"
          >
            {micActive ? (
              <>
                <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Microphone on
              </>
            ) : (
              <>
                <MicOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Microphone off
              </>
            )}
          </span>
        </div>

        {mode === "text" ? (
          <>
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  send();
                }}
                disabled={!connected}
                spellCheck={false}
                aria-label="Message to the agent"
                placeholder={connected ? "Type a turn, press Enter to send" : "Connect to send a turn"}
                data-testid="text-composer-input"
              />
              <Button onClick={send} disabled={!sendable} data-testid="text-composer-send">
                Send
              </Button>
            </div>
            {/* Rule 5 of the design doc: text mode must state what it does not test. */}
            <p
              className="rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-200"
              data-testid="text-mode-trade"
            >
              Typing goes straight to the agent: nothing transcribes you and nothing judges when you
              finished talking, so mishearings and turn-taking are untested here. A turn that works
              typed can still fail out loud. The reply is still spoken, so you will hear it and its
              voice timings are real — but you cannot interrupt what you did not start by talking.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="voice-mode-note">
            The microphone streams continuously and the server decides where your turn ends. Switch to
            text to iterate on prompts and tools without paying for transcription.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
