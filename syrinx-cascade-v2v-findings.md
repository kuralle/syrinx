# Our own cascaded V2V — syrinx STT→LLM→TTS with the kuralle agent

Measured through the REAL syrinx pipeline (Deepgram nova-3 STT → LLM → Cartesia sonic-3 TTS) via
the headless `runOneTurn` harness, injecting a real speech WAV (`university-support-add-drop.wav`).
NOT LiveKit. `scripts/run-kuralle-cascade-v2v.ts`. Brain = kuralle agent (RAG+flows+skills) via the
`fromKuralleRuntime` bridge, vs an AI SDK baseline on the IDENTICAL STT/TTS. gpt-4.1-mini.

## Measured — brain-dependent stages (clean, mean of 2, stable across two runs)
| stage | AI SDK | kuralle-agent |
|---|---|---|
| LLM TTFT (STT-final → first token) | ~1.1–1.6s | **~1.2–1.4s** |
| TTS TTFB (token → first audio) | ~0.27–0.59s | **~0.25s** |

→ kuralle's LLM term is **on par with the AI SDK** in the cascade (≈1.2s) — through the syrinx
bridge there's no kuralle penalty here. TTS TTFB ~250ms (Cartesia sonic-3).

## STT finalize — use the repo's real number, not this harness's artifact
This harness's bare config (Silero VAD + Deepgram `endpointing:600`, no smart-turn EOS) mis-detects
end-of-speech at mid-utterance pauses, so STT **force-finalizes at ~3.5s** (measured 3844–4476ms —
an artifact, not real STT latency). The repo's production config (`university-support`, smart-turn
EOS plugin) finalizes naturally: **`sttFinalAfterSpeechEnd: 964ms`** (`test/performance/university-support-baseline.json`). aria-flow measured pure Deepgram nova-2 at ~280ms. So real syrinx STT
finalize ≈ **0.3–1.0s** depending on endpointing owner.

## Composed cascaded V2V (real stages) — kuralle brain
| stage | value | source |
|---|---|---|
| endpointing / EOU | 300–700 ms | config (smart-turn, tunable) |
| STT finalize | **~964 ms** | repo baseline (Deepgram nova-3 + smart-turn) |
| LLM TTFT | **~1240 ms** | measured here (kuralle agent) |
| TTS TTFB | **~254 ms** | measured here (Cartesia sonic-3) |
| **V2V (speechEnd → first audio)** | **≈ 2.5 s** | STT + LLM + TTS composed |

(speechEnd→first-audio ≈ 964+1240+254 ≈ **2.46s**; add endpointing for mouth-to-ear.)

## Read
- **Syrinx cascaded V2V with the kuralle agent ≈ 2.5s** (speechEnd→first audio), LLM-dominated.
  Lands in aria-flow's cross-team budget (~1.8s lean / ~2.3s typical / ~3.1s heavy).
- STT+TTS are small and stable (~1.2s combined, brain-independent); the **LLM term dominates** and
  is where any optimization pays off. kuralle ≈ AI SDK on the LLM term in this single-Q&A cascade.
- This is a cascaded number. The bi-model path (realtime front voicing immediately + kuralle
  delegated behind a lead-in) is what gets *perceived* latency under the cascade — still the
  recommended architecture for sub-second feel; this cascade is the honest fallback budget.

## Harness caveat (honest)
The clean single-run end-to-end V2V needs the smart-turn EOS plugin wired into `runOneTurn`'s
session (the bare default mis-endpoints → force-finalize). Brain-dependent stages (LLM/TTS) are
unaffected and were measured cleanly; STT is taken from the repo's production-config baseline.

## Clean cascade (smart-turn EOS) — live 2026-06-09
Harness: `scripts/run-kuralle-cascade-clean.ts` (`pnpm -C examples/02-hello-voice-headless smoke:kuralle-cascade-clean`).
Session shell matches `createUniversitySupportKuralleSession` (Silero VAD + Pipecat smart-turn EOS,
`endpointingOwner: "smart_turn"`, Deepgram nova-3 STT, Cartesia sonic-3 TTS). Brain =
`createFullUniversityRuntime` kuralle agent (RAG+flows+skills) — the bare
`createUniversitySupportKuralleSession` defineAgent loops `memory_block` on this fixture without
emitting a spoken reply. Fixture: `university-support-add-drop.wav` + 1.5s trailing silence,
realtime 20ms pacing + 5s post-feed silence. Anchor: `eos.turn_complete` for LLM/V2V; STT finalize =
`vad.speech_ended` → last `stt.result`. 3 reps + median.

| rep | STT finalize | LLM TTFT | TTS TTFB | V2V (eos→audio) |
|---|---|---|---|---|
| 1 | 464 ms | 1558 ms | 302 ms | 1860 ms |
| 2 | 431 ms | 1174 ms | 267 ms | 1441 ms |
| 3 | 451 ms | 1252 ms | 298 ms | 1550 ms |
| **median** | **451 ms** | **1252 ms** | **298 ms** | **1550 ms** |

Transcript (rep 3): *"Hi. I'm Maya Chen. Student ID is 10042. I need to know whether I can still add biology one, o one after the deadline, and what form I should submit."*

Agent reply (rep 3): late-add guidance + offer to book advisor appointment (no grounded Late Add Petition tool path — full-runtime KB lacks student-relations tool).

### Read (clean, measured — replaces composed estimate)
- **Real STT finalize ≈ 0.45s** (median 451ms) — smart-turn owns endpointing; no 3.8s force-finalize artifact.
- **Clean cascaded V2V (eos→first audio) ≈ 1.55s** (median 1550ms) — not the ~2.5s composed estimate.
- LLM TTFT ~1.25s + TTS TTFB ~0.30s dominate after STT; total ≈ 451+1252+298 ≈ 2.0s from vad-end,
  but eos fires after STT so eos→audio ≈ 1.55s.
- Prior composed row used repo baseline STT (964ms) + prior LLM/TTS from bare-harness brain runs;
  this run proves the smart-turn path is faster on STT and lands **~1.5s V2V** for this fixture+brain.
