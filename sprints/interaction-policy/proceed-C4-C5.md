# Proceed evidence — `IP-C4` rich STT seam + `IP-C5` VapInteractionPolicy

**Verdict:** **PROCEED** (both chunks; two documented placeholder-buffer follow-ups)
**Manager:** Opus 4.8 (1M), 2026-07-10
**Commits:** `90b64ca [IP-C4]`, `be30a75 [IP-C5]` + manager guard/notes (this commit) · **Worker:** grok

## Verified (manager re-run, exit codes authoritative)
- `pnpm -r --filter './packages/*' typecheck` 0; `pnpm -r test` 0. `@kuralle-syrinx/vap` 4/4;
  `core` 256 (253 + grok's C4 tests + 1 manager guard); `deepgram` 36→37 (+wordTimings).
- **Guard tests byte-unchanged** (`turn-arbiter.test`, `characterization`); my prior C1/C2 regression guards
  still present + green.
- Proof json: 8 commands all exit 0; StubVapPredictor honestly noted (no open ONNX export of the VAP model).

## C4 — read the hunks
- `SttPartialPacket` (`stt.partial`) added; Deepgram maps `alt.words` → `{word,startMs,endMs,confidence}` and
  emits `stt.partial` **alongside** the unchanged `stt.interim`.
- **No double-drive** (the key risk): `handleSttPartial` ONLY caches `wordTimings` per context
  (`sttPartialWordTimings`, cleared on close + `turn.change`); barge-in stays driven by `stt.interim`/`.result`
  via `observeSttForBargeIn`, which now attaches the cached wordTimings to the observation. Confirmed in the
  diff + a **manager guard**: sustained `stt.partial` (no interim) during active TTS → no `interrupt.tts`.

## C5 — read the hunks
- `@kuralle-syrinx/vap` mirrors `silero-vad`: `index.ts` (`VapInteractionPolicy` + `StubVapPredictor` +
  `LocalVapPredictor`/onnxruntime-node), `workers.ts` (`WorkersVapPredictor`/onnxruntime-web via
  `model_bytes`/`model_url` — **no filesystem → CF-correct**), `vap-policy.ts` (pure decision + buffer).
- **Async/sync crux is correct:** `observe()` is synchronous — appends the frame, fire-and-forgets inference
  (guarded one-in-flight-per-context), returns a decision from the last cached probs. Thresholds match RFC §6.
  p99 ≤ 5 ms bench passes.

## Two documented follow-ups (placeholder `RollingFeatureBuffer` — NOT fixed now, by design)
The buffer is placeholder feature-extraction paired with the stub; the real VAP needs its own encoded feature
window, so this buffer is expected to be redesigned when a real checkpoint lands. Two issues flagged in
`packages/vap/README.md` ("MUST fix when wiring the real model"):
1. **O(n²) full-buffer append** (`copyWithin` per sample) — clears the dev-box gate but is a latency risk on
   the constrained edge (REQ-10). → O(1) ring buffer.
2. **Feature aliasing** — the `Float32Array` given to `predict()` is a live view mutated by later appends
   during async inference; harmless for the stub, must be a stable snapshot for a real predictor.
Both are latent (stub ignores features; no real model wired) → documented, not pre-optimized (avoids polishing
code that gets replaced). The chunk **meets its REQ-9 gate**.

## Decision
**PROCEED.** C4 rich seam is additive + no-double-drive-verified; C5 lands the VAP package + policy behind the
seam with a correct sync/async split and a CF-correct edge predictor, honestly stub-backed until a checkpoint
is exported. The two buffer issues are documented at the exact place the real-model wirer will look.
