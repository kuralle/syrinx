# VE-04 / G25 — Word-level-timestamp context alignment (completes G2)

- **Status:** Ready · **Priority:** P1 · **Phase:** E (engine)
- **Area:** context-integrity / barge-in · **Findings:** F12; completes catalog G2
- **Depends on:** — (builds on G12 playout clock, already shipped) · **Blocks:** —
- **Catalog:** G25 (and closes the open **G2**)

## Problem / Evidence

On barge-in, the LLM/TTS have generated faster than realtime, so unspoken
assistant text is queued. The conversation context must record **what the user
actually heard, not what was generated** — otherwise the next turn's history
diverges from reality. This is catalog **G2** ("interrupted-turn history
divergence"), documented-but-not-shipped (a partial fix was reverted after a
deadlocking test exposed the real mechanism). Kwindla §4.8.2: use **word-level
timestamps** from TTS to assemble the assistant message text matching audio
actually played; *"if your TTS model doesn't have word-level timestamps, you can't
align the conversation context with what the user heard."* Cartesia/ElevenLabs/Rime
support them.

## Root cause (diagnose)

The engine truncates audio on the playout clock (G12) but still writes the
**full generated text** into LLM context on interruption — there is no mechanism
to truncate the assistant message to the spoken prefix, because the spoken prefix
isn't computed from word timestamps.

## Proposed solution (rfc)

1. Have the TTS plugins surface **word/segment-level timestamps** where the
   provider supports it (Cartesia first — it's the interactive default). Carry them
   on the TTS packets.
2. On `interrupt.tts`, use the playout-clock position (`tts.playout_progress`,
   G12) + word timestamps to compute the **spoken prefix** of the assistant
   message, and write only that prefix into LLM/conversation context.
3. Re-attempt G2's cross-component truncation with this mechanism; add the
   previously-deadlocking scenario as a regression test (understand and fix the
   deadlock root cause from the prior revert — see `RELIABILITY-HARDENING-NOTES.md`).

## Acceptance criteria
- [x] TTS packets carry word/segment timestamps (Cartesia at minimum).
- [x] On barge-in, context records only the spoken prefix (by playout position + word ts).
- [x] The prior deadlock scenario is a green regression test, not a revert.
- [x] G2 marked SHIPPED in the catalog.

## Test plan (TDD + smoke)
- **Unit:** given word timestamps + a playout position, the spoken-prefix
  computation is exact at word boundaries; barge-in writes only the spoken prefix;
  the deadlock scenario completes.
- **Smoke (live):** live recorder coherence smoke with a mid-utterance barge-in;
  assert the recorded assistant audio AND the logged assistant context end at the
  same spoken word (Whisper the recording, compare to context text).

## Definition of done
Post-barge-in context matches heard audio at word granularity; G2 closed with a
non-deadlocking regression test; live smoke proves audio/context alignment.

## Sources
Kwindla §4.8.2 (word-level timestamps for context); catalog G2/G12; F12.
