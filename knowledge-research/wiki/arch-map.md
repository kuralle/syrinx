# ARCH — Orchestration Architecture (Map of Content)

## The core problem
The voice engine has three stateless inference services (STT, LLM, TTS) that must be wired into a single **stateful, real-time, overlapping** loop where the user can interrupt at any moment. The architecture question is: what is the runtime shape that carries audio in → transcript → response → audio out with sub-second voice-to-voice latency, instant barge-in, and pluggable providers? Every clone answers with some form of *streaming frame/event pipeline behind a long-lived stateful container*.

## The narrative

Start with the **frame-pipeline model** [[ARCH-01-frame-pipeline-model]]: a linked chain of single-responsibility `FrameProcessor`s passing typed `Frame`s bidirectionally between transport nodes (Pipecat's processors+frames+transports; Modal's framework rationale). The frames themselves form a **taxonomy** [[ARCH-02-frame-taxonomy]] — audio, partial/final transcription, LLM tokens, TTS audio, and lifecycle events — split into three base categories. The category split is load-bearing: **system frames jump the queue ahead of data frames** [[ARCH-03-system-vs-data-frame-ordering]] inside every processor (a two-band priority queue + separate task), which is the mechanism that makes <100ms barge-in possible.

Above the frames sits the **event-driven lifecycle** [[ARCH-04-event-driven-lifecycle]]: the loop is overlapping, not sequential, driven by an explicit agent-state machine (listening/thinking/speaking) and lifecycle events. This is the streaming era; it replaced the batch cascade. The **three-era trade-off** [[ARCH-05-batch-vs-streaming-vs-s2s]] — batch cascade (4s dead air, dead) vs streaming cascade (dominant, ~1s) vs speech-to-speech (full-duplex, expressive, but weak tool-calling) — frames the strategic choice.

Within the streaming cascade, Vapi decomposes into **three parallel streams** [[ARCH-06-three-parallel-streams]] (audio-input / transcription / response-generation) with **predict-and-scrap** speculative generation; LiveKit implements this as preemptive generation. Latency is further hidden by the **thinker-talker pattern** [[ARCH-07-thinker-talker]] (small talker + filler + big thinker), with the hard rule that guardrails sit before TTS.

The wiring is concretized in **LiveKit's AgentSession** [[ARCH-08-livekit-agentsession]] (stateful container + STT/LLM/TTS as overridable node generators + AudioRecognition hooks). Where that state lives differs across runtimes: **Rapida's Talker/Communication goroutine vs Cloudflare's hibernatable Durable Object** [[ARCH-09-rapida-cloudflare-runtimes]]. And the whole thing is bounded by the **Voice-Engine / Agent-Orchestration split** [[ARCH-10-voice-engine-orchestration-boundary]] — transcript-out / response-in — which is exactly Syrinx's scope line.

## Canonical implementations

| Concern | Clone | Where |
|---|---|---|
| Pipeline chain + source/sink linking | Pipecat | `pipecat/src/pipecat/pipeline/pipeline.py:91,113-121,207-212` |
| Frame taxonomy (Audio/Text/Transcription/lifecycle) | Pipecat | `pipecat/src/pipecat/frames/frames.py:54,94-128,414-464,962-1098` |
| System>Data priority queue + 2-task processing | Pipecat | `pipecat/src/pipecat/processors/frame_processor.py:119-154,996-1042` |
| ParallelPipeline (N concurrent branches, lifecycle sync) | Pipecat | `pipecat/src/pipecat/pipeline/parallel_pipeline.py:24-76,144-204` |
| AgentSession container (stt/vad/llm/tts) | LiveKit Py | `agents/livekit-agents/livekit/agents/voice/agent_session.py:222-406,1325-1346` |
| STT→LLM→TTS node generators + StreamAdapter wrapping | LiveKit Py | `agents/.../voice/agent.py:414-519` |
| AgentActivity: cascade-vs-realtime branch, AudioRecognition, sync end-of-turn | LiveKit Py | `agents/.../voice/agent_activity.py:190-287,791,1921-1923` |
| Preemptive (predict-and-scrap) generation | LiveKit Py | `agents/.../voice/agent_activity.py:1857-1919` |
| Agent-state / lifecycle events | LiveKit Py | `agents/.../voice/events.py:92-119` |
| JS parity (same AgentSession/Activity/AudioRecognition split) | LiveKit JS | `agents-js/agents/src/voice/{agent_session,agent_activity,audio_recognition}.ts` |
| Dispatcher + Talker per-call loop | Rapida | `voice-ai/api/assistant-api/socket/pipeline.go:36-83`; `internal/adapters/internal/stream.go:32` |
| Stateful per-conversation `Communication` contract | Rapida | `voice-ai/api/assistant-api/internal/type/communication.go:35-82` |
| STT/TTS as `Transformers[…]`; VAD/EOS/denoiser/normalizer stages | Rapida | `voice-ai/api/assistant-api/internal/{transformer,type,vad,end_of_speech}/` |
| Durable-Object Agent (hibernate, SQL storage) | Cloudflare | `cloudflare-agents/packages/agents/src/index.ts:1342-1346,1533,1622-1819` |
| `withVoice` mixin: STT session → onTurn → sentence-chunked TTS queue + interrupt | Cloudflare | `cloudflare-agents/packages/voice/src/voice.ts:133-162,584-595,951-989` |
| Managed reference topologies (Tier 1–4) + ecosystem patterns | Deepgram (source) | `_sources/pdf/deepgram-voice-agent.parsed.md:1326-1712` |

## Open questions / gaps
- **Speculative generation cost.** Predict-and-scrap (Vapi/ElevenLabs/LiveKit-preemptive) fires multiple LLM requests per turn. Modal's counter-finding (final-transcript time is all that matters; partials may not be worth it) is unreconciled — needs a Syrinx latency-vs-LLM-cost measurement. See [[ARCH-06-three-parallel-streams]], [[LAT-09-preemptive-generation]].
- **State-residency choice.** Live goroutine (Rapida) vs Durable Object (Cloudflare) vs managed runtime (Deepgram) have very different scale-down/drain and cold-start profiles. Not yet evaluated against Syrinx's deployment. See [[ARCH-09-rapida-cloudflare-runtimes]], [[REL-07-connection-draining-scaledown]].
- **Frame-class tree vs events.** Pipecat's 100+ frame types vs LiveKit's object/event model vs Cloudflare's JSON protocol — which gives the best instrumentation/interruption ergonomics for us? Unverified which we should mirror.
- **S2S drop-in.** LiveKit proves one session API can host both cascade and RealtimeModel. Whether Syrinx should keep the LLM slot polymorphic from day one (vs cascade-only) is an open design call. See [[ARCH-05-batch-vs-streaming-vs-s2s]].
- **Guardrails-before-TTS plumbing.** The irreversibility rule (can't unspeak) implies a mandatory pre-TTS gate; none of the clones' code paths were traced to confirm where this gate lives. `(unverified in code)`
