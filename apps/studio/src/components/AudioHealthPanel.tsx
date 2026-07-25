// SPDX-License-Identifier: MIT
//
// Why you cannot hear anything, or be heard — with the fix for that exact cause.
//
// A denied microphone used to leave the user looking at a silent screen with no
// recovery path, and a blocked mic used to flip the whole session to "error" even
// though the socket was fine. Both are wrong for the same reason: a session with
// no microphone is still a session. Text mode needs no microphone at all, so the
// way out is always offered here, next to the problem.
//
// The output half exists because silence and "audio is arriving and you cannot
// hear it" are opposite bugs that look identical. The server tells us how much
// speech it sent; the client knows how much arrived and whether any of it carried
// signal. Reporting only one of those would hide the other.
//
// Design rule 1 — never a packet name in the prose. The server's audio messages
// are "speech the server says it sent", never their type name.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  diagnoseAudioOutput,
  type AudioOutputCondition,
  type MicFailure,
  type MicFailureKind,
} from "@/lib/audio-health";
import type { ConversationMode } from "@/hooks/useSyrinxSession";

const MIC_PROBLEM: Record<MicFailureKind, string> = {
  denied: "This page is blocked from using the microphone",
  "no-device": "No microphone is attached",
  "in-use": "Something else is holding the microphone",
  "insecure-context": "This page is not allowed a microphone on an insecure address",
  unsupported: "This browser gave no way to ask for a microphone",
  unknown: "The microphone request failed",
};

const MIC_RECOVERY: Record<MicFailureKind, string> = {
  denied:
    "Open the site controls in the address bar — the padlock, or the blocked-microphone icon — set Microphone to Allow, then reload this page. The browser will not ask again on its own once it has been refused.",
  "no-device":
    "Plug in a microphone, or enable the built-in one in your system sound settings, then switch back to voice. The browser only sees devices that exist when it asks.",
  "in-use":
    "Close whatever is holding it — a call, a recording app, another tab of this studio — then switch back to voice. Only one program at a time gets exclusive access on some systems.",
  "insecure-context":
    "Browsers only hand out a microphone over https, or on localhost and 127.0.0.1. Reach this page by one of those.",
  unsupported:
    "Use a current Chrome, Edge, Firefox or Safari. Voice mode needs the browser's microphone API; text mode does not.",
  unknown:
    "The browser did not name a cause. The message it gave is below — reload and retry, and check the device in your system sound settings.",
};

const OUTPUT_PROBLEM: Partial<Record<AudioOutputCondition, string>> = {
  "not-reaching-page": "The server sent speech that never arrived here",
  "arriving-silent": "Audio is arriving, but every frame of it is silent",
  "playback-suspended": "Audio is arriving and playback is paused by the browser",
  silent: "The agent has not produced any speech",
};

const OUTPUT_EXPLANATION: Partial<Record<AudioOutputCondition, string>> = {
  "not-reaching-page":
    "The server accounted for speech it sent, and no audio frames reached this page at all. That is a broken downlink, not a quiet agent — the usual causes are a codec or envelope the client did not expect, or something between you stripping binary frames.",
  "arriving-silent":
    "Frames are arriving and decoding, and every one of them is digital silence. The speech synthesiser produced nothing audible, or the sample rate it declared does not match the bytes it sent.",
  "playback-suspended":
    "The audio is here and decoded. The browser is holding playback because the page has had no user interaction yet, so nothing reaches the speakers.",
  silent:
    "A turn completed and the server reported no speech for it. This is real silence upstream, not a playback problem — check the speech synthesiser and its key.",
};

function MicSection({
  micFailure,
  mode,
  onModeChange,
}: {
  readonly micFailure: MicFailure;
  readonly mode: ConversationMode;
  readonly onModeChange?: (mode: ConversationMode) => void;
}): React.JSX.Element {
  return (
    <div
      className="space-y-2 rounded bg-destructive/10 px-2 py-1.5"
      data-testid="mic-failure"
      data-kind={micFailure.kind}
    >
      <p className="text-sm font-medium" data-testid="mic-failure-problem">
        {MIC_PROBLEM[micFailure.kind]}
      </p>
      <p className="text-xs" data-testid="mic-failure-recovery">
        {MIC_RECOVERY[micFailure.kind]}
      </p>
      {/* The way out that always works: text mode holds no microphone at all. */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground" data-testid="mic-failure-text-mode">
          Text mode needs no microphone — you can keep working on prompts and tools right now, and
          only lose transcription and turn-taking.
        </p>
        {mode !== "text" && onModeChange && (
          <Button variant="outline" size="sm" onClick={() => onModeChange("text")}>
            Switch to text
          </Button>
        )}
      </div>
      {micFailure.kind === "unknown" && micFailure.detail !== "" && (
        <p className="font-mono text-[11px] text-muted-foreground" data-testid="mic-failure-detail">
          {micFailure.detail}
        </p>
      )}
    </div>
  );
}

export function AudioHealthPanel({
  micFailure,
  mode,
  serverAudioBytes,
  framesReceived,
  peakLevel,
  playbackState,
  turnCount,
  onModeChange,
  onResumePlayback,
}: {
  readonly micFailure?: MicFailure;
  readonly mode: ConversationMode;
  /** Bytes of speech the server said it sent this session. */
  readonly serverAudioBytes: number;
  readonly framesReceived: number;
  readonly peakLevel: number;
  readonly playbackState?: AudioContextState;
  readonly turnCount: number;
  readonly onModeChange?: (mode: ConversationMode) => void;
  readonly onResumePlayback?: () => void;
}): React.JSX.Element | null {
  const condition = diagnoseAudioOutput({
    serverAudioBytes,
    framesReceived,
    peakLevel,
    playbackState,
    turnCount,
  });
  const outputProblem = OUTPUT_PROBLEM[condition];

  // Nothing wrong with either half — no card. A permanent "audio: fine" panel
  // would be noise, and this one has to be worth looking at when it appears.
  if (!micFailure && outputProblem === undefined) return null;

  return (
    <Card className="border-destructive/50" data-testid="audio-health">
      <CardHeader>
        <CardTitle>Audio</CardTitle>
        <CardDescription>
          What is stopping sound getting in or out, and what to do about it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {micFailure && <MicSection micFailure={micFailure} mode={mode} onModeChange={onModeChange} />}

        {outputProblem !== undefined && (
          <div className="space-y-2" data-testid="audio-output-condition" data-condition={condition}>
            <p className="text-sm font-medium" data-testid="audio-output-problem">
              {outputProblem}
            </p>
            <p className="text-xs" data-testid="audio-output-explanation">
              {OUTPUT_EXPLANATION[condition]}
            </p>
            {condition === "playback-suspended" && onResumePlayback && (
              <Button size="sm" onClick={onResumePlayback} data-testid="resume-playback">
                Start playback
              </Button>
            )}
            {condition === "not-reaching-page" && (
              // The measured pair, because the whole claim rests on it.
              <p className="text-xs text-muted-foreground" data-testid="audio-output-counts">
                {serverAudioBytes} bytes reported sent, 0 frames received.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
