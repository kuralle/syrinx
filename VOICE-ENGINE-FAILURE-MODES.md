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
| G8 | **✅ SHIPPED — provider concurrency/rate-limit backoff** — `categorizeSttError` now maps concurrency-limit phrasing (e.g. Cartesia) → recoverable `RateLimit`; `waitForRetryDelay` uses equal-jitter backoff to avoid thundering-herd reconnects. All plugins inherit it via the shared retry/categorize primitives | all | Low-Med | Low (scale) | `voice/src/{error-handler,retry}.ts` | **P3 done** |
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

### G2 — Interrupted-turn history divergence  ·  ✅ SHIPPED (full precision via G25/VE-04)  ·  reasoning

**Shipped in two stages:**

**Stage 1 (G2 base — text approximation):** `AISDKBridgePlugin` (`voice-bridge-aisdk/src/index.ts`) now tracks `spokenByContext` (accumulated `tts.text` per turn) and `assistantMsgByContext` (in-place reference to the history entry). On `interrupt.llm`, `commitInterruptedHistory()` rewrites the turn's history entry to the spoken approximation. Both sub-cases handled: committed turn (generation done before barge-in → truncate in place) and mid-generation abort (never committed → record what was sent). Non-deadlocking: G10's concurrent producer means the bus drain loop is free when interrupt fires; `commitInterruptedHistory` is a pure sync map-mutation, no bus awaits, no re-entrant dispatch risk.

**Stage 2 (G25/VE-04 — word-level precision):** Cartesia TTS plugin now emits `tts.word_timestamps` packets with cumulative offsets from the context audio start (`add_timestamps: true`). The bridge accumulates word timestamps and tracks `tts.playout_progress` per context. `computeSpokenPrefix()` uses precision ladder: (1) word timestamps + playout position → exact spoken prefix at word boundaries; (2) fallback to `spokenByContext` (approximate, headless/browser paths without paced transport). Regression test: barge-in-during-playback scenario drives the previously-deadlocking sequence through the live bus loop and asserts it completes; prior deadlock was caused by blocking bus drain inside a handler — the G10 concurrent producer + sync commitInterruptedHistory prevents it.

**Tests:** `voice-bridge-aisdk/src/index.test.ts` — 8 tests covering exact word-boundary prefix (G25), fallback paths, deadlock regression, mid-generation interrupt.

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

### G12 — Turn-taking keyed on TTS generation-end instead of playout-end  ·  ✅ SHIPPED  ·  core/turn-taking
**Shipped (2026-05-31).** Found via the `conversation.wav` overlap the user heard ("when the agent speaks the user also
speaks"). Deterministic loop: `scripts/analyze-overlap.mjs` (per-100 ms stereo RMS) measured **7.9 s of overlap, 28.5 % of
agent speech**, in regions that landed exactly where each new user turn began. Byte math from `events.jsonl`: Cartesia TTS
streams at **~2.2× realtime** — 12.9 s of speech arrives in a 5.7 s burst. `voice-agent-session.ts` cleared
`activeTtsContextIds` in `handleTtsEnd` (the **generation** clock), but the streamed audio keeps playing ~7 s longer. In
that gap the assistant is audible yet the engine believes it is silent, so user speech is **not** recognized as barge-in
(`latestActiveTtsContextId()` returns "") → no truncation → both tracks overlap. First principles: in real telephony RTP is
paced at realtime so generation-clock == playout-clock and the gap cannot open; our WS engine streams faster than realtime,
decoupling them (cf. LiveKit `playback_position`, Pipecat playout-driven `BotStoppedSpeaking`; the WS transport's
`paced-playout.ts` already paces the wire, but the engine's turn-taking *state* did not follow it). **Fix.** Track a
per-context playout cursor advanced by each chunk's realtime duration (already computed for the idle timeout); on `tts.end`
defer releasing the context until its playout estimate elapses; barge-in/interrupt/stall route through one release helper;
timers cleared on close. The synthetic carrier now gates the next user turn on playout-end (polite turn-taking), and the
coherence smoke fails above 1500 ms of stereo overlap. Regression test at the barge-in seam (red→green); full suite green;
live 3-turn re-run drove overlap **7.9 s → 0.0 s**.

**Follow-up — full transport-grounded unification (2026-05-31).** The sample-duration estimate is provider-agnostic but is
still a parallel clock, and the recorder reconstructed a *third* clock from generation arrival. Pipecat (and LiveKit) use
**one** clock: the output transport's realtime playout. Adopted the same: new core packet `tts.playout_progress`, emitted
by the paced-playout layer (`PacedPlayoutQueue.onFramePlayed` → `PlayoutProgressEmitter`) in telnyx/twilio/smartpbx. The
session releases the assistant context on the transport's authoritative `complete` (estimate defers to it while real
progress flows, and remains the fallback for the browser-WS and headless paths). The recorder re-anchors each assistant
turn onto its real playout-start at finalize. All three timelines — turn-taking, transport, recorder — now share the
playout clock. Unit-verified at each seam (session consumer, telnyx emission, recorder re-anchor); **end-to-end telephony
(generation≠playout under queue backlog) still needs a Fly synthetic-carrier run** — the headless smoke exercises the
estimate fallback (unchanged).

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

---

## 7. Sprint 01 — WebSocket transport hardening + scale (G13–G26)

From a thermo-nuclear review of `voice-server-websocket` / `voice-ws` /
`voice-client-browser` cross-checked against the Deepgram guide, the LiveKit /
Cloudflare / Level-Up / dev.to / Deepgram transport articles, Kwindla's Pipecat
gist+talk, and 2025–26 papers. Full specs + acceptance tests + TDD/smoke plans:
`issues/sprint-01-websocket-transport/`. Strategic premise check: WebSocket is
right for server↔provider (`voice-ws` ✅) and server↔carrier ✅; the browser
last-mile leg is the one every source flags — harden it and make it swappable.

### G13 — Four WS transports are one host copy-pasted  ·  P1  ·  transport/structure
**Problem.** `index/twilio/telnyx/smartpbx.ts` redeclare ~10 helpers ×4, the ~130-line
connect/pending-buffer/startup/close skeleton ×4, and `wire*SessionEvents` ×3 (browser a
divergent 4th lacking pacing). >50% of ~3,500 lines is dup. **Fix.** Extract
`WebSocketTransportHost` + `OutboundPlayoutPipeline` + `InboundFramePipeline`; carriers become
~150-line codec/control adapters (same code-judo already done on the provider side with
`voice-ws`). **Tests:** all 109 tests green unchanged + Fly synthetic-carrier green. → WT-01

### G14 — Carrier-file codec module + no anti-aliasing  ·  P1  ·  audio/correctness
**Problem.** μ-law/resample/PCM exported from `twilio.ts` and imported by telnyx+smartpbx;
`index.ts` re-rolls its own. `resamplePcm16`/`normalizePcm16` are linear-interp with NO
low-pass-before-decimation → aliasing degrades STT on fricatives/sibilants (Level-Up). **Fix.**
Canonical `voice/src/audio/` (pcm/mulaw/resample) with anti-aliased down-sample. **Tests:**
spectral anti-alias test (≥40 dB image rejection) + telephony/recorder live smoke. → WT-02

### G15 — Browser leg bursts TTS unpaced, no playout clock, no client jitter buffer  ·  P1  ·  transport/browser
**Problem.** `index.ts:515` sends TTS straight to the wire (PacedPlayoutQueue used 0×);
no `PlayoutProgressEmitter` → browser excluded from G12 playout-clock; client has no jitter
buffer. **Fix.** Route browser through the shared outbound pipeline + AudioContext jitter buffer
(~100 ms, Deepgram). **Tests:** headless-Chrome scheduled-playout + clean barge-in flush. → WT-03

### G16 — `close()` hard-kills all live calls on deploy  ·  P1  ·  transport/scale
**Problem.** All 4 servers do `client.terminate()` in `close()` — immediate RST, no drain.
Every deploy guillotines in-flight calls. **Fix.** Graceful drain in the host (stop accept →
drain paced queues to deadline → 1001 via `closeWebSocketWithFallback` → terminate stragglers);
wire SIGTERM. **Tests:** drain-on-close unit + mid-utterance graceful-close live smoke. → WT-04

### G17 — Shipped browser client can't reconnect/resume/keepalive  ·  P1  ·  client/availability
**Problem.** `SyrinxBrowserClient.connect()` has no reconnect, no `sessionId` capture/resume,
no keepalive — the server's 15 s resume window is unusable by the official client. **Fix.**
Backoff reconnect re-dialing `?sessionId=`, keepalive ping, reconnecting/resumed events,
storm-cap. **Tests:** fake-socket reconnect/resume unit + drop-mid-session headless smoke. → WT-05

### G18 — Session state in-memory only (no horizontal scale)  ·  P2  ·  transport/scale
**Problem.** `sessions` is a bare process Map; dies on redeploy, forces sticky routing. **Fix.**
`SessionStore` interface + `InMemorySessionStore` default (zero behavior change) + injection
point, shaped for a drop-in Redis/DO impl. **Tests:** injected-fake store lease/release ordering
+ resume smoke through the seam. → WT-06

### G19 — Raw PCM browser uplink; transport not swappable  ·  P2  ·  transport/scale
**Problem.** Browser uplink is 16 kHz PCM16 ≈ 256 kbps (Kwindla: avoid raw PCM); WebSocket is
hard-wired on the leg every source flags. **Fix.** `ClientTransport` seam (mirror Cloudflare
`VoiceTransport`) + Opus on the browser leg negotiated in `ready`; WebRTC/QUIC become drop-ins.
**Tests:** transport-conformance + Opus round-trip + bandwidth-measured headless smoke. → WT-07

### G20 — No concurrency cap; unmatched upgrade leaks sockets  ·  P2  ·  transport/scale
**Problem.** Unbounded session acceptance (Deepgram: WS concurrency limits); `websocket-upgrade.ts`
leaves unmatched-path sockets dangling. **Fix.** `maxConcurrentSessions` admission (reject 1013 +
metric) + destroy sockets on unmatched upgrade paths. **Tests:** cap-rejection + bad-path-destroy
unit + multi-adapter routing regression. → WT-08

### G21 — No real per-turn metrics; browser leg untested under impairment  ·  P2  ·  observability
**Problem.** `metrics` message defined but server never emits it; no four-timestamp per-turn
instrumentation; browser leg has no loss/jitter smoke (telephony does). **Fix.** Emit per-turn
metrics (4 timestamps + stage latencies + correlation id from the playout clock); add browser
loss/jitter smoke; assert ~800 ms voice-to-voice SLO band. **Tests:** metric-compute unit +
impaired-browser smoke. → WT-09

### G22 — Endpointing is silence/Smart-Turn only (no semantic signal)  ·  P2  ·  turn-taking
**Problem.** Smart Turn is a separate model blind to STT semantics → premature cuts + trailing
latency. **Fix.** Fuse a semantic-completeness signal off STT partials with Smart Turn (JAL-Turn
direction: reuse the encoder, ~0 added latency). **Tests:** labeled complete/mid-thought/backchannel
set + no-latency-regression live smoke. (JAL-Turn 2603.26515, Phoenix-VAD 2509.20410, FastTurn 2604.01897) → VE-01

### G23 — Barge-in is a time gate, not speaker attribution  ·  P2  ·  barge-in
**Problem.** G1's `minInterruptionMs` commits on any sustained speech incl. bystander/TV/echo.
**Fix.** Primary-speaker (pVAD) gate composed with G1; suppress non-primary; graceful G1 fallback.
**Tests:** mixed-speaker + echo unit + injected-background live smoke. (FireRedChat 2509.06502) → VE-02

### G24 — Unfilled dead air over LLM TTFB  ·  P3  ·  perceived latency
**Problem.** No audio between endpoint and first LLM token (~350 ms TTFB dominates). **Fix.**
Optional, interruptible dual-track filler connective started at endpoint, spliced into the real
response. **Tests:** filler-before-token + cancel-on-continue unit + A/B perceived-latency smoke.
(DDTSR 2602.23266, Moshi 2410.00037) → VE-03

### G25 — Post-barge-in context records generated, not heard, text (closes G2)  ·  ✅ SHIPPED  ·  context-integrity
**Shipped (2026-05-31).** Cartesia TTS plugin enables `add_timestamps: true`, emits `tts.word_timestamps`
packets with cumulative-offset timestamps. Bridge accumulates them per context, tracks
`tts.playout_progress` for realtime playout position. `computeSpokenPrefix()` on `interrupt.llm`:
words with `endMs ≤ playedOutMs` → exact spoken prefix at word granularity; fallback to `spokenByContext`
(text-level) when playout clock absent (headless/browser). Full test suite: word-boundary exactness,
fallback paths (no timestamps, no playout), deadlock-regression (previously-deadlocking
barge-in-during-playback scenario passes). G2 closed. → VE-04

### G26 — No conversational-quality CI gate  ·  P3  ·  evaluation
**Problem.** Smokes assert transport invariants, not turn-taking timing/overlap; nothing fails CI
on conversational regression. **Fix.** Bot-to-bot examiner (EVA-X turn-taking-timing + overlap +
accent/noise) wired as a CI gate (warn → block). **Tests:** known-good/bad fixture scoring + live
end-to-end baseline. (EVA-Bench 2605.13841, Full-Duplex-Bench-v2 2510.07838) → VE-05
