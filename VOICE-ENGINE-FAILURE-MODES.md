# Syrinx Voice Engine — Failure-Mode Catalog & Reliability Strategy

> **Operating directive (embodied):** Take an autonomous stand and deliver the work. No shortcuts, no deferring,
> no workarounds when the real fix exists. Breaking changes are embraced over back-compat. Search before building,
> test before shipping, ship the complete thing. Time / fatigue / complexity are not excuses. Don't fight errors —
> research 3–5 fixes and pick the best. The bar is "holy shit, that's done," not "good enough."

**Purpose.** A grounded, source-cited catalog of what can break this engine, across every transport and every
pipeline stage, with each gap's current exposure in v2 code (`file:line`), severity, and the *real* fix
(breaking changes allowed). This is the reverse-engineering of how production engines stay reliable, turned into
an actionable plan. Full research trail is in `RELIABILITY-HARDENING-NOTES.md` (4 layers, fact-checked).

**Methodology / sources (all grounded, not assumed):**
1. **Deepgram "Definitive Guide to Voice AI Agents"** (107 pp) — `research-notes/deepgram-voice-agent.txt`, esp. the
   Common-Failure-Modes appendix and Resilience/Reliability chapters.
2. **Production reference engines, read & fact-checked at `file:line`:** LiveKit Agents (Python + JS), Rapida (Go),
   Pipecat (Python). Under `…/asyncdot/openscoped/voice-media-transport/research/`.
3. **Same-project prior art** (v1.x): `PLAN-kernel-ws-optimization.md` (benchmarked vs the Pipecat/Daily
   voiceaiandvoiceagents.com gold standard) + hardening scratchpads.
4. **Web research** (pi/Gemini + fact-checks against MDN, LiveKit, Chromium WebRTC, PNAS).
5. **v2 Syrinx source audit** — personally read; every gap below cites `file:line`.

---

## 1. The taxonomy: 5 layers × every transport

Deepgram's framing (the right mental model): every real-time voice failure lives in one of five layers — **capture,
transcription, reasoning, synthesis, playback** — and you must identify the layer *before* tuning. Syrinx adds a
6th cross-cutting concern: **transport** (browser WS, Twilio, Telnyx, SmartPBX, Fly carrier), because Syrinx is
**WebSocket end-to-end** (no WebRTC last mile — a settled decision, ADR-006).

The single most important architectural truth (PDF + LiveKit + pi research, fact-checked): **a voice agent is an
event-driven, interrupt-aware, asynchronous system, not a sequential pipeline. Latency compounds; timing mismatches —
not raw inference — cause premature cutoffs, dead air, and double-speak.** And because Syrinx is WS-only, it inherits
WS's structural weaknesses (no native backpressure, TCP head-of-line blocking, no jitter buffer, no timing semantics)
that it must close in software.

---

## 2. Prioritized gap register

Severity = user-perceived damage when it fires. Frequency = how often on real traffic. Exposure = confirmed in v2 source.
P (priority) = Severity × Frequency, adjusted for blast radius.

| # | Gap | Layer | Sev | Freq | Exposure (v2 `file:line`) | P |
|---|-----|-------|-----|------|---------------------------|---|
| G1 | **✅ SHIPPED — False barge-in** — raw VAD speech-start instantly interrupted; no min-duration/backchannel guard | capture/playback | High | High | `voice/src/voice-agent-session.ts` (gated) | **P0 done** |
| G2 | **✅ SHIPPED — Interrupted-turn history divergence** — bridge now tracks text sent to TTS per turn and, on barge-in, rewrites that turn's history to the spoken prefix (truncate if committed, record spoken prefix if mid-generation); user utterance always preserved | reasoning | High | High | `voice-bridge-aisdk/src/index.ts` | **P0 done** |
| G10 | **✅ SHIPPED — Bus head-of-line blocking** — `PipelineBus.on()` now supports a per-handler `{concurrent}` opt-in; the bridge runs generation as a concurrent producer so the drain loop is never parked (LLM→TTS streams during generation; interrupts handled promptly) | transport/core | Med | Med | `voice/src/pipeline-bus.ts` + `voice-bridge-aisdk` + repro/sim | **P1 done** |
| G11 | **✅ SHIPPED — Periodic Silero VAD state reset mid-speech** — now gated on `!this.speaking` so the RNN state is never zeroed mid-utterance (only at silence) | capture | High | Med | `voice-vad-silero/src/index.ts` (gated + 2 tests) | **P1 done** |
| G3 | **✅ SHIPPED — TTS output stall watchdog** — `ttsStallMs` (default 15s) armed after first `tts.audio`; if the provider goes silent mid-utterance (no audio/`tts.end`) it emits a recoverable `tts.error` (NetworkTimeout) instead of hanging. (STT stall already covered by force-finalize→provider-finalize→timeout; LLM by `withStreamIdleTimeout`.) | synthesis | High | Low-Med | `voice/src/voice-agent-session.ts` | **P1 done** |
| G4 | **✅ SHIPPED (scoped) — graceful degradation on LLM failure** — on a recoverable LLM error the session speaks a configurable `errorFallbackText` (default on) via the TTS path instead of failing silently ("never fail silently"). TTS/STT-failure fallback (canned audio / clarification) + multi-provider FallbackAdapter remain follow-ons | reasoning | Med-High | Low-Med | `voice/src/voice-agent-session.ts` | **P1 done (scoped)** |
| G5 | **✅ SHIPPED (refined) — Telephony pacer drift correction + `pacer_deadline_miss` metric** — `PacedPlayoutQueue` now drift-locks cadence to wall-clock and reports late wake-ups; comfort/idle frames deliberately NOT added (WS carriers handle gaps natively, unlike Rapida's RTP) | playback | Med | Med | `voice-server-websocket/src/paced-playout.ts` + 3 adapters | **P2 done** |
| G6 | **✅ INVESTIGATED — N/A for this bridge** — history is text-only (tool-call/result are observability bus packets, never persisted to `this.history`), so no dangling tool-call survives across turns; `abortSignal` already propagates to tool execution. Tool *side-effects* remain the tool author's responsibility | reasoning | Low | Low | `voice-bridge-aisdk/src/index.ts:140-162,202` | **N/A** |
| G7 | **✅ SHIPPED — live VAQI/SLO telemetry** (vaqi.latency_ms / interruption / missed_response + interrupt.latency_ms) | observability | Med | n/a | `voice/src/voice-agent-session.ts` (observability-only) | **P2 done** |
| G8 | **No per-provider concurrency/rate-limit backoff** — 429/concurrency under load not retried with backoff | all | Low-Med | Low (scale) | prior-art backlog | **P3** |
| G9 | **✅ AUDITED + observability — Long-call WS write-after-close** — v2 was *already* safe (send helpers guard `readyState`); added per-context `websocket.send_after_close` drop metric across all 4 transports. (>10-min soak smoke still TODO) | transport | Med | Low | `voice-server-websocket/src/{index,twilio,telnyx,smartpbx}.ts` | **P3 ~done** |

**Strengths already hardened (must NOT regress):** mixed-sample-rate rejection; interrupted-context terminal
suppression across core + all transports; recorder wall-clock truncation of unheard audio; Smart Turn as single
boundary authority (raw-VAD finalize rejected); transport backpressure (1013) + heartbeat + max-session + startup
timeout + envelope/sequence validation; provider-semantic adapters (Deepgram provider-finalize + state-discard on
reconnect, Cartesia X-API-Key/contexts/cancel + the `flush_done` fix); LLM stream idle timeout.

---

## 3. The fixes (real fixes, breaking changes embraced)

### G1 — False barge-in guard  ·  ✅ SHIPPED  ·  capture/playback
**Shipped (2026-05-30).** Added `minInterruptionMs` (default 280 ms) to `VoiceAgentSessionConfig`. The session now
gates `interrupt.detected`: on `vad.speech_started` during active TTS it sets a *pending* interruption keyed on the
user context, and commits it only once `vad.speech_activity` shows speech sustained past `minInterruptionMs`. A
`vad.speech_ended` before the threshold cancels it (`interrupt.suppressed_short_speech`); if the assistant finishes
during the window the gate resolves without a stale cut (`interrupt.gate_resolved_after_tts_end`); a committed gate
emits `interrupt.committed_after_ms`. `minInterruptionMs: 0` restores the legacy immediate cut. The gate is driven
purely by bus packets (no timers → no cleanup). Tests: 3 new (sustained-commit, short-blip-suppressed,
assistant-finishes-during-gate) + 3 existing barge-in tests re-pointed to the explicit gate-off path. Full triad green.
*Honest scope:* this kills transient noise / clicks / very short blips (the most common false triggers); a deliberate
≥280 ms spoken backchannel ("yeahhh") still commits — semantic backchannel detection is out of scope.

**Original problem.** `handleVadSpeechStarted()` fired `interrupt.detected{source:"vad"}` the instant VAD reported speech while
TTS is active — no min-duration, no min-words, no backchannel window, no debounce (`voice-agent-session.ts:462-485`).
A cough, a backchannel "mhm/yeah/okay", background TV, or a VAD false-positive **cuts the agent off mid-sentence**.
Because the browser WS has **no native backpressure** (✓ MDN), queued TTS audio must be fully flushed on every such
false trigger — so the cost is both a wrong cut *and* an audible flush. Deepgram PDF names this directly
("responds too early / premature interruption", "agent talks over user"). LiveKit guards it; Syrinx does not.

**Fix (matches LiveKit, ✓ `turn_config/interruption.ts:26-45`):** introduce an interruption-gating policy in the
core session before emitting `interrupt.detected`:
- `minInterruptionMs` (default ~500 ms of *sustained* user speech) before a barge-in is committed;
- optional `minInterruptionWords` (release only after STT yields ≥N words) when STT interim is available;
- `falseInterruptionTimeoutMs` — if speech doesn't sustain, *resume* assistant playback (don't leave it cut);
- a short `backchannelWindow` at turn start/end where short utterances are treated as acknowledgement, not barge-in.
Emit `interrupt.suppressed_backchannel` / `interrupt.committed` metrics. **Tunable per profile** (telephony vs browser).
**Breaking:** changes the interrupt timing contract; tests asserting "VAD speech_started → immediate clear" must be
rewritten to the gated semantics. That's the correct break.
**Tests:** sustained-speech → commits; 200 ms blip → suppressed + playback resumes; backchannel "yeah" mid-reply →
suppressed; existing genuine-barge-in smokes still cut within budget.

### G2 — Interrupted-turn history divergence  ·  P0  ·  reasoning  ·  *(corrected analysis — investigated, not yet shipped)*
**Corrected understanding (from an empirical investigation this session — see RELIABILITY-HARDENING-NOTES).** I first
read this as "the interrupted turn is *dropped* (amnesia)" because the bridge `return`s on abort before
`rememberTurn` (`:154`). I implemented that fix and wrote a test — the test **deadlocked**, which exposed the real
mechanism: the **PipelineBus drain loop awaits sync handlers serially** (`pipeline-bus.ts:191-194,309-312`). An
`eos.turn_complete` handler runs the *entire* LLM generation while parking the loop, so `interrupt.llm` (Critical) is
generally **not dispatched until generation finishes** — i.e. barge-in is processed during **TTS playback**, after
`rememberTurn(fullText)` already ran. Therefore:
- **Common case (barge-in during playback):** generation completed → history holds the **FULL** generated text, but the
  user only heard the spoken prefix → **divergence** (model believes it said words never heard). *This* is the real,
  frequent G2 — and the mid-generation-abort fix does **not** touch it (that path calls `rememberTurn` normally at `:154`).
- **Rare case (abort genuinely lands mid-generation):** turn dropped (amnesia). Real but uncommon given the blocking loop.

I **reverted** the partial mid-abort fix rather than ship an incomplete change with a deadlocking test (no workarounds,
never claim done without proof).

**Real fix (the honest one, breaking changes OK):** retroactively truncate the **last** assistant history message to the
spoken prefix when `interrupt.detected` fires during playback. Needs the spoken boundary, which the session already
knows (it tracks TTS-sent text — `flushTtsText`/`ttsTextBuffers`, and the recorder's wall-clock played-ms). Plumb a
"truncate last assistant turn to N spoken chars/words" signal from session → bridge on interrupt. Precision ladder:
(1) TTS word timestamps → exact last-word-≤-played-ms; (2) else proportional clock-time, flagged approximate. This is a
**cross-component** change (session owns the spoken boundary; bridge owns history) — scoped as its own focused effort,
not a drive-by. **Tests** must account for the bus blocking model (drive a real playback-then-barge-in sequence, not a
hung generation). *(G2 also interacts with **G10** — if the bus loop didn't block, mid-generation abort would be common
and both sub-cases would need handling.)*

### G3 — Mid-turn STT/TTS stall watchdog  ·  P1  ·  transcription/synthesis
**Problem.** `withStreamIdleTimeout` guards only the LLM stream (`bridge-aisdk:100`). If Deepgram stops emitting
without `speech_final`/error, or Cartesia/Gemini go silent mid-utterance without `done`/`error`/close, the turn
**hangs → dead air** (Deepgram PDF #1, the top failure: "monitor audio flow and message cadence; if input or output
stalls, treat it as a failure and initiate recovery"). This is a **field-wide blind spot** — LiveKit/Rapida rely on
provider timeouts too — so doing it well is a differentiator, but it must avoid false-positive stalls that would kill
healthy slow turns.
**Fix.** A per-stage cadence watchdog in the core session keyed off the bus: after `stt.finalize` is requested,
require provider progress (interim/final/keepalive-ack) within `sttStallMs`; after first `tts.audio` for a context,
require subsequent audio or `tts.end` within `ttsStallMs`. On breach → structured `stt.error`/`tts.error` (recoverable)
+ the existing reconnect/terminal path + a spoken fallback ("one moment…") rather than silence. Budgets must be
generous (e.g. STT 4 s post-finalize, TTS 3 s between chunks) and **disabled during known-idle states** (post-turn
playout, keepalive) to avoid false positives.
**Tests:** fake STT that finalizes then goes silent → watchdog fires recoverable error within budget; fake TTS that
sends 1 chunk then stalls → fires; healthy slow provider under budget → no false fire.

### G4 — Graceful degradation / provider fallback  ·  P1  ·  all stages
**Problem.** Syrinx fails a turn (visible `*.error`) on provider failure. The PDF (Ch3) is explicit: *never fail
silently* — "if synthesis fails, fallback voice/canned audio; if reasoning fails, acknowledge + recover/escalate; if
transcription confidence drops, ask for clarification." LiveKit/Pipecat ship `FallbackAdapter`s (✓ verified
`tts/fallback_adapter.py:46-60`) with background recovery probes. **Honest constraint** (✓ LiveKit
`fallback_adapter.ts:577-584`): you can only fall back **before first audio**; once audio is mid-utterance, fail
visibly — don't stitch two voices.
**Fix (scoped, not boil-the-ocean-wrong):** a kernel-level degradation policy:
- **Synthesis fallback:** on `tts.error` *before first audio* of a turn → retry on a configured secondary TTS, else
  play a short canned "I'm having trouble, one moment" clip rather than silence.
- **Reasoning failure:** on `llm.error` → speak a graceful acknowledgement + (configurable) escalation hook, not dead air.
- **STT low-confidence / repeated finalize-timeout:** prompt for clarification rather than proceeding on empty input.
Multi-provider `FallbackAdapter` for STT/LLM/TTS is the larger follow-on; the *minimum honest* version is "never let the
caller hear unexplained silence." **Tests:** TTS-fails-before-audio → canned fallback plays + recorded; LLM-fails →
spoken acknowledgement; no fallback attempted after first audio (atomicity preserved).

### G5 — Telephony pacer: comfort frames + deadline-miss metric  ·  P2  ·  playback
**Problem.** The telephony output paces at 20 ms but (per audit) emits nothing to hold cadence during gaps and has no
late-tick instrumentation. Rapida's pacer (✓ `output/pacer.go:29-97`) drift-corrects, emits **idle/silence frames**,
and flags late ticks (2 ms tolerance). PLAN SLO: pacer deadline miss = 0. Under CPU pressure or GC, late frames →
choppy audio (PDF "choppy/distorted audio … often actually transport artifacts").
**Fix.** Give the telephony pacers a drift-corrected timer that (a) emits a comfort/silence frame when the queue
underruns (configurable; carriers differ on whether they want continuous frames), and (b) emits `pacer_deadline_miss`
when a frame ships >5 ms late. Pair with G7. **Tests:** queue underrun → comfort frames at cadence; injected scheduler
lag → `pacer_deadline_miss` emitted; no audible gap in decoded carrier WAV.

### G6 — Function-call interruption contract  ·  P2  ·  reasoning
**Problem.** When barge-in aborts mid tool-call, the tool may already be executing; no paired `CANCELLED`/`IN_PROGRESS`
result is recorded and (per G2) the whole turn is dropped. Dangling tool state → incoherent next turn (PLAN A5).
**Fix.** Kernel emits a paired tool-call resolution on interruption: `{status: CANCELLED}` for not-yet-started,
`{status: IN_PROGRESS, taskId}` for in-flight async, and a `dangling_tool_call` telemetry event if a request would reach
the LLM without a paired response. Folds into the G2 history-commit path. **Tests:** interrupt during tool-call →
CANCELLED recorded in history; in-flight async → IN_PROGRESS placeholder; no dangling request passed to next prompt.

### G7 — Live stage-budget SLO telemetry  ·  P2  ·  observability
**Problem.** Stage latencies are computed post-hoc in smokes; there are no live breach events. PDF Ch4 + PLAN §3 define
the SLOs; VAQI (Interruptions / Missed responses / Latency) is derivable from existing event timestamps.
**Fix.** Emit `*_over_budget` metrics live: `interrupt_over_budget` (VAD speech_started → TTS abort >60 ms),
`pacer_deadline_miss` (G5), `reconnect_over_budget` (WS drop → first replay frame >500 ms), plus a rolling **VAQI**
(I/M/L) from the bus event stream. Observability-only (no throwing). **Tests:** synthetic over-budget injection emits
the right metric; VAQI computed correctly from a scripted event sequence.

### G8 — Per-provider concurrency/rate-limit backoff  ·  P3  ·  all (scale)
**Problem.** Under sustained parallel load, a provider 429 / concurrency-limit isn't retried with backoff (prior-art
backlog). **Fix.** Map 429/concurrency close-reasons to recoverable + exponential backoff w/ jitter in the existing
per-plugin reconnect (pattern: Pipecat `websocket_service.py:108` `exponential_backoff_time`). **Tests:** simulated 429
→ backoff+retry, not a failed turn.

### G9 — Long-call WS write-after-close audit  ·  P3  ·  transport
**Problem.** v1.x hit `audioIn write failed: Socket is not open` on long calls. **Fix.** Audit v2 browser + telephony
egress for guarded writes (check `readyState===OPEN` before every send; already partly present). Add a long-session
soak smoke (>10 min) that asserts no write-after-close. **Tests:** soak smoke; unit test that send-after-close is a
no-op + metric, not a throw.

---

### G10 — Bus head-of-line blocking on long sync handlers  ·  ✅ SHIPPED  ·  transport/core
**Shipped (2026-05-30).** Repro harness (`voice/src/pipeline-bus.g10.test.ts`): (1) a bus-level test proving a Critical
interrupt is not dispatched while a slow sync Main handler runs, and (2) a session-level **production simulation** with a
streaming LLM bridge — which quantified the bug: all `tts.text` arrived **batched at 383 ms, after** generation ended
(370 ms), i.e. TTS could not start until the *entire* LLM response was generated. Fix: `PipelineBus.on()` gained a
per-handler `{ concurrent: true }` opt-in — consumer handlers stay awaited in order (state-mutation ordering preserved),
while a PRODUCER handler (the AI-SDK bridge's `eos.turn_complete` generation) is dispatched fire-and-forget so it never
parks the drain loop. The bridge registers generation concurrent and supersedes any still-in-flight generation
(`abortController?.abort()` before starting a new turn). Both harness tests flip GREEN; full suite green (no regression to
the interruption-suppression / barge-in invariants); live 3-turn interactive smoke passed end-to-end. Result: LLM→TTS
streams during generation, and barge-in is processed promptly mid-generation.

**Original analysis (kept for context).**
**Problem.** `PipelineBus.start()` drains one packet at a time and **awaits each sync-packet handler** before continuing
(`pipeline-bus.ts:191-194` → `dispatch` `:309-312`). The bridge's `eos.turn_complete` handler `await`s the whole LLM
generation, so for the duration of generation the drain loop is parked: VAD `speech_started`, `interrupt.*`, and even
`llm.delta` queue and are not dispatched until generation returns (`push` does call `onPacket` synchronously, but route
dispatch waits). In practice this is masked because (a) `onPacket` observability still fires, and (b) barge-in usually
happens during *playback* (loop free, generation already returned). But during **slow generation** (e.g. Gemini
free-tier multi-second TTFT) a user who barges in *before any audio* has their interrupt **delayed until generation
completes** — a responsiveness gap, and the structural reason G2's mid-generation case barely fires. `AsyncPacket`s
(`isAsync:true`, e.g. `vad.speech_activity`) are already fire-and-forget (`:295-306`); the turn/generation handler is not.
**Fix direction (breaking OK):** make turn generation non-blocking w.r.t. the drain loop — either run `processTurn` as a
managed background task (so the loop keeps draining Critical/Main and can deliver `interrupt.llm` mid-generation), or
split a fast dispatch path for Critical so interrupts preempt a long-running Main handler. Must preserve ordering
guarantees and the interrupted-context suppression invariants. **Tests:** push a long-running generation handler, then a
Critical interrupt; assert the interrupt is dispatched before generation completes.

### G11 — Periodic Silero VAD state reset mid-speech  ·  P1  ·  capture  *(from independent Gemini review; ✓ I verified the code)*
**Problem.** `voice-vad-silero/src/index.ts:129-132` runs, after every inference: `if (now - this.lastResetMs >= 5000)
this.resetModelState()`, and `resetModelState()` (`:186-189`) **zeros the Silero RNN `state` (`Float32Array(2*1*128)`)
and the lookback `context`**. Silero VAD is an RNN — its `state` is the recurrent hidden state carrying temporal
context. Zeroing it **unconditionally every 5 s of wall-clock, regardless of whether the user is mid-speech**, restarts
the model cold mid-utterance → a confidence dip right after the reset. On a user turn longer than 5 s this can produce a
spurious `vad.speech_ended` (→ premature endpointing / clipped transcript), and it can **undermine G1**: a reset-induced
blip during a long barge-in would look like a "short blip → suppress." References reset VAD state at **silence/utterance
boundaries**, never on a wall-clock timer mid-speech.
**Fix (breaking OK).** Only reset when **not speaking** (gate on the VAD's own `speaking` flag / sustained silence), or
remove the timer entirely if it was a guard against a problem that no longer exists. If a periodic refresh is truly
needed for numerical drift, defer it to the next silence boundary. **Tests:** feed >5 s of continuous speech frames and
assert no mid-speech state reset and no spurious `speech_ended`; assert reset still happens during a silence gap.

## 4. Sequencing for implementation (task #8)

P0 first (G1, G2) — highest user-perceived damage, highest frequency, and they interact (false barge-in × dropped
history compound the incoherence). Then P1 (G3 stall watchdog, G4 graceful degradation). Then P2 (G5–G7). P3 (G8–G9)
as soak/scale follow-ons. Each fix: **failing test first (red→green)**, targeted tests, docs, then full triad
(`pnpm -r typecheck && pnpm -r test && git diff --check`) + relevant emulator/live smokes. No back-compat shims.

## 5. Settled / out of scope (do not re-litigate)
- **WebSocket, not WebRTC** (ADR-006): all Syrinx transports force WS; LiveKit covers WebRTC where wanted. Work is to
  close WS quirks, not switch transport.
- **Smart Turn as the single endpointing authority** — keep; raw-VAD finalization was tried and rejected (premature cuts).
- Provider-account (real Twilio/Telnyx) validation remains documented-but-unblocking; Fly synthetic carrier is the floor.

## 6. Appendix — independent Gemini (agy) review findings

An independent section-by-section review (Gemini, grounded in the parsed Deepgram guide + code; full file:
`research-notes/deepgram-ariaflow-review.md`) **cross-validated G2 (history divergence), G6 (dangling tool calls), and
G10 (bus head-of-line blocking)** from a different model family, and surfaced **G11** (above, fact-checked). It also
raised these **grounded enhancements** (beyond the reliability gaps — lower priority / different scope). *Caveat: the
reviewer's `txt:` line numbers are self-asserted and were not cross-checked against the parsed text — trust the code
paths (verifiable), verify the Deepgram line basis before acting.*

- **Inbound jitter/reorder buffer** (~100 ms) — distinct from G5's *outbound* comfort-frame pacer; absorbs carrier-side
  inbound jitter/loss on lossy networks. Telnyx adapter has bounded reorder; browser/Twilio do not. (`paced-playout.ts`).
- **Context summarization vs raw slicing** — `voice-bridge-aisdk:233-239` truncates history by slicing oldest messages;
  the guide favors summarization so long sessions don't abruptly lose old context. Related to G2 but a different mechanism.
- **Telephony DTMF + transfer/escalation** — the guide covers DTMF (handled outside the speech pipeline) and call
  transfer/escalation; the Twilio/Telnyx adapters implement neither. Feature-completeness, not reliability-breaking.
- **Speculative/eager LLM pre-warm on interim STT** — the PLAN's A6 (predict-and-scrap); latency optimization.
- **Adaptive persona / multilingual mid-session voice swap** — expose STT confidence/detected-language to the agent +
  TTS; product/feature scope (and must respect the "no language-specific transcript reconstruction" rule).
- **Security baseline** — short-lived tokens vs static keys; PII redaction/profanity middleware on the bus / recordings.
- **Automated WER/latency eval harness** over recorded sessions — extends G7/VAQI for regression baselining.
