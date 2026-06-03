# VE-08 — Tier-1 hardening

**Type:** mix (AFK build / HITL tuning) · **Tier:** Tier-1 · **Status:** Backlog
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **Tier-1 list**, **§9 Multilingual & Audio Preprocessing**

## What to build
The polish layer that makes the engine feel human once Tier-0 is solid. Each sub-item is independently shippable — split into child tickets during VE-00/rfc-to-sprints if desired.

## Acceptance criteria
- [ ] **Eager-EOT / preemptive generation** with commit-time validation and scrap-on-resume (speculative LLM start during the final-silence wait; no audio playout until validated).
- [ ] **Denoising / AEC** before VAD/STT where the deployment noise profile requires it (Krisp/RNNoise selectable; AEC vs hard-mute tradeoff per mode).
- [ ] **Backchannel-vs-interruption classification** + false-interruption resume.
- [ ] **Multilingual:** carry language code + confidence on transcript frames; language-triggered TTS voice switching (greenfield — see VE-09); persona/pacing/pronunciation consistency across languages.
- [ ] **µ-law passthrough** benchmark where STT/TTS support it natively.

## Demo / verify
Measured TTFA improvement from preemptive gen with no premature/incorrect playout; clean conversation in a noisy room; "mm-hmm" doesn't interrupt; a code-switch mid-call keeps persona.

## Blocked by
VE-02, VE-03 (and VE-05 to measure the preemptive-gen win).

## Key references
notes: LAT-09/10/11, TURN-09/11, STT-11/12, XPORT-10/12, LANG-01..04, TTS-10; wiki/lat-map, lang-map.

## Current state (Syrinx)
Backchannel labels, latency filler, word timestamps, and language fields exist as partial primitives; eager EOT, denoising/AEC, false-resume, VAD benchmarks, pronunciation controls, dynamic voice switching, and Opus/FEC verification still need child slices. See [`../reconcile/VE-08-bridge.md`](../reconcile/VE-08-bridge.md).
