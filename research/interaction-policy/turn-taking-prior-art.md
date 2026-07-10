# Turn-taking / interaction-control prior art — how the field solves it, model + license audit, and the VAP decision

**Date:** 2026-07-10 · **For:** the Syrinx VAP build-vs-adopt-vs-train decision (companion to
`docs/vap-assessment-for-review.md`). · **Method:** 4 parallel firsthand deep dives (LiveKit, Pipecat/Smart
Turn, Vapi/ElevenLabs, model+license audit) — every license below was read from the actual `LICENSE`/model
card, not inferred.

---

## TL;DR (the committed verdict)

1. **No production platform ships a monolithic VAP.** The frontier (LiveKit) *decomposes* turn-taking into
   separately-trained **audio EOU + barge-in CNN + backchannel** heads; Vapi *orchestrates* pluggable
   partner detectors + config; ElevenLabs bundles a proprietary turn model. The industry pattern is
   **"binary/semantic EOU detector + VAD + rules + speculative generation"**, not continuous VAP.
2. **Only ONE off-the-shelf detector is cleanly commercial-usable: Pipecat Smart Turn v3 (BSD-2-Clause).**
   TEN (Agora anti-compete + no-on-device) and LiveKit (framework-locked, can't even distill from it) are
   **disqualified by license** for a competing voice platform. Krisp is closed/rented. → **Adopt Smart Turn.**
3. **You cannot "patch" Smart Turn into VAP.** It's a binary, mono, pause-triggered Whisper-Tiny classifier —
   no head for backchannel/future-VA, no stereo. Getting VAP capability = new head + stereo + retrain = a new
   model. (You *can* run it on a sliding window + fuse Silero + ASR for better endpointing — same capability
   class, real win, cheap.)
4. **CORRECTION to the VAP-assessment doc: an ONNX VAP DOES exist and is clean *code*.** `inokoj/VAP-Realtime`
   is MIT, ships an official ONNX exporter, runs **real-time on CPU**, is **stereo**, and has **dedicated
   backchannel + nodding fine-tunes**. The only blocker is that its *distributed weights* are LDC-trained
   (research-restricted) — so the path to VAP is **retrain the MIT architecture on owned/licensed dialogue
   audio**, not "no model exists" and not "patch Smart Turn."

**Recommendation:** ship **Silero (MIT) + Smart Turn v3 (BSD) + RuleBased + Defer** behind the seam now — all
license-clean, production-proven, multilingual. Keep VAP **dormant**. *If* the C6 eval later shows VAP's
continuous/backchannel value beats this stack, the path is **VAP-Realtime (MIT code + ONNX exporter) trained
on our own audio** — a bounded ML project, not a research moonshot and not a Smart Turn patch.

---

## 1. Commercial-use license audit (read this first — it kills most options)

| Model | License (firsthand) | Commercial for Syrinx? | Note |
|---|---|---|---|
| **Silero VAD** | MIT | ✅ YES | already in use |
| **Pipecat Smart Turn v3** | **BSD-2-Clause** | ✅ **YES, unconditional** | binary EOT only |
| **VAP-Realtime (Inoue)** — code | MIT (+ CPC encoder MIT) | ✅ code YES | the architecture + ONNX exporter |
| **VAP-Realtime — distributed weights** | trained on LDC Switchboard/Fisher/Candor | ⚠️ **CONDITIONAL** | retrain on owned audio to clear |
| **TurnGPT (Ekstedt)** | MIT (code) | ⚠️ code YES, weights research-corpus | text-side recipe, not a product weight |
| **Moshi/Mimi (Kyutai)** | code MIT/Apache; **weights CC-BY-4.0** | ✅ YES (attribution) | but a 7B E2E model, not a seam-able detector |
| **TEN Turn Detection (Agora)** | Apache **+ anti-compete + no-on-device** | ❌ **NO** for us | license text forbids competing use + device deploy |
| **LiveKit turn-detector / EOU** | LiveKit Model License (proprietary) | ❌ **NO** | usable only inside LiveKit Agents; can't distill from it |
| **Krisp VIVA Turn/Interruption** | closed paid SDK | ❌ rent-only | no weights to adopt/self-host |

**Verbatim, because the naming lies:**
- TEN `LICENSE`: *"You may not (i) host … on any End User devices … or (ii) Deploy … in a way that competes
  with Agora's offerings."* Both carve-outs bite a competing, edge-capable platform → NO.
- LiveKit `MODEL_LICENSE`: *"not to use any LiveKit Models on a standalone basis or with any frameworks other
  than LiveKit Agents; (ii) not to use any … output … to improve or otherwise develop any other models."* →
  can't even distill it. NO.

**Result: the only license-clean off-the-shelf *detector* is Smart Turn v3 (BSD-2).** The only license-clean
path to *continuous/backchannel* VAP is VAP-Realtime's MIT **code**, trained on your own data.

## 2. Model capability table

| Model | Modality | ONNX | Size | Latency | Langs | Binary vs continuous |
|---|---|---|---|---|---|---|
| Silero VAD | audio | ✅ | tiny | <1 ms | agnostic | binary speech/silence |
| **Smart Turn v3** | audio (Whisper-Tiny enc + linear head) | ✅ 8 MB int8 | 8 M | **~12 ms CPU** | **23** | **binary EOT** (no backchannel) |
| **VAP-Realtime** | **stereo audio** (CPC + self/cross-attn) | ✅ **official exporter** | few M | **real-time CPU** | EN/JP (+ML) | **continuous p_now/p_future + backchannel + nod** |
| LiveKit EOU v1/mini | audio (+semantic) | mini local | n/d | fast | 14 | continuous prob + backchannel thr — *fenced* |
| LiveKit turn-detector (legacy) | text (Qwen2.5-0.5B) | ✅ q8 | 0.5 B | ~50–160 ms | 14 | binary — *fenced* |
| TEN turn detection | text (Qwen2.5-7B) | ✗ | ~8 B | LLM-scale | EN/ZH | 3-class — *disqualified* |
| TurnGPT | text (GPT-2) | convertible | 124 M | fast | EN | continuous next-speaker |
| Krisp VIVA TP v3 | audio | closed | ~9 M/30 MB | 69% shifts <200 ms | 12+ | binary EOT + sep. interruption — *closed* |
| Moshi | audio full-duplex (dual-stream) | partial | ~7 B | ~0.7 s | EN | full continuous — *whole-stack replacement* |

## 3. How each platform actually solves it (mechanisms)

**LiveKit (the frontier — audio-native, decomposed, fenced).** Three learned heads: **EOU** (audio v1 cloud /
v1-mini local ONNX; fuses semantic + acoustic; dynamically shortens/extends the Silero silence timeout;
commits after ~1 s if no prediction) + **adaptive barge-in** (audio encoder + **CNN**, 30 ms inference,
**86% precision / 100% recall @ 500 ms overlap**, rejects **51%** of VAD false barge-ins, "discriminate genuine
interruptions from 'mm-hmm,' coughs") + **backchannel** classification. Background/thinking audio is
**asset-based** (pre-recorded `.ogg`); backchannels are **detected/suppressed, not generated**. **Preemptive
LLM generation on by default.** Lesson: turn-taking is a *multi-signal audio problem*, and LiveKit's moat is
the *fenced models + cloud*, not the open code.

**Pipecat (adopt-the-detector).** Silero VAD (continuous, `stop_secs≈0.2`) → **Smart Turn v3** (pause-triggered
binary EOT) → word-count heuristic OR **Krisp VIVA** (closed model) for interruption. Filler = **dynamic TTS**
(`TTSSpeakFrame`, kept out of LLM context), not assets. Krisp's IP model is the only VAP-adjacent interruption
intelligence in the ecosystem — and it's paywalled.

**Vapi (orchestrate + config, no own model).** `startSpeakingPlan` routes to **pluggable** detectors (LiveKit
`waitFunction "200+8000*x"`, Krisp acoustic, Deepgram Flux `eotThreshold 0.7`, Assembly) + a base `waitSeconds
0.4`. `stopSpeakingPlan` is pure config (`numWords`, `voiceSeconds 0.2`, `backoffSeconds 1`; VAD 50–100 ms vs
transcription 200–500 ms). **Backchannel generation** = a proprietary fusion model (the one bespoke piece);
`<flush/>` token cuts buffering. Lesson: **the turn model is treated as a swappable commodity, not a moat.**

**ElevenLabs (bundle + hide).** Proprietary turn model (VAD + DL over fillers/prosody/micro-pauses); only
`turn_timeout` + `turn_eagerness` exposed; native non-tunable barge-in + a `skip-turn` tool; `soft_timeout`
filler phrase; no generative backchannel. TTS ~75 ms / ~135 ms e2e. Lesson: even the "premium feel" leader
exposes 2–3 knobs over a bought/bundled model.

**Cross-platform matrix:**

| | Endpointing | Barge-in | Backchannel | Own model? |
|---|---|---|---|---|
| LiveKit | audio EOU (learned) | **CNN, learned** | detect/suppress | **yes, fenced** |
| Pipecat | Smart Turn (adopt) | word-count / Krisp | Krisp detect | **no** (adopts) |
| Vapi | pluggable partners | config thresholds | fusion model (gen) | **no** (orchestrates) |
| ElevenLabs | bundled turn model | native | none (consumes fillers) | **yes, bundled** |
| **Syrinx (proposed)** | **Smart Turn + Silero** | **RuleBased** (→ Smart-Turn-fusable) | C3 gap-cue / VAP-later | seam: adopt + optional-own |

## 4. Can we patch Smart Turn to ≈ VAP? — Verdict: NO for VAP's defining capabilities

Firsthand-verified limits (from reading the Smart Turn source):
1. **Single sigmoid output** — no backchannel class, no future-VA horizon. You cannot read backchannel timing
   or predictive shift out of it; needs a **new multi-bin projection head** → retrain.
2. **Trained pause-conditioned** — 8 s window right-aligned + left-zero-padded, labelled "is this turn-final
   pause complete." Running it mid-utterance at 20–50 Hz is out-of-distribution.
3. **Mono** — VAP is inherently **two-speaker** (it projects the agent channel too — that's *how* it times
   backchannels/overlap). Smart Turn never sees the bot → new I/O + dual-channel training data.
4. **Latency** — a Whisper-Tiny encoder over 8 s is 12–65 ms; fine per-pause, a non-starter at VAP frame rate.

**What you *can* do cheaply:** run Smart Turn on a sliding window + fuse Silero VAD + ASR partials → a
lower-latency, semantically-aware **endpointer**. Real improvement, same capability class. **80% of VAP's
value is not reachable by patching** — the missing 80% (continuous backchannel/overlap/predictive) *is* the
new head + stereo + retrain, i.e. VAP-Realtime, not Smart Turn.

## 5. The VAP path, corrected — VAP-Realtime (MIT), if the eval ever asks for it

`github.com/inokoj/VAP-Realtime` (Koji Inoue, MIT; CPC encoder also MIT): **stereo** input → continuous
`p_now`/`p_future`; **fine-tuned variants for backchannel** ("probability of backchannel 500 ms later") **and
nodding**; **"operates in real-time in a CPU environment"**; ships `tools/export_vap_onnx.py` + a browser
ONNX demo + TFLite/TFJS exporters. So — contrary to my earlier claim — **ONNX VAP is a solved, MIT-licensed
path, CPU-real-time, with the exact backchannel capability VAP is prized for.** The *only* blocker is that the
distributed English checkpoint is trained on LDC97S62 (Switchboard) etc. → **retrain on owned/commercially-
licensed dialogue audio** to ship it. That is a bounded, fundable ML task — the seam + C6 eval decide whether
it's worth it.

## Recommendation + flip conditions

**Pick: Silero (MIT) + Smart Turn v3 (BSD) + RuleBased + Defer, behind the seam. VAP dormant.**
Rationale: it is the only fully license-clean, production-proven, multilingual (23-lang), CPU-cheap stack; it
matches what Pipecat/Vapi ship; and it directly serves the multilingual wedge. Building a bespoke turn model
now is premature (§ build-for-one) and — for the *operational* job — unnecessary.

**Flip to "train VAP" if AND ONLY IF:** the C6 eval (with the real cheap stack live) shows a **measurable
turn-taking-quality gap** vs native-realtime that traces specifically to **continuous backchannels / overlap /
predictive shift** (the things Smart Turn structurally can't do) — AND that gap matters to a real customer.
Then the path is **VAP-Realtime architecture, retrained on our audio, ONNX-exported** — cost ≈ an ML project
(data + train + eval), *not* patching Smart Turn, *not* LiveKit/TEN weights, *not* the LDC checkpoints.

**Do NOT:** adopt TEN or LiveKit weights (license); rent Krisp as the moat (closed); ship VAP-Realtime's
LDC-trained checkpoint commercially; or try to patch Smart Turn's binary head into VAP.

## Corrections to prior claims (propagated)
- **"No ONNX VAP exists"** (in an earlier chat + implied in `docs/vap-assessment-for-review.md`): **CORRECTED**
  — VAP-Realtime ships an official MIT ONNX exporter; ONNX VAP is real and CPU-real-time. The blocker is the
  *weights' training-data license*, not existence or technical feasibility. (Doc patched.)
- **"VAP needs a GPU inference fleet"**: **SOFTENED** — VAP-Realtime runs real-time on CPU (CPC + small
  transformer, few M params). The 60k-*concurrent per-frame* aggregate cost is still large, but per-inference
  it is cheap CPU, not a mandatory GPU tier; inference-rate gating + batching apply.

## Sources
LiveKit: github.com/livekit/agents; huggingface.co/livekit/turn-detector (+MODEL_LICENSE);
livekit.com/blog/{using-a-transformer-to-improve-end-of-turn-detection, adaptive-interruption-handling,
turn-detection-voice-agents-vad-endpointing-model-based-detection}. Pipecat/Smart Turn:
github.com/pipecat-ai/{smart-turn,pipecat}; huggingface.co/pipecat-ai/smart-turn-v3; daily.co blog (Smart Turn
v3/v3.1/v3.2). Vapi: docs.vapi.ai/{customization/speech-configuration, voice-pipeline-configuration,
assistants/flush-syntax, how-vapi-works}. ElevenLabs: elevenlabs.io/docs (conversation-flow, skip-turn),
elevenlabs.io/blog/{conversational-ai-2-0, how-do-you-optimize-latency-for-conversational-ai};
deepgram.com/learn/elevenlabs-barge-in-interruptions-turn-taking. Models/licenses: github.com/inokoj/VAP-Realtime;
github.com/ErikEkstedt/{VoiceActivityProjection,TurnGPT} (arXiv:2205.09812, 2010.10874); arXiv:2403.06487,
2401.04868; github.com/facebookresearch/CPC_audio; github.com/TEN-framework/ten-turn-detection;
github.com/kyutai-labs/moshi; krisp.ai VIVA docs; arXiv:2509.14515 (full-duplex survey), arXiv:2509.23938 (Easy Turn).
</content>
