---
id: REL-10
title: Deepgram failure-mode catalog — symptom → originating layer → what to inspect
domain: REL
tags: [failure-modes, catalog, debugging, triage, five-layers, diagnosis]
sources: [deepgram-ebook]
code_refs: []
---

**Claim (one line):** Real-time voice bugs surface at *boundaries* between perception/reasoning/synthesis/transport; the fastest fix is to first identify *which of the five layers* (audio capture · transcription · reasoning · synthesis · playback) owns the symptom, then inspect that layer — don't tune parameters blindly.

**Detail.** Distilled verbatim from Deepgram's "Common Failure Modes in Real-Time Voice Agents" appendix (ebook line 2023-2112). The five layers (closing note, ebook 2091-2093): **capture · transcription · reasoning · synthesis · playback**.

| # | Symptom | Usually originates in (layer) | What to inspect |
|---|---|---|---|
| 1 | Slow or awkward responses | EOT detection · reasoning latency · client playback (transcription/reasoning/playback) | Turn-boundary signals; gap between final user speech and agent response; whether playback starts as soon as synthesis is available. "Perceived latency is often introduced outside the speech models." |
| 2 | Fails to respond / dead air | Turn-detection failure · orchestration bug · downstream timeout (reasoning) | Whether `EndOfTurn` events are delivered; LLM response timeouts; synthesis init; event-handler errors; unhandled exceptions / blocking ops preventing the response phase. |
| 3 | Inaccurate domain-specific transcription | Model selection · vocabulary coverage (transcription) | Whether the ASR model fits the domain; whether specialized terminology (keyterms) is surfaced. Generic models miss clinical/financial/product terms. |
| 4 | Talks over user / misses interruptions | Audio transport · interruption detection (capture/playback) | Whether audio flows continuously during agent playback; true full-duplex support; uninterrupted mic input + fast speech-start detection. |
| 5 | Responds too early / premature interruption | Aggressive EOT thresholds · boundary tuning (transcription/reasoning) | `eot_threshold`, `eager_eot_threshold`; whether partials/early turn signals fire responses prematurely; VAD sensitivity. Speed-for-accuracy tradeoff on natural pauses. |
| 6 | Choppy / distorted / unnatural audio | Playback buffering · encoding mismatch · network (playback/transport) | Audio-format consistency across the pipeline; whether playback adds needless buffering. "Many perceived synthesis issues are actually transport or client-side artifacts." |
| 7 | Echo / audio feedback loops | Audio routing · missing echo cancellation (capture) | Whether agent output is fed back into input; full-duplex config; hardware AEC; media-gateway inbound/outbound isolation in telephony. |
| 8 | Tools / function calls not triggered | Tool visibility · instruction framing (reasoning) | Whether functions are clearly defined, discoverable, role-aligned; underspecified tools ⇒ model answers directly. |
| 9 | Missing/confused speakers (multi-party) | Audio routing · channel config (capture) | Whether speakers are mixed correctly upstream; whether architecture supports the participant count (many agents assume one speaker). |
| 10 | Loss of context / "forgetting" mid-conversation | State persistence · memory strategy (reasoning) | How prior turns are retained/injected; need for summarization or structured memory vs raw transcript accumulation. |
| 11 | Repetitive / incoherent over time | Context growth · prompt design (reasoning) | How history is accumulated/summarized/truncated; old context overwhelming working memory. |
| 12 | Auth / connection failures | Token lifecycle · endpoint config (transport) | Credential validity/scope/refresh; correct regional / feature-enabled endpoints. |
| 13 | WebSocket disconnections / instability | Network · keepalive config · session recovery (transport) | Connection-timeout settings; reconnection backoff; whether state is restored after reconnect; proxy/firewall config. "Long-lived sessions require explicit keepalive + graceful reconnection." |

**Prior-art divergence.** Deepgram's discipline is *layer-first triage*: "identify which layer is responsible before attempting to tune parameters or swap components" (ebook 2092-2093). This is the diagnostic backbone — most other notes in this domain (REL-01..09) are the *fixes* for rows 12-13 (reconnect/keepalive/state-restore/failover), while rows 1-2,5 map to turn-taking/latency domains (see [[wiki/turn-map]] and [[wiki/lat-map]]) and rows 4,6-7 to barge-in/transport (see [[wiki/barge-map]] and [[wiki/xport-map]]).

**Implication for Syrinx.** Bake this table into the runbook: every voice incident starts by classifying the layer, then jumps to the matching note. Rows 12-13 ⇒ REL reconnect/keepalive/state-restore. Instrument per-layer events ([[OBS-01-event-instrumentation-turn-boundaries]]) so the layer is *observable*, not guessed.

Links: [[REL-01-reconnect-exponential-backoff]] [[REL-03-keepalive-idle-socket]] [[REL-04-state-restoration-injected]] [[REL-06-graceful-degradation-layered]] [[REL-08-fallback-adapter-availability]] [[OBS-01-event-instrumentation-turn-boundaries]] [[BARGE-01-full-duplex-requirement]] [[LAT-03-latency-ladder]]
