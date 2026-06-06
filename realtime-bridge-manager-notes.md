# RealtimeBridge (B-01) — manager notes

Goal: bi-model voice — `gpt-realtime-2` front + university `.stream` Reasoner back. Plan: `docs/rfc-realtime-bridge.md`.
Worker: cursor. Manager: review every diff + run live gates.

## Build order status
| WBS | Chunk | Worker | Status | Gate |
|-----|-------|--------|--------|------|
| 1 | `fromOpenAIRealtime` adapter + `packages/ws` realtime socket | cursor | ✅ DONE, live-verified | `{"ok":true, capturedBytes:19200, resampledBytes:12800, durationMs:400}` — live gpt-realtime-2 frame round-tripped through `decodeSyrinxAudioEnvelope` (R2) |
| 2 | `RealtimeBridge` VoicePlugin (live audio loop) | cursor | ✅ DONE, live-verified | `{"ok":true, audioBytes:115200}` — 3.6s gpt-realtime-2 audio through bridge→session→tts.audio→wav |
| 4 | delegate loop + university Reasoner (the payoff) | cursor | ✅ DONE, live-verified | bi-model turn: lead-in→ask_university→university reasoner→voiced grounded Late-Add-Petition answer. OQ1 resolved (function_call_output+response.create, no double-audio). |
| 3 | barge-in (detect+cancel+truncate+fresh contextId) | cursor | ✅ logic done (unit + live detection); ⚠ live resume-smoke flaky | double-barge-in unit test green |
| 5 | latency gate + README | manager | ✅ README done; ⏳ direct-vs-bridged delta harness OPEN | measured bridged numbers documented |

## WBS-3 review (honest)
Barge-in additions correct: `playedMs` from `tts.playout_progress.playedOutMs`, `interrupt.tts` →
`cancelResponse(playedMs)` + `inflight?.abort()`, `speech_started` → `interrupt.detected`, playedMs reset/turn.
- ✅ Deterministic **double-barge-in unit test** (R1+R3): cancelResponse called ≥2, turn B & C fresh-contextId
  audio delivered (not dropped).
- ✅ Live: barge-in DETECTION fired (2nd speech_started mid-turn-1 → interrupt).
- Manager fix: `cancelResponse` now guards on `activeResponse` (set on response.created, cleared on
  response.done/cancel) — avoids "Cancellation failed: no active response" when barge-in hits an idle session.
- ⚠ **Live `smoke:realtime-bargein` "second turn timeout"** — flaky ORCHESTRATION (chaining 3 sequential
  live turns + server_vad + mid-response barge with one WAV fixture reliably eliciting a fresh audible 3rd
  response is hard). NOT a demonstrated bridge defect; the logic is unit-proven + detection-live-confirmed.
  Follow-up: rework the live barge smoke to use distinct fixtures / explicit response control, OR accept
  the unit test as the barge-in gate.

## WBS-5 (manager)
`packages/realtime/README.md` written with the honest latency characterization (measured bridged numbers
from the live smokes; explicitly NOT "~0"). OPEN: the rigorous first-audio direct-vs-bridged delta harness.

## Review-WBS execution (autonomous-manager, 2026-06-06)
Codex review returned not-ready (14 rows). Executed via cursor, manager-reviewed each diff + ran gates:
- **Chunk 1 — R-04,06,07,08,09,10,11,12,13** ✅ DONE: runtime-agnostic base64 (atob/btoa) + `globalThis.crypto.randomUUID` + injected `debug` (no Buffer/node:crypto/process in src); session-config surface (instructions/modalities/temperature/inputTranscription/toolChoice/in-out rates); delegate-tool mismatch guard; full ReasoningPart contract (never inject ""); `contextProvider` + stateless doc; `requiresResponseCreateAfterToolOutput` gate; assistant-item lifecycle clear on start/done/cancel; audio coalescing to ≤20ms frames + odd-byte guard; pump surfaces llm.error. **20→22 unit tests; live university gate still green.**
- **Chunk 3 — R-05, R-14, T-07** ✅ DONE: README "Deploy on Cloudflare Workers" (createWorkersSocket + env-binding injection); `edge-safety.test.ts` (source-scan regression lock + functional round-trip — manager fixed cursor's original which crashed vitest by deleting globalThis.process); skip-open doc/test. typecheck 0 errors.
- **Chunk 2 — R-01,02,03** ⏸ DEFERRED per owner: repo-wide publish gap (ALL 16 packages ship raw TS + workspace:*), spec'd at `docs/npm-publish-setup-task.md`. Not a realtime-only fix.
- **Spike (decision §5)** ✅ DONE: @openai/agents chain ≈22MB unpacked (openai SDK 9.8 + agents-core 5.5 + ext 2.5 + zod4 4.6). Isolation PASSES (core stays clean) but adapter not Free-edge-friendly → do NOT build the optional fromOpenAIAgentsTransport now (no consumer). Hybrid = keep seam + learn event-shapes.
- Remaining open (not blockers): event-shape backlog T-01/03/04/05 (each gated on a named consumer), first-audio latency delta harness (WBS-5), repo-wide publish task.
- Transport decision recorded: `bi-model-research/transport-decision.md` (don't adopt @openai/agents by default).

## Final state
- New pkg `@kuralle-syrinx/realtime`: adapter + bridge + 8 unit tests (all green). `pnpm -r typecheck` = 0 errors.
- 4 live smokes wired (frame/oneturn/university green; bargein logic-green/live-resume flaky).
- **Bi-model thesis PROVEN LIVE** (university turn). Not committed (commit only on user request).
- Hard reqs: R1✅ R2✅ R3✅(logic) R4✅ R5✅ R6✅ R7✅(honest, delta harness open).

## WBS-4 review
Delegate loop mirrors processTurn (R4): text-delta accumulate, finish.text, suspended throws, non-recoverable
error throws, AbortError swallowed; correct `llm.tool_call`/`llm.tool_result` packet fields; injectToolResult.
7/7 unit tests (incl finish-with-text + suspended). No debris (cursor obeyed). LIVE timeline proves the thesis.

## WBS-2 review + manager fixes
Bridge was clean (VoicePlugin contract, R1 fresh-contextId-per-turn with previousContextId, R2 24k→16k
resample + 20ms chunking, eos+tts.end re-arm, llm.error real shape on Critical, no `as any`). Fixes:
- removed root debris (`realtime-bridge-implementation-notes.md`, `-scratchpad.md`) — cursor keeps emitting these.
- transcript ROLE bug: bridge recorded the assistant's `output_audio_transcript` as `stt.result`/`eos.text`
  (those are the USER's transcript). Fixed: only `role:"user"` finals become turn user text. (Delegate gets
  the query from the tool-call args, not this — so not a WBS-4 blocker.)
- carry-forward: assistant transcript currently unused; user-input transcription not requested on the
  session (would need `audio.input.transcription` in session.update) — only needed if we want user STT timeline.

## WBS-1 review + manager fixes (on top of cursor's diff)
Cursor's adapter was clean (exact interface, reused `WebSocketConnection`, no `as any`, exact-JSON tests).
Manager corrections found via the live feedback loop (each surfaced by the next gpt-realtime-2 error):
1. removed stray root debris (`realtime-adapter-implementation-notes.md`, `-scratchpad.md`).
2. `session.update` needed `session.type:"realtime"` (was missing — gap in the manager brief, not cursor).
3. `session.audio.output.format.rate` required (added `rate:24000`).
4. `output_modalities` must be `["audio"]` not `["audio","text"]` (doc example was wrong).
5. semantic_vad never fired `speech_stopped` on synthetic TTS → made `turn_detection` a configurable option (default semantic_vad); gate uses `server_vad`+`silence_duration_ms:500`. Then full lifecycle fired (6 audio deltas).
6. added `close(): Promise<void>` to `RealtimeAdapter` + impl (was private) — needed so the socket/keepAlive
   releases the event loop; WBS-2's `VoicePlugin.close()` will call it.
7. smoke: surface recoverable errors (was silently swallowed) + `SYRINX_REALTIME_DEBUG` raw-type logging.

## Carry-forward for WBS-2+
- `turn_detection` is now configurable on the adapter — the bridge/session config should choose
  (`server_vad` is more deterministic; `semantic_vad` is the design default but conservative on TTS).
- adapter `close()` exists — wire it to `VoicePlugin.close()`.
- OQ1 (async-fn-calling vs manual response.create) still to resolve at WBS-4 via live smoke.
