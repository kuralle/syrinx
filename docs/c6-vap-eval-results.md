# C6 VAP evaluation result

**Run date:** 2026-07-10
**Verdict:** `properly-dormant`

## Decision

Do not fund VAP production adoption. Keep the licensed predictors and `InteractionPolicy` integration
available for later experiments, but leave the cheap Silero + Smart Turn + rule-based stack as the default.

The funding rule required Kyoto VAP + STT to reduce latency at the 5% false-cutoff operating point by at
least 100 ms without regressing AUC. It instead added 515.625 ms and reduced AUC by 0.04199.

## EoT frontier

The Modal run evaluated the first 32 English conversations from `livekit/eot-bench-data` at revision
`35a1aec3f859527a0eb1dd6d22f6146e4ca3e2e5`: 457.4 seconds of audio and 96 scored silence spans
(64 hold, 32 EoT). The dataset is CC-BY-4.0. Gold silence spans represent the existing Silero VAD trigger;
no additional VAD weights were downloaded.

| arm | AUC | AP | latency @ 5% cutoff | timeout rate | detect rate |
|---|---:|---:|---:|---:|---:|
| Silero + Smart Turn + rules | 0.8042 | 0.6737 | **659.375 ms** | **3.125%** | **96.875%** |
| Kyoto VAP | **0.8237** | 0.6408 | 1,418.750 ms | 93.750% | 6.250% |
| Kyoto VAP + STT | 0.7622 | 0.6606 | 1,175.000 ms | 75.000% | 25.000% |
| DualTurn | 0.3271 | 0.2568 | 1,237.500 ms | 56.250% | 43.750% |

The raw JSON is persisted in the `syrinx-vap-models` Modal Volume at
`/eval/c6-eot-en-32.json`. Reproduce with:

```bash
modal run scripts/modal/run_c6_eot_eval.py --limit 32
```

## Full-duplex metrics

Syrinx already ships the Full-Duplex-Bench-style contract in
`examples/02-hello-voice-headless/scripts/eva-evaluator.ts`: turn-taking timing, overlap score, average and
maximum response latency, minimum inter-turn gap, and conversation overlap. The C6 runner projects each
official eot-bench frontier onto the same three comparison fields: `turnTakingTimingScore = AUC * 100`,
`overlapScore = (1 - cutoffRate@5%) * 100`, and `avgResponseLatencyMs = meanLatency@5% * 1000`.

Full-Duplex-Bench's Candor/ICC v1 audio was not downloaded because it is CC-BY-NC. The allowed synthetic
subsets do not add real conversational evidence beyond the licensed eot-bench run, so they are not used to
override the verdict.

## Krisp test set

`Krisp-AI/turn-taking-test-v1` could not be evaluated: Hugging Face returns HTTP 401 for its files and license
until gated terms are accepted, and no `HF_TOKEN` is available. No Krisp data or model was downloaded. This is
recorded as unavailable rather than bypassing the gate or weakening the license rules.

## Licensed artifacts

- DualTurn source revision `d7abba2c0c8d1ab8e992879c6a186384e00f94cb`, Apache-2.0.
- Continuous Mimi ONNX revision `58ec3bc5f381eb84e0e97bc5a2a15cbe703c8a94`, CC-BY-4.0 with attribution.
- `maai-kyoto/vap_mc_en_kyoto` revision `01b948b6db91bbcedb9b105ecdcf77ed70e11474`, MIT.
- Smart Turn v3.2 CPU revision `f766f81d3cfdf7737ac64aad813d91bbfd56bf93`, BSD-2-Clause.

No non-Kyoto VAP, LiveKit model weights, TEN, Krisp model, or noncommercial Full-Duplex-Bench audio was used.
