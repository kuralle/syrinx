---
id: OBS-11
title: Client-side vs orchestrator-side e2e latency — Modal's diarization approach captures true hardware-to-hardware latency that server-side timestamps miss
domain: OBS
tags: [e2e-latency, client-side, diarization, pyannote, modal, livekit, measurement, benchmarking]
sources: [modal-v2v, deepgram-ebook]
code_refs: []
---

**Claim (one line):** Server-side e2e latency (LiveKit's `started_speaking_at − stopped_speaking_at`) misses hardware capture/playback and network jitter; Modal's client-side diarization approach captures **true hardware-to-hardware latency** and is the more honest number — the two numbers should not be confused.

**Detail.** There are two fundamentally different measurement points for the voice-to-voice latency figure of merit:

**Orchestrator-side (LiveKit's approach):** `e2e_latency = started_speaking_at − stopped_speaking_at` (`agent_activity.py:2769`) — both timestamps are taken at the orchestrator. `stopped_speaking_at` is pinned to the VAD silence trigger; `started_speaking_at` is pinned to when the TTS first audio frame is produced at the orchestrator output. This measures **only the engine's processing time** — the time from "we decided the user stopped" to "we produced a response." It excludes: microphone capture latency on the client device, audio encoding/framing into WebRTC, network uplink jitter from client→bot, the VAD hangover period (which is inside `stopped_speaking_at` but calibrated), network downlink jitter from bot→client, client-side jitter-buffer playout delay, and speaker output latency. LiveKit calls this `e2e_latency` but it's really **engine processing latency** — the orchestrator's view of its own performance.

**Client-side (Modal's approach):** Modal records conversation audio in the same physical space as the client, then runs **Pyannote (Precision-2) speaker diarization** offline to recover turn boundaries from the raw audio (modal-v2v line 46). The v2v latency is then computed as the **duration from the acoustic end of the user's utterance to the acoustic start of the agent's utterance** — the literal gap between two speakers in the recorded waveform. This captures **everything**: client capture, encoding, network, VAD hangover, STT, LLM, TTS, network, decoding, playout. It is the true "what the user experiences" number.

The two numbers differ significantly. LiveKit's server-side number is typically **100-300 ms smaller** — the difference includes client-side audio pipeline latency (~40-60 ms encode+decode), network round-trip jitter (~10-50 ms per leg), and hardware latency (~10-30 ms mic/speaker). For a server-side number of ~800 ms, the client-side number is often ~1000-1200 ms.

**Prior-art divergence.** LiveKit measures server-side and calls it "e2e_latency" without noting the gap. Modal measures client-side and calls it "v2v latency." Deepgram's VAQI "L" (Latency) defines it as "the time between user speech ends and assistant response begins" (deepgram-ebook ~962) but doesn't specify where the timestamps are taken — leaving it ambiguous. No clone measures both and publishes the delta.

**Implication for Syrinx.** Measure BOTH. Server-side for per-turn SLO alerting (fast, always available, good for regression detection). Client-side for truth (via periodic synthetic probes + Pyannote diarization, per [[OBS-10-synthetic-real-user-monitoring]]). Never call the server-side number "e2e latency" in customer-facing metrics — label it "engine latency." The delta between the two is a health metric in itself: a growing gap indicates client-side or network degradation.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-01-event-instrumentation-turn-boundaries]] [[OBS-10-synthetic-real-user-monitoring]] [[LAT-01-v2v-figure-of-merit]] [[LAT-08-network-vs-engine-colocation]]
