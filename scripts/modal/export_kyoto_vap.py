"""Export the MIT Kyoto MC-VAP Mimi head to ONNX on Modal.

The export consumes Continuous Mimi embeddings. Encoder weights remain in the
separate CC-BY-4.0 artifact and are not folded into this MIT head graph.
"""

from __future__ import annotations

import json
from pathlib import Path

import modal


app = modal.App("syrinx-kyoto-vap-export")
volume = modal.Volume.from_name("syrinx-vap-models", create_if_missing=True)
base_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "huggingface_hub==0.36.0",
    "onnx==1.19.1",
    "onnxruntime==1.23.2",
    "safetensors==0.6.2",
    "torch==2.8.0",
)
image = (
    base_image
    .apt_install("git")
    .pip_install("einops==0.8.1", "transformers==5.5.3")
    .pip_install(
        "git+https://github.com/MaAI-Kyoto/MaAI.git@3b36533692931e62190a65168498c87f48cc2e78",
        extra_options="--no-deps",
    )
)

MODEL_REPO = "maai-kyoto/vap_mc_en_kyoto"
MODEL_REVISION = "01b948b6db91bbcedb9b105ecdcf77ed70e11474"
MODEL_FILE = "vap_mc_mimi_state_dict_en_kyoto_12.5hz_20000msec.pt"
MAAI_REVISION = "3b36533692931e62190a65168498c87f48cc2e78"


@app.function(image=image, volumes={"/artifacts": volume}, cpu=4, memory=16384, timeout=3600)
def export_kyoto_vap() -> dict[str, object]:
    import onnx
    import onnxruntime as ort
    import site
    import sys
    import torch
    import torch.nn as nn
    import types
    from huggingface_hub import hf_hub_download

    maai_root = next(Path(path) / "maai" for path in site.getsitepackages() if (Path(path) / "maai").is_dir())
    maai_package = types.ModuleType("maai")
    maai_package.__path__ = [str(maai_root)]
    sys.modules["maai"] = maai_package
    from maai.models.config import VapConfig
    from maai.models.vap import VapGPT

    root = Path("/artifacts/vap-mc-en-kyoto")
    root.mkdir(parents=True, exist_ok=True)
    checkpoint = Path(hf_hub_download(
        repo_id=MODEL_REPO,
        filename=MODEL_FILE,
        revision=MODEL_REVISION,
        local_dir=root,
    ))

    config = VapConfig(frame_hz=12.5, encoder_type="mimi", context_limit=250)
    model = VapGPT(config)
    model.decrease_dimension = nn.Linear(512, config.dim)
    raw = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state = raw.get("state_dict", raw) if isinstance(raw, dict) else raw
    head_state = {
        key: value for key, value in state.items()
        if not key.startswith(("encoder.", "zero_shot."))
    }
    missing, unexpected = model.load_state_dict(head_state, strict=False)
    missing_non_encoder = [key for key in missing if not key.startswith(("encoder1.", "encoder2."))]
    if missing_non_encoder or unexpected:
        raise RuntimeError(
            f"Kyoto VAP state mismatch: missing={missing_non_encoder[:8]} unexpected={unexpected[:8]}"
        )
    model.eval()

    class KyotoVapHead(nn.Module):
        def __init__(self, vap: VapGPT) -> None:
            super().__init__()
            self.decrease = vap.decrease_dimension
            self.channel = vap.ar_channel
            self.cross = vap.ar
            self.vap_head = vap.vap_head
            states = vap.objective.codebook.emb.weight.reshape(256, 2, 4)
            self.register_buffer("now_states", states[:, :, 0:2].sum(dim=-1))
            self.register_buffer("future_states", states[:, :, 2:4].sum(dim=-1))

        def aggregate(self, probs: torch.Tensor, states: torch.Tensor) -> torch.Tensor:
            aggregate = torch.einsum("bid,dc->bic", probs, states)
            return aggregate / (aggregate.sum(dim=-1, keepdim=True) + 1e-5)

        def forward(self, user_features: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
            user = self.decrease(user_features)
            assistant = self.decrease(torch.zeros_like(user_features))
            user_channel = self.channel(user)["x"]
            assistant_channel = self.channel(assistant)["x"]
            cross = self.cross(user_channel, assistant_channel)["x"]
            probs = torch.softmax(self.vap_head(cross), dim=-1)
            return self.aggregate(probs, self.now_states), self.aggregate(probs, self.future_states)

    head = KyotoVapHead(model).eval()
    sample = torch.zeros(1, 250, 512)
    output_path = root / "vap-mc-en-kyoto-head.onnx"
    with torch.no_grad():
        torch_outputs = head(sample)
    torch.onnx.export(
        head,
        sample,
        output_path,
        input_names=["user_features"],
        output_names=["p_now", "p_future"],
        dynamic_axes={
            "user_features": {1: "frames"},
            "p_now": {1: "frames"},
            "p_future": {1: "frames"},
        },
        opset_version=17,
    )
    onnx.checker.check_model(str(output_path), full_check=False)
    session = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    ort_outputs = session.run(None, {"user_features": sample.numpy()})
    max_abs_error = max(
        float(abs(torch_output.numpy() - ort_output).max(initial=0))
        for torch_output, ort_output in zip(torch_outputs, ort_outputs)
    )
    if max_abs_error > 1e-4:
        raise RuntimeError(f"Kyoto VAP ONNX parity failed: max_abs_error={max_abs_error}")

    manifest = {
        "format": "syrinx.kyoto-vap.onnx.v1",
        "frame_rate_hz": 12.5,
        "context_frames": 250,
        "feature_dimension": 512,
        "file": output_path.name,
        "outputs": {
            "p_now": "[batch, frames, speaker(user=0, assistant=1)]",
            "p_future": "[batch, frames, speaker(user=0, assistant=1)]",
            "pShift": "p_now[..., assistant]",
            "pHold": "p_now[..., user]",
        },
        "source": {
            "repo": MODEL_REPO,
            "revision": MODEL_REVISION,
            "file": MODEL_FILE,
            "license": "MIT",
            "maai_code_revision": MAAI_REVISION,
        },
        "encoder": {
            "repo": "maai-kyoto/continuous-mimi-onnx",
            "license": "CC-BY-4.0",
            "bundled_separately": True,
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    volume.commit()
    return {
        "artifact": str(output_path),
        "max_abs_error": max_abs_error,
        "output_shapes": [list(output.shape) for output in ort_outputs],
        "manifest": manifest,
    }


@app.local_entrypoint()
def main() -> None:
    print(json.dumps(export_kyoto_vap.remote(), indent=2))
