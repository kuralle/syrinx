# VAP adoption — verified findings & forward plan

**Status:** Ready to implement · **Date:** 2026-07-10 · **Author:** octalpixel (+ Claude Fable, manager)
**Supersedes in part:** the "train on owned audio" conclusion in
`research/interaction-policy/turn-taking-prior-art.md` §5 and the corrected §6.1 of
`docs/vap-assessment-for-review.md`. Everything else in those docs stands.

---

## 0. Headline

**VAP adoption is unblocked without training a model.** The prior-art audit correctly found that
`inokoj/VAP-Realtime` exists (MIT code, ONNX exporter) but concluded its LDC-trained weights force us to
*retrain on owned/licensed audio*. That retrain **has already been done and released by the Kyoto group
itself**: the MaAI project (the successor that absorbed VAP-Realtime) publishes **MIT-licensed VAP weights
trained on Kyoto's own corpus** (`*_kyoto` variants). Separately, a second family (**DualTurn**, Apache-2.0)
ships **ready-made ONNX** with streaming inference. Both were verified firsthand on Hugging Face (2026-07-10),
not just via search.

Consequence: the "fund only if the eval proves it" gate is unchanged, but **running the gate is now days of
integration, not months of ML work.** VAP moves from *dormant* to *dormant-but-armed*.

---

## 1. Verified adoptable artifacts (no training required)

| Artifact | Where | Format | License | Languages | Notes |
|---|---|---|---|---|---|
| **MaAI VAP, `vap_mc_*_kyoto`** | `huggingface.co/maai-kyoto` (29 repos); code `github.com/MaAI-Kyoto/MaAI` (`pip install maai`) | PyTorch state dict, **23–27 MB** (CPC variant) | **MIT** (trained on Kyoto's own Online Conversation Dataset — this is the "retrain on owned audio," already done) | EN, ZH, JA, trilingual | CPU real-time (IWSDS 2024, arXiv:2401.04868). **Mono-channel (`_mc_`) variants take user-audio only** — matches our existing buffer, no agent-channel plumbing. Outputs `p_now` (0–600 ms) / `p_future` (600–2000 ms). Needs a **one-time torch→ONNX export** (not training). |
| **MaAI backchannel, `vap_bc_*`** | same org | PyTorch | **MIT** | EN, ZH, JA | Continuous backchannel **timing + type** prediction (NAACL 2025, arXiv:2410.15929). The only open model of its kind. |
| **MaAI Mimi encoder** | `maai-kyoto/continuous-mimi-onnx` | **ONNX** (fp32 + int8, 156 MB) | CC-BY-4.0 (attribute) | n/a | Streaming encoder for the `normal-ver2` variant — cleanest export path pairs this with the ver2 head. |
| **DualTurn** | `huggingface.co/anyreach-ai/dualturn-qwen2.5-mimi-0.5B`; code `github.com/anyreachai/dualturn` | **ONNX shipped** (~4 GB fp32) + safetensors | **Apache-2.0** | EN only | Streaming KV-cache, **~41–78 ms/step on one CPU**, stereo user+agent @ 12.5 Hz. Heads map 1:1 to `VapProbs`: EOT/BOT→`pShift`, BC→`pBackchannel`, HOLD→`pHold`, + future-VAD at 4 horizons. Caveats: Interspeech 2026 submission (unrefereed), single-author, Node-only (never Workers). |
| **Smart Turn v3.2** | `huggingface.co/pipecat-ai/smart-turn-v3` | **ONNX** (8 MB int8) | BSD-2 | 23 | Already integrated (`packages/pipecat-smart-turn`). Endpointing only — confirmed *not* patchable into VAP. |
| *(fallbacks)* Easy Turn (`ASLP-lab/Easy-Turn`, model + 1,145 h data) · SoulX-Duplug-0.6B (`Soul-AILab`) | HF | PyTorch | Apache-2.0 | EN+ZH | 4-state semantic controllers (complete/incomplete/backchannel/wait). GPU-class; alternatives if the VAP family fails the eval. |

**Avoid (license):** non-kyoto `vap_en/ch/jp/fr` (CC-BY-NC, LDC-derived) · `vap_tri` non-kyoto (CC-BY-NC-SA) ·
LiveKit `turn-detector` **and** v1/v1-mini (model license restricts use to LiveKit Agents — cannot adopt or
distill) · TEN models (Agora anti-compete addendum — includes TEN VAD until the addendum is read and cleared) ·
Krisp (closed, SDK rental) · `inokoj/VAP-Realtime` distributed weights (LDC-trained; repo archived into MaAI).

---

## 2. Job coverage in the open ecosystem (what needs VAP, what doesn't)

| Job | Open coverage | Verdict |
|---|---|---|
| (a) Endpointing at a pause | Smart Turn v3.2 (+ our semantic fusion) | **Solved, shipped** |
| (b) Predictive turn-shift *before* the pause | Only the VAP/MaAI family (open); Flux `EagerEndOfTurn` (hosted) | Open-but-single-source |
| (c) Backchannel timing | Only MaAI `vap_bc_*` | Open-but-single-source |
| (d) Barge-in vs backchannel during agent speech | **No purpose-built open model** (Krisp IP v1 is proprietary). Stereo VAP/DualTurn approximate it implicitly | The genuine gap — strengthens the VAP bet |

Production validation of the *category*: Tavus **Sparrow-1** (GA, continuous 40 ms floor-ownership controller in
a cascaded pipeline — VAP's design, proprietary), **Krisp VIVA 2.0** (continuous turn prediction + learned
backchannel-vs-interruption, commercial), **GPT-Live/Moshi** (native full-duplex). No open framework ships a
continuous controller — LiveKit closed the request (livekit/agents#3094) by pointing at its license-fenced
model. The open slot is real and empty.

---

## 3. Corrections to the external verdict (measured)

The verdict's **decision** (ship Silero + Smart Turn v3 + RuleBased + Defer; gate VAP on the eval) is
**agreed and adopted**. Three supporting claims needed correction:

1. **"Only ONE off-the-shelf detector is license-clean" — false.** True within the pause-triggered-EOU
   category; false overall: MaAI `*_kyoto` + `vap_bc_*` (MIT) and DualTurn (Apache-2.0) are license-clean and
   pretrained (§1).
2. **"Getting VAP capability = retrain = a new model" — false.** The retrain-on-owned-audio already happened
   upstream (that is what `_kyoto` means). Remaining work is integration + a one-time export.
3. **"LiveKit decomposes into audio-EOU + a barge-in CNN + a backchannel head" — unsupported.** Their shipped
   v1 is a dual-branch (semantic+acoustic) *EOU model* only; barge-in is VAD-triggered; no backchannel head
   exists in any LiveKit release we could find. The seam-matches-the-field argument stands on Vapi's pluggable
   detectors and issue #3094, not on this decomposition.

---

## 4. GPT-Live feel without VAP (the orchestration playbook)

GPT-Live's feel decomposes into five behaviors. Four are orchestration; one is model territory.

| Behavior | Mechanism | Syrinx status |
|---|---|---|
| Responds fast, never cuts you off | Silero + Smart Turn + semantic fusion, **plus a confidence→wait-time curve** (LiveKit `waitFunction` pattern: high EOT confidence ≈150 ms wait, low ≈1.5–2 s) | Fusion shipped; curve = C1b |
| No dead air / instant response | **Speculative generation on eager signals** — Flux `EagerEndOfTurn`/`TurnResumed` → start LLM at medium confidence, revoke on resume | Shipped (v4.1 + Flux) |
| Backchannels while you speak | C3 cue layer (pre-cached assets, delegate-gap timing) + Retell-style tenant knobs (enable/frequency/cue-set) | C3 shipped; knobs small |
| Graceful interruption | RuleBased barge-in + **pause-then-resolve** (on overlap speech: duck playout immediately, resume if the speech yields, commit interrupt if it continues — Sparrow-1's behavior as rules) + `acknowledgementPhrases` suppression | Barge-in shipped; resolve rule small |
| Thinks while speaking | Responder-Thinker seam + progress utterances for long tool calls | Shipped (v4.0.0) |

**What rules cannot fake:** sub-100 ms floor prediction during sustained overlap, prosody-timed
micro-responses, semantically chosen backchannels. That residual is what the C6 eval prices. For tenants who
want 100% today: `DeferInteractionPolicy` + a native full-duplex front (GPT-Live API when it lands, Gemini
Live, Moshi) — the model-agnostic thesis working as designed.

Estimate: orchestration ≈ 85–90% of the perceived feel; Defer covers the rest today; the eval decides whether
owning the last mile openly is worth it.

---

## 5. Cloudflare tier

- **Hosted (best today):** Workers AI serves **`@cf/pipecat-ai/smart-turn-v2`** ($0.00034/audio-min,
  `is_complete` + `probability`) — endpointing via `env.AI` binding, zero in-isolate ONNX. Check the catalog
  for v3; v2 is wav2vec2 (~14 langs), weaker than our bundled v3.2. Deepgram **Flux** over WebSocket is the
  other hosted option and carries the eager/speculative events.
- **In-isolate (possible):** Smart Turn v3.2 int8 (8 MB) via onnxruntime-web — plausible under the 128 MB
  limit, unverified publicly, single-threaded WASM (>12 ms).
- **Never in-isolate:** DualTurn (~4 GB), Mimi encoder (156 MB > memory limit), all LLM-based detectors.
- **Continuous VAP on Workers:** wrong tier for per-frame inference regardless of model size; MaAI (23–27 MB)
  is the only conceivable future candidate, post-quantization, gated windows only. Real VAP runs on the Node
  tier first.

---

## 6. Design changes a real model forces (before wiring)

1. **Predictor interface → stateful streaming.** Both families are incremental (DualTurn KV cache; VAP causal
   encoder state). Replace stateless `predict(fullWindow)` with `push(frame) → probs` + per-`contextId` state;
   `decideFromProbs` and the sync-observe/async-inference split survive unchanged.
2. Fix the two documented `RollingFeatureBuffer` defects (O(1) ring write; stable snapshot for in-flight
   inference) — already on the README MUST-fix list.
3. Output mapping at the predictor boundary: MaAI `p_now`/`p_future` or DualTurn heads → the 3-prob contract.
4. Stereo only for DualTurn (feed TTS playout as channel 2); MaAI `_mc_` mono variants need nothing.
5. Inference cadence: 10–20 Hz gated to contested windows (agent speaking / delegate gap), not 50 Hz always-on.

---

## 7. Forward plan (ordered)

1. **C1b (critical path)** — session `interactionPolicy` injection + feed `audio_frame`/`playout_tick`;
   endpointing stack (Silero + Smart Turn + fusion + confidence→wait curve) as a first-class selectable
   policy. Required for *any* learned controller.
2. **Feel chunks (small, rule-based, demo-visible):** pause-then-resolve barge-in; backchannel tenant knobs;
   `acknowledgementPhrases` suppression.
3. **Arm the eval:**
   - 3a. **DualTurn smoke (days):** wire the Apache-2.0 ONNX into `LocalVapPredictor`; forces the §6 fixes.
   - 3b. **MaAI export (a chunk):** one-time torch→ONNX of `vap_mc_en_kyoto`; the strategic multilingual candidate.
4. **Run C6:** real-VAP vs cheap stack, using **eot-bench** (LiveKit, open, latency-vs-false-cutoff frontier),
   **Full-Duplex-Bench** (arXiv:2503.04721) metrics, Krisp's public test set (`Krisp-AI/turn-taking-test-v1`);
   include a VAP-fused-with-STT arm (content beats prosody alone — LiveKit's caution). **Gate unchanged:**
   wins by a margin worth the compute → fund; loses → properly dormant, with evidence.
5. **Workers tier (parallel, small):** `@cf/pipecat-ai/smart-turn-v2` binding in `server-workers`; check
   catalog for v3.

Nothing here starves the P0s: the only meaty item (C1b) was already committed work.

---

## References (adds to the two prior docs)

- MaAI: `github.com/MaAI-Kyoto/MaAI` · `huggingface.co/maai-kyoto` · real-time VAP arXiv:2401.04868 ·
  multilingual arXiv:2403.06487 · backchannel arXiv:2410.15929 · noise-robust arXiv:2503.06241 ·
  prompt-guided arXiv:2506.21191 · triadic arXiv:2507.07518
- DualTurn: arXiv:2603.08216 · `github.com/anyreachai/dualturn` · HF `anyreach-ai/dualturn-qwen2.5-mimi-0.5B`
- Alternatives: Easy Turn arXiv:2509.23938 · SoulX-Duplug arXiv:2603.14877
- Eval: eot-bench `github.com/livekit/eot-bench` · Full-Duplex-Bench arXiv:2503.04721 · Talking Turns
  arXiv:2503.01174 · VAP-as-judge arXiv:2305.17971
- Field: survey arXiv:2509.14515 · VAP-as-general-controller arXiv:2501.08946 · FireRedChat arXiv:2509.06502
- Production: Tavus Sparrow-1 blog (2026-01) · Krisp turn-taking/interruption-prediction blog (2026-05) ·
  livekit/agents#3094 · LiveKit Turn Detector v1 blog (2026-06) · GPT-Live announcement (2026-07) ·
  Cloudflare Workers AI `@cf/pipecat-ai/smart-turn-v2`
