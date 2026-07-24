# Testing & baseline runbook

How to verify a change, run the smokes, and establish/re-establish the latency baselines in this monorepo (25 `@kuralle-syrinx/*` packages). Grounded in the actual scripts + CI.

---

## 0. TL;DR — the verify command

```bash
pnpm -r --filter './packages/*' typecheck   # what CI runs (scoped to published packages)
pnpm -r test                                 # all package unit suites (vitest)
```

- **This is the green baseline for every change.** No keys needed; fast.
- **Known caveat:** the *unscoped* `pnpm -r typecheck` has ONE pre-existing failure — `examples/02-hello-voice-headless/scripts/run-studio-bargein-e2e.ts` (missing `playwright-core`). CI avoids it by scoping to `./packages/*`. When you run the unscoped version, that one failure is expected; anything else is a regression.
- Per-package: `pnpm --filter @kuralle-syrinx/core test` / `… typecheck`.

## 1. CI (`.github/workflows/ci.yml`)

Runs on **push to `main`** and **every PR**: `pnpm install --frozen-lockfile` → `pnpm -r --filter './packages/*' typecheck` → `pnpm -r test`. Node 22. **No live smokes in CI** (no provider keys) — smokes are run locally / by the manager (see §4/§5). A red CI = a real unit/typecheck regression.

## 2. The three levels of testing

| Level | Keys? | Speed | What it proves |
|-------|-------|-------|----------------|
| **Unit** (`pnpm -r test`) | no | seconds | correctness of every exported surface (happy + failure path); the regression baseline |
| **Live smokes** (`smoke:*`) | yes (`.env`) | seconds–minutes, costs credits | the feature works end-to-end against real providers |
| **Latency baselines** (gates) | yes | minutes, costs credits | the measured latency vs the recorded baseline |

## 3. Manager-verify discipline (why green tests ≠ done)

Passing unit tests are necessary, **not sufficient**. Every subtle bug this codebase's vNext work hit (speculative mid-stream promotion; the two reasoner composites hanging on a rejecting backend) **passed the author's green tests** — they were caught by:

1. **Re-run the claimed commands yourself** — exit codes are authoritative, not a worker's summary.
2. **Read the diff** (the hunks), not the transcript.
3. **Build a repro for the untested path** — the timing/concurrency case the suite skipped. Promote a confirmed repro to a permanent regression guard.

For a delegated change: re-run `pnpm --filter <pkg> test`, read the diff, and if it touches streaming/concurrency/turn-boundaries, write the adversarial case (interrupt mid-stream, a throwing backend, a barge-in during promotion) and confirm it before accepting.

## 4. Live smokes

`.env` at the repo root holds the keys (present today): `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY` (+ `CARTESIA_VOICE_ID`), `ELEVENLABS_API_KEY` (+ id), `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`. Run: `pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:<name>`.

**Credit discipline:** use the short fixture `SYRINX_WS_MAX_TURNS=1` on multi-turn smokes; run the minimum repeats (latency gates: ≥3 for the network-noisy LLM leg).

Catalog by area (keys each needs):

- **Cascade v2v** (OPENAI + DEEPGRAM + CARTESIA): `smoke:university-support`, `smoke:websocket-interactive`, `smoke:websocket-university`, `smoke:kuralle-cascade-clean`, `smoke:kuralle-full-text`, `smoke:latency-filler`, `smoke:flux-live`, `smoke:flux-speculative-ab`.
- **Realtime / bi-model** (OPENAI, or provider key): `smoke:realtime-oneturn`, `smoke:realtime-university`, `smoke:realtime-bargein`, `smoke:realtime-frame`, `smoke:realtime-kuralle-bimodel`, `smoke:realtime-sinhala-tts`. Gemini variants (`smoke:realtime-gemini-*`) need `GEMINI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`; Grok (`smoke:grok-realtime`/`grok-stt`/`grok-tts`) need `XAI_API_KEY`.
- **Telephony** (emulators need the LLM/STT/TTS keys, not carrier creds): **`smoke:telnyx-emulator`** (the P0 multi-turn guard — must reach turn 2+), `smoke:twilio-emulator`, `smoke:smartpbx-emulator`. Live carrier calls (`smoke:telnyx-carrier-call`, `smoke:twilio-carrier-call`, `smoke:telephony-university-live`) need carrier config + a reachable number.
- **Browser transport**: `smoke:browser-runtime`, `smoke:browser-client-reconnect`, `smoke:browser-opus-uplink`, `smoke:browser-jitter`.
- **Audio/recorder/eval**: `smoke:background-audio-listen`, `smoke:live-recorder-coherence`, `smoke:eva-bench-examiner`, `smoke:kuralle-memory`, `smoke:gemini-translate`.

## 5. Latency baselines (the gates)

The SLO band + measured baselines live in **[`latency-budget.md`](latency-budget.md)** — that doc IS the recorded baseline; each latency change appends a new dated section to gate against.

### 5.1 Reasoner-leg gate (cheap, the composites' domain)
```bash
pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:reasoner-latency-gate
```
Measures LLM-TTFT for plain vs `HedgedReasoner` vs `RoutingReasoner` vs composed. Knobs: `SYRINX_LLM_MODEL` (deep, default `gpt-4.1-mini`), `SYRINX_LLM_FAST_MODEL` (default `gpt-4.1-nano`), `SYRINX_HEDGE_AFTER_MS` (300), `SYRINX_BENCH_RUNS` (10, 1 warmup discarded). **Full procedure + caveats: [`rfc-reasoner-latency-amendment.md`](rfc-reasoner-latency-amendment.md) §4.**

### 5.2 Full v2v gate
```bash
SYRINX_WS_MAX_TURNS=1 pnpm --filter @kuralle-syrinx-example/02-hello-voice-headless smoke:websocket-interactive
```
Read the `turn_latency` event for the v2v decomposition (STT-final + LLM-TTFT + TTS-TTFB). Inject a composed reasoner via the `withVoice({ reasoner })` factory to gate a composed config.

### 5.3 Establishing / re-establishing a baseline
1. Run the relevant gate **≥3×** (the LLM leg is network-noisy — see `latency-budget.md` S1-00).
2. Record the pre-change P50/P95 as the **denominator**; append it to `latency-budget.md` (a new dated section).
3. **The rule (RFC §7a):** a post-change result **above** the recorded band that isn't explained by provider noise (re-run ×3) is a **hard-flag regression** — reject, do not merge. The `Reasoner` seam is a structural passthrough; the failure mode the gate protects against is accidental buffering (which balloons TTFT to full-generation time).

## 6. What "done" means here

A change is done when: the unit suite is green (`pnpm -r test`), the touched surface has a happy + failure-path test, the relevant live smoke was observed working (not just types), any latency-sensitive change was gated against the recorded baseline, and — for streaming/turn-boundary code — an adversarial repro was written for the timing case the happy-path tests skip. No `--no-verify`, `@ts-ignore`, or silenced catches.
