# @kuralle-syrinx/recorder

Stereo call recorder for [Syrinx](https://github.com/kuralle/syrinx). Writes a
time-aligned conversation WAV — caller on the left channel, assistant on the right —
plus per-speaker stems, an event log, and a manifest.

When someone reports *"it talked over me"* or *"it cut me off"*, this is the artifact
that settles it. The two channels are positioned on one timeline, so overlap is
visible rather than remembered.

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

`files` is `null` until the session initializes the plugin and final once it closes.

## What lands on disk

From a real 11-second turn:

```
conversation.wav      2ch 16000Hz 11.04s   caller left, assistant right
user_audio.pcm        4.72s                caller stem, mono
assistant_audio.pcm   11.04s               assistant stem, mono
events.jsonl          993 packets          every bus packet, in order
manifest.json                              paths, rates, durations, byte counts
```

The stems are raw PCM16 at the rate each side actually used — the caller's uplink rate
and the assistant's synthesis rate can differ, and the conversation WAV resamples to a
common one so the two line up.

## Why the alignment is not just concatenation

Assistant audio is re-anchored onto the **playout clock** using
`tts.playout_progress`, not the moment TTS generated it. Those differ: synthesis
finishes long before the caller has heard the sentence. Positioning by generation time
would show the agent replying earlier than it actually spoke, which is precisely the
thing you are trying to measure when investigating an interruption.

When no paced transport is wired — a headless fixture run, for instance — no playout
signal arrives and generation-arrival positioning is kept instead. The manifest records
which applied.

## Configuration

```ts
attachRecorder(session, {
  outputDir: './recordings',
  sessionId: 'call-1234',        // optional, recorded in the manifest
  userSampleRateHz: 16000,       // defaults to the negotiated uplink rate
  assistantSampleRateHz: 24000,  // defaults to the synthesis rate
});
```

Filenames (`eventsFile`, `userAudioFile`, `assistantAudioFile`, `manifestFile`,
`conversationFile`) are all overridable.

## Checking a recording

`validateVoiceSessionRecorderManifest(manifest)` returns a list of problems — empty when
the manifest is internally consistent. Useful in CI, where a recording that silently
wrote zero bytes should fail the build rather than pass as "a file exists".

The `./wav` subpath exports `interleaveStereoPcm16` and `pcm16ToWav` if you want to
build the stereo mix yourself from the stems.

## License

MIT
