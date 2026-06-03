# VE-09 — Greenfield gaps (design-first; no OSS clone implements these)

**Type:** HITL (design before build) · **Tier:** Greenfield · **Status:** Backlog
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **Greenfield Gaps**

## What to build
The capabilities the verification confirmed **no OSS clone provides** — each needs a design (RFC) before implementation. These are Syrinx's differentiation surface.

## Acceptance criteria (each → its own RFC + child ticket)
- [ ] **Dynamic hedging** of silent provider hangs: per-endpoint `mean + k·σ` timeout → cancel-and-refire to next-fastest (Vapi pattern; source-only). Needs per-endpoint latency histograms (from VE-05/07) first.
- [ ] **Bandit exploit/explore routing** across provider endpoints by measured tail health (define exploration slice + cost guard).
- [ ] **Supervised VAD subprocess** with auto-respawn (isolate VAD so a crash doesn't drop the call).
- [ ] **Pre-TTS guardrail/classifier** placement on the critical path ("can't unsay spoken words") with a budgeted P95.
- [ ] **VAQI rollup** (define the I/M/L formula + tolerance bands + missed-response window).
- [ ] **Replay / load / fault-injection harness** for the non-deterministic pipeline (recorded-audio replay, P95/P99 assertions, provider-fault injection, turn diagnostics).

## Demo / verify
Each sub-capability: an approved RFC, then a measured before/after (e.g. hedging cuts P95 tail; fault injection proves graceful recovery).

## Blocked by
VE-05, VE-07 (these depend on the observability/latency telemetry existing first).

## Key references
notes: LAT-06/07, REL-11, ARCH-11, LAT-13, OBS-03/09; the "Greenfield Gaps" + "Open questions" sections of every `wiki/*-map.md`.
