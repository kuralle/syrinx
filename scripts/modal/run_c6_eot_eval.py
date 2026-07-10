"""Run the C6 EoT policy frontier on licensed model artifacts via Modal."""

from __future__ import annotations

import io
import json
import math
import re
import time
from pathlib import Path

import modal


app = modal.App("syrinx-c6-eot-eval")
volume = modal.Volume.from_name("syrinx-vap-models", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.12").apt_install("git").pip_install(
    "datasets==4.0.0",
    "huggingface_hub==0.36.0",
    "onnxruntime==1.23.2",
    "pandas==2.3.2",
    "pyarrow==21.0.0",
    "scikit-learn==1.7.1",
    "scipy==1.16.1",
    "soundfile==0.13.1",
    "transformers==4.57.6",
    "git+https://github.com/livekit/eot-bench.git@0c6c86768921bb44eee64f9b9b3427689dceeeaa",
)

EOT_DATA_REVISION = "35a1aec3f859527a0eb1dd6d22f6146e4ca3e2e5"
SMART_TURN_REVISION = "f766f81d3cfdf7737ac64aad813d91bbfd56bf93"
SCORE_POINT_S = 0.2
INFERENCE_INTERVAL_S = 0.1


@app.function(image=image, volumes={"/artifacts": volume}, cpu=8, memory=24576, timeout=7200)
def run_eval(limit: int = 32) -> dict[str, object]:
    import numpy as np
    import onnxruntime as ort
    import pandas as pd
    import soundfile as sf
    from datasets import Audio, load_dataset
    from eot_harness.metrics import compute_metrics_from_predictions
    from huggingface_hub import hf_hub_download
    from scipy.signal import resample_poly
    from transformers import WhisperFeatureExtractor

    if limit <= 0:
        raise ValueError("limit must be positive")
    bundle = Path("/artifacts/dualturn-qwen2.5-mimi-0.5B")
    kyoto = Path("/artifacts/vap-mc-en-kyoto")
    for required in (bundle / "manifest.json", kyoto / "manifest.json"):
        if not required.exists():
            raise FileNotFoundError(f"Required exported artifact is missing: {required}")

    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = 4
    session_options.inter_op_num_threads = 1
    mimi = MimiEncoder(bundle, ort, np, session_options)
    dualturn = DualTurnRunner(bundle, ort, np, session_options)
    kyoto_session = ort.InferenceSession(
        str(kyoto / "vap-mc-en-kyoto-head.onnx"),
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )
    smart_model = hf_hub_download(
        "pipecat-ai/smart-turn-v3",
        "smart-turn-v3.2-cpu.onnx",
        revision=SMART_TURN_REVISION,
    )
    smart_session = ort.InferenceSession(
        smart_model,
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )
    feature_extractor = WhisperFeatureExtractor(
        feature_size=80,
        sampling_rate=16000,
        hop_length=160,
        n_fft=400,
        n_samples=128000,
        nb_max_frames=800,
    )

    dataset = load_dataset(
        "livekit/eot-bench-data",
        "en",
        split=f"validation[:{limit}]",
        revision=EOT_DATA_REVISION,
    ).cast_column("audio", Audio(decode=False))
    arms: dict[str, list[dict[str, object]]] = {
        "silero+smartturn+rules": [],
        "kyoto-vap": [],
        "kyoto-vap+stt": [],
        "dualturn": [],
    }
    started = time.perf_counter()
    total_audio_s = 0.0
    total_spans = 0

    for row_number, row in enumerate(dataset):
        audio, sample_rate = decode_audio(row["audio"], sf, np)
        if sample_rate != 16000:
            audio = resample_poly(audio, 16000, sample_rate).astype(np.float32)
        total_audio_s += len(audio) / 16000
        audio_24k = resample_poly(audio, 3, 2).astype(np.float32)
        user_features = mimi.encode(audio_24k)
        assistant_features = mimi.encode(np.zeros_like(audio_24k))
        dualturn_scores = dualturn.predict(user_features, assistant_features)

        spans = list(row["silence_spans"])
        for span_index, span in enumerate(spans):
            start = float(span["start"])
            end = float(span["end"])
            duration = end - start
            if duration < 0.1 - 1e-6:
                continue
            total_spans += 1
            timestamp = min(end, start + SCORE_POINT_S)
            sample_end = min(len(audio), int(math.floor(timestamp * 16000 + 1e-6)))
            smart_score = smart_turn_score(
                audio[:sample_end], smart_session, feature_extractor, np,
            )
            transcript = visible_transcript(row.get("words") or [], timestamp - 0.5)
            cheap_score = semantic_fusion(smart_score, transcript)
            frame_index = max(0, min(len(user_features) - 1, int(math.floor(timestamp * 12.5))))
            context_start = max(0, frame_index - 249)
            kyoto_features = user_features[context_start:frame_index + 1, :]
            if len(kyoto_features) < 250:
                kyoto_features = np.pad(
                    kyoto_features,
                    ((250 - len(kyoto_features), 0), (0, 0)),
                )
            kyoto_output = kyoto_session.run(None, {
                "user_features": kyoto_features[None, :, :].astype(np.float32),
            })[0]
            kyoto_score = float(kyoto_output[0, -1, 1])
            dualturn_score = float(dualturn_scores[min(frame_index, len(dualturn_scores) - 1)])
            scores = {
                "silero+smartturn+rules": cheap_score,
                "kyoto-vap": kyoto_score,
                "kyoto-vap+stt": semantic_fusion(kyoto_score, transcript),
                "dualturn": dualturn_score,
            }
            label = "eot" if span_index == len(spans) - 1 else "hold"
            for arm, score in scores.items():
                arms[arm].extend(prediction_grid(
                    row_id=str(row["id"]),
                    span_index=span_index,
                    label=label,
                    start=start,
                    end=end,
                    score=score,
                ))
        print(f"row {row_number + 1}/{limit}", flush=True)

    summaries: dict[str, object] = {}
    for arm, rows in arms.items():
        _, summary = compute_metrics_from_predictions(
            pd.DataFrame(rows),
            score_point_s=SCORE_POINT_S,
        )
        safe_summary = json_safe(summary, np)
        safe_summary["full_duplex_bench_style"] = full_duplex_bench_style(safe_summary)
        summaries[arm] = safe_summary

    cheap_latency = latency_at_five_percent(summaries["silero+smartturn+rules"])
    fused_latency = latency_at_five_percent(summaries["kyoto-vap+stt"])
    cheap_auc = float(summaries["silero+smartturn+rules"].get("auc", math.nan))
    fused_auc = float(summaries["kyoto-vap+stt"].get("auc", math.nan))
    fund = (
        math.isfinite(fused_latency)
        and math.isfinite(cheap_latency)
        and fused_latency <= cheap_latency - 100
        and fused_auc >= cheap_auc
    )
    result = {
        "benchmark": {
            "name": "livekit/eot-bench-data",
            "revision": EOT_DATA_REVISION,
            "language": "en",
            "rows": limit,
            "spans": total_spans,
            "audio_seconds": total_audio_s,
            "score_point_s": SCORE_POINT_S,
            "license": "CC-BY-4.0",
            "silence_source": (
                "gold silence spans stand in for the existing Silero VAD trigger; "
                "no additional VAD weights are downloaded"
            ),
        },
        "runtime_seconds": time.perf_counter() - started,
        "arms": summaries,
        "verdict": {
            "fund": fund,
            "rule": "fund only if VAP+STT cuts latency@5% false-cutoff by >=100ms without AUC regression",
            "cheap_latency_at_5pct_ms": cheap_latency * 1000,
            "vap_stt_latency_at_5pct_ms": fused_latency * 1000,
            "cheap_auc": cheap_auc,
            "vap_stt_auc": fused_auc,
            "status": "fund" if fund else "properly-dormant",
        },
        "unavailable": {
            "Krisp-AI/turn-taking-test-v1": (
                "HF access is gated, no HF_TOKEN is configured, and its license text returns HTTP 401; "
                "no data was downloaded or evaluated."
            ),
        },
    }
    output = Path(f"/artifacts/eval/c6-eot-en-{limit}.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
    volume.commit()
    return result


class MimiEncoder:
    def __init__(self, bundle: Path, ort, np, options) -> None:
        self.ort = ort
        self.np = np
        self.metadata = json.loads((bundle / "continuous_mimi_fp32.json").read_text())
        self.session = ort.InferenceSession(
            str(bundle / "continuous_mimi_fp32.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    def encode(self, audio_24k):
        np = self.np
        spec = self.metadata["contract"]["spec"]
        padding_shapes = spec["padding_cache_shapes"]
        past_shapes = spec["past_key_value_shapes"]
        states = [np.zeros(tuple(shape), np.float32) for shape in padding_shapes + past_shapes]
        cp_len = int(self.metadata["cache_position_len"])
        max_past = int(self.metadata["max_past_len"])
        cache_position = 0
        position = 0
        features = []
        for start in range(0, len(audio_24k), 1920):
            wave = audio_24k[start:start + 1920]
            if len(wave) < 1920:
                wave = np.pad(wave, (0, 1920 - len(wave)))
            feeds = {
                "wave_24k": wave.reshape(1, 1, 1920).astype(np.float32),
                "cache_position": (np.arange(cp_len, dtype=np.int64) + cache_position) % max_past,
                "position_ids": np.arange(position, position + cp_len, dtype=np.int64),
            }
            for index, state in enumerate(states[:len(padding_shapes)]):
                feeds[f"pad_cache_{index}"] = state
            for index, state in enumerate(states[len(padding_shapes):]):
                feeds[f"past_{index}"] = state
            outputs = self.session.run(None, feeds)
            embedding = outputs[0]
            if embedding.shape[-1] != 512 and embedding.shape[1] == 512:
                embedding = embedding.transpose(0, 2, 1)
            features.append(embedding[0])
            cp_out = outputs[1].reshape(-1)
            cache_position = int(cp_out[-1]) % max_past if len(cp_out) else (cache_position + cp_len) % max_past
            position += cp_len
            states = list(outputs[2:])
        return np.concatenate(features, axis=0).astype(np.float32)


class DualTurnRunner:
    def __init__(self, bundle: Path, ort, np, options) -> None:
        self.ort = ort
        self.np = np
        self.projection = ort.InferenceSession(str(bundle / "projection.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        self.backbone = ort.InferenceSession(str(bundle / "onnx/model-inputs-embeds.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        self.heads = ort.InferenceSession(str(bundle / "turn-heads.onnx"), sess_options=options, providers=["CPUExecutionProvider"])

    def predict(self, user_features, assistant_features):
        np = self.np
        past = None
        position = 0
        scores = []
        for start in range(0, len(user_features), 3):
            user = user_features[None, start:start + 3, :]
            assistant = assistant_features[None, start:start + 3, :]
            embeds = self.projection.run(None, {"user_features": user, "assistant_features": assistant})[0]
            frames = embeds.shape[1]
            past_length = 0 if past is None else past[0].shape[2]
            feeds = {
                "inputs_embeds": embeds,
                "attention_mask": np.ones((1, past_length + frames), np.int64),
                "position_ids": np.arange(position, position + frames, dtype=np.int64).reshape(1, -1),
            }
            for layer in range(24):
                feeds[f"past_key_values.{layer}.key"] = np.zeros((1, 2, 0, 64), np.float32) if past is None else past[layer * 2]
                feeds[f"past_key_values.{layer}.value"] = np.zeros((1, 2, 0, 64), np.float32) if past is None else past[layer * 2 + 1]
            outputs = self.backbone.run(None, feeds)
            head_outputs = self.heads.run(None, {"hidden_states": outputs[0]})
            eot, bot = head_outputs[0], head_outputs[1]
            scores.extend(np.maximum(eot[0, :, 0], bot[0, :, 0]).tolist())
            past = [value[:, :, -62:, :] for value in outputs[1:]]
            position += frames
        return np.asarray(scores, np.float32)


def decode_audio(value, sf, np):
    if value.get("bytes") is not None:
        array, sample_rate = sf.read(io.BytesIO(value["bytes"]), dtype="float32")
    else:
        path = value.get("path")
        array, sample_rate = sf.read(path, dtype="float32")
    if array.ndim > 1:
        array = array.mean(axis=1)
    return np.asarray(array, np.float32), int(sample_rate)


def smart_turn_score(audio, session, extractor, np) -> float:
    model_audio = np.zeros(128000, np.float32)
    tail = audio[-128000:]
    model_audio[-len(tail):] = tail
    features = extractor(
        model_audio,
        sampling_rate=16000,
        return_tensors="np",
        padding="max_length",
        max_length=128000,
        truncation=True,
        do_normalize=True,
    ).input_features.astype(np.float32)
    outputs = session.run(None, {"input_features": features})
    return float(outputs[0].reshape(-1)[0])


def visible_transcript(words, effective_time: float) -> str:
    return " ".join(
        str(word["word"]).strip()
        for word in words
        if float(word["end"]) <= effective_time + 1e-6 and str(word["word"]).strip()
    )


def semantic_fusion(model_score: float, transcript: str) -> float:
    text = " ".join(transcript.strip().split())
    if not text:
        return model_score
    incomplete = re.search(
        r"\b(and|but|or|so|because|if|when|while|although|since|unless|until|the|a|an|to|for|of|in|on|at|with|about|from|by|please|just|also|then|well|um|uh|i|we|you|my|your|our|this)$",
        text,
        re.IGNORECASE,
    ) or text.endswith(",")
    if incomplete:
        return min(model_score, 0.49)
    if re.search(r"[.!?][\"')]*$", text):
        return max(model_score, 0.90)
    return model_score


def prediction_grid(*, row_id: str, span_index: int, label: str, start: float, end: float, score: float):
    count = max(1, int(math.floor((end - start) / INFERENCE_INTERVAL_S + 1e-6)))
    durations = [round(index * INFERENCE_INTERVAL_S, 6) for index in range(count + 1)]
    if durations[-1] < end - start - 1e-6:
        durations.append(round(end - start, 6))
    return [{
        "id": row_id,
        "language": "en",
        "span_index": span_index,
        "timestamp": round(start + duration, 6),
        "silence_dur": duration,
        "p_eot": float(score),
        "label": label,
    } for duration in durations]


def latency_at_five_percent(summary: dict[str, object]) -> float:
    point = summary.get("operating_points", {}).get("5pct")
    return math.nan if point is None else float(point["mean_latency"])


def full_duplex_bench_style(summary: dict[str, object]) -> dict[str, float]:
    """Project the official EoT frontier onto Syrinx's shipped FDB-style contract."""
    point = summary.get("operating_points", {}).get("5pct") or {}
    return {
        "turnTakingTimingScore": float(summary.get("auc", 0.0)) * 100,
        "overlapScore": (1 - float(point.get("cutoff_rate", 1.0))) * 100,
        "avgResponseLatencyMs": float(point.get("mean_latency", math.nan)) * 1000,
    }


def json_safe(value, np):
    if isinstance(value, dict):
        return {str(key): json_safe(item, np) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item, np) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


@app.local_entrypoint()
def main(limit: int = 32) -> None:
    print(json.dumps(run_eval.remote(limit), indent=2))
