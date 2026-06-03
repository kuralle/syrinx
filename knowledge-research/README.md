# Syrinx Voice-Engine Second Brain

A Zettelkasten knowledge base of **prior art for the speech-in / speech-out path** of a production voice-orchestration platform. Built to harden Syrinx's voice engine — **voice-to-voice latency and reliability** are the key metrics.

## Scope (what we optimize)
The **Voice Engine** half of the stack (per ElevenLabs' split): VAD, turn-taking, interruption detection, STT, TTS, and the **audio transport** that carries them. The boundary is the **transcript out** and the **response text in**. We do **not** optimize agent behavior / reasoning quality — only:
- Are we reliably sending audio through WebSockets/WebRTC?
- Is the STT provider getting it properly (resampling, encoding, endpointing)?
- Is the transcript delivered to the agent cleanly?
- Is the agent's stream reaching TTS correctly (resampling, streaming, sentence boundarying)?

## Layout
- `_sources/` — raw captures of the primary sources (blogs + diagrams, the Deepgram ebook, the Together-AI talk). **Read these, don't re-fetch.**
- `_clones/` — canonical OSS implementations to cite: `pipecat/`, `agents/` (LiveKit Python), `agents-js/` (LiveKit JS), `voice-ai/` (Rapida), `cloudflare-agents/`.
- `notes/` — **atomic Zettelkasten notes** (one idea each). See `CONVENTIONS.md`.
- `wiki/` — **Maps of Content (MOCs)**: synthesis pages that thread the atomic notes into a narrative per domain.

## Primary sources (all read meticulously)
1. ElevenLabs — Orchestration Engine (`_sources/blogs/elevenlabs-orchestration-engine.md`)
2. ElevenLabs — Voice agents that last / FDE (`...elevenlabs-voice-agents-that-last-fde.md`)
3. Vapi — How we solved latency (`...vapi-how-we-solved-latency.md`)
4. Vapi — Pipeline Part 1 (`...vapi-pipeline-part-1.md`)
5. Vapi — Pipeline Part 2 (`...vapi-pipeline-part-2.md`)
6. Modal — One-second voice-to-voice (`...modal-one-second-voice-to-voice.md`)
7. Diagram observations (`_sources/blogs/_diagram-observations.md`)
8. Deepgram — Definitive Guide to Voice AI Agents, 107pp (`_sources/pdf/deepgram-voice-agent.parsed.md`)
9. Together AI — Engineering Voice Agents at Scale, talk (`_sources/youtube/together-ai-engineering-voice-agents.md`)

## Domains (note-ID prefixes)
| Code | Domain | Wiki MOC |
|---|---|---|
| `XPORT` | Audio transport (WS/WebRTC, framing, codecs, jitter, sample rates) | `wiki/xport-map.md` |
| `STT` | Speech-to-text ingestion (streaming/partials, resampling, encoding, confidence, WER/keyterms, fallback) | `wiki/stt-map.md` |
| `TURN` | Turn-taking & endpointing (VAD, semantic EOT, eager EOT, thresholds) | `wiki/turn-map.md` |
| `BARGE` | Interruption / barge-in (full-duplex, playback cancel, buffer flush, context reconstruction) | `wiki/barge-map.md` |
| `TTS` | Text-to-speech egress (streaming, TTFA, RTF, sentence aggregation, resampling, phonemes) | `wiki/tts-map.md` |
| `LAT` | Latency engineering (budgets, TTFT, hedging, co-location, speculative/predict-and-scrap) | `wiki/lat-map.md` |
| `REL` | Reliability & failure modes (reconnect, keepalive, drain, backpressure, degradation, failure catalog) | `wiki/rel-map.md` |
| `ARCH` | Orchestration architecture (frame pipeline, event-driven, S2S, thinker-talker) | `wiki/arch-map.md` |
| `OBS` | Observability & evals (VAQI, per-stage latency, event instrumentation) | `wiki/obs-map.md` |
| `LANG` | Multilingual & localization (unified vs specialized streams, dynamic voice switching, language detection, persona consistency) | `wiki/lang-map.md` |

See `CONVENTIONS.md` for the note format.
