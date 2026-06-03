---
id: OBS-10
title: Synthetic + real-user monitoring, and S2S auditability via parallel transcription
domain: OBS
tags: [observability, monitoring, synthetic, rum, s2s, auditability]
sources: [deepgram-ebook, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/metrics/base.py:115, agents/livekit-agents/livekit/agents/metrics/base.py:143]
---

**Claim (one line):** Production monitoring needs two feeds — scheduled **synthetic** probes that re-run known scenarios to catch regressions early, and **real-user** telemetry that captures the variability synthetics can't — and for speech-to-speech models you must run a **transcription model alongside** the audio so the conversation is auditable as text.

**Detail.** Deepgram: "Production observability benefits from combining synthetic probes with real-user telemetry" — synthetic monitoring "runs scripted sessions on a schedule… reuse representative scenarios developed during pre-release testing" to "catch known failure modes early"; real-user monitoring "aggregates signals from live traffic… captures variability introduced by user behavior, network conditions, and external dependencies that synthetic tests cannot fully simulate" (deepgram-ebook line 1069–1081). Together: this pipeline runs forever ("Observability maintains conversational health during live operation," deepgram-ebook line 1075). The S2S wrinkle is from Together: with a speech-to-speech model you lose the natural transcript boundary, so "run a **transcription model alongside** the S2S model for auditability (see incoming/outgoing audio as text); evals shift to **full-duplex whole-conversation** metrics" (together-talk line 44); LiveKit encodes the S2S case as `RealtimeModelMetrics` with its own `ttft` = "time to first audio token" and audio/text token splits (`metrics/base.py:115,143–157`), preserving per-turn timing even when there's no separate STT/LLM/TTS to instrument. Synthetic + RUM both feed the same SLO histograms (see [[OBS-06-slos-percentiles-tail]]); observability "does not replace evaluation… it provides continuous input that guides where deeper analysis is required" (deepgram-ebook line 1063–1065), closing the loop back to [[OBS-09-replay-load-fault-injection]].

**Prior-art divergence.** Deepgram treats synthetic vs RUM as the two halves of coverage (predictability vs emergent-issue surfacing). Together's contribution is the S2S-specific auditability tactic — a *shadow transcription* pass purely for observability, not for the response path. The OSS clones give you `RealtimeModelMetrics` (timing) but a shadow-STT for text auditability of an S2S model is something Syrinx would add itself.

**Implication for Syrinx.** Run scheduled synthetic calls (reusing the replay test library) for early-warning, aggregate RUM from live traffic for emergent issues, and — if/when we use an S2S/realtime model — run a cheap parallel transcription pass so every call is auditable as text and evals can move to whole-conversation metrics.

Links: [[OBS-06-slos-percentiles-tail]] [[OBS-09-replay-load-fault-injection]] [[OBS-04-per-stage-latency-metrics]] [[ARCH-05-batch-vs-streaming-vs-s2s]]
