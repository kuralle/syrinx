# @kuralle-syrinx/vap

Voice Activity Projection (`VapInteractionPolicy`) for Syrinx turn-taking behind the interaction-policy seam.

## Predictors

| Class | Runtime | Model source |
|-------|---------|--------------|
| `StubVapPredictor` | Any | Deterministic placeholder for tests and integration without a checkpoint |
| `LocalVapPredictor` | Node (`onnxruntime-node`) | DualTurn bundle at `bundle_path` / `model_path` or `packages/vap/models/dualturn` |
| `WorkersVapPredictor` | Workers (`onnxruntime-web`) | `model_bytes` or `model_url` config |

## Local DualTurn bundle

Build the bundle remotely with:

```bash
modal run scripts/modal/export_dualturn_bundle.py
```

The script persists weights in the `syrinx-vap-models` Modal Volume. A local bundle directory contains:

- `manifest.json` and `NOTICE.md`
- Continuous Mimi ONNX + metadata (MAAI Kyoto, CC-BY-4.0; attribution in `NOTICE.md`)
- DualTurn projection and all turn heads exported from its Apache-2.0 safetensors
- a patched DualTurn Qwen backbone that consumes `inputs_embeds`, plus its external data file

The published DualTurn ONNX is only the Qwen backbone. Its upstream example accepts an `embeds` argument but
still feeds token IDs, so it is not audio-dependent as written. The Modal export replaces the embedding lookup
with a real `inputs_embeds` graph input before the bundle is accepted.

## Async/sync split

`observe()` stays synchronous: it snapshots PCM and serializes `push(frame)` calls per `contextId`, while reading
the latest cached probabilities. `LocalVapPredictor` owns per-context Mimi and Qwen causal state. User audio is
channel 0 and assistant PCM attached to `playout_tick` is channel 1. Decisions may lag inference by one frame.
Pass `semanticTranscriptFusion` as `fuseTranscript` to arm the C6 VAP+STT policy variant; transcript state is
scoped and reset with the same `contextId` as predictor state.

## Model sourcing status

No model weights are committed. Use `StubVapPredictor` until the attributed bundle is exported and made available
at the configured path. The Node predictor maps `max(user EOT, user BOT)` to `pShift`, user BC to
`pBackchannel`, and user HOLD to `pHold`.

## Ring-buffer invariant

`RollingFeatureBuffer` writes through a ring cursor and exposes only chronological copies via `snapshot()`.
The policy also copies every predictor frame before enqueueing it. Async inference therefore never observes a
typed-array view being mutated by a later audio frame.
