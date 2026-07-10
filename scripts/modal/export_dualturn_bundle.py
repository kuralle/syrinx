"""Build the licensed DualTurn ONNX bundle on Modal.

Run with:
    modal run scripts/modal/export_dualturn_bundle.py

Artifacts are persisted in the ``syrinx-vap-models`` Modal Volume. No model
weights are committed to the Syrinx repository.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import modal


app = modal.App("syrinx-dualturn-export")
volume = modal.Volume.from_name("syrinx-vap-models", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "huggingface_hub==0.36.0",
    "onnx==1.19.1",
    "onnxruntime==1.23.2",
    "safetensors==0.6.2",
    "torch==2.8.0",
)

DUALTURN_REPO = "anyreach-ai/dualturn-qwen2.5-mimi-0.5B"
DUALTURN_REVISION = "d7abba2c0c8d1ab8e992879c6a186384e00f94cb"
MIMI_REPO = "maai-kyoto/continuous-mimi-onnx"
MIMI_REVISION = "58ec3bc5f381eb84e0e97bc5a2a15cbe703c8a94"


@app.function(image=image, volumes={"/artifacts": volume}, cpu=4, memory=16384, timeout=3600)
def export_bundle() -> dict[str, object]:
    import onnx
    import onnxruntime as ort
    import numpy as np
    import torch
    import torch.nn as nn
    import time
    from huggingface_hub import hf_hub_download
    from safetensors import safe_open

    root = Path("/artifacts/dualturn-qwen2.5-mimi-0.5B")
    root.mkdir(parents=True, exist_ok=True)

    def download(repo: str, filename: str, revision: str) -> Path:
        return Path(
            hf_hub_download(
                repo_id=repo,
                filename=filename,
                revision=revision,
                local_dir=root,
            )
        )

    backbone_graph = download(DUALTURN_REPO, "onnx/model.onnx", DUALTURN_REVISION)
    backbone_data = download(DUALTURN_REPO, "onnx/model.onnx_data", DUALTURN_REVISION)
    weights_path = download(DUALTURN_REPO, "model.safetensors", DUALTURN_REVISION)
    mimi_model = download(MIMI_REPO, "continuous_mimi_fp32.onnx", MIMI_REVISION)
    mimi_metadata = download(MIMI_REPO, "continuous_mimi_fp32.json", MIMI_REVISION)

    patched_backbone = root / "onnx" / "model-inputs-embeds.onnx"
    _patch_backbone_inputs(onnx, backbone_graph, patched_backbone)

    class Projection(nn.Module):
        def __init__(self, tensors: dict[str, torch.Tensor]) -> None:
            super().__init__()
            self.proj = nn.Sequential(nn.Linear(1024, 896), nn.GELU(), nn.Linear(896, 896))
            self.proj[0].weight.data.copy_(tensors["mimi_projection.proj.0.weight"])
            self.proj[0].bias.data.copy_(tensors["mimi_projection.proj.0.bias"])
            self.proj[2].weight.data.copy_(tensors["mimi_projection.proj.2.weight"])
            self.proj[2].bias.data.copy_(tensors["mimi_projection.proj.2.bias"])

        def forward(self, user_features: torch.Tensor, assistant_features: torch.Tensor) -> torch.Tensor:
            return self.proj(torch.cat([user_features, assistant_features], dim=-1))

    class SparseHead(nn.Module):
        def __init__(self, prefix: str, tensors: dict[str, torch.Tensor]) -> None:
            super().__init__()
            self.layers = nn.Sequential(
                nn.Linear(896, 256),
                nn.GELU(),
                nn.Dropout(0.1),
                nn.Linear(256, 1),
            )
            self.layers[0].weight.data.copy_(tensors[f"{prefix}.0.weight"])
            self.layers[0].bias.data.copy_(tensors[f"{prefix}.0.bias"])
            self.layers[3].weight.data.copy_(tensors[f"{prefix}.3.weight"])
            self.layers[3].bias.data.copy_(tensors[f"{prefix}.3.bias"])

        def forward(self, hidden: torch.Tensor) -> torch.Tensor:
            return self.layers(hidden).squeeze(-1)

    class TurnHeads(nn.Module):
        def __init__(self, tensors: dict[str, torch.Tensor]) -> None:
            super().__init__()
            self.eot_user = SparseHead("eot_head_ch0", tensors)
            self.eot_assistant = SparseHead("eot_head_ch1", tensors)
            self.bot_user = SparseHead("bot_head_ch0", tensors)
            self.bot_assistant = SparseHead("bot_head_ch1", tensors)
            self.hold_user = SparseHead("hold_head_ch0", tensors)
            self.hold_assistant = SparseHead("hold_head_ch1", tensors)
            self.bc_user = SparseHead("bc_head_ch0", tensors)
            self.bc_assistant = SparseHead("bc_head_ch1", tensors)

        @staticmethod
        def pair(first: torch.Tensor, second: torch.Tensor) -> torch.Tensor:
            return torch.sigmoid(torch.stack([first, second], dim=-1))

        def forward(self, hidden_states: torch.Tensor) -> tuple[torch.Tensor, ...]:
            return (
                self.pair(self.eot_user(hidden_states), self.eot_assistant(hidden_states)),
                self.pair(self.bot_user(hidden_states), self.bot_assistant(hidden_states)),
                self.pair(self.hold_user(hidden_states), self.hold_assistant(hidden_states)),
                self.pair(self.bc_user(hidden_states), self.bc_assistant(hidden_states)),
            )

    required = [
        "mimi_projection.proj.0.weight",
        "mimi_projection.proj.0.bias",
        "mimi_projection.proj.2.weight",
        "mimi_projection.proj.2.bias",
    ]
    for event in ("eot", "bot", "hold", "bc"):
        for channel in ("ch0", "ch1"):
            for suffix in ("0.weight", "0.bias", "3.weight", "3.bias"):
                required.append(f"{event}_head_{channel}.{suffix}")
    with safe_open(weights_path, framework="pt", device="cpu") as handle:
        tensors = {name: handle.get_tensor(name) for name in required}

    projection = Projection(tensors).eval()
    heads = TurnHeads(tensors).eval()
    projection_path = root / "projection.onnx"
    heads_path = root / "turn-heads.onnx"
    torch.onnx.export(
        projection,
        (torch.zeros(1, 1, 512), torch.zeros(1, 1, 512)),
        projection_path,
        input_names=["user_features", "assistant_features"],
        output_names=["inputs_embeds"],
        dynamic_axes={
            "user_features": {1: "frames"},
            "assistant_features": {1: "frames"},
            "inputs_embeds": {1: "frames"},
        },
        opset_version=17,
    )
    torch.onnx.export(
        heads,
        torch.zeros(1, 1, 896),
        heads_path,
        input_names=["hidden_states"],
        output_names=["eot_probs", "bot_probs", "hold_probs", "bc_probs"],
        dynamic_axes={name: {1: "frames"} for name in (
            "hidden_states", "eot_probs", "bot_probs", "hold_probs", "bc_probs"
        )},
        opset_version=17,
    )

    for path in (patched_backbone, projection_path, heads_path, mimi_model):
        onnx.checker.check_model(str(path), full_check=False)

    projection_session = ort.InferenceSession(str(projection_path), providers=["CPUExecutionProvider"])
    projected = projection_session.run(
        None,
        {
            "user_features": torch.zeros(1, 1, 512).numpy(),
            "assistant_features": torch.zeros(1, 1, 512).numpy(),
        },
    )[0]
    heads_session = ort.InferenceSession(str(heads_path), providers=["CPUExecutionProvider"])
    head_outputs = heads_session.run(None, {"hidden_states": projected})
    assert projected.shape == (1, 1, 896)
    assert all(output.shape == (1, 1, 2) for output in head_outputs)

    mimi_spec = json.loads(mimi_metadata.read_text())
    mimi_session = ort.InferenceSession(str(mimi_model), providers=["CPUExecutionProvider"])
    mimi_inputs = {
        "wave_24k": np.zeros((1, 1, 1920), np.float32),
        "cache_position": np.arange(mimi_spec["cache_position_len"], dtype=np.int64),
        "position_ids": np.arange(mimi_spec["cache_position_len"], dtype=np.int64),
    }
    for index, shape in enumerate(mimi_spec["contract"]["spec"]["padding_cache_shapes"]):
        mimi_inputs[f"pad_cache_{index}"] = np.zeros(tuple(shape), np.float32)
    for index, shape in enumerate(mimi_spec["contract"]["spec"]["past_key_value_shapes"]):
        mimi_inputs[f"past_{index}"] = np.zeros(tuple(shape), np.float32)
    started = time.perf_counter()
    mimi_outputs = mimi_session.run(None, mimi_inputs)
    mimi_ms = (time.perf_counter() - started) * 1000
    mimi_features = mimi_outputs[0]
    if mimi_features.shape[-1] != 512 and mimi_features.shape[1] == 512:
        mimi_features = mimi_features.transpose(0, 2, 1)
    if mimi_features.shape[-1] != 512:
        raise RuntimeError(f"Unexpected Mimi feature shape: {mimi_features.shape}")
    projected = projection_session.run(None, {
        "user_features": mimi_features,
        "assistant_features": mimi_features,
    })[0]

    backbone_session = ort.InferenceSession(str(patched_backbone), providers=["CPUExecutionProvider"])
    frames = projected.shape[1]
    backbone_inputs = {
        "inputs_embeds": projected,
        "attention_mask": np.ones((1, frames), np.int64),
        "position_ids": np.arange(frames, dtype=np.int64).reshape(1, -1),
    }
    for layer in range(24):
        backbone_inputs[f"past_key_values.{layer}.key"] = np.zeros((1, 2, 0, 64), np.float32)
        backbone_inputs[f"past_key_values.{layer}.value"] = np.zeros((1, 2, 0, 64), np.float32)
    started = time.perf_counter()
    backbone_outputs = backbone_session.run(None, backbone_inputs)
    backbone_ms = (time.perf_counter() - started) * 1000
    pipeline_outputs = heads_session.run(None, {"hidden_states": backbone_outputs[0]})
    if not all(np.isfinite(output).all() for output in pipeline_outputs):
        raise RuntimeError("DualTurn end-to-end smoke emitted non-finite probabilities")

    manifest = {
        "format": "syrinx.dualturn.onnx.v1",
        "frame_rate_hz": 12.5,
        "sample_rate_hz": 24000,
        "context_frames": 62,
        "files": {
            "mimi_model": mimi_model.name,
            "mimi_metadata": mimi_metadata.name,
            "projection": projection_path.name,
            "backbone": str(patched_backbone.relative_to(root)),
            "backbone_data": "onnx/model-inputs-embeds.onnx_data",
            "heads": heads_path.name,
        },
        "probability_mapping": {
            "pShift": "max(eot_probs[user], bot_probs[user])",
            "pBackchannel": "bc_probs[user]",
            "pHold": "hold_probs[user]",
        },
        "sources": [
            {
                "repo": DUALTURN_REPO,
                "revision": DUALTURN_REVISION,
                "license": "Apache-2.0",
            },
            {
                "repo": MIMI_REPO,
                "revision": MIMI_REVISION,
                "license": "CC-BY-4.0",
                "attribution": "Continuous Mimi ONNX by the MAAI Kyoto team, derived from Kyutai Mimi.",
            },
        ],
    }
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    (root / "NOTICE.md").write_text(
        "# Model notices\n\n"
        "- DualTurn-Qwen2.5-Mimi-0.5B by Anyreach AI, Apache-2.0.\n"
        "- Continuous Mimi ONNX by the MAAI Kyoto team, CC-BY-4.0, derived from Kyutai Mimi.\n"
    )
    for source_only in (backbone_graph, backbone_data, weights_path):
        source_only.unlink(missing_ok=True)
    shutil.rmtree(root / ".cache", ignore_errors=True)
    volume.commit()
    return {
        "artifact_dir": str(root),
        "mimi_shape": list(mimi_features.shape),
        "mimi_ms": mimi_ms,
        "backbone_ms": backbone_ms,
        "projection_shape": list(projected.shape),
        "head_shapes": [list(output.shape) for output in pipeline_outputs],
        "probabilities": [output.reshape(-1).tolist() for output in pipeline_outputs],
        "manifest": manifest,
    }


def _patch_backbone_inputs(onnx: object, source: Path, destination: Path) -> None:
    model = onnx.load(str(source), load_external_data=False)
    graph = model.graph
    gather = next(
        node for node in graph.node
        if node.op_type == "Gather" and "model.embed_tokens.weight" in node.input
    )
    gathered = gather.output[0]
    for node in graph.node:
        for index, value in enumerate(node.input):
            if value == gathered:
                node.input[index] = "inputs_embeds"
    graph.node.remove(gather)
    for graph_input in list(graph.input):
        if graph_input.name == "input_ids":
            graph.input.remove(graph_input)
    graph.input.insert(0, onnx.helper.make_tensor_value_info(
        "inputs_embeds", onnx.TensorProto.FLOAT, ["batch", "sequence", 896]
    ))
    external_name = "model-inputs-embeds.onnx_data"
    (destination.parent / external_name).unlink(missing_ok=True)
    onnx.save_model(
        model,
        str(destination),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=external_name,
        size_threshold=1024,
        convert_attribute=False,
    )


@app.local_entrypoint()
def main() -> None:
    print(json.dumps(export_bundle.remote(), indent=2))
