# RFC — Explicit Turn-Taking State Machine for the Voice Engine

Companion design study for **CR-09 / CR-02** (deferred barge-in extraction). This
is not "extract a class to shrink a file" — it is "model turn-taking as a first-class,
position-aware state machine so the engine's safety-critical concurrency is correct by
construction and the deferred turn-taking roadmap becomes buildable."

Status: **proposal** (research-grounded). Implementation is staged + test-first (§6).

---

## 1. Root cause (not the symptom)

The filed symptom is "barge-in logic lives in a 1273-line file." The **root** is:

> Turn-taking is an **implicit, distributed state machine** with no explicit state
> model and no single owner of its invariants. The interrupt **decision** layer is
> **position-blind**, and **execution** is split across two packages.

Concrete evidence in our code:

1. **State is smeared across ~6 handlers + 4 collaborators + the bus.** The "interrupt
   state" is `pendingInterruption` / `pendingInterruptionAwaitingAudio` /
   `interruptedGenerationContextIds` / `firstTtsAudioFired` mutated independently by
   `handleVadSpeechStarted`, `handleVadSpeechActivity`, `handleVadSpeechEnded`,
   `handleVadAudioForSpeakerGate`, `tryCommitPendingInterruption`,
   `suppressPendingInterruption`, `handleInterruptDetected` — plus `PrimarySpeakerGate`,
   `TtsPlayoutClock`, `LatencyFiller`, and the **bridge** (`voice-bridge-aisdk`). No
   object answers "what turn state are we in, and which transitions are legal?"
2. **The decision layer is position-blind.** The wire packet `tts.playout_progress`
   carries `playedOutMs` (`packets.ts:330`) — the true *heard* position — but the
   session's `TtsPlayoutClock` **discards it**: `handleTtsPlayoutProgress` →
   `noteProgress(contextId, complete)` keeps only the `complete` boolean + an
   *end-estimate* (`playoutEndMs`). The session decides interruptions on
   "still speaking: yes/no", never "heard 1.2 s of a 3 s utterance."
3. **Execution is split.** The cut itself (`handleInterruptDetected`: cancel TTS, cancel
   LLM, truncate recorder, stop idle, release playout) lives in the session, but the
   **context truncation** (rewrite history to the spoken prefix, G2/G25/VE-04) lives in
   the **bridge**, which independently reconstructs position from `playedOutMsByContext`
   + word timestamps. Two components, one logical transition.
4. **Detection, decision, and execution are fused** into the VAD event handlers: a
   `vad.speech_started` flows through begin-pending → threshold → gate → emit in one
   call chain, mixing the dumb acoustic signal with the precise interrupt decision and
   the irreversible side-effects.

This is why the catalog's intended features were **deferred as un-buildable** on the
current design: `falseInterruptionTimeoutMs` (resume a falsely-cut turn from where the
user stopped hearing), `minInterruptionWords`, `backchannelWindow`
(`VOICE-ENGINE-FAILURE-MODES.md` G1). You cannot resume-from-position when the decision
layer never knew the position, and you cannot add a new decision policy without
re-deriving the implicit transitions across all six handlers.

---

## 2. Why this is the right change (research-grounded)

Three principles converge across LiveKit Agents, Pipecat, and the full-duplex
literature (Moshi/Kyutai, Full-Duplex-Bench, Smart Turn v2, Kwindla/Daily). Citations
in §8.

### P1 — Detection → Decision → Execution are three stages, three clocks, three failure modes
- **Detection** ("is there speech?") is cheap, acoustic, deliberately **high-recall** —
  it fires on backchannels, coughs, TV. Pipecat models this as a *raw* layer
  (`VADUserStartedSpeakingFrame`) distinct from the turn-level
  `UserStartedSpeakingFrame`.
- **Decision** ("*should* this interrupt / commit the turn?") is **high-precision** —
  endpointing delay, min-duration, min-words, primary-speaker, semantic completeness.
  LiveKit layers this as an explicit tier above raw VAD.
- **Execution** is the **irreversible** bundle: cancel playout, cancel generation,
  truncate context. You cannot un-cancel a generation.

Fusing them conflates recall (detection wants it) with precision (execution wants it)
into one threshold, and commits the irreversible side-effect *before* the decision
evidence is complete. LiveKit's adaptive model rejects **~51%** of VAD barge-ins as
false positives — that rejection only exists because decision is a separate tier.

> **Strongest precedent — Pipecat already did this refactor.** On `main`, Pipecat
> collapsed its `StartInterruptionFrame`/`StopInterruptionFrame`/`BotInterruptionFrame`
> triad into a single high-priority `InterruptionFrame` and **extracted turn-taking into
> a dedicated `turns/` package** built around a `UserTurnController` state machine with
> **two independent pluggable strategy lists**: *start strategies* (barge-in:
> `VADUserTurnStartStrategy`, `MinWordsUserTurnStartStrategy`) and *stop strategies*
> (endpointing: `TurnAnalyzerUserTurnStopStrategy` composing Smart Turn + VAD). Detection
> (`VADController`, a `QUIET/STARTING/SPEAKING/STOPPING` machine) only *reports*; the
> controller+strategies *decide* (carried as an `enable_interruptions` flag); the
> processors/output transport *execute* (`handle_interruptions` cancels playout;
> `_bot_speaking` tracks **real playout**, not generation). A leading OSS voice framework
> independently converged on exactly the design below — this de-risks it from "ambitious
> idea" to "proven pattern."

### P2 — "Agent is speaking" is keyed on the playout clock, not the generation clock
The clocks diverge by hundreds of ms to seconds (TTS/LLM run ahead). Two rules follow:
- **Interruptibility:** a turn is interruptible while its *playout* is in progress, even
  after generation finished. (We already do this via `TtsPlayoutClock` — WT-03/G12.)
- **Context truncation must be atomic with the cancel, at the heard position.** The
  canonical failure is Pipecat #2791: bot counts to 20, user cuts at "5", the partial
  output never lands in context, so the model re-counts from 1. The user heard "1–5";
  context must say "1–5". This *requires* position, and the cancel + truncate must be
  **one transition**, not two interleaving handlers.

### P3 — A cascade must model turn-taking explicitly (Moshi models it implicitly; we can't)
End-to-end full-duplex models (Moshi) learn turn-taking *implicitly* as parallel
audio/text token streams — speak and listen at once, no explicit boundaries. A
cascaded STT→LLM→TTS pipeline has no such joint sequence, so it must model turn-taking
**explicitly**, and the right boundary is **a single arbiter owning both input-speech
state and output-playout state simultaneously** — the cascade's stand-in for Moshi's
two parallel streams. Interruption is a **transition in that arbiter**, never a
side-effect emitted from inside STT, the LLM, or TTS. Components publish events
(speech detected, token generated, audio played) and receive commands (cancel, flush);
they do not decide turn-taking. Full-Duplex-Bench's overlap taxonomy (user interruption,
backchannel, side-conversation, ambient speech) is the test matrix that arbiter passes.

### Why explicit beats handler-smeared mutable state — *specifically here*
Interruption is a **concurrency problem**: two clocks, multiple async producers (VAD,
STT, LLM, TTS), and irreversible side-effects racing. Smeared across booleans mutated
by independent callbacks, the legal-transition rules are implicit and unenforced, so
**illegal states are reachable**: interrupt-after-playout-ended, cancel-without-truncate,
double-interrupt, zombie "speaking forever" if a callback is missed. LiveKit encodes
each utterance as a `SpeechHandle` with **set-once futures** (`_interrupt_fut`,
`_done_fut`, `wait_for_playout()`) + a cancel timeout, so two VAD callbacks cannot
half-flip state and every utterance terminalizes. An explicit machine makes each
invariant a **guarded transition**: illegal states become unrepresentable, the
playout/generation distinction is encoded in *which state you're in*, and the
decision/execution split is structural rather than a discipline each handler must
remember.

---

## 3. The proposed design

A single **`TurnArbiter`** (working name) owns turn-taking state for the session. It is
the only writer of turn state; the session's handlers become thin adapters that feed it
events and apply the commands it returns.

### States (canonical, converging with LiveKit's agent/user split)
```
Listening → UserSpeaking → Endpointing → AgentThinking → AgentSpeaking
                                              ↑                 │
                                              └──── Interrupting ┘ → Listening
```
`Endpointing` and `Interrupting` are **decision states**, not instants.

### What the arbiter owns (fixing the splits in §1)
- **Input-speech sub-state**: pending barge-in window, sustained-speech accumulator,
  speaker-gate composition (today's `pendingInterruption*`).
- **Output-playout sub-state**: which context is live + **its heard position**
  (`playedOutMs`, *stop discarding it*) + end-estimate (today's `TtsPlayoutClock`,
  folded in / fed by it).
- **Two independent decision-policy lists** (Pipecat's key refinement — barge-in and
  endpointing must tune independently, not fight over one `is_speaking` flag):
  - **Start/barge-in policies** (route `AgentSpeaking`→`Interrupting`): `MinDurationPolicy`
    (G1 `minInterruptionMs`), `PrimarySpeakerPolicy` (VE-02), future `MinWordsPolicy`,
    `BackchannelWindowPolicy`. A barge-in commits only if the composed policy says so.
  - **Stop/endpointing policies** (route `UserSpeaking`→`Endpointing`→`AgentThinking`):
    today's Smart-Turn + STT completeness (VE-01), future `SemanticEndpointPolicy`
    (Smart Turn v2). These decide *user-turn-complete*, a separate question from barge-in.
- **Execution as one atomic command bundle**: `{cancelPlayout, cancelGeneration,
  truncateContextAt(playedOutMs)}` — unifying the session+bridge split so cancel and
  truncate cannot interleave.

### Invariants enforced as guarded transitions
1. An interruption commits **only** against a turn whose playout has **not** ended
   (today's `interrupt.gate_resolved_after_tts_end` becomes a guard, not an ad-hoc check).
2. Cancel-playout and context-truncation are **one transition** (kills the #2791 class).
3. A detected-speech event in `AgentSpeaking` **must** pass the decision gate before
   reaching `Interrupting` — detection never transitions straight to execution.
4. Exactly one turn is live; `AgentThinking` is cancellable; backchannels are absorbed
   without leaving `AgentSpeaking`.
5. A cancel transition drops only *interruptible* work — it must **not** discard
   lifecycle/terminal packets (Pipecat's `UninterruptibleFrame` lesson: naive
   "flush everything on interrupt" kills the `EndFrame`). Our Critical-route packets
   (`session.disconnect`, `init.failed`) must survive a barge-in flush.
6. A stuck turn must self-terminalize (Pipecat's 5 s stop-timeout watchdog; LiveKit's
   `_done_fut` + cancel timeout) — no "speaking forever" if a `tts.end`/playout-complete
   event is dropped.

---

## 4. Mapping onto current behavior — **zero regression**

| Today (implicit) | Under the arbiter |
|---|---|
| `pendingInterruption` + `minInterruptionMs` gate (G1) | `UserSpeaking`→`Interrupting` guarded by `MinDurationPolicy` |
| `PrimarySpeakerGate` composition (VE-02) | `PrimarySpeakerPolicy` in the decision gate |
| `tryCommit`/`suppress` metric paths | transition outcomes (committed / suppressed_*) |
| `TtsPlayoutClock` active/end-estimate (WT-03) | arbiter's output-playout sub-state |
| bridge spoken-prefix rewrite (G2/G25/VE-04) | `truncateContextAt(playedOutMs)` in the execution bundle (bridge still applies it; arbiter owns *when/where*) |
| `interruptedGenerationContextIds` late-packet gating | a property of being in `Interrupting`/`Listening` for that context |

Every existing metric and behavior has a 1:1 home. The 125-test voice suite + the ~12
barge-in/gate tests are the **characterization net** that proves equivalence.

---

## 5. What it unlocks (the ambition)

Once the arbiter owns position + composable policies, the deferred roadmap becomes
*additive*, not surgical:
- **Resume-on-false-interruption** (`falseInterruptionTimeoutMs`): pause instead of kill,
  start a timer, resume from `playedOutMs` if no real user turn materializes — exactly
  LiveKit's `resume_false_interruption`. Impossible today (position-blind).
- **Backchannel window** and **min-words**: new decision policies, no handler surgery.
- **Semantic endpointing** (Smart Turn v2): a `SemanticEndpointPolicy` that shortens/
  extends the VAD silence timeout — the single biggest published false-interruption win
  (~39–85% reductions).
- **Full-Duplex-Bench overlap taxonomy** becomes a **deterministic** test matrix against
  the arbiter (VE-05 examiner already exists to score it).

---

## 6. Implementation plan — staged, test-first, behavior-identical

- **Stage 0 — Characterization net (zero risk).** Add focused tests that pin the exact
  current transition table: short-blip-suppressed, sustained-commit-after-`minInterruptionMs`,
  suppressed-non-primary, suppressed-short-speech, immediate-cut (`minInterruptionMs<=0`),
  gate-resolved-after-tts-end, awaiting-audio commit, playout-complete release. Most
  exist end-to-end; make the **transitions** explicit assertions.
- **Stage 1 — Make the implicit machine explicit *in place*.** Introduce the state enum
  + guarded transitions *inside* the session, no extraction yet. No behavior change;
  suite green.
- **Stage 2 — Extract `TurnArbiter`.** Move the state machine into its own module, deps
  injected (bus, gate, playout, policies). Behavior-identical; suite green; session
  drops well under 1000 lines.
- **Stage 3 — Position-aware.** Thread `playedOutMs` into the arbiter (stop discarding
  it); unify the execution bundle with the bridge's truncate. Still no new behavior.
- **Stage 4 (separate, opt-in) — Ship the unlocked features** behind config/profile:
  resume, backchannel, min-words, semantic endpoint. Each is a policy + its own tests.

Each stage is independently revertible and gated on the full suite.

---

## 7. Risks & why this is ambitious-but-safe (not premature abstraction)

- **Risk:** it's the safety-critical path (a wrong cut = talk-over or won't-stop).
  **Mitigation:** test-first (Stage 0), behavior-identical extraction (Stages 1–3),
  staged with the suite green at each step.
- **Not premature abstraction:** the state machine already *exists* — implicitly,
  distributed, and unenforced. We are making an inherent concurrency/state problem
  explicit, justified by (a) a real present bug class (position-blind decisions,
  cancel/truncate split) and (b) a concrete deferred roadmap that is otherwise
  un-buildable. The third-use-case test is met: G1, VE-02, and the deferred
  resume/backchannel/semantic features are all the "same" decision in different clothes.

---

## 8. Sources

LiveKit Agents source (`voice/speech_handle.py`, `io.py`, `audio_recognition.py`,
`agent_activity.py`) + `docs.livekit.io/agents/build/turns`; Pipecat
`docs.pipecat.ai/.../speech-input` + issue #2791; Smart Turn v2
(`huggingface.co/pipecat-ai/smart-turn-v2`); LiveKit blogs (transformer EOT, EOU −39%,
adaptive interruption); Daily "Advice on Building Voice AI, June 2025" (Kwindla,
playout-aligned context + latency budget); Moshi/Kyutai (arXiv 2410.00037);
Full-Duplex-Bench (arXiv 2503.04721). Cross-referenced against our
`VOICE-ENGINE-FAILURE-MODES.md` (G1/G2/G6/G10/VE-02/VE-04) and the shipped code.
