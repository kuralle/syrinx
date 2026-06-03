# Build Operating Instructions — Syrinx Voice Engine

**Read this, then the master document, before touching any card.**

## The master document
[`../PRODUCTION-CHECKLIST.md`](../PRODUCTION-CHECKLIST.md) is the single source of truth for *what_ to build and to what standard. It is **claim-verified** against the canonical OSS implementations (audit: [`../_reviews/VERIFICATION-REPORT.md`](../_reviews/VERIFICATION-REPORT.md)). Each checklist item carries: the requirement, the evidence note, the canonical `_clones/...:line`, the target number, and (for subtle mechanisms) pseudocode. **When an issue and the checklist disagree, the checklist wins** — and fix the issue.

Supporting knowledge: the 109-note second brain in [`../notes/`](../notes) and the domain maps in [`../wiki/`](../wiki) (each map's "Open questions / gaps" feeds VE-09).

## Hard rules (carry these into every card)
1. **Scope = speech-in / speech-out only** — transport, STT/VAD/turn-taking, transcript-out, response-text-in, TTS/audio-out. Not agent reasoning/prompting/RAG.
2. **Voice-to-voice latency and reliability are the metrics.** Optimize **P95/P99**, not the mean. "Every 10 ms matters."
3. **Cite reality, not memory.** The `_clones/` are reference, but Syrinx's own code is ground truth for what exists — confirm with `file:line`, never assume.
4. **One source of truth per turn boundary** (VE-02): never run redundant VAD/endpointing when a provider owns EOT.
5. **Guardrails before TTS** — spoken words can't be unsaid (VE-09).
6. **Drain, don't kill** stateful calls on scale-down (VE-06).
7. **No silent failure** — every degraded path must speak or escalate, never go quiet.
8. **Source-only ≠ verified.** Items the checklist marks "source-only" / "no clone implements it" (Vapi hedging, co-location math, <100 ms barge-in, RTF, VAQI rollup) are **greenfield** — measure them in Syrinx, don't assume the number transfers.

## Workflow per card (Phase-A / Phase-B, rfc-to-sprints style)
1. **Grab:** move the card Ready → In Progress; set the issue `**Status:**`.
2. **Read** the master-document § it points to + the listed notes.
3. **Build the vertical slice** end-to-end (it must be demoable on its own).
4. **Proceed-evidence (Phase A gate):** before marking done, produce proof the slice works end-to-end — a demo, a measured number (v2v / TTFA / barge-in onset), or a passing integration test. Link the proof in the issue.
5. **Manager review (Phase B gate):** move to In Review; an independent pass checks the diff against the acceptance criteria + the checklist standard (use `/delegate-review`). Only then → Done.
6. **Regression:** each new slice must not break the prior slices' demos (re-run the v2v measurement).

## Starting point
**VE-00 (gap analysis) is the only card in Ready.** It re-scopes everything else against Syrinx's actual code. Do it first; do not build VE-01..09 until the gap analysis has narrowed their acceptance criteria to real gaps.
