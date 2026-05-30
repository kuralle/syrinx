# Syrinx Voice Engine — Reliability Hardening Running Notes

> **Operating directive (embodied for this whole effort):**
> Take an autonomous stand, and deliver the work. Do not ask for permissions, do not ask questions
> (take all the well-researched recommendations into account). Fend for yourself and deliver results.
> Do the whole thing. Do it right. Do it with tests. Do it with documentation. No shortcuts, no
> deferring, no "table this for later", no workarounds when the real fix exists. Breaking changes are
> embraced over back-compat. Search before building. Test before shipping. Ship the complete thing.
> Time / fatigue / complexity are not excuses. Don't fight errors — research 3–5 fixes, pick the best.

**Goal of this effort:** Reverse-engineer how production voice engines stay reliable, build a grounded
catalog of what can break *this* engine (across every transport and every pipeline stage), run the real
Fly synthetic-carrier path end-to-end, document live provider testing per official docs, and implement
the highest-value reliability fixes — all grounded in source, not assumptions.

**Started:** 2026-05-30 · **Branch:** v2

---

## Changes shipped this effort (running log)

- **[FIX/FEATURE] G1 — false-barge-in gate** (`packages/voice/src/voice-agent-session.ts` + tests). Raw VAD
  speech-start used to fire `interrupt.detected` immediately (`:462-485`), so any cough / click / backchannel / VAD
  false-positive cut the agent off mid-sentence — and because the browser WS has no native backpressure (✓ MDN), each
  false cut also forces a full flush of queued TTS audio. Added `minInterruptionMs` (default 280 ms): the session now
  defers the cut until `vad.speech_activity` shows speech sustained past the threshold; `vad.speech_ended` before then
  cancels it. Driven purely by bus packets (no timers). 3 new tests + 3 existing barge-in tests re-pointed to an explicit
  gate-off path. Full triad green. Honest scope: kills transient/short false triggers, not deliberate ≥280 ms spoken
  backchannels. `minInterruptionMs:0` = legacy immediate cut.
- **[INVESTIGATION → REVERT] G2 — interrupted-turn history.** Implemented "remember interrupted turn on abort", wrote a
  test, and the test **deadlocked** — which exposed that `PipelineBus` awaits sync handlers serially
  (`pipeline-bus.ts:191-194,309-312`), so `interrupt.llm` is generally dispatched *after* generation completes (during
  playback), not mid-generation. That means the real G2 is **history divergence** (full generated text stored though
  only the spoken prefix was heard), which the mid-abort fix doesn't address. **Reverted** the partial fix rather than
  ship an incomplete change with a broken test (no workarounds; never claim done without proof). G2 re-specified with the
  corrected analysis in `VOICE-ENGINE-FAILURE-MODES.md`; the real fix is a cross-component spoken-prefix truncation
  (session → bridge) scoped as its own effort.
- **[FINDING] G10 — bus head-of-line blocking** (new gap, found via the G2 investigation): the drain loop parks on the
  long-running generation handler, delaying VAD/interrupt dispatch during slow LLM generation. Documented with a fix
  direction (non-blocking generation task / Critical preemption) in the catalog.


- **[FIX] Fly synthetic-carrier bot never started its server** (`examples/02-hello-voice-headless/scripts/`).
  Root cause (from Fly boot logs, not guessed): the Dockerfile runs the `start-telephony-spike.ts` wrapper, which did a
  bare side-effect `await import("./serve-telephony-review.js")`. But the serve modules only auto-run `main()` behind a
  *direct-entry* guard (`import.meta.url === pathToFileURL(process.argv[1]).href`). Imported from the wrapper, the guard
  is false → `main()` never runs → process exits 0 → machine never binds `0.0.0.0:4180` → `/healthz` times out → run
  fails (apps were still destroyed cleanly, no cost leak). The wrapper (added 2026-05-29) was never actually exercised
  on Fly despite the handoff claiming a green run. **Real fix (no workaround):** `export` `main` from
  `serve-telephony-review.ts` and `serve-synthetic-carrier.ts`; the wrapper now imports and `await`s the role-correct
  `main()`. Verified locally: wrapper holds the server open and `/healthz` returns `{ok:true}` (before the fix it exited
  immediately). Standalone direct-entry guards kept; test imports (named helpers) unaffected.

## Delegated waves (ship-it-managed → claude-sonnet, each diff adversarially reviewed)

- **Wave 1 (accepted, green):** G11 VAD-reset gate (surgical `!speaking` guard + 2 behavioral tests); G7 VAQI/SLO
  telemetry (observability-only, timer cleaned on close, 5 value-precise tests incl. the leak test); G9 long-call WS —
  **audit outcome: v2 was already write-after-close-safe** (send helpers guard `readyState`), worker added a per-context
  `websocket.send_after_close` drop metric across all 4 transports.
- **Wave 2 (accepted, green):** G5 pacer — refined the scope before delegating: dropped the catalog's "comfort/idle
  frames" idea (Rapida is RTP; these are WS carriers that handle gaps natively) and scoped to drift-corrected cadence +
  `pacer_deadline_miss` metric. The worker shipped it but had a **false-miss-on-natural-gap bug** (deadline only
  re-baselined on `clear()`, not on a natural drain) — I caught it in review, fixed it (`else { nextDeadlineMs = 0 }`
  on drain) and added the regression test (verified red→green). ws package 116 tests.
- **Wave 3 (remaining, NOT delegated hands-off):** G10 (bus non-blocking generation) → G2+G6 (spoken-prefix history +
  tool-call contract) → G3 (stall watchdog) → G4 (graceful degradation). These touch the core dispatch loop and the
  interruption invariants; to be driven directly with close review as a focused effort, not sprayed to a worker.

## Deviations / decisions not in the spec (running log)

1. **Notes file name.** The spec said keep a running `implementation-notes` file. The repo already has
   `implementation-notes.md` (the v2-kernel build scratchpad with its own kanban). To avoid clobbering
   that record, this effort's running notes live here in `RELIABILITY-HARDENING-NOTES.md`. The existing
   file is left untouched.
2. **Reference-repo root.** The user-given paths use `…/asyncdot/openscoped/voice-media-transport/research/…`
   (note: `asyncdot/openscoped`, a *different* root from this repo's `asyncdot-openscoped`). Verified all
   four repos exist there. PDF verified at `/Users/mithushancj/Downloads/deepgram-voice-agent.pdf` (107pp).
3. **`pi-glm` worker not installed.** Available workers verified: `codex`, `cursor` (`agent`), `claude-glm`,
   `claude` (sonnet), `pi`, `opencode`. Web-research + impl delegation will use `claude` (sonnet), `pi`,
   `claude-glm`, and `cursor`.

---

## Layer 0 — Deepgram "Definitive Guide to Voice AI Agents" (107pp ebook)

Source: `/Users/mithushancj/Downloads/deepgram-voice-agent.pdf` → parsed to
`research-notes/deepgram-voice-agent.txt`. Citations are `txt:line` (deck line numbers).

### Core thesis — why this is hard (Ch1, txt:153–171)
A voice agent is **not a sequential pipeline**. It is a real-time, event-driven, interrupt-aware system
of independently-operating components (STT, reasoning, synthesis, audio I/O) each emitting **asynchronous
events**. Without strong orchestration, timing mismatches cause premature cutoffs, delayed responses, or
the agent speaking at the wrong moment. **Latency compounds across stages** — every 100 ms matters; the
remedy is to overlap work, react to partial signals, and minimize handoff overhead.

### Event-driven turn management (Ch2, txt:530–566)
- Never poll for state; react to a stream of conversational events.
- Canonical events: **StartOfTurn** (cancel playback) → **EagerEndOfTurn** (begin speculative reasoning)
  → **TurnResumed** (cancel speculative work) → **EndOfTurn** (finalize). Thresholds `eager_eot_threshold`
  / `eot_threshold` tune the speed↔stability trade-off.
- **CRITICAL for Syrinx (txt:557–561):** *"When integrating [a unified turn model like Flux] into LiveKit,
  Pipecat, or Vapi, downstream VAD and turn logic should be disabled. Redundant detection introduces
  desynchronization, leading to premature responses or mid-utterance replies. [It] should be the single
  source of truth for conversational boundaries."* → Syrinx runs **Silero VAD + Pipecat Smart Turn +
  Deepgram finalize** simultaneously. Audit for redundant-detection desync (does VAD ever finalize a turn
  Smart Turn would have kept open, or vice-versa?).

### Interruption / barge-in (Ch2, txt:567–580; telephony txt:736–748)
- Input & output pipelines must run **concurrently**. New speech during playback → output stops
  **immediately**, state → listening. **Playback cancellation must be explicit so buffers and downstream
  components reset cleanly.** TTS must be interruptible, cancellable, replaceable at any moment.
- Telephony barge-in enforced at **two levels**: (1) **Media** — stop/mute outbound audio the moment
  inbound speech resumes; (2) **Logic** — cancel/invalidate pending reasoning or tool execution.
  Playback-confirmation events are essential so buffers reset cleanly before the next response.

### Reliability, failover, session recovery (Ch2, txt:588–601)
- Streaming connections implement **reconnection with exponential backoff**. On reconnect, **restore prior
  conversational context via injected state** rather than cold restart. When recovery fails, **communicate
  clearly rather than leaving silence.**
- **Monitor audio flow and message cadence. If input or output stalls, treat it as a failure and initiate
  recovery.** Fallback responses / alternate synthesis paths preserve continuity.
- Goal is not perfect uptime but **resilient interaction** — state-aware, transparent, responsive under failure.

### Telephony runtime (Ch2, txt:706–792)
- Provider terminates PSTN and opens a **bidirectional WebSocket** media stream. **Each session has a unique
  call/stream id that must be preserved on all inbound & outbound media to avoid cross-call contamination.**
- **Avoid transcoding where possible** — format alignment removes latency and failure modes (Deepgram accepts
  μ-law natively; TTS can emit μ-law). PSTN adds 100–200 ms RTT; mitigate with regional co-location.
- Non-blocking event-driven media ingress/egress loops; blocking pipelines cause dead air / clipped speech /
  missed interruptions. DTMF handled **outside** the speech pipeline so it doesn't pollute transcripts.
- Call termination/transfer/escalation handled explicitly; media stream closed immediately on end; mute
  during transfer to avoid overlap/clipping/echo.

### Scaling & concurrency (Ch2 txt:759–770; Ch3 txt:902–916)
- Each call = independent long-lived streaming session. Scaling pressure points: **WebSocket concurrency
  limits, orchestrator throughput, downstream LLM rate limits.**
- Async runtimes + LBs with connection persistence; **graceful connection draining and backpressure during
  spikes**; define **fallback behaviors when upstream degrades so callers never experience unexplained silence.**
- Tier model usage (large models for complex turns, light for routine).

### Resilience & graceful degradation (Ch3, txt:902–916)
- **Never fail silently.** If reasoning/retrieval fails → acknowledge verbally + recover or escalate. If
  synthesis fails → fallback voice / canned audio. If transcription confidence drops → **prompt for
  clarification rather than proceeding on uncertain input.** When automated recovery fails → escalate to human.
- Non-disruptive deploys: **drain sessions before recycling instances**; let active conversations complete.

### Reliability testing & evaluation (Ch4, txt:953–1010)
- Voice agents are **probabilistic**, not deterministic — measure **outcome distributions**, not a single right answer.
- Testing methods: **probabilistic regression** (metric distributions across versions → drift), **replay testing**
  (reprocess recorded audio through new builds, holding input constant → isolate timing regressions),
  **load/stress** (track **tail latency p95/p99**, not averages — worst case dominates perception),
  **fault injection** (delayed reasoning, dropped synthesis → confirm graceful recovery), **turn-level diagnostics**
  (visualize UserStoppedSpeaking→AgentStartedSpeaking + interruption overlay).
- Test envs must mirror production (telephony codecs, streaming pipelines, orchestration). Release advances only
  after thresholds met; monitor same metrics continuously after.

### VAQI — Voice Agent Quality Index (Ch4, txt:962–975)
Three timing behaviors derived from event timestamps:
- **I (Interruptions):** how often the agent speaks before the user finishes.
- **M (Missed responses):** how often the agent fails to respond within a window after a turn ends.
- **L (Latency):** UserStoppedSpeaking → AgentStartedSpeaking.
Retell AI cited at ~800 ms response w/ interruption handling in production (txt:979) — sub-second is achievable.

### Common failure modes appendix — 5 layers: capture, transcription, reasoning, synthesis, playback (Ch9, txt:2043–2111)
1. **Dead air / agent fails to respond** ← turn-detection failure, orchestration bugs, downstream timeout,
   unhandled exceptions or **blocking operations** that prevent entering response phase. Inspect EndOfTurn
   delivery, LLM timeouts, synthesis init, event-handler errors.
2. **Inaccurate domain transcription** ← model/vocabulary.
3. **Echo / audio feedback loops** ← audio routing / missing echo cancellation; agent hearing itself → response
   loops or distorted transcription; telephony gateway must isolate inbound/outbound channels.
4. **Tools not triggered** ← tool visibility / instruction framing.
5. **Agent talks over user / misses interruptions** ← audio transport or interruption detection; needs continuous
   mic input during playback + true full-duplex + fast speech-start detection.
6. **Responds too early / premature interruption** ← aggressive EOT thresholds; partial transcripts / early turn
   signals triggering prematurely; VAD over-sensitivity.
7. **Choppy / distorted / unnatural audio** ← playback buffering, **encoding mismatches**, network instability.
   "Many perceived synthesis issues are actually transport or client-side artifacts." Inspect **audio-format
   consistency across the pipeline** + buffering strategy.
8. **Repetitive / incoherent over time** ← context growth / prompt design.
9. **Authentication / connection failures** ← token lifecycle, endpoint config.
10. **WebSocket disconnections / connection instability** ← network reliability, **keepalive config, session
    recovery logic.** Inspect connection-timeout settings, **reconnection backoff**, **state restoration after
    reconnect**, proxy/firewall config. Long-lived sessions require **explicit keepalive + graceful reconnection.**
11. **Missing/confused speakers (multi-party)** ← audio routing / channel config; many agents assume one speaker.
12. **Loss of context mid-conversation** ← state persistence / memory strategy.

Closing note (txt:2091–2099): diagnose by identifying the responsible layer (capture/transcription/reasoning/
synthesis/playback) **before** tuning parameters or swapping components.

---

## Layer 1 — Reference-engine teardown (LiveKit Python, LiveKit JS, Rapida)

Delegated to read-only Explore agents; **the high-impact claims below were personally fact-checked** by opening
the cited lines (✓ marks verified-by-me). Paths are under
`…/asyncdot/openscoped/voice-media-transport/research/`.

### Cross-cutting patterns the references share (and Syrinx's status)

| Pattern | LiveKit-py | LiveKit-js | Rapida | **Syrinx today** |
|---|---|---|---|---|
| **Multi-provider FallbackAdapter** (STT/LLM/TTS auto-failover + background recovery) | ✓ `stt/fallback_adapter.py`, `tts/fallback_adapter.py`, `llm/fallback_adapter.py` ✓ verified | ✓ `tts/fallback_adapter.ts`, `stt/fallback_adapter.ts` | partial (lazy TTS reconnect) | **❌ NONE — fails the turn** |
| **Reject mixed input sample rate; resample only from known rate** | ✓ `stt/stt.py:457-458` ✓ verified | ✓ `utils.ts:751,786` | ✓ `audio_processor.go` | ✓ HAS (browser WS + envelope) |
| **First speech-start persisted across multiple VAD bursts in one turn** | ✓ `audio_recognition.py:161,965` | ✓ `audio_recognition.ts:1346-1350,1563` | n/a | ✓ smoke collectors do this |
| **Min interruption duration / words / false-interruption timeout / backchannel boundary** | ✓ `turn.py:119-120` (min_duration 0.5s, min_words), interruption.py | ✓ `turn_config/interruption.ts:26-45` (minDuration 500ms, falseInterruptionTimeout 2000ms, backchannelBoundary [1000,3500]) | — | **❓ AUDIT — Syrinx VAD/energy gate may lack false-barge-in guard** |
| **Sentence-stream pacer** (hold TTS text until remaining audio < threshold, not fire-on-arrival) | ✓ `tts/stream_pacer.py:117-163` | ✓ `tts/stream_adapter.ts` | — | partial: sentence-buffers + flush, but **no remaining-audio-based pacing** |
| **20ms output pacer w/ drift correction + idle/silence frames + late-tick health** | — | — | ✓ `output/pacer.go:29-97` ✓ verified | partial: paces 20ms, **but does it emit silence to hold cadence / track late ticks?** AUDIT |
| **Recorder trims system track to wall-clock cutoff on interruption** | `recorder_io` playback_position | playback position | ✓ `default_audio_recorder.go:200-235` ✓ (truncateSystemTrack) | ✓ HAS (recorder truncation) |
| **Connection pool w/ maxSessionDuration / reuse** | ✓ `utils/connection_pool.py:96-125` | ✓ `connection_pool.ts:50-200` | — | transport max-session only |
| **Stream id preserved to prevent cross-call contamination** | room-scoped | room-scoped | ✓ `twilio/websocket.go:102-112`, `session.go:123-126`; LLM `isCurrentContextID()` gate | ✓ per-adapter streamSid/callId; ✓ interrupted-context gate |
| **Mid-turn STALL / WATCHDOG detection (audio-flow / message-cadence freeze → recover)** | **❌ NOT IMPL** (agent reports) | **❌ NOT IMPL** (no app-level ping) | weak: only read-deadline timeouts | **❌ transport heartbeat only — no per-stage stall detection** |
| **Exponential backoff reconnect on provider stream** | ✓ `stt.py:372-411`, `worker.py:1090` | ✓ `ws_transport.ts` | ✓ lazy/30s handshake | partial: Deepgram reconnect discards state; Cartesia reconnect; **no uniform backoff policy across plugins** |
| **Non-blocking drop + dropped-frame metric under backpressure** | bounded chans | bounded queues | ✓ `audio_processor.go:340-360` + `droppedOutputFrames` | closes slow consumer (1013) instead of dropping |

### Notable specifics worth stealing or matching
- **LiveKit FallbackAdapter** (✓ verified `tts/fallback_adapter.py:46-60`): a `list[TTS]`, `max_retry_per_tts`,
  marks a provider unavailable on failure and spawns a background recovery task that re-tests with a probe
  utterance; emits `availability_changed`. *Streaming caveat (js `fallback_adapter.ts:577-584`): once audio
  has been pushed mid-utterance it canNOT fall back — error is rethrown to preserve atomicity.* → The honest
  design: fall back **before first audio**, fail visibly **after**.
- **LiveKit `_EndOfTurnInfo`** (`audio_recognition.py:1117-1152`): computes `transcription_delay` and
  `end_of_turn_delay` from event timestamps — i.e. the raw material for **VAQI** (PDF). Syrinx already records
  similar stage latencies; computing a VAQI-style I/M/L index is low-hanging.
- **Rapida pacer** (✓ verified `output/pacer.go`): 20ms timer, **idle/silence frame when no audio**, late-tick
  flag (2ms tol), drift reset when behind. Holds carrier cadence even through gaps.
- **Rapida non-blocking backpressure** (`audio_processor.go:340-360`): `select{ case ch<-f: default: /*drop*/ }`
  + `droppedOutputFrames` atomic counter — drops a frame rather than blocking or closing the call. Different
  philosophy from Syrinx (close slow consumer). For a *live phone call*, dropping a frame may beat dropping the call.
- **LiveKit StreamAdapter**: wraps a non-streaming STT into a streaming one via VAD segmentation — pattern for
  graceful degradation when a streaming provider dies.

### The shared blind spot (important)
**None of the three references implement a strong mid-turn stall/watchdog** ("if input or output stalls mid-turn,
treat as failure and recover") that the Deepgram PDF explicitly recommends (txt:596-598). They rely on provider
timeouts. So this is genuinely hard / unsolved in the OSS field — an area where Syrinx could lead rather than
follow, but must be designed carefully (false-positive stalls would kill live turns).

### Pipecat (read directly — Layer 1b below)

---

## Layer 1b — Pipecat (read directly; paths under `…/research/pipecat/src/pipecat/`)

- **Uniform WS reconnect abstraction** (`services/websocket_service.py:38-135`, ✓ read): `WebsocketService` base with
  `reconnect_on_error`, `_verify_connection()` via `websocket.ping()`, `_reconnect_websocket()`, **concurrent-reconnect
  guard** (`_reconnect_in_progress`), `_try_reconnect(max_retries=3)` with `exponential_backoff_time(attempt)`, reports
  failures as `ErrorFrame`, and **`send_with_retry()`** (send → on any exception reconnect → retry once). → Syrinx's
  Deepgram/Cartesia reconnect is **bespoke per plugin**; no shared backoff/verify/retry primitive. (But Syrinx's
  per-plugin **state-discard on STT reconnect** is arguably *more* correct than blind resend — keep that.)
- **Output interruption** (`transports/base_output.py:535-558`, ✓ read): on `InterruptionFrame`, cancel+recreate the
  audio task to **clear buffered output**, with an **`UninterruptibleFrame`** concept (some audio is protected from
  barge-in, e.g. legally-required disclosures) — Syrinx treats *all* assistant audio as interruptible (fine, but note
  the capability gap).
- **Smart Turn = single source of truth** (`audio/turn/smart_turn/base_smart_turn.py:107-161`, ✓ read): state starts
  `INCOMPLETE`; becomes `COMPLETE` when **either** the ML model fires **or** silence exceeds `stop_secs` — the silence
  fallback lives *inside* Smart Turn, not as an independent VAD finalizer. This is exactly the PDF's "disable redundant
  downstream turn logic" rule. **Syrinx already follows this** (Smart Turn gates `stt.finalize`; raw-VAD finalization
  was explicitly rejected after it caused premature cuts). ✅ low risk — but verify VAD can't independently end a turn.
- **Carrier serializers** (`serializers/`): twilio, telnyx, plivo, exotel, genesys, vonage — deserialize provider media
  → PCM, serialize PCM → provider media, serialize interruption → provider `clear`. Same boundary Syrinx uses.
- Pipecat also has a **task-level watchdog** (`processors/frame_processor.py`, Deepgram Flux) that flags stuck async
  tasks — an infra-level stall guard, distinct from a *media-flow* stall watchdog (which remains unsolved field-wide).

---

## Layer 4 — Web research (delegated to pi/Gemini + claude-sonnet + claude-glm; load-bearing claims fact-checked)

Delegation tooling fixed mid-run (claude-glm is a shell *alias* → `timeout` can't exec it; claude/`-p` needs
`< /dev/null`). pi/Gemini returned the strongest report (473 lines, 86 URLs). glm dumped raw search content (low
signal). Sources stored in `research-notes/delegated/`. **✓ = I independently fact-checked.**

### WebSocket failure modes (Syrinx is WS-only end-to-end, so all of these apply)
- **No native browser backpressure** ✓ (MDN `WebSocket/bufferedAmount`, WebSocket.org, Chrome `WebSocketStream` docs):
  the WS API has **no `pause()` and no drain event**; the browser always reads the OS socket as fast as possible;
  `bufferedAmount` is read-only polling. Only `WebSocketStream` (Chrome-only) gives true backpressure. → **If TTS
  generates 4 s of audio in 600 ms, ~3.4 s queues up, and on barge-in all of it must be flushed before the agent stops.**
  This is precisely why Syrinx's **bounded queue + 1013 close + interrupted-context suppression + `audio_clear`** matter —
  and why the **false-barge-in gap (Layer 3 #1) is worse than it looks**: a false interrupt forces a full flush of queued audio.
- **TCP head-of-line blocking** (LiveKit blog; WebSocket.org): one lost TCP segment stalls all later audio → "silence,
  then burst" on 4G/5G handoffs. WS-over-TCP cannot avoid this; mitigate with short messages + minimal buffers.
- **No built-in jitter buffer / no timing semantics** (LiveKit): WS delivers bytes; playout timing is the app's job.
  Twilio guidance: 40–80 ms prebuffer, 3–4 packets (matches PLAN).
- **Infra interception** (Medium case study, UNVERIFIED source): an API Gateway converting each WS audio byte into a
  separate downstream HTTP request caused 3–5 s latency. → Relevant to Fly/proxy/LB deployment; verify no idle-timeout
  or per-message proxying on the public TLS path. (AWS ALB 60 s idle, nginx `proxy_read_timeout`, CF ~100 s are the
  classic idle-close culprits — corroborated by general infra knowledge; Syrinx's heartbeat mitigates.)

### Latency reality (corroborates PLAN's ~800–1000 ms budget)
- **Human turn-taking baseline ≈ 200 ms** ✓-plausible (Stivers et al., PNAS 2009, 10 languages; Levinson & Torreira 2015).
  Perception ladder: <300 ms exceptional, 300–500 ms acceptable, 500–800 ms "slow", >800 ms awkward ("800 ms rule"),
  >1500 ms users repeat themselves, >2000 ms mental model flips to query-response.
- **VAD/endpointing is the single biggest controllable stage (100–400 ms)** and the dominant tail risk. Naive fixed
  silence = 500–800 ms; semantic turn (Pipecat Smart Turn / LiveKit adaptive) ≈ 86 %+ precision sub-300 ms. HuggingFace
  measured EOU P50 = 554 ms / P95 = 858 ms at `min_endpointing_delay` 0.5 s. → Syrinx's "STT final after speech end"
  (~900 ms live) is **on the high side**; the gap is provider finalize + the 0.8 s VAD stop, not transport.
- Streaming **overlap** (max-of-stages, not sum) is what gets to sub-second — reinforces "overlap work, react to partial
  signals" (PDF). Speculative generation (PLAN A6) is the named lever.
- Arxiv enterprise-agent measurement (TTFA 755 ms; STT 402 / LLM TTFT 457 / TTS TTFB 221 ms P50) — **UNVERIFIED** (arxiv
  id 2603.05413 not opened); cited only as directional corroboration.

### WebRTC vs WebSocket — settled for Syrinx (do not re-litigate)
WebRTC wins the last mile (NetEq adaptive jitter buffer, Opus FEC/PLC, GCC congestion control, packet-loss concealment)
but Syrinx's transports (Twilio/Telnyx Media Streams, browser-WS, CF/Fly) **force WS**; LiveKit already provides WebRTC
where wanted. WebRTC also *fails* for AI (drops packets → garbled prompts; ICE cold-start 500–2000 ms without Trickle;
renders by arrival-time not timestamp). **Decision stands (ADR-006): close the WS quirks, don't switch transport.**

---

## Layer 3 — v2 Syrinx code audit (THIS repo, source-grounded — ✓ personally read)

The whole point: which candidate failure modes is **this** engine actually exposed to? Verified against v2 source.

### CONFIRMED GAPS (with file:line)
1. **False barge-in — no min-interruption / backchannel guard.**
   `packages/voice/src/voice-agent-session.ts:462-485` — `handleVadSpeechStarted()` fires `interrupt.detected`
   (`source:"vad"`) **immediately** on any VAD speech-start while TTS is active. No min-duration, no min-words, no
   backchannel window, no debounce. → A cough, "mhm/yeah/okay", TV, or a VAD false-positive **cuts off the agent
   mid-sentence**. LiveKit guards this (minDuration 500 ms, minWords, falseInterruptionTimeout 2000 ms,
   backchannelBoundary). Maps to PDF failure modes "responds too early / premature interruption" + "agent talks over
   user." **HIGH severity, high frequency on live calls.**
2. **Interrupted turn vanishes from LLM history.**
   `packages/voice-bridge-aisdk/src/index.ts:101` (`if (signal.aborted) return;`) returns **before**
   `rememberTurn(userText, reply)` at `:154`. So on barge-in, **both the user text and the partial assistant reply are
   dropped from `this.history`**. Next turn the LLM has no record the exchange happened. → "loss of context",
   "repetitive/incoherent over time" (PDF #8/#12). Gold standard (PLAN A4 / LiveKit): remember the assistant message
   **truncated to words actually heard**, plus the user text. **HIGH severity.**
3. **No mid-turn STT/TTS stall guard (dead-air risk).**
   `withStreamIdleTimeout(...)` exists but is used **only** in `bridge-aisdk/src/index.ts:100` (LLM). Deepgram STT and
   Cartesia/Gemini TTS have **no engine-level idle/stall watchdog**: if a provider goes silent mid-utterance without a
   `done`/`error`/close, the turn can hang → **dead air** (PDF failure mode #1, the top one). The field-wide blind spot
   (LiveKit/Rapida lack it too), so an opportunity to lead. Must be designed to avoid false-positive stalls.
   **HIGH severity, lower frequency.**
4. **No multi-provider FallbackAdapter / graceful degradation.**
   Syrinx plugins fail the turn on provider failure (visible `*.error`). No STT/LLM/TTS failover or canned-audio
   fallback. LiveKit (`{stt,tts,llm}/fallback_adapter.py` ✓) + Pipecat have it; PDF Ch3 demands "if synthesis fails,
   fallback voice / canned audio; if reasoning fails, acknowledge + recover/escalate; never fail silently."
   **MEDIUM-HIGH severity** (fail-closed-with-error is defensible, but a live call hears silence/drop).
5. **Telephony pacer: no comfort/idle frame, no deadline-miss tracking.**
   `packages/voice-server-websocket/src/twilio.ts` paces at `DEFAULT_OUTBOUND_FRAME_DURATION_MS = 20` but has no
   idle/comfort-noise frame to hold cadence through gaps and no late-tick / `pacer_deadline_miss` instrumentation.
   Rapida's `output/pacer.go` (✓ read) drift-corrects, emits idle frames, flags late ticks (2 ms tol). PLAN SLO:
   pacer deadline miss = 0. **MEDIUM severity** (choppy audio under CPU pressure; PDF "choppy/distorted audio").
6. **Function-call interruption contract not enforced (dangling tool calls).**
   Tied to #2: when barge-in aborts mid-tool-call, the tool may already be executing; no `CANCELLED`/`IN_PROGRESS`
   paired result is recorded and the turn is dropped from history. PLAN A5. **MEDIUM severity.**
7. **No stage-budget SLO breach telemetry.** Stage latencies are measured post-hoc in smokes, but there are no live
   `*_over_budget` events (interrupt latency ≤60 ms, pacer deadline, reconnect RTO ≤500 ms). Observability gap (PDF Ch4 + PLAN §3).
8. **No per-provider concurrency / rate-limit backoff.** Prior-art backlog item; under sustained parallel load a
   provider 429/concurrency-limit isn't retried with backoff. **LOW-MEDIUM** (matters at scale, not single calls).

### CONFIRMED STRENGTHS (already hardened — do NOT regress)
- Mixed-sample-rate rejection + resample-from-known-rate ✓ (matches LiveKit invariant).
- Interrupted-context **terminal suppression** across core + all transports ✓ (late LLM/TTS/provider output dropped).
- Recorder **wall-clock truncation** of unheard assistant audio ✓ (`voice-recorder/src/index.ts:250-264,330`).
- **Smart Turn = single source of truth** (Silero VAD feeds it; raw-VAD finalize explicitly rejected) ✓ — matches PDF
  "disable redundant downstream turn logic." (Note: this is the *finalize* path; the *interrupt* path is raw VAD — see gap #1.)
- Transport: 1013 backpressure ceiling, heartbeat ping, max-session timer, startup timeout, oversized-frame close,
  envelope validation, sequence/chunk guards ✓.
- Provider-semantic adapters (Deepgram provider-finalize + state-discard-on-reconnect; Cartesia X-API-Key + contexts +
  cancel + flush_done fix) ✓.
- **LLM stream idle timeout** ✓ (`withStreamIdleTimeout`) — but STT/TTS uncovered (gap #3).

---

## Layer 2 — Same-project prior art (`…/asyncdot/openscoped/voice-media-transport/`)

> These docs are from the **v1.x generation** (mastra/elevenlabs, `apps/audio-fixtures`), which predates this
> repo's v2 kernel. Treat as *signal about what breaks*, not current code; verify each against v2 before acting.

### Real bugs/issues already hit (v1.x)
- `long-call-scratchpad.md`: **`audioIn write failed: Socket is not open` after first run** — a WS lifecycle/
  reuse bug on long calls. → Verify v2 browser/telephony WS can't write to a closed socket on long sessions.
- `reliability-hardening-scratchpad.md`: needed **server-side `bufferedAmount` egress backpressure**, structured
  WS `error` events, AssemblyAI-style **ready/welcome-before-audio** + **bounded reconnect**. (v2 has heartbeat +
  1013 backpressure + ready advertisement — partially carried over.)
- `production-hardening-scratchpad.md`: **provider concurrency / rate-limit under sustained parallel load**;
  Cartesia concurrency-limit **retry/backoff**; resampler reset at segment boundaries; odd-byte-offset safety.
  → v2 has odd-byte safety; **per-provider concurrency/rate-limit backoff is still a backlog item.**

### `PLAN-kernel-ws-optimization.md` (2026-05-14) — benchmarked vs the Pipecat/Daily gold-standard guide (voiceaiandvoiceagents.com)
Concrete, gold-standard-grounded targets and gaps (verify which landed in v2):
- **Voice-to-voice budget ≤800 ms aspiration / ~993 ms typical:** STT+endpointing 300, LLM TTFT 350, TTS TTFB 120,
  network/codec/OS ~223. (Syrinx longform is far above this — Gemini TTS/LLM bound, already known.)
- **Stage-budget SLOs w/ `*_over_budget` telemetry:** endpointer ≤250 ms, **interrupt latency (VAD speech_started →
  TTS abort) ≤60 ms**, **reconnect RTO (WS drop → first replay frame) ≤500 ms**, **pacer deadline miss (audio out
  >5 ms late past 20 ms cadence) = 0**, cold start ≤300 ms. → Syrinx measures stage latencies but not these
  *budget-breach* events; pacer-deadline-miss and interrupt-latency SLOs are absent.
- **A4 Word-level interruption truncation:** truncate conversation context to the **spoken-word boundary** (using
  TTS word timestamps), not clock-time. v1.x truncated by clock-time — **and so does v2** (recorder/engine truncate
  by wall-clock). **Real gap** — corroborated by Deepgram PDF + LiveKit gold standard. Risk: context contains words
  the user never heard → "repetitive/incoherent over time" failure mode.
- **A5 Function-call interruption contract:** every tool-call request needs a paired response even when interrupted
  (`result` / `CANCELLED` / `IN_PROGRESS`); kernel must never pass a **dangling tool-call** to the LLM. → Audit
  `bridge-aisdk` in v2: interruption mid-tool-call may leave a dangling request → incoherent next turn.
- **A6 Predict-and-scrap LLM speculation** (300–600 ms win on confident turns; abort on continued speech; never
  speculate tool-cued turns). Not in v2.
- **A7 Zero-alloc steady state:** per-frame `Buffer.from`/`Float32Array`/string allocs cause **major GC pauses that
  are user-audible** → maps to PDF failure mode #1 ("blocking operations prevent entering response phase"). Not audited in v2.
- **Jitter buffer rule (Twilio):** **40–80 ms prebuffer, 3–4 packets max**; "larger jitter buffer = larger perceived
  delay." Buffer jobs: smooth sender bursts to exact 20 ms cadence, absorb receive jitter, underrun/comfort-noise fill.
- **WS-vs-WebRTC decision (still valid):** Twilio Media Streams + CF Workers + browser-WS force WS; LiveKit gives
  WebRTC where wanted. The work is to **close the WS quirks (HOL blocking, no codec/echo/congestion feedback,
  observability), not switch transport.** WebRTC migration explicitly rejected (ADR-006).
