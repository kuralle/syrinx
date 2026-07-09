# Story Brief — `IP-C4-C5` rich STT seam (C4) + `@kuralle-syrinx/vap` VapInteractionPolicy (C5)

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If anything
> contradicts disk, **STOP** → `.handoff/blocked-ip-c4c5.md`.
>
> **Branch:** `plan/ip-vap` (already checked out; off `beta`, has the IP-C1+C2 seam). **Commits:** TWO atomic
> commits — `[IP-C4] rich STT seam (wordTimings)` then `[IP-C5] @kuralle-syrinx/vap VapInteractionPolicy`.
> No push, no main. **Proof:** `.handoff/proof-ip-c4c5.json`. **Do NOT run any live smoke.**

## 0. Context you must load first
1. `docs/rfc-interaction-policy-seam.md` §4.1 (`InteractionPolicy`/`InteractionObservation` — already built),
   §4.2 (`VapInteractionPolicy`), §4.5 (`SttPartialPacket`), §6 (VAP pseudocode), §8 C4/C5, §9, §11 (abort).
2. `packages/core/src/interaction-policy.ts` — the seam. **`observe(obs): readonly InteractionDecision[]` is
   SYNCHRONOUS by design (REQ-9 latency). `InteractionObservation` already has `stt_partial`/`audio_frame`
   kinds with an optional `wordTimings?`. `WordTiming { word; startMs; endMs; confidence }` is exported.**
3. `packages/core/src/policies/rule-based.ts` + `interaction-coordinator.ts` — how a policy plugs in.
4. `packages/silero-vad/src/{index.ts,workers.ts,vad-state-machine.ts}` + `package.json` — **the exact
   packaging pattern to mirror**: `index.ts` (Node, `onnxruntime-node`) + `workers.ts` (edge,
   `onnxruntime-web`, model bytes via `model_url`/`model_bytes`) + a shared state module so Node/Workers
   never drift; `package.json` exports `.` and `./workers`.
5. `packages/pipecat-smart-turn/src/index.ts` — `LocalSmartTurnV3Predictor`: ONNX `InferenceSession.create`,
   `async predict(audio): Promise<number>`, bundled model at `../models/*.onnx`. **Note inference is ASYNC.**
6. `packages/deepgram/src/stt.ts` — where `stt.interim`/`stt.result` are pushed (~line 504-524) and where the
   provider alternative is parsed (~line 300). Deepgram alternatives carry a `words` array
   (`{ word, start, end, confidence, punctuated_word }`, start/end in **seconds**).
7. `packages/core/src/packets.ts` — `SttInterimPacket`/`SttResultPacket` shapes; where to add the new packet.

---

## PART A — `[IP-C4]` rich STT seam (wordTimings). Commit this FIRST, prove it green, then Part B.

Goal: give the seam optional word-level timings for the VAP consumer, **additively and without changing
barge-in behavior** (RuleBased ignores them; the existing `stt.interim`→barge-in path is untouched).

### A1. New packet — `packages/core/src/packets.ts`
```ts
export interface SttPartialPacket {
  readonly kind: "stt.partial";
  readonly contextId: string;
  readonly timestampMs: number;
  readonly text: string;
  readonly wordTimings?: readonly WordTiming[];   // import WordTiming from interaction-policy.ts
}
```
Add `"stt.partial"` to the packet-kind union and export the type. Add a factory in `packet-factories.ts`
mirroring the `sttInterim` factory.

### A2. Deepgram emits it — `packages/deepgram/src/stt.ts`
Where the interim alternative is handled, ALSO push a `stt.partial` (Route.Main) carrying the same text
plus `wordTimings` mapped from `alt.words`: `{ word, startMs: start*1000, endMs: end*1000, confidence }`.
Emit it **alongside** the existing `stt.interim` (do NOT remove or change `stt.interim`). If `alt.words` is
absent, omit `wordTimings` (still emit the packet, or skip — your call, document it).

### A3. Thread wordTimings to the observation WITHOUT double-driving barge-in — `voice-agent-session.ts`
The session must NOT drive barge-in from both `stt.interim` and `stt.partial`. Keep barge-in exactly as
today (driven by `stt.interim`/`stt.result` via `observeSttForBargeIn`). Add a **cache**: subscribe to
`stt.partial`, store the latest `wordTimings` per `contextId` (a `Map<string, readonly WordTiming[]>`,
cleared on `turn.change`/close alongside the other per-turn state). In `observeSttForBargeIn`, attach the
cached `wordTimings` for that context onto the `stt_partial`/`stt_final` observation it already builds. Net:
one barge-in flow (unchanged) + observations now carry wordTimings when available.

### A4. Tests (C4)
- `packets`/factory unit test for `stt.partial`.
- `deepgram` test: a provider message with `words` → a `stt.partial` with mapped `wordTimings` (ms), and
  `stt.interim` still emitted unchanged.
- `voice-agent-session.test.ts` (additive `it`): after a `stt.partial` with wordTimings, the next barge-in
  observation carries those wordTimings — assert via a tiny spy policy, OR assert no behavior change +
  that a `stt.partial` is handled without error. Barge-in characterization + existing suites **unchanged**.
- Green: `pnpm --filter @kuralle-syrinx/core test` + `... deepgram test` + both typechecks, exit 0.

**Commit `[IP-C4] rich STT seam (wordTimings)`. Then Part B.**

---

## PART B — `[IP-C5]` `@kuralle-syrinx/vap` VapInteractionPolicy.

Goal: a learned frame-incremental turn-taking controller behind the seam, selectable like RuleBased/Defer.
**Turn-scoped only** — the full-duplex/no-boundary mode is BLOCKED on backlog B-05 (do NOT attempt it).

### B1. The async/sync reconciliation (the crux — implement exactly)
ONNX inference is async (`Promise`), but `InteractionPolicy.observe()` is SYNC and must stay ≤5 ms p99
(REQ-9). So **decouple inference from the decision read**:
- `VapInteractionPolicy` keeps a rolling PCM feature buffer. On each `audio_frame` observation it appends
  the frame (cheap) and, if no inference is in flight, **kicks an async inference** (fire-and-forget) that
  updates a cached `{ pShift, pBackchannel, pHold }`.
- `observe()` is SYNC: it appends the frame, maybe kicks inference, then returns a decision computed from
  the **latest cached probabilities** (thresholds per RFC §6 pseudocode: `pShift>SHIFT_TH && ttsActive →
  interrupt`; `pBackchannel>BC_TH && delegateInFlight → backchannel`; `pShift>TAKE_TH → take_turn`;
  `pHold>HOLD_TH → hold`; else `keep_listening`). No `await` on the hot path → observe stays ≤5 ms.
- This means decisions lag inference by ~one frame — acceptable and standard for frame-incremental VAP.

### B2. Pluggable predictor (no real checkpoint is in the repo — this is a real dependency)
Define `VapPredictor { initialize(cfg): Promise<void>; predict(features: Float32Array): Promise<VapProbs>; close(): Promise<void> }`
where `VapProbs = { pShift: number; pBackchannel: number; pHold: number }`.
- `LocalVapPredictor` (Node, `onnxruntime-node`) + `WorkersVapPredictor` (`onnxruntime-web`), mirroring
  silero-vad, loading a VAP ONNX checkpoint from `../models/` (Node) or `model_url`/`model_bytes` (Workers).
- **Model sourcing:** try to source an open VAP checkpoint (Ekstedt & Skantze Voice Activity Projection —
  search GitHub for an exported ONNX; the original is PyTorch). If you can obtain + bundle one, wire the
  real I/O and document its input feature shape + output mapping in the package README. **If you cannot
  obtain a real ONNX checkpoint in this run, DO NOT fake results** — ship a `StubVapPredictor` (deterministic,
  documented as a placeholder) so the package + policy + tests + latency bench are complete and green, and
  write the model-sourcing gap into `.handoff/blocked-ip-c4c5.md` as a NOTE (not a full block — Part B still
  lands with the stub). The real checkpoint slots into `VapPredictor` with zero policy changes.

### B3. Package structure (mirror silero-vad exactly)
`packages/vap/` — `package.json` (`@kuralle-syrinx/vap`, exports `.`/`./workers`, deps `onnxruntime-node`
+ `onnxruntime-web` pinned to the versions silero-vad uses, `@kuralle-syrinx/core`), `tsconfig`, `src/index.ts`
(`VapInteractionPolicy` + `LocalVapPredictor` + `StubVapPredictor`), `src/workers.ts` (`WorkersVapPredictor`),
`src/vap-policy.ts` (shared decision logic, so Node/Workers never drift), `README.md`. Register the package
in the workspace (`pnpm-workspace.yaml` if needed) and the root tsconfig references if that pattern is used.

### B4. Tests (C5)
- `vap-policy.test.ts`: feed frames + a StubVapPredictor with scripted probabilities → assert each threshold
  path yields the right `InteractionDecision`; `observe` returns the cached decision synchronously;
  `delegateInFlight` gates backchannel; `ttsActive` gates interrupt.
- **Latency bench** (REQ-9): a test that calls `observe({audio_frame})` N times and asserts the synchronous
  path p99 ≤ 5 ms (measure with the injectable clock / `performance.now`; the ASYNC inference is excluded —
  only the sync observe path is gated). If a StubVapPredictor is used, the bench still validates the sync
  path cost (buffer append + threshold read).
- Green: `pnpm --filter @kuralle-syrinx/vap test` + typecheck exit 0; full `pnpm -r --filter './packages/*'
  typecheck` + `pnpm -r test` exit 0 (only the known pre-existing example playwright failure is allowed).

**Commit `[IP-C5] @kuralle-syrinx/vap VapInteractionPolicy`.**

## Constraints (both parts)
- Behavior-preserving: do NOT change RuleBased/Defer/coordinator/arbiter behavior; do NOT edit existing
  characterization tests. The new policy is additive/selectable.
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch, raw `setTimeout` on the hot path, or FAKED model
  outputs presented as real.
- Latency: `observe()` stays synchronous and cheap. Inference is off the hot path.

## Proof
`.handoff/proof-ip-c4c5.json`: `commands_run` (each `{command, exit_code}` — the test/typecheck commands
above), `claims[]` (each with a `type`), `satisfies_assertions` =
`["REQ-5","REQ-7","REQ-9","test:stt-partial","test:vap-thresholds","test:vap-latency-bench"]`,
`files_changed`, `demo_artifact` (save the vap test output to `sprints/interaction-policy/artifacts/ip-c5.txt`),
`notes` (MUST state clearly whether a real VAP ONNX checkpoint was sourced+wired or a StubVapPredictor was
used, and why). Two commits as specified. Exit — no PR.

## If stuck
- Can't keep barge-in behavior unchanged while adding wordTimings → STOP, `.handoff/blocked-ip-c4c5.md`.
- Can't make `observe()` stay sync+cheap with async inference → STOP, describe the exact obstacle.
- No real VAP checkpoint obtainable → this is NOT a full block: ship with `StubVapPredictor` + a NOTE (see B2).
