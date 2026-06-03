# µ-law Passthrough Benchmark Plan (VE-04.5)

**Status:** design-first / greenfield. Measure in Syrinx before enabling — do not assume the win transfers. Destructive default stays edge-transcode until a benchmark justifies a change.

## Current path (baseline to beat)
Telephony carriers deliver 8 kHz µ-law. Today Syrinx transcodes at the edge:
- **Ingress:** `decodeMuLawToPcm16` (µ-law→PCM16 @8k) → `resamplePcm16Streaming` to the engine rate (16 kHz) → VAD + Deepgram STT (`encoding=linear16&sample_rate=16000`).
- **Egress:** TTS PCM16 → resample to 8k → `encodeMuLaw` → carrier `media`.

## Passthrough option under test
Some providers accept native µ-law:
- **Deepgram STT** accepts `encoding=mulaw&sample_rate=8000` — could skip ingress decode+resample for the STT leg.
- **TTS** native µ-law egress is provider-dependent (Cartesia/Deepgram output formats) — could skip egress resample+encode.

## What to measure (per leg, over a fixed fixture set)
Use the existing telephony live smoke (`smoke:telephony-university-live`) as the harness; add A/B modes via an env flag (e.g. `SYRINX_MULAW_PASSTHROUGH=stt|tts|both|off`).

| Metric | Edge transcode (baseline) | µ-law passthrough | Decision criterion |
|---|---|---|---|
| STT accuracy (WER vs reference transcripts) | 16 kHz PCM | 8 kHz µ-law | passthrough must not materially raise WER |
| STT-final delay (speechEnd→sttFinal) | | | lower is better |
| TTS first-byte (TTFB) | | | lower is better |
| Per-turn CPU (transcode work removed) | | | lower is better |
| v2v P50/P95 | | | no regression |

## Key constraint (limits the ingress win)
**VAD and the denoiser require PCM16.** Even with µ-law-passthrough STT, the ingress still needs a PCM decode for VAD/turn-taking — so passthrough removes the *resample* and the STT-leg decode, not the decode entirely. Quantify the residual win; it may be small. Egress passthrough (skip resample+µ-law-encode when TTS can emit µ-law) is the cleaner candidate.

## Decision rule
Enable passthrough **only** where it shows a measured latency/CPU win with **no material WER regression** for that leg, behind an explicit per-leg flag (never a silent default change to the internal PCM contract). 8 kHz µ-law is lossy vs 16 kHz PCM; if WER regresses, keep edge transcode.

## Deliverable when executed
An A/B run table (the matrix above) for at least the 3-turn telephony fixture set per provider, saved alongside the other `test/performance/` baselines, plus a go/no-go per leg.
