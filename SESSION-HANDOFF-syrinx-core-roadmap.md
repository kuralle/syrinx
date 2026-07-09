# Session handoff — Syrinx core roadmap (updated 2026-07-09)

> Orientation for a fresh session. Read this, then the per-effort notes it points to.
> The 2026-07-09 planning section directly below is the NEWEST state; the "Where the repo stands"
> section (v4.0/v4.1) below it is still accurate for what is SHIPPED.
> Everything in the v4.0/v4.1 sections is COMMITTED AND PUSHED to kuralle/main unless marked otherwise.

## 2026-07-09 planning session — vNext RFCs drafted + build order (NOT committed)

A research + planning session. No product code shipped. It produced **3 RFCs + 3 research artifacts +
1 live spike**, all UNCOMMITTED new files on `main` (git add + commit when ready). It also proved the
half-cascade provider question live. Reference the artifacts — do not re-derive:

**RFCs drafted (`docs/`):**
- `docs/rfc-incremental-unit-substrate.md` — **capstone / substrate.** Reframes speculative generation,
  barge-in truncation, eager-EOT, and the `contextId → turn-epoch` reshape as ONE Incremental-Unit
  commit/revoke primitive (`IuLedger` in core). Resolves the `.understanding/` P0 turn-boundary cluster.
- `docs/rfc-interaction-policy-seam.md` — full-duplex `InteractionPolicy` seam (collapses the 3 endpointing
  owners into one; VAP-class learned controller as first impl; backchannels; eval harness as C6 proof gate).
- `docs/rfc-half-cascade.md` — realtime front text-only + Syrinx TTS (was plan-of-record #2, now specced).

**Research artifacts (`research/`, ARS-produced = CC-BY-NC, internal-only):**
- `research/full-duplex-orchestration-litreview.md` — 22 verified sources; VAP/Moshi/taxonomy; the
  model-agnostic-orchestration thesis + the residual limit.
- `research/half-cascade-spike-results.md` — **live go/no-go: GO.** OpenAI text-only + tools PASS on
  `gpt-realtime-2` and `gpt-realtime-2.1-mini` (community "text-breaks-with-tools" bug did NOT reproduce);
  mini text TTFT ~359ms; Zeta Sinhala TTS (Modal, OpenAI-compat `/v1/audio/speech`) warm streaming TTFB
  ~0.8s, **cold-start 40–60s = prod blocker (needs keep-warm)**. Adapter gap: `openai-compatible-realtime.ts`
  handles `output_audio_transcript.delta` but NOT `response.output_text.delta` (the half-cascade C0 change).
  Provider matrix: OpenAI/Azure YES; Gemini flash-live candidate, native-audio NO; Nova Sonic candidate;
  Grok Voice/Ultravox/Phonic/PersonaPlex NO (audio-native).
- `research/incremental-processing-deep-dive.md` — academic grounding (Stivers/Levinson/Bögels turn-taking
  psycholinguistics; Schlangen & Skantze Incremental Unit model; Pickering & Garrod). The IU-substrate RFC's basis.

**Deep-dive finding (why the capstone exists):** preemptive/speculative generation across the ecosystem
(Flux eager-EOT, LiveKit preemptive-generation, Pipecat markers, our SpeculativeHold) is the rediscovery of
the Incremental-Unit model. Barge-in truncation-to-heard-prefix and speculative generation are the SAME
operation (commit heard / revoke rest). See memory `incremental-unit-substrate-insight`.

### BUILD ORDER (dependency-sequenced; this is the plan of record now)

- **Phase 0 (spine, do first):** IU-substrate **C1** (`IuLedger`) + **C5** (`contextId → turn-epoch` identity)
  — the shared prerequisite; clears the P0 telephony cluster. Then **C2** (re-express shipped speculative gen
  on the ledger, behavior-preserving).
- **Phase 1 (parallel once identity exists):**
  - Track A (critical path): InteractionPolicy **C1** (RuleBased seam, behavior-preserving) → **C5** VAP → **C3** backchannels.
  - Track B (orthogonal): reasoner-latency **routing + hedging** (`docs/rfc-reasoner-latency.md`; speculative
    already shipped). Pull to front if the 2.1–3.6s v2v compute-latency gap is the priority.
  - Track C (cheap, no deps): half-cascade **C0** (adapter `output_text` handler; spike-de-risked).
- **Phase 2:** half-cascade **C1–C4** — blocked on Track A (half-cascade removes native turn detection → needs InteractionPolicy).
- **Phase 3:** eval harness (InteractionPolicy **C6**) — measures cascade / native-realtime / half-cascade × VAP; settles degenerate-vs-fine-grained IU.

One-line: **substrate identity → turn-taking (InteractionPolicy+VAP) → half-cascade → eval.** Off critical path:
Gemini-flash/Nova-Sonic provider spikes; Zeta Modal keep-warm (before Sinhala prod).

### Suggested skills for the next session
- `/rfc-to-sprints docs/rfc-incremental-unit-substrate.md` then `/ship-it-managed` — the RFCs' kickoffs chose
  Router D (managed adversarial delegation) for these multi-chunk architectural changes.
- `/code-understand --path packages/core/src/voice-agent-session.ts` before IU-substrate C3 — the heard-prefix
  commit wiring touches the finalize/barge-in path; understand it before the reshape.
- `/feature-build docs/rfc-half-cascade.md` — if running the half-cascade cut solo/autonomous (start at C0).
- Memory to load first: `incremental-unit-substrate-insight`, `gpt-live-validates-orchestration-thesis`,
  `latency-is-top-priority`, `manager-runs-smokes` (IC develops; manager runs live smokes).

### Not done / open
- Plandesk not wired to this repo (MCP tools absent this session). To populate tasks: `plandesk token create`
  + `claude mcp add ... http://127.0.0.1:3847/mcp/` + new session + `scaffold_project_from_plan`. One task per RFC.
- The two half-cascade provider spikes (Gemini-flash, Nova Sonic) — LiveKit-doc candidates, unverified by us.
- All new files above are UNCOMMITTED.

---

> The section below is the prior (2026-07-03) handoff — accurate for SHIPPED v4.0/v4.1 state.
> (Supersedes the 2026-07-02 version — that session's two streams shipped in v4.0.0.)

## Where the repo stands

- **v4.0.0 released to npm (2026-07-03)** — all 22 `@kuralle-syrinx/*` packages, lockstep. It ships
  the voice-engine correctness sweep + the bi-model **Responder-Thinker** delegate seam (G1 result
  envelope default-on, G2 delegate observability, G3 tool_call cues, G4 durable reasoner sessions
  + resume, G5 docs). CHANGELOG.md has the full entry.
- **v4.1.0 released to npm (2026-07-03)** — the two efforts below are PUBLISHED (additive minor):
  1. **Cascade refinement** (`cascade-refinement-implementation-notes.md`, gitignored local file):
     Deepgram **Flux** turn-aware STT adapter (semantic end-of-turn on the Workers edge; new
     `eos.retracted` packet), **speculative generation** in ReasoningBridge (opt-in
     `speculative: true`; LiveKit/Flux eager pattern; live A/B measured: saving =
     min(LLM TTFT, eager lead) — seconds on hesitant speakers, ~100ms on quick utterances),
     `turn_latency` session event (honest TTFA decomposition), nova-3 `keyterm` biasing.
     Live smokes: `smoke:flux-live`, `smoke:flux-speculative-ab` (example 02).
  2. **Background audio** (`background-audio-implementation-notes.md`, gitignored local file):
     `BackgroundAudioMixer` in server-websocket (ambient bed + thinking loop keyed off G3 cues +
     ducking + equal-power `fadeMs`), mix-under-TTS on all four outbound paths, idle comfort
     noise on edge-twilio, `withVoice({ backgroundAudio })` passthrough. Listen demo:
     `smoke:background-audio-listen` (renders mixed.wav/clean.wav via live Aura).
  (Both shipped in 4.1.0 — main and npm are in sync.)

## The plan of record (user-approved "vNext", in order)

1. ~~Release v4.0.0 + prove the delegate seam~~ DONE (live bi-model smoke passed).
2. **Half-cascade (realtime front + separate TTS)** — user-requested 2026-07-03 (LiveKit
   "Separate TTS configuration"): run the realtime model in TEXT-ONLY modality (OpenAI
   `modalities: ["text"]`; check Gemini Live equivalent) so it does native speech comprehension
   while ALL speech synthesis goes through Syrinx's own TTS pipeline. Design shape: adapter
   config `modalities`/`caps.supportsTextOnlyModality`; RealtimeBridge routes the front's text
   deltas into the existing llm.delta → segmenter → tts.text path instead of passing provider
   audio through. Syrinx-specific wins: (a) G1 faithful voicing becomes STRUCTURAL (every word
   goes through our text→TTS, no reliance on require_repeat_verbatim prompting); (b) barge-in
   uses the strong TTS playout-clock/heard-prefix machinery instead of realtime estimates;
   (c) voice control/pronunciation/multilingual (the dual-model Sinhala probe already proved the
   motivation — clean Sinhala text, code-switched audio). **LATENCY GATE (hard requirement)**:
   half-cascade v2v = front text TTFT + segmenter first-sentence wait + TTS TTFB, vs native S2S
   audio TTFT — must be MEASURED per provider (turn_latency event + an A/B smoke like
   flux-speculative-ab) before it's recommended; budget per `latency-is-top-priority` memory.
3. **Eval harness — THE next big move**: run tau2-bench/mu-bench-style tasks and publish numbers,
   now over FOUR configs: cascade / native realtime solo / realtime+delegate / half-cascade
   (+delegate). Half-cascade's latency budget gets answered by the same harness. The field's
   battleground is agentic voice benchmarks (τ-voice: best native = grok-voice-think-fast 67.3%).
   See memory `voice-ai-landscape-2026h1` + `research/competitors/sierra/`.
4. ~~Semantic end-of-turn~~ DONE early (Flux adapter, above) — but NOT yet latency-gated live.
5. SLIIT port: unblocked since v4.0.0; sibling repo `…/kuralle-suite/sliit-chatbot`; ready-to-apply
   port in `bimodel-delegate-seam-implementation-notes.md`. USER SAID DON'T TOUCH SLIIT for now.

## Open follow-ups (small, all recorded in the per-effort notes)

- Idle comfort-noise bed for the NODE telephony carriers (mark-machinery needs a per-carrier
  background-frame encoder; edge-twilio already has the bed).
- TTS `finish_timeout_ms` wedge-guard: early tts.end vs late audio ordering in the real pipeline —
  needs a repro before touching drain ordering.
- Real recorded ambience/typing assets for the demo (current ones are generated placeholders).
- 39 dependabot vulns on kuralle/syrinx default branch (pre-existing) — untriaged.
- grok-voice-think-fast front adapter (`fromGrokVoice` over openai-compatible-realtime) — assessed,
  wanted for the eval harness's "best native" baseline; not built yet.

## How to verify anything here

`pnpm -r typecheck && pnpm -r test` — only expected typecheck failure is
`examples/02-hello-voice-headless/scripts/run-studio-bargein-e2e.ts` (missing playwright-core,
pre-existing). Live smokes need the repo-root `.env` (keys are set; short fixtures per the
latency-gate memory). Provider currency + how to run live proofs: memory `ve01-live-proof-harness`.
