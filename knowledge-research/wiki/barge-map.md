# BARGE — Interruption / Barge-in (Map of Content)

## Core problem
A natural voice agent lets the user cut in mid-sentence. Doing this well means the system must (a) be **full-duplex** — listening while it speaks — and (b) execute a fast, ordered teardown when real speech is detected: abort the LLM, stop TTS, flush queued audio, and re-enter listening, all in **under 100ms** (Vapi). The hard part is keeping conversation history honest afterward: the agent must record only the words the user *actually heard*, and it must avoid stopping for noise (or recover if it does). Barge-in is where the speech-out path and the reasoning path are forced to coordinate.

## Narrative
The precondition is structural: input and output audio loops must run concurrently — without **full-duplex** [[BARGE-01-full-duplex-requirement]] there is nothing to interrupt. Given that, an interruption triggers a fixed **sequence** [[BARGE-02-interruption-sequence]] — abort LLM → stop TTS → clear buffers → listen — that fans out from one event so the steps fire together, not serially. Deepgram sharpens the model: the sequence is enforced at **two levels** [[BARGE-03-media-vs-logic-levels]], *media* (stop/mute outbound audio) and *logic* (cancel pending reasoning/tool). The costliest media step is the **buffer flush** [[BARGE-04-buffer-flush]]: because the LLM/TTS run ahead of playback, seconds of audio sit queued and must be cleared (while sparing uninterruptible control frames).

The subtle correctness problem is **context reconstruction** [[BARGE-05-context-reconstruction-vapi]]: history must be truncated to the words actually played. The two clones do this differently, compared head-to-head in **LiveKit vs Pipecat** [[BARGE-08-spoken-word-truncation-livekit-vs-pipecat]] — LiveKit estimates the played prefix from playback-clock × speaking-rate; Pipecat gates word frames by presentation timestamp; Vapi trusts TTS word timestamps.

Robustness comes from two guards. First, **confidence-gated interruption** [[BARGE-06-confidence-gated-interruption]]: only high-confidence / sufficiently-long / non-backchannel speech may interrupt (Vapi gates on STT confidence; LiveKit on duration+words+an ML overlap classifier at prob 0.5). Second, when the gate is set aggressively, **false-interruption recovery** [[BARGE-09-false-interruption-recovery]] pauses rather than kills the speech and resumes it (~2s default) if no real utterance lands. Finally, full-duplex creates an echo hazard the agent hears itself — handled by **auto-mute / echo avoidance** [[BARGE-07-echo-auto-mute]], where hard mute (Deepgram Rust, Pipecat `AlwaysUserMute`) trades away barge-in and LiveKit keeps the mic open behind AEC + ignore-windows.

## Notes in this domain
- [[BARGE-01-full-duplex-requirement]] — concurrent in/out is the precondition
- [[BARGE-02-interruption-sequence]] — the <100ms abort→stop→flush→listen order
- [[BARGE-03-media-vs-logic-levels]] — stop the sound *and* the thought
- [[BARGE-04-buffer-flush]] — clear queued audio, spare uninterruptible frames
- [[BARGE-05-context-reconstruction-vapi]] — history = words actually heard
- [[BARGE-06-confidence-gated-interruption]] — only high-confidence speech interrupts
- [[BARGE-07-echo-auto-mute]] — mic hears the agent; mute vs AEC tradeoff
- [[BARGE-08-spoken-word-truncation-livekit-vs-pipecat]] — speaking-rate vs PTS mechanisms
- [[BARGE-09-false-interruption-recovery]] — pause-and-resume on false trigger

## Canonical implementations
- **Pipecat**: `InterruptionFrame` dispatch — `src/pipecat/processors/frame_processor.py:632` (`_start_interruption` :842); TTS flush — `src/pipecat/services/tts_service.py:902` (`reset_active_audio_context`); output buffer flush — `src/pipecat/transports/base_output.py:538`; PTS-gated word frames — `base_output.py:379,616`; spoken-prefix aggregation — `src/pipecat/processors/aggregators/llm_response_universal.py:1880`; mute strategies — `src/pipecat/turns/user_mute/always_user_mute_strategy.py:14`.
- **LiveKit Python (`agents`)**: `AgentActivity.interrupt()` — `livekit-agents/livekit/agents/voice/agent_activity.py:1268`; spoken-prefix written to chat ctx — `agent_activity.py:2415-2448`; transcript synchronizer (`forwarded_text` / `synchronized_transcript`) — `voice/transcription/synchronizer.py:276,294,344`; false-interruption recovery — `agent_activity.py:3669`; interruption defaults (`min_duration 0.5`, `false_interruption_timeout 2.0`, `backchannel_boundary (1.0,1.0)`) — `voice/turn.py:117`; self-speech ignore windows — `voice/audio_recognition.py:295,311`.
- **LiveKit JS (`agents-js`)**: adaptive ML interruption detector (interruption vs backchannel, `threshold 0.5`, min 2×25ms frames, 0.5s audio prefix) — `agents/src/inference/interruption/defaults.ts:7`, `interruption_detector.ts`, `interruption_stream.ts:257-301`.
- **Deepgram (ebook, prose)**: two-level barge-in rule + `on_user_started_speaking` pseudocode (~line 649, 739); Rust reference agent auto-mute (~line 1546); echo/feedback + "talks over user" failure modes (~line 2043, 2071).
- **Cloudflare (`cloudflare-agents`)**: no dedicated interruption module like the others. Its `examples/voice-agent` routes media over a Realtime SFU (WebRTC); barge-in is driven client-side from local mic audio levels for "silence/interrupt detection" — `examples/voice-agent/src/use-sfu-voice.ts:9-10,53`. Not a server-side cascading-pipeline barge-in implementation.

## Open questions / gaps
- **No measured latency for the <100ms sequence in any clone.** Vapi asserts <100ms; LiveKit/Pipecat fan out via one event but emit no instrumented barge-in latency. Needs an [[OBS-04-per-stage-latency-metrics]] probe to verify.
- **Pause/resume vs flush-only contract.** LiveKit's false-interruption recovery [[BARGE-09-false-interruption-recovery]] requires `audio_output.can_pause`; Pipecat's flush is destructive (recreate task). Which contract Syrinx adopts determines whether optimistic barge-in is even possible.
- **Word-timestamp reliability per TTS provider.** [[BARGE-08-spoken-word-truncation-livekit-vs-pipecat]] hinges on whether our chosen TTS emits per-word timing; if not, we inherit LiveKit's speaking-rate estimation error. Needs a per-provider audit (cross-ref TTS domain).
- **Echo vs barge-in tension** [[BARGE-07-echo-auto-mute]] unresolved for browser/WebRTC: does our transport provide AEC, or must we hard-mute (and lose barge-in)?
- **Cloudflare** offers no in-pipeline barge-in to cite — confirm whether the SFU path is in scope for Syrinx or out.
