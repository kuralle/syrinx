# VAP (Voice Activity Projection) — build write-up & assessment for external review

**Status:** For external review · **Date:** 2026-07-10 · **Author:** octalpixel (+ Claude, manager)
**Decision under review:** should Syrinx invest further in VAP, keep it dormant behind the seam, or drop it?

---

## 0. How to review this document

You do **not** need prior Syrinx context. §1 gives you the minimum. The question we want your judgement on is
in §7. We have deliberately written the case *for* and *against* VAP so you can weigh it, not just ratify it.
The code is real and on a branch (§5) if you want to read it.

**TL;DR:** We built the *seam* to make turn-taking controllers swappable (clearly right), and — behind it — a
`VapInteractionPolicy` package as the "learned controller" (a thesis bet). VAP is **used by no production
platform**, and its operational job is already covered by cheaper, shipping, multilingual pieces (Silero VAD +
Pipecat Smart Turn + rule-based barge-in). We currently believe VAP should stay **dormant behind the seam** and
only be funded if an eval proves it beats the cheap stack. We want an outside read on that call.

> **CORRECTED (2026-07-10) — two claims in this doc were revised after a firsthand prior-art + license audit
> (`research/interaction-policy/turn-taking-prior-art.md`), which supersedes them:**
> 1. **"No ONNX VAP exists" was WRONG.** `github.com/inokoj/VAP-Realtime` (MIT code) ships an *official* ONNX
>    exporter, runs **real-time on CPU**, is **stereo**, and has **dedicated backchannel + nodding fine-tunes**.
>    The real blocker is not existence or technical feasibility — it is that the *distributed weights* are
>    trained on LDC-restricted Switchboard/Fisher/Candor audio, so a commercial VAP requires **retraining the
>    MIT architecture on owned/licensed dialogue audio** (a bounded ML project).
> 2. **"VAP needs a GPU fleet" was overstated.** VAP-Realtime runs real-time on CPU (CPC + a small transformer,
>    few-M params). The per-inference cost is cheap CPU; the aggregate cost at high *concurrent per-frame* load
>    is still large but is managed by inference-rate gating + batching, not a mandatory GPU tier.
> Also confirmed: the only *license-clean off-the-shelf* detector is **Smart Turn v3 (BSD-2)** — TEN
> (Agora anti-compete) and LiveKit (framework-locked) weights are legally un-adoptable for a competing platform.

> **UPDATE 2 (2026-07-10, second verification pass — `docs/vap-adoption-findings.md` supersedes parts of the
> correction above):** the "retrain on owned/licensed audio" step is **already done upstream and released**:
> MaAI (Kyoto; successor to VAP-Realtime) ships **MIT-licensed pretrained VAP weights** (`maai-kyoto` on HF,
> `vap_mc_*_kyoto`, EN/ZH/JA/trilingual, incl. mono-channel + MIT backchannel models `vap_bc_*`), and
> **DualTurn** (Apache-2.0) ships **ready-made ONNX** with ~41–78 ms/step streaming CPU inference. Adoption is
> therefore an **integration + one-time export, no training**. "Only Smart Turn is license-clean" holds only
> within the pause-triggered-EOU category. Recommendation amended: **dormant-but-armed** — run the C6 eval
> against these real checkpoints (days, not months) and let the gate decide.

---

## 1. Minimum context: Syrinx + the InteractionPolicy seam

**Syrinx** is a pre-launch, open, model-agnostic **voice-agent orchestration engine** (TypeScript monorepo;
runs on Node and the Cloudflare Workers edge). Thesis: be the *open* orchestrator of "any speech front × any
reasoning back × any voice," i.e. GPT-Live-class conversational feel without vendor lock-in.

"Interaction control" = the decisions of **when to speak, keep listening, backchannel, or interrupt**. We
recently extracted these into a single seam:

- **`InteractionPolicy`** (`packages/core/src/interaction-policy.ts`): `observe(obs) → Decision[]` (synchronous,
  ≤5 ms/frame) + `reset()`. Decisions: `keep_listening | take_turn | backchannel | hold | interrupt`.
- Implementations behind the seam, all interchangeable:
  - **`RuleBasedInteractionPolicy`** — deterministic barge-in (min-interruption threshold, backchannel /
    low-confidence / bystander suppression). Shipping.
  - **`DeferInteractionPolicy`** — observe-only; used when the front model (GPT-Live / Gemini Live / Moshi) is
    natively full-duplex and owns turn-taking itself. Shipping.
  - **`VapInteractionPolicy`** — *the learned controller this document is about.* Behind the seam, **stub-backed.**
  - (Endpointing today — Silero VAD + Pipecat **Smart Turn v3** + Deepgram **Flux** — is not yet a first-class
    policy; that is a small pending chunk, "C1b".)

**The seam is not in question here.** It is clearly correct: it makes RuleBased / Smart Turn / Defer / VAP
swappable per session/tenant and is the concrete form of the model-agnostic thesis. This document is only
about the **VAP implementation** behind it.

---

## 2. What VAP is (technical)

**VAP = Voice Activity Projection**, Erik Ekstedt & Gabriel Skantze (KTH), Interspeech 2022 (arXiv:2205.09812).

Unlike a VAD ("is someone speaking?") or an end-of-turn detector ("is the user done?"), VAP is a
**continuous, frame-incremental** model that, from **raw stereo audio (both speakers)**, predicts the
**near-future voice-activity pattern** (~2 s horizon) as a distribution over a codebook of future on/off
patterns. From that projection you read `p_shift` (turn changing), `p_hold`, `p_backchannel`.

- **Cadence:** every ~20 ms (50 Hz), continuously — including *while the agent is speaking* (for barge-in) and
  *while listening* (for backchannels). This is what makes it "full-duplex" rather than pause-triggered.
- **Architecture:** a pretrained self-supervised audio encoder (CPC — Contrastive Predictive Coding) → a
  transformer → the projection distribution. The CPC encoder is the heavy part (much more compute than a VAD).
- **The reference checkpoint:** `VAP_3mmz3t0u_50Hz_ad20s_...pt` — 50 Hz, 20 s context, **PyTorch only**,
  trained on **English** dialogue corpora.

What VAP uniquely does over the cheap stack: **continuous listener backchannels timed to prosody**, **overlap /
simultaneous-speech handling**, and **predictive** (pre-pause) turn-shift. What it does *not* uniquely add:
endpointing (Smart Turn does that) and barge-in (rule-based does that).

---

## 3. Why it was built (rationale + provenance)

**Provenance:** the decision predates the implementation — it is written into `docs/rfc-interaction-policy-seam.md`
(RFC chunk **C5**, "a `VapInteractionPolicy` is selectable behind the same seam"). The implementation this
session executed that RFC.

**The rationale, as recorded in the RFC + the internal lit-review** (`research/full-duplex-orchestration-litreview.md`,
22 sources) + memory (`gpt-live-validates-orchestration-thesis`):

1. **Close the one real gap vs GPT-Live, openly.** OpenAI's GPT-Live (2026-07) validated the "full-duplex
   interaction + delegated reasoning" architecture but ships it *closed* (one front welded to one reasoner).
   Syrinx already shipped the delegation half (the Responder-Thinker seam, v4.0.0). The remaining gap was
   **continuous full-duplex turn-taking**. VAP was chosen as the concrete way to own that in an *open,
   model-agnostic* way.
2. **The research says turn-taking is a separable, small, learned, portable model — and VAP is the canonical
   example.** Self-supervised, frame-incremental, multilingual (arXiv:2403.06487), extensible to backchannels
   from the same model (arXiv:2410.15929), improvable with a richer seam (SIGDIAL 2025; arXiv:2506.03980), and
   reused as a *general* controller on systems it was not built for (arXiv:2501.08946). So it was the natural
   artifact to *prove* "a decoupled controller can drive full-duplex feel."

**In one line: VAP was built as a *thesis-proof / open-differentiation* bet — to demonstrate the open
full-duplex controller GPT-Live keeps closed — not because launch or scale required it.**

---

## 4. What was actually built

A new package `@kuralle-syrinx/vap`, mirroring the existing `silero-vad` / `pipecat-smart-turn` packaging:

- `packages/vap/src/vap-policy.ts` — pure decision logic (`decideFromProbs`, thresholds) + `RollingFeatureBuffer`.
- `packages/vap/src/index.ts` — `VapInteractionPolicy` (**synchronous `observe()`; async ONNX inference is
  fire-and-forget off the hot path; `observe()` returns the last-computed decision** to hold ≤5 ms), plus
  `StubVapPredictor`, `LocalVapPredictor` (Node, onnxruntime-node).
- `packages/vap/src/workers.ts` — `WorkersVapPredictor` (Cloudflare, onnxruntime-web; model via
  `model_bytes`/`model_url` — **no filesystem**, edge-compatible).
- Tests + a p99 ≤ 5 ms latency bench (on the synchronous path). `packages/vap/README.md` documents the model
  I/O contract + known follow-ups.

It is **behind the seam and selectable in principle**, but see §6 — it is not reachable end-to-end yet, and
the predictor is a stub.

---

## 5. Where the code is (branch + commits)

| Item | Ref |
|---|---|
| **Branch** | `plan/ip-vap` (off `beta`), pushed to `github.com/kuralle/syrinx` |
| **VAP build commit (C5)** | `be30a75` — `[IP-C5] @kuralle-syrinx/vap VapInteractionPolicy` |
| **Manager verification + notes** | `3588e47` — `[IP-C4/C5 verify] ... guard/notes` |
| **The seam it plugs into (C1/C2)** | merged to `beta` via PR `kuralle/syrinx#25`, merge commit `fcead10` |
| **Package** | `packages/vap/` |
| **Governing RFC** | `docs/rfc-interaction-policy-seam.md` (chunk C5) |
| **Internal research** | `research/full-duplex-orchestration-litreview.md`; `research/interaction-policy/c3-backchannel-decision.md` |

The whole InteractionPolicy batch (C3 backchannels, C4 rich STT seam, C5 VAP, C6 eval harness) is on
`plan/ip-vap`, pending a batch PR into `beta`.

---

## 6. Current state — honest gaps

1. **No commercially-clean model wired.** We ship a **`StubVapPredictor`** so the package/policy/bench are
   complete and green, but it makes **no real decisions**. **CORRECTED:** an ONNX VAP *does* exist —
   `inokoj/VAP-Realtime` (MIT code, official ONNX exporter, CPU-real-time, stereo, backchannel+nod fine-tunes) —
   but its distributed weights are trained on LDC-restricted audio. So a real, ship-able VAP requires
   **retraining that MIT architecture on owned/licensed dialogue audio** + ONNX export — not a mythical model,
   but a bounded ML project. (Detail + license audit: `research/interaction-policy/turn-taking-prior-art.md`.)
2. **Not wired end-to-end.** The session can't yet *select* VAP (no `interactionPolicy` injection) and does not
   feed it `audio_frame`/`playout_tick` observations, so even if selected it would receive no audio.
   Additionally, VAP expects **stereo** input; our placeholder `RollingFeatureBuffer` holds one mono channel —
   it does not match the model's real input shape (it is explicitly placeholder code).
3. **Placeholder-buffer defects (documented in `packages/vap/README.md`):** O(n²) full-buffer append (passes
   the bench on a fast dev box; a latency risk on the constrained edge) and a feature-aliasing hazard (harmless
   for the stub; would corrupt a real model's input). Both are latent and to be fixed *with* the real model.
4. **Cost at high concurrent load.** Per-frame inference: at N concurrent calls, ~N × 50 inferences/s (e.g. 60k
   concurrent → ~3M inferences/s). **CORRECTED (softened):** VAP-Realtime runs *real-time on CPU* (few-M params),
   so per-inference is cheap — not a mandatory GPU tier. The aggregate at very high concurrency is still large
   and per-frame ONNX inside a Cloudflare Workers isolate is likely the wrong tier; the levers are
   **inference-rate gating (run near boundaries / at 10–20 Hz, not 50) + batching**, and only *maybe* a
   dedicated inference service. This is an infra-design question, not a blocker.

---

## 7. The reassessment — and the question for you

**Evidence that VAP is not the operational answer:**

- **No production platform ships VAP.** LiveKit, Pipecat, Deepgram, Vapi each use their *own* end-of-turn
  models; Moshi / GPT-Live / Gemini bake turn-taking into an E2E model. VAP / TurnGPT are **research** artifacts
  (reused only in research prototypes). Sources: `research/interaction-policy/c3-backchannel-decision.md`
  (9-system prior-art matrix); `research/full-duplex-orchestration-litreview.md`.
- **The cheap stack already covers the operational job.** Endpointing → **Silero VAD + Pipecat Smart Turn v3**
  (ONNX, CPU-fast ~600 ms v2v, **23 languages**, open, production-recommended); barge-in → **RuleBased**;
  native fronts → **Defer**; "start early" latency → speculative generation (already shipped). VAP's *unique*
  additions (continuous backchannels, overlap, predictive shift) are either covered by a cheaper proxy (C3's
  delegate-gap cue) or are frontier polish.
- **Founder/investor lens (pre-launch).** VAP-real is months (export + fine-tune + GPU tier + eval + rollout)
  and directly starves the stated P0s (distribution, DX) and the sharpest wedge (faithful **multilingual** voice
  — where Smart Turn's 23 languages help and VAP's English checkpoint would not).

**The case *for* keeping VAP alive:** the differentiation thesis. If Syrinx wants to *credibly* claim
"open full-duplex, GPT-Live's feel without lock-in," a continuous learned controller is the eventual proof — and
VAP is the open, portable one. The seam + C6 eval harness let us **evaluate** that cheaply (shadow mode) before
funding it.

**Our current recommendation:** ship the production stack as **Silero + Smart Turn + RuleBased + Defer** behind
the seam; keep **VAP dormant** (a stub-backed package, costing nothing in prod); fund it only if the C6 eval
shows it beats the cheap stack by a margin worth a GPU tier.

**What we want your review on:**
1. Is "keep VAP dormant, ship Smart Turn + rules + Defer" the right call pre-launch — or are we underrating the
   full-duplex differentiation and should invest in VAP now?
2. If VAP is worth keeping alive: convert-and-fine-tune the existing checkpoint, train our own, or wait for a
   better open model? Any ONNX VAP (or equivalent continuous controller) we've missed?
3. Is per-frame inference fundamentally viable at scale, or does the compute math (§6.4) kill VAP as a
   *self-hosted* controller regardless — pointing instead at Defer-to-native for the full-duplex case?
4. Anything in §2/§4 (the sync-observe/async-inference design, the stereo mismatch, the placeholder buffer)
   that a real model would break on and we should redesign before wiring?

---

## References
- Ekstedt & Skantze, "Voice Activity Projection" (Interspeech 2022) — arXiv:2205.09812; repo
  `github.com/ErikEkstedt/VoiceActivityProjection` (PyTorch-only).
- Ekstedt & Skantze, "TurnGPT" (EMNLP Findings 2020) — arXiv:2010.10874.
- Multilingual VAP — arXiv:2403.06487 · Backchannel fine-tuning — arXiv:2410.15929 · Prompt-guided VAP (SIGDIAL
  2025) · Multimodal VAP — arXiv:2506.03980 · General reuse — arXiv:2501.08946.
- Pipecat Smart Turn v3 — `github.com/pipecat-ai/smart-turn`; `docs.pipecat.ai/.../smart-turn-overview`;
  Daily blog (v3.1); v3 supports 23 languages, ONNX, CPU.
- Syrinx internal: `docs/rfc-interaction-policy-seam.md`; `research/full-duplex-orchestration-litreview.md`;
  `research/interaction-policy/c3-backchannel-decision.md`.
</content>
