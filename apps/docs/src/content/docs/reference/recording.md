---
title: Recording a call
description: Write a time-aligned stereo conversation WAV — caller on the left, assistant on the right — plus per-speaker stems, an event log and a manifest.
---

When someone says *"it talked over me"* or *"it cut me off"*, a transcript cannot settle
it and a memory of the call is not evidence. `@kuralle-syrinx/recorder` writes the two
speakers onto one timeline so overlap is visible.

```bash
npm install @kuralle-syrinx/recorder
```

## Attach it

```ts
import { attachRecorder } from '@kuralle-syrinx/recorder';

const session = new VoiceAgentSession({ plugins: { /* … */ } });
const recording = attachRecorder(session, { outputDir: './recordings' });

// … run the conversation …

await session.close();
console.log(recording.files?.conversationAudioPath);
```

`files` is `null` until the session initializes the plugin, and final once it closes —
so read it after `close()`, not before.

## What you get

From a real 11-second turn:

| File | Contents |
| --- | --- |
| `conversation.wav` | 2ch 16 kHz — **caller left, assistant right**, one timeline |
| `user_audio.pcm` | caller stem, mono, at the negotiated uplink rate |
| `assistant_audio.pcm` | assistant stem, mono, at the synthesis rate |
| `events.jsonl` | every bus packet in order (993 on that turn) |
| `manifest.json` | paths, sample rates, durations, byte counts |

The stems keep each side's native rate; the conversation WAV resamples to a common one
so the channels line up.

## The alignment is the point

Assistant audio is re-anchored onto the **playout clock** from `tts.playout_progress`,
not the moment TTS generated it. Those are not the same instant — synthesis finishes
well before the caller has heard the sentence. Positioning by generation time would
draw the agent replying earlier than it actually spoke, which is exactly the error you
are trying to detect when investigating an interruption.

:::note[Headless runs position differently]
With no paced transport wired — a fixture replay, for instance — no playout signal
arrives, and generation-arrival positioning is kept instead. The manifest records which
applied, so a recording never silently misrepresents its own timeline.
:::

## Reading a recording

A clean, non-overlapping turn looks like this when you measure the two channels:

```
LEFT  (caller)     peak 32767   non-silent 23.5%
RIGHT (assistant)  peak 27686   non-silent 25.9%
overlap             0.0%
```

Non-zero overlap means the two spoke at once. That is not automatically a bug — barge-in
*should* produce overlap — but unexplained overlap on a turn where nobody interrupted is
a real finding.

### Transcribe each channel

Levels prove a file is not empty; they cannot catch a channel swap or TTS speaking text
the reasoner never produced. Transcribing each side with an **independent** STT can. On
the recording above, whisper — which never saw the engine's output — returned:

```
LEFT  (caller)     "What's the application deadline for the computer science masters?"
RIGHT (assistant)  "Please specify the University for the application deadline."
```

matching the engine's reported transcript and reply exactly. That is the check worth
automating: it proves the caller landed left, the assistant landed right, and the voice
spoke what the reasoner generated.

`validateVoiceSessionRecorderManifest(manifest)` returns a list of problems, empty when
the manifest is internally consistent. Worth running in CI: a recording that wrote zero
bytes should fail a build rather than pass because the file exists.

## Building the mix yourself

The `./wav` subpath exports `interleaveStereoPcm16` and `pcm16ToWav` if you would rather
assemble the stereo file from the stems on your own terms.

## Next

- [Background observer](/guides/background-observer/) — the other thing you attach to a
  live session, for guardrails rather than evidence.
- [Observability](/reference/observability/) — metrics and the packet stream.
