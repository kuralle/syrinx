# Sprint 01 — Kanban Board

> **External review track:** after each wave (~2 issues) lands, an independent Gemini
> (`agy`) review of that wave's **committed** commits is fired, appending to
> `GEMINI-EXTERNAL-REVIEW.md`. The orchestrator does NOT read these mid-sprint (keeps
> it unbiased) — read holistically at sprint end. Fired so far: `gemini-review-w0` (WT-02, WT-05).

Move a card right as it progresses. A card enters **Review** only with green
unit tests + a live-API smoke (where applicable) + updated docs. It enters
**Done** only after the reviewer has read the actual diff (ship-it-managed
Phase 3) and observed the behavior end-to-end.

Legend: `WT` = WebSocket transport · `VE` = voice engine · `(Pn)` priority ·
`→deps` blocked-by.

---

## 📥 Backlog
_(empty — all sprint issues are specced and promoted to Ready/Blocked)_

## 🟢 Ready (unblocked — transport track shipped sequentially, in order)

## ⛔ Blocked (waiting on a dependency)

## 🔨 In Progress
_(none)_

## 👀 In Review (tests green, awaiting diff review)
- **VE-05** (P3) EVA-Bench / Full-Duplex-Bench CI gate (G26) — cursor/auto. `eva-evaluator.ts` scores EVA-X turn-taking timing + stereo overlap; live examiner smoke with clean + noise/accent perturbation arms; warn→block gate via `SYRINX_EVA_GATE_MODE`. **9 examiner tests**; live smoke `qualityGate.passed:true` (`eva-bench-examiner-2026-05-31T16-14-51-754Z`, timing 80 / overlap 100, 0 ms overlap).
- **VE-03** (P3) Latency-hiding filler token dual-track (G24) — cursor/auto. Optional `latencyFillerEnabled` connective at endpoint before LLM TTFB; interruptible + splice-safe; metrics `filler.started|spliced|cancelled`. **105 voice tests**; live A/B smoke `qualityGate.passed:true` (`latency-filler-ab-2026-05-31T16-08-48-429Z`, −916 ms speech-end→first-audio vs off).
- **VE-02** (P2) Speaker-attribution barge-in gate (G23) — cursor/auto. Goertzel-band primary-speaker fingerprint locked on first user turn; composes with G1 `minInterruptionMs`; `interrupt.suppressed_non_primary` + assistant-echo rejection; G1 fallback when no profile. **97 voice tests**; live smoke `qualityGate.passed:true` (`primary-speaker-barge-in-2026-05-31T16-03-22-762Z`, 0 false interrupts).
- **VE-03** (P3) Latency-hiding filler token dual-track (G24) — cursor/auto. Optional `latencyFillerEnabled` connective at `eos.turn_complete` before LLM TTFB; cancel on user resume; splice strips duplicate connectives. **105 voice tests**; live A/B smoke `qualityGate.passed:true` (`latency-filler-ab-2026-05-31T16-08-48-429Z`, −916 ms endpoint→first-audio).
- **VE-01** (P2) Semantic endpointing fused off STT partials — cursor/auto. Heuristic semantic-completeness scorer fused with Pipecat Smart Turn in `@asyncdot/voice-turn-pipecat`; defers mid-thought pauses when acoustics approve, shortcuts complete utterances when Smart Turn is uncertain. **18 turn-pipecat tests**; voice 88/88; transport 147/147; live recorder coherence `qualityGate.passed:true` (`live-university-recorder-2026-05-31T15-52-47-698Z`).
- **WT-09** (P2) Metrics wiring + per-turn timestamps + browser loss/jitter smoke — cursor/auto. `TurnMetricsTracker` emits populated `metrics` per turn (4 timestamps + stage latencies + `correlationId`) from `PlayoutProgressEmitter`; browser jitter smoke with uplink `clean|jittery|bursty` proxy; interactive smoke logs P50/P95 voice-to-voice SLO warnings. **147 tests ×5 stable**; live jitter smoke `qualityGate.passed:true` (`browser-jitter-2026-05-31T15-35-29-161Z`).
- **WT-08** (P2) Concurrency cap + admission control + upgrade-path leak — cursor/auto. Shared per-HTTP-server upgrade router destroys unmatched paths; `maxConcurrentSessions` rejects N+1 with 1013 + `transport.admission_rejected` metric on all four carriers. **142 tests ×5 stable**; typecheck green.
- **WT-07** (P2) `ClientTransport` seam + Opus browser leg — **In Review**. `ClientTransport` + `WebSocketClientTransport`; `SyrinxBrowserClient` on seam; Opus uplink/downlink at 48 kHz wire (16 kHz engine) via `ready.supportedInputCodecs`; PCM fallback. Smoke: **~102 kbps** vs **~256 kbps** PCM baseline (`browser-opus-uplink-2026-05-31T15-10-02-401Z`). **138 tests ×5 stable**; client 45/45; `pnpm -r typecheck` green.

## ✅ Done (diff reviewed + behavior observed)
- **VE-05** (P3) EVA-Bench examiner CI gate — cursor/auto `88a6742`. `eva-evaluator.ts` (EVA-X turn-taking timing + Full-Duplex overlap from stereo `conversation.wav`, noise/accent perturbations) + warn→block gate (`SYRINX_EVA_GATE_MODE`, overlap >1500 ms hard-fails); 9 gate tests + known-good/bad fixtures + checked-in baseline; **live `qualityGate.passed:true`** (timing 80/overlap 100, 0 ms overlap). Hygiene clean. **→ SPRINT COMPLETE.**
- **VE-03** (P3) Latency-hiding filler token — cursor/auto `5b27689`. Off-by-default `LatencyFillerController`: connective → TTS at endpoint before LLM, first `llm.delta` splices with duplicate-prefix stripping, cancel-on-resume. Voice 105 tests; **live A/B smoke `qualityGate.passed:true`: −916 ms (~17%) speech-end→first-audio** (5539→4623). Hygiene clean.
- **VE-02** (P2) Speaker-attribution barge-in — cursor/auto `f698dfe`. Lightweight `PrimarySpeakerGate` (no model) composes with G1: scores VAD audio vs first-turn fingerprint, blocks assistant TTS echo, emits `interrupt.suppressed_non_primary` for non-primary, falls back to G1. Voice 97 tests; **live background-speech smoke `qualityGate.passed:true`, 0 false interrupts**. Hygiene clean.
- **VE-01** (P2) Semantic endpointing fused off STT partials — cursor/auto `a301796` + reviewer `d76f5e3`. Zero-latency heuristic `scoreSemanticCompleteness()` on STT partials + `fuseEndpointDecision()` augmenting Smart Turn (mid-thought pauses defer, complete utterances shortcut). 18 turn-pipecat tests + labeled fixture set; voice session 88 tests; **live recorder-coherence smoke `qualityGate.passed:true`** (3 multi-clause turns, 0 truncations). Reviewer committed the dangling `@evan/opus` lock entry from WT-07. _(Interactive-smoke manifest-write hiccup flagged pre-existing; recorder coherence same PCM path passed.)_
- **WT-09** (P2) Metrics + per-turn timestamps + browser loss/jitter smoke — cursor/auto `824f7fd`. `TurnMetricsTracker` (4 canonical timestamps + stage latencies + correlation id) → `metrics` message; browser jitter smoke `qualityGate.passed:true` (jittery profile, e2eMs=598, 0 playback errors); interactive P50/P95 SLO. Suite 5/5×147, client 46. Hygiene clean. **→ TRANSPORT TRACK WT-01–WT-10 COMPLETE.**
- **WT-08** (P2) Concurrency cap + admission + upgrade-leak — cursor/auto `be30deb`. `maxConcurrentSessions` admission (close 1013 + `transport.admission_rejected` metric); unmatched-upgrade `socket.destroy()` leak fix; 4 carriers threaded; 158-line admission test. Suite 5/5×142; hygiene clean. _(Cap is per-routed-path via `wsServer.clients.size`, not global — reasonable per-endpoint.)_
- **WT-07** (P2) `ClientTransport` seam + Opus browser leg — cursor/auto `2b03a35`. `ClientTransport` interface (`transport.ts`) + `WebSocketClientTransport`; client + server `browser-opus.ts` (dynamic `@evan/opus`), codec negotiated in `ready`, PCM fallback. **Live Opus smoke `qualityGate.passed:true`, REAL measured 256→102 kbps (2.5× win, ratio 0.399), server decodes end-to-end.** Client 45 tests + server 5/5×138; hygiene clean. _Follow-up: Opus is 48 kHz (~102 kbps); a 16-24 kHz voice profile would approach the ~32 kbps aspiration — tuning, not blocking._
- **WT-06** (P2) Externalizable `SessionStore` — cursor/auto `bf416d6`. `SessionStore` interface + `InMemorySessionStore` default + injectable `options.sessionStore`; all session access (lease/release/listAll/clear) routed through it; zero behavior change. 167-line test incl. injected-fake seam proof. Suite 5/5 (135 tests). Git hygiene clean (name-only, notes append-only).
- **WT-10** (P1) Test-suite flakiness hardening — cursor/auto worker `4ac8a4d`. From the delegated Gemini+GLM converged diagnosis: `afterEach` cleanup registry (`setupTransportTestCleanup`/`registerServer`) in all 4 test files + shared `test-helpers.ts` + `vitest.config.ts`; fixed the 2 named flaky tests. **Reviewer verified 10/10 suite runs** (128 tests; was ~1/3 flaky). NO retries / NO fake timers. Git hygiene clean (name-only commit; notes appended not clobbered — the hard-rule brief worked).
- **WT-03** (P1) Browser pacing + playout clock + jitter buffer — cursor/Sonnet worker `05e92cc` + reviewer `42e59ee`. Diff read; browser adapter now routes outbound TTS through the shared `OutboundPlayoutPipeline` (paced + `PlayoutProgressEmitter` → G12 playout clock on the browser leg) + integrates WT-04 `drainAndClose`; new `AudioJitterBuffer` (AudioContext-scheduled, flush-on-clear). 41 client tests + 4 browser-pacing tests; headless smoke `qualityGate.passed:true`; suite 127/128 (1 = known pre-existing flake, fixed in WT-10). **Reviewer fix:** worker's broad `git add` clobbered `implementation-notes.md` (−178 lines) — restored from 88ce280.
- **WT-04** (P1) Graceful drain on shutdown — worker (died on 1M-credit limit) + reviewer `88ce280`. `close({graceful,drainDeadlineMs})` host + per-carrier path (drain→1001→terminate at deadline); SIGTERM wired. 7 graceful-drain tests **12× stable**, full suite 124 green. **Reviewer took ownership** (worker out of credits) + root-caused the flaky browser tests to a `ready`-message race in the TEST (not close); reverted speculative close changes. _(Pre-existing unrelated `index.test.ts` malformed-JSON flake noted for a suite-health pass.)_
- **WT-01** (P1) Extract `WebSocketTransportHost` — worker `40ea8be`. Diff read; lifecycle skeleton lives ONLY in `transport-host.ts` (+ `outbound-playout-pipeline.ts`, `transport-helpers.ts`); zero helper/lifecycle copies in the 4 carriers (twilio 942→522, telnyx 946→630, smartpbx 739→457, index 882→682); no file >1000 lines; **117 transport tests ×5 stable**; Telnyx-reorder/Twilio-reject/SmartPBX-passthrough preserved. **Live gate passed:** Fly synthetic-carrier (Deepgram TTS) E2E green on all 3 carriers (twilio/telnyx/smartpbx `gate=true`, 0 failures), both Fly apps destroyed, no leaks. Clean — no reviewer fixes needed.
- **VE-04** (P1) Spoken-prefix context (closes G2) — worker `5b615b5`. Diff read; `tts.word_timestamps` (Cartesia cumulative offset) + bridge precision ladder; **deadlock regression test verified real** (barge-in mid-playout at 450 ms → history truncates to exactly the heard words). Tests green (voice 87 / bridge 8 / cartesia 11). G2+G25 SHIPPED. ✅ **Live debt CLOSED** with the new Cartesia key: recorder-coherence `qualityGate.passed:true` + `tts.word_timestamps` emitted live. _Investigating the original smoke exposed + fixed a real crash:_ **G27** (`b1950ad`) — `voice-ws` dispose-while-connecting killed the process via an unhandled `'error'` (regression test proven to fail without the fix); hardens every provider plugin.
- **WT-02** (P1) Canonical audio module + anti-aliased resampler — worker `f08d4db` + reviewer `7c1ebc2`. Diff read; real windowed-sinc anti-alias (spectral lock ≥40 dB); zero codec re-declarations; all 4 transports on `@asyncdot/voice/audio`; 87 voice + 117 transport tests green; recorder coherence live smoke `qualityGate.passed:true` with new resampler. **Reviewer caught worker's over-claim** (a 1/3-flaky drain test), root-caused it (per-call FIR rebuild load + fixed-wait test), fixed both (FIR memoization + condition-poll) → suite 8/8 stable.
- **WT-05** (P1) Browser client reconnect + resume + keepalive — worker `ed81306` + reviewer flap-guard `190f2fd`. Diff read; 32 unit pass; live headless smoke `resumed:true`, `reconnectUrlHasSessionId:true`, event order verified. Reviewer added `minStableMs`/`maxQuickFailures` quick-failure guard.

---

### Burndown
14 sprint issues + WT-10 (flakiness, from delegated diagnosis) · **7 done (WT-01..05, VE-04, WT-10)** + G27 bonus · 6 in review (WT-06..09, VE-01..03, VE-05) · VE-05 queued→review.
External reviews: gemini-review w0/w1/w2 fired (unread, accumulating in GEMINI-EXTERNAL-REVIEW.md).
Worker note: claude 1M-context credits exhausted → workers run on `cursor-agent --model auto` (fast) / sonnet-4.
External review: `gemini-review-w0` + `gemini-review-w1` fired (unread, accumulating in GEMINI-EXTERNAL-REVIEW.md).
Live-verification debt: none open (VE-04 closed via new Cartesia key).

