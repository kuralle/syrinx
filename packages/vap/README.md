# @kuralle-syrinx/vap

Voice Activity Projection (`VapInteractionPolicy`) for Syrinx turn-taking behind the interaction-policy seam.

## Predictors

| Class | Runtime | Model source |
|-------|---------|--------------|
| `StubVapPredictor` | Any | Deterministic placeholder for tests and integration without a checkpoint |
| `LocalVapPredictor` | Node (`onnxruntime-node`) | `model_path` config or `packages/vap/models/vap.onnx` |
| `WorkersVapPredictor` | Workers (`onnxruntime-web`) | `model_bytes` or `model_url` config |

## ONNX I/O contract (when a checkpoint is bundled)

- **Input:** `features` float32 tensor shaped `[1, N]` — rolling normalized PCM from `audio_frame` observations (16 kHz mono int16 → float32 / 32768).
- **Output:** scalar tensors `p_shift`, `p_backchannel`, `p_hold` (aliases `pShift` / `pBackchannel` / `pHold` also accepted).

Map an exported Ekstedt & Skantze VAP checkpoint to these names before dropping it at `models/vap.onnx`. The upstream project ships PyTorch `.pt` weights only; no official ONNX export is bundled in this repository yet.

## Async/sync split

`observe()` stays synchronous: it appends audio to a rolling buffer, fire-and-forgets ONNX inference when idle, and reads the latest cached probabilities. Decisions may lag inference by ~one frame.

## Model sourcing status

No VAP ONNX checkpoint is bundled. Use `StubVapPredictor` until a checkpoint is exported and placed at `models/vap.onnx` (Node) or supplied via Workers config. Policy thresholds and decision mapping are unchanged when swapping predictors.

## MUST fix when wiring the real model (placeholder `RollingFeatureBuffer`)

The current `RollingFeatureBuffer` is a **placeholder** paired with `StubVapPredictor`; it passes the
`observe()` p99 ≤ 5 ms bench on dev hardware but has two issues to resolve when the real VAP model + its
actual feature pipeline are wired (the real Ekstedt & Skantze VAP does not consume raw 16 kHz samples — it
needs its own encoded feature window, so this buffer is expected to be redesigned then):

1. **O(n²) full-buffer append.** When the buffer is full, `append` shifts via `copyWithin` **per sample**
   (~20 MB of memcpy per 20 ms frame at 16 k capacity). It clears the dev-box gate but is a latency risk on
   the slower/constrained Workers edge (REQ-10). Replace with an O(1) ring-buffer write pointer.
2. **Feature aliasing.** The feature `Float32Array` handed to `predict()` is a live view mutated by later
   `append` calls during the async inference. Harmless for `StubVapPredictor` (ignores features); a **real**
   predictor must be given a stable snapshot (copy) for the duration of the async `run()`.

Both are latent today (stub ignores features; no real model is wired), which is why they are documented here
rather than pre-optimized — but they are load-bearing the moment a real predictor lands.