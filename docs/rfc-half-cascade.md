# RFC: Half-cascade — realtime front (text-only) + Syrinx TTS

**Category:** Architectural Change
**Author:** octalpixel
**Date:** 2026-07-09
**Status:** Implemented (C0–C4 shipped + live-verified 2026-07-11; C5 deferred — see Implementation Status below)
**Reviewers:** (maintainer)
**Related:**
- `docs/rfc-interaction-policy-seam.md` (turn-detection seam — a hard dependency; see REQ-6)
- `research/half-cascade-spike-results.md` (live go/no-go spikes — the Section 2 evidence)
- `research/full-duplex-orchestration-litreview.md` (architecture taxonomy)
- `docs/rfc-realtime-bridge.md`, `docs/rfc-bimodel-delegate-seam.md` (the RealtimeBridge + Responder-Thinker this builds on)
- LiveKit "Separate TTS configuration" (https://docs.livekit.io/agents/models/realtime/) — the prior-art mechanism
- SESSION-HANDOFF-syrinx-core-roadmap.md item #2 (the original design sketch)
- Memory: `dualmodel-sinhala-tts-probe`, `latency-is-top-priority`, `gpt-live-validates-orchestration-thesis`

---

## 1. Problem Statement

Native realtime speech-to-speech (S2S) has three limits Syrinx cannot fix from the outside:

1. **Multilingual audio is wrong.** The dual-model Sinhala probe (memory `dualmodel-sinhala-tts-probe`)
   showed gpt-realtime emits *clean Sinhala text* but **code-switches to English in the audio**. No closed
   realtime model will fix Sinhala audio for us. This is the primary driver.
2. **Faithful voicing is prompt-level, not structural.** The delegate envelope's `require_repeat_verbatim`
   nudges the front to voice the reasoner's answer, but the front still resynthesizes it and can drift.
3. **No control over synthesis** — voice, pronunciation, pacing, telephony encoding — all live inside the
   provider.

**Half-cascade** fixes all three: run the realtime front in **text-only modality** (native speech
comprehension, no audio generation) and route its text through **Syrinx's own TTS**. Success:
- Correct Sinhala audio (front text → a Sinhala TTS), verified by ear on a live smoke.
- Faithful voicing becomes **structural** — every spoken word passes through Syrinx TTS.
- Latency stays within the ~800 ms–1000 ms v2v budget for English/fast-TTS; Sinhala is an accepted
  latency-relaxed mode (native S2S produces *no* correct Sinhala, so there is no faster correct option).

### 1.1 Non-Goals / Out of Scope

- **Non-goal:** the `InteractionPolicy`/VAP turn-detection seam itself — it is a separate RFC
  (`docs/rfc-interaction-policy-seam.md`) and a **hard dependency** of C3, not built here.
- **Non-goal (v1):** non-OpenAI fronts. Half-cascade also works on Azure OpenAI (same API) and, per
  LiveKit docs, the text-capable Gemini Live model (`gemini-*-flash-live`) and Amazon Nova Sonic — but each
  is a candidate gated by its own provider spike (see §5.3), not built in v1. Gemini *native-audio* models
  are AUDIO-only (verified) and cannot half-cascade at all. Audio-native providers (xAI Grok Voice,
  Ultravox, Phonic, NVIDIA PersonaPlex) have no text-only modality and are out by design.
- **Non-goal:** replacing native S2S as the default — half-cascade is opt-in per language/config; native
  S2S stays the default path.
- **Non-goal:** full cascade (STT+LLM+TTS) — half-cascade deliberately keeps the realtime front's native
  speech comprehension (see §2.2 alternatives).
- **Deferred:** dynamic/expressive backchannel synthesis and prosody-target passing to TTS — those belong
  to the InteractionPolicy RFC's rich-typed seam, not here.
- **Deferred:** Zeta voice-pinning/cloning (reference audio + `ref_text`) — v1 uses zero-shot; pinning is a
  later config nicety.

## 2. Background

**The mechanism (LiveKit prior art, verbatim).** LiveKit calls this "Separate TTS configuration" and names
it a *"half-cascade architecture."* It is two config choices: set the realtime model to a **text-only
response modality** and attach a **separate TTS**; *"the realtime model doesn't generate audio; all speech
synthesis is handled by the configured TTS."* LiveKit flags four consequences, three of which bind us:
- **Turn detection degrades** — *"accurate turn detection relies on both VAD and context gained from
  realtime speech-to-text, which… isn't available"*; you must supply your own turn detector/STT. → This is
  the hard dependency on `docs/rfc-interaction-policy-seam.md` (REQ-6).
- **Delayed/absent interim transcription** — realtime models give no interim user transcripts in this mode.
- **Scripted/faithful output** — LiveKit *recommends* separate-TTS precisely when exact output matters
  (our faithful-voicing goal).

**Live spike evidence** (`research/half-cascade-spike-results.md`, 2026-07-09 — the go/no-go that gates this
RFC):
- **Provider: PASS.** OpenAI Realtime text-only **with tools** works on `gpt-realtime-2` and
  `gpt-realtime-2.1-mini`; the community "text-breaks-with-tools" bug does **not** reproduce; the full
  Responder-Thinker round-trip (tool call → `function_call_output` → faithful text) works in text mode.
- **Front choice:** `gpt-realtime-2.1-mini` text TTFT ≈ **359 ms**, *faster* than its own audio TTFT
  (~506 ms). Mini is the recommended half-cascade front.
- **Text event name:** output arrives as `response.output_text.delta` / `.done`.
- **Adapter gap (code):** `packages/realtime/src/openai-compatible-realtime.ts` handles
  `response.output_audio_transcript.delta` (line 309) but **not** `response.output_text.delta`. So
  `modalities:["text"]` (already wired at `from-openai-realtime.ts:78`) sets the session, yet the current
  adapter surfaces nothing spoken. This is the core code change (C0).
- **TTS latency (Zeta Sinhala, OpenAI-compatible Modal endpoint):** warm **streaming TTFB ≈ 0.78–0.94 s**
  (`stream:true`, pcm, `num_steps=8` fastest); **cold start ≈ 40–60 s** (Modal scale-to-zero) — a production
  blocker until keep-warm is set.
- **Assembled budget:** English + fast TTS (Cartesia ~0.15 s TTFB) ≈ **0.8 s** (within budget); Sinhala +
  Zeta ≈ **1.4–1.5 s** (over budget, but the only correct-Sinhala path).

**Existing plumbing that helps.** `RealtimeBridge` already emits `llm.delta`/`llm.done` from the assistant
transcript (`realtime-bridge.ts:489–504`) — today display-only. Half-cascade re-purposes that path to
*drive* TTS. `fromOpenAIRealtime` already accepts `modalities` (`from-openai-realtime.ts:30,78`). The
cascade output path (`llm.delta → segmenter → tts.text → TTS → tts.audio`) already exists.

## 3. Strict Requirements

- **REQ-1:** The OpenAI adapter surfaces text-only output — `response.output_text.delta`/`.done` emit
  `transcript` events (role `assistant`, `final` false/true), identical shape to the audio-transcript path.
- **REQ-2:** In text-only mode, `RealtimeBridge` routes assistant transcript deltas into the core path
  `llm.delta → segmenter → tts.text` (driving a registered TTS plugin), instead of the display-only emit;
  provider audio events are absent in this mode and must not be required.
- **REQ-3:** `RealtimeAdapter.caps` gains `supportsTextOnlyModality?: boolean`, set per-provider. OpenAI
  Realtime = true; Gemini **native-audio** models = false (they support only AUDIO response modality — a
  verified provider limitation).
- **REQ-4 (structural faithful voicing):** every spoken word in text-only mode is produced by Syrinx TTS
  from the front's text — no provider audio path is used.
- **REQ-5:** Barge-in in text-only mode uses Syrinx's `TtsPlayoutClock` heard-prefix machinery (the TTS is
  ours), not provider audio estimates.
- **REQ-6 (turn-detection dependency):** because the text-only front no longer generates audio and its
  native turn-taking degrades (LiveKit), turn detection MUST be supplied by Syrinx — the
  `InteractionPolicy` seam (`docs/rfc-interaction-policy-seam.md`) or, as an interim, a separate STT for
  interim transcripts + VAD. Half-cascade must not regress turn-taking vs native S2S.
- **REQ-7 (latency gate):** v2v first-audio is measured per `(front, TTS)` pair via the A/B smoke.
  English/fast-TTS must stay within the ~800–1000 ms budget; Sinhala/Zeta is an accepted relaxed mode and
  must be labelled as such (not the latency-sensitive default).
- **REQ-8 (pluggable TTS by language):** TTS is selected by config/language — a Sinhala TTS (Zeta) for `si`,
  an existing fast TTS (Cartesia/Deepgram/ElevenLabs) for others.
- **REQ-9 (dual runtime):** works on Node and Cloudflare Workers (`withVoice(Agent)`).

## 4. Interface Specification

### 4.1 caps addition
- **Location:** `packages/realtime/src/realtime-adapter.ts`
- **Add:** `readonly supportsTextOnlyModality?: boolean;` (optional; absent = false).

### 4.2 OpenAI adapter — surface text output
- **Location:** `packages/realtime/src/openai-compatible-realtime.ts` (message switch, near line 309)
- **Add cases:**
  - `response.output_text.delta` → `push({ type: "transcript", role: "assistant", text: delta, final: false })`
  - `response.output_text.done` → `push({ type: "transcript", role: "assistant", text: transcript, final: true })`
  - accumulate into the existing `assistantTranscript` buffer (same as the audio-transcript cases).
- **Behavior:** produces the same `RealtimeEvent` `transcript` shape the bridge already consumes — no new
  event type.
- **Error cases:** if both audio and text deltas arrive (misconfig), prefer text in text-only mode; log once.

### 4.3 RealtimeBridge — text-only routing
- **Location:** `packages/realtime/src/realtime-bridge.ts`
- **Signature:** `new RealtimeBridge(adapter, reasoner?, delegateToolName?, opts?)` — `opts` gains
  `readonly textOnly?: boolean` (defaults to `adapter.caps.supportsTextOnlyModality && modalities===["text"]`).
- **Behavior:** when `textOnly`, assistant `transcript` deltas are pushed as `llm.delta` (Route.Main) as they
  stream (not buffered to turn end), flow through the core segmenter to `tts.text`, and a registered TTS
  plugin produces `tts.audio`. The provider `audio` event handler is a no-op in this mode.
- **Requires:** a TTS plugin registered on the bus (the cascade TTS path). Absent → constructor throws.

### 4.4 fromOpenAIRealtime
- **Location:** `packages/realtime/src/from-openai-realtime.ts`
- Set `caps.supportsTextOnlyModality = (opts.modalities?.length === 1 && opts.modalities[0] === "text")`.

### 4.5 Zeta TTS plugin (Sinhala)
- **Location:** `packages/zeta-tts/src/index.ts` (new; mirrors an existing TTS plugin)
- **Contract:** OpenAI-compatible `POST {base}/v1/audio/speech`, body
  `{ model:"zeta", input, response_format:"pcm", stream:true, task_type:"Base", num_steps }`, 48 kHz mono
  PCM streamed; resampled to engine rate in the plugin. `num_steps` configurable (default 8 — fastest TTFB
  per spike).
- **Error cases:** 503 (Modal cold/asleep) → surface a recoverable TTS error + a one-line "cold start" log;
  keep-warm (C5) is the real fix.

## 5. Architecture and System Dependencies

### 5.1 Structural changes
```
NATIVE S2S (today)                     HALF-CASCADE (text-only front)
------------------                     ------------------------------
adapter audio events → tts.audio       adapter response.output_text.delta
   (provider synthesizes)         ==>     → transcript event
                                          → llm.delta → segmenter → tts.text
                                          → Syrinx TTS plugin (Zeta / Cartesia)
                                          → tts.audio (OUR audio, OUR playout clock)
turn-taking: provider VAD              turn-taking: Syrinx InteractionPolicy (REQ-6 dependency)
```
- **Created:** `packages/zeta-tts` (Sinhala TTS plugin); adapter `output_text` cases; bridge `textOnly` mode.
- **Reused:** the entire cascade output path (segmenter → tts.text → TTS → tts.audio); `TtsPlayoutClock`.
- **Deleted:** nothing — text-only is opt-in; native S2S remains the default.

### 5.2 Dependencies
- **Hard:** `docs/rfc-interaction-policy-seam.md` for turn detection (REQ-6). Half-cascade built on today's
  endpointing would ship a turn-taking regression (LiveKit's documented failure mode).
- **Infra:** Zeta Modal keep-warm (`min_containers=1`) before Sinhala production (spike: 40–60 s cold start).

### 5.3 Provider matrix

Half-cascade is a per-provider **capability** (REQ-3 `caps.supportsTextOnlyModality`), not an OpenAI
special-case. Survey of the eight LiveKit realtime providers (2026-07-09):

| Front | text-only modality | half-cascade | confidence |
|---|---|---|---|
| OpenAI `gpt-realtime-2.1-mini` (recommended v1) | yes | supported | CONFIRMED — live spike |
| OpenAI `gpt-realtime-2` | yes (input rate ≥ 24 kHz) | supported | CONFIRMED — live spike |
| Azure OpenAI Realtime | yes (same API) | supported | high (identical API) |
| Gemini Live text-capable (`gemini-*-flash-live`) | yes (`modalities:["TEXT"]`) | candidate | medium — spike first |
| Gemini Live native-audio | **no** (AUDIO-only) | not supported | high (verified) |
| Amazon Nova Sonic 2.0 | reportedly yes | candidate | low — verify (ambiguous) |
| xAI Grok Voice / Ultravox / Phonic / NVIDIA PersonaPlex | **no** (audio-native) | not supported | medium (LiveKit docs) |

v1 targets OpenAI (proven by our own live spike). Gemini-flash and Nova Sonic are candidate additional
fronts, each gated by its own one-hour provider spike (same shape as
`research/half-cascade-spike-results.md`) before adoption. Only OpenAI is verified here; the rest are read
from LiveKit plugin docs.

### 5.4 Performance
Budget assembled in spike results; A/B smoke enforces REQ-7. English/fast-TTS ≈ 0.8 s (in budget); Sinhala
/Zeta ≈ 1.4–1.5 s (relaxed mode). Streaming (`stream:true`) is mandatory; non-streaming (~2 s TTFB) is not.

## 6. Pseudocode

```
# openai-compatible adapter — new cases
CASE "response.output_text.delta":
    assistantTranscript += delta
    push(transcript{role:assistant, text:delta, final:false})
CASE "response.output_text.done":
    push(transcript{role:assistant, text: transcript || assistantTranscript, final:true})
    assistantTranscript = ""

# RealtimeBridge — on assistant transcript when textOnly
ON transcript(assistant, delta, final):
    IF textOnly:
        push Route.Main llm.delta{contextId, text: delta}     # DRIVE the TTS path (stream as it arrives)
        IF final: push Route.Main llm.done{contextId, text}
    ELSE:
        buffer for display-only (today's behavior)
ON provider audio event:
    IF textOnly: ignore
    ELSE: push tts.audio (today)

# Zeta TTS plugin — on tts.text
ON tts.text(sentence):
    POST /v1/audio/speech {model:zeta, input:sentence, response_format:pcm, stream:true, num_steps:8}
    FOR chunk IN streamed_pcm: push tts.audio(resample(chunk, 48k→engineRate))
```

## 7. Code Blueprint

```ts
// openai-compatible-realtime.ts — add near the audio_transcript cases
case "response.output_text.delta": {
  const delta = msg["delta"];
  if (typeof delta === "string" && delta.length > 0) {
    this.assistantTranscript += delta;
    this.stream.push({ type: "transcript", role: "assistant", text: delta, final: false });
  }
  break;
}
case "response.output_text.done": {
  const t = typeof msg["text"] === "string" ? msg["text"] : this.assistantTranscript;
  this.stream.push({ type: "transcript", role: "assistant", text: t, final: true });
  this.assistantTranscript = "";
  break;
}
```
```ts
// realtime-bridge.ts — in the "transcript" assistant branch (currently buffers for display)
if (this.opts.textOnly) {
  bus.push(Route.Main, { kind: "llm.delta", contextId: this.contextId, timestampMs: Date.now(), text: ev.text });
  if (ev.final) bus.push(Route.Main, { kind: "llm.done", contextId: this.contextId, timestampMs: Date.now(), text: ev.text });
} else { /* existing display-only accumulation */ }
```
Spike-confirmed event names and the `modalities:["text"]` config path (`from-openai-realtime.ts:78`) make
C0 low-risk. The Zeta plugin follows an existing TTS plugin's structure; the streaming contract is taken
verbatim from the live spike (`research/half-cascade-spike-results.md`).

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C0 | Adapter surfaces text-only output: `response.output_text.delta`/`.done` → transcript events; `caps.supportsTextOnlyModality` | `packages/realtime/src/openai-compatible-realtime.ts`, `from-openai-realtime.ts`, `realtime-adapter.ts` | REQ-1,3; spike | Unit test: text deltas emit assistant `transcript` events; live: `modalities:["text"]` session surfaces spoken text |
| C1 | `RealtimeBridge` `textOnly` routing: transcript deltas → `llm.delta` → segmenter → `tts.text`; suppress audio path; require TTS plugin | `packages/realtime/src/realtime-bridge.ts` | REQ-2,4,5 | Test: in textOnly, assistant deltas produce `tts.text`; provider audio ignored; throws without a TTS plugin |
| C2 | `@kuralle-syrinx/zeta-tts` plugin (OpenAI-compat streaming pcm, 48 k→engine resample, `num_steps` config) | `packages/zeta-tts/src/*` (new) | REQ-8; spike | Live: Sinhala text → streamed audio; warm TTFB logged; 503 surfaces recoverable error |
| C3 | Turn-detection wiring (dependency): consume `InteractionPolicy` for endpointing in text-only; interim fallback = Deepgram STT for interim transcripts + VAD | `packages/core/*`, `packages/realtime/*` | REQ-6; `rfc-interaction-policy-seam` | Turn-taking parity vs native S2S on a multi-turn smoke (no early cut-offs) |
| C4 | Latency A/B smoke: half-cascade vs native per `(front, TTS)`; `turn_latency` decomposition | `examples/02-hello-voice-headless/scripts/*` | REQ-7 | Produces v2v TTFA per config; English/fast-TTS within budget asserted |
| C5 | Zeta keep-warm (Modal `min_containers=1`) — infra prereq for Sinhala prod | Modal deploy config | REQ-7; spike | No 40–60 s cold start on first call after idle |

- [x] **C0** adapter text-only output (unblocks everything; spike-confirmed)
- [x] **C1** bridge text-only routing
- [x] **C2** TTS plugin (shipped as the generic `@kuralle-syrinx/openai-tts`, not `zeta-tts` — see below)
- [x] **C3** turn-detection dependency (Syrinx-owned turns via InteractionPolicy)
- [x] **C4** latency A/B smoke (live proofs; English ~0.8–1.6s, Sinhala relaxed)
- [ ] **C5** Zeta keep-warm (infra / deploy — deferred, see below)

## Implementation Status (2026-07-11)

Shipped on branch `feat/half-cascade` (unmerged; not yet released):

- **C0** (`realtime`) — `response.output_text.delta/.done` → assistant transcript events;
  `caps.supportsTextOnlyModality`.
- **C1** (`realtime-bridge.ts`) — `textOnly` streams the front's text into
  `llm.delta → segmenter → tts.text`; suppresses provider audio; the **TTS plugin owns `tts.end`**
  (REQ-5). A live-testing bug (double-emit / forced `tts.end`) was caught and fixed.
- **C2** — **Q1 resolved: generic OpenAI-compatible TTS plugin, not a Zeta-specific one.**
  `@kuralle-syrinx/openai-tts` (`OpenAICompatibleTTSPlugin`) speaks any `POST /v1/audio/speech`
  endpoint via `base_url` + `extra_body`, mirroring `livekit-plugins-openai` / Pipecat
  `OpenAITTSService`. Zeta is proprietary/internal → a **documented config** (README + the example
  smokes: `base_url`=Modal, `model:"zeta"`, `source_sample_rate_hz:48000`,
  `extra_body:{task_type,num_steps}`), never a `fromZeta` factory and no internal URL in package source.
- **C3** (`realtime-adapter`/`bridge`) — `adapter.requestResponse()` (commit + `response.create`) +
  bridge `syrinxTurns`: Syrinx's `eos.turn_complete` drives the front (server VAD off). Live-proven:
  provider stays silent until Syrinx signals.
- **C4** — live smokes (`smoke:half-cascade-oneturn` / `-syrinx-turns` / `-sinhala` / `-conversation`
  / `-multiturn`). English + Sinhala single- and multi-turn conversations verified (context carried
  across turns; structural faithful voicing via Syrinx TTS confirmed by provider attribution + STT).
- **Adjacent fixes:** `tts-core` finish-timeout made **inactivity-based** (a fixed 2s timer was
  truncating long half-cascade turns mid-sentence); `openai-tts` **WSOLA `tempo`** control
  (pitch-preserving time-stretch) for Sinhala pacing.

### C5 — Zeta keep-warm (deferred, infra gate)
The Zeta endpoint runs on **Modal Flash** (traffic-driven autoscaler, GPU memory-snapshot restore,
`.modal.direct` URL). When scaled to zero it returns **503 fail-fast** rather than cold-booting on
request; the autoscaler brings a container up on sustained traffic (a `GET /v1/models` nudge wakes it).
Production Sinhala therefore needs the **Flash autoscaler minimum ≥ 1** — a config on the Zeta Modal app
(the `asyncdotengineering` infra, not this repo), plus/or a pre-warm nudge for dev. This is a deploy +
ongoing-GPU-cost gate.

## 9. Validation and Testing

### 9.0 Validation contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1 | §3 | text deltas surface as assistant transcript events (unit) |
| REQ-2/4 | §3 | textOnly drives `tts.text`; no provider audio used |
| REQ-6 | §3 | turn-taking parity vs native S2S (no early cut-offs) on multi-turn |
| REQ-7 | §3 | v2v TTFA per `(front,TTS)`; English/fast-TTS within budget |
| test:adapter-output-text | §9.1 | fail-to-pass unit for C0 |
| cmd:smoke-half-cascade-sinhala | §9.3 | live Sinhala half-cascade renders correct audio |

### 9.1 Fail-to-pass tests
- `openai-compatible-realtime.test.ts` — `response.output_text.delta`/`.done` → transcript events.
- `realtime-bridge.test.ts` — textOnly routes deltas to `llm.delta`/`tts.text`; ignores provider audio;
  throws without a TTS plugin.
- `zeta-tts.test.ts` — request shape (`stream:true`, pcm, `num_steps`); 503 → recoverable error.

### 9.2 Regression
- `pnpm -r typecheck && pnpm -r test` (known pre-existing playwright-core failure excepted).
- Native S2S smokes unchanged (text-only is opt-in).

### 9.3 Validation commands
```bash
# graduate the spike into a repo smoke (provider text+tools):
pnpm --filter @kuralle-syrinx/examples smoke:half-cascade-oai-textmode
# live Sinhala half-cascade (front text -> Zeta -> audio), ear-verified:
pnpm --filter @kuralle-syrinx/examples smoke:half-cascade-sinhala-listen
# latency A/B vs native S2S (short fixture per latency-gate memory):
SYRINX_WS_MAX_TURNS=1 pnpm --filter @kuralle-syrinx/examples smoke:half-cascade-latency-ab
```
### 9.4 Live evidence already captured
`research/half-cascade-spike-results.md` — provider PASS (both models), Zeta streaming TTFB ~0.8 s warm,
cold-start 40–60 s. C4 formalizes this into a repeatable smoke.

## 10. Security Considerations
No new external attack surface beyond the Zeta endpoint (own infra, Modal). Handle any Zeta auth key via env
(same posture as other provider keys in `.env`). Text-only mode reduces provider-side audio handling.

## 11. Rollback and Abort Criteria
- **Rollback:** text-only is opt-in via `modalities`/`textOnly`; default remains native S2S — revert = don't
  set it. No data migration.
- **Abort C3 if:** turn-taking cannot reach parity with native S2S without the InteractionPolicy seam —
  then half-cascade waits on that RFC (do not ship a turn-taking regression).
- **Abort Sinhala production if:** Zeta keep-warm (C5) is not in place — a 40–60 s cold start on first call
  is unacceptable for live calls.
- **Symptom-patch stop:** if faithful voicing "works" only by re-adding `require_repeat_verbatim` prompting
  rather than structurally through Syrinx TTS, stop — that defeats the RFC's purpose.

## 12. Open Questions
- **Q1 — Zeta as an OpenAI-compat TTS plugin vs a bespoke adapter?** Tradeoff: reuse vs precision.
  **Proposal:** OpenAI-compat TTS plugin — the endpoint *is* `/v1/audio/speech`; the spike proved the shape.
- **Q2 — Ship C3 behind InteractionPolicy, or with an interim separate-STT turn detector now?** Tradeoff:
  wait vs a temporary path. **Proposal:** prefer InteractionPolicy; if half-cascade is needed before that
  lands, ship the LiveKit-documented interim (Deepgram STT interim transcripts + VAD) and delete it when
  InteractionPolicy arrives (no dual shape kept long-term).
- **Q3 — Gemini half-cascade?** Tradeoff: coverage vs the native-audio text-only limitation. **Proposal:**
  OpenAI-only in v1; `caps.supportsTextOnlyModality=false` for Gemini native-audio; revisit with
  `gemini-2.0-flash-live`.
- **Q4 — Zeta `num_steps` quality/latency default?** **Proposal:** default 8 (fastest TTFB per spike);
  expose as config; tune for quality per deployment.
- **Q5 — Language→TTS routing?** **Proposal:** config maps language/mode → TTS plugin (Zeta for `si`,
  Cartesia/Aura for others); default non-`si` to the existing fast TTS to stay within budget.

## Risks
- **Turn-taking regression** (REQ-6) — the top risk; mitigated by sequencing behind InteractionPolicy and
  the C3 parity gate.
- **Zeta cold start** (40–60 s) — production blocker until keep-warm (C5).
- **Latency for Sinhala** (~1.4–1.5 s) — over budget; accepted as a relaxed mode because native S2S has *no*
  correct-Sinhala alternative; must be labelled, not defaulted.
- **Provider drift** — OpenAI text-mode+tools works today (spike); pin the smoke as a regression guard in
  case a future model reintroduces the text-with-tools bug.

### Alternatives considered
- **Keep native S2S + prompt for faithful voicing / accept English-only.** Rejected: does not fix Sinhala
  audio (the primary driver) and leaves voicing non-structural.
- **Full cascade (STT+LLM+TTS).** Rejected for this use: loses the realtime front's native speech
  comprehension; half-cascade keeps comprehension while owning synthesis.
- **Wait for a provider to fix multilingual audio.** Rejected: no closed model will prioritize Sinhala; this
  is Syrinx's moat precisely because they won't.
