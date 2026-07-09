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