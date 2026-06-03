---
id: LAT-05
title: LLM TTFT 200-300ms target dictates the 8-30B model sweet spot
domain: LAT
tags: [llm, ttft, model-size, inference-engine]
sources: [together-talk, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/llm/llm.py:296]
---

**Claim (one line):** The LLM latency metric that matters is TTFT (time-to-first-token); a ~200–300ms TTFT target forces the model into the 8–30B sweet spot and forces inference-engine selection by P95 TTFT, not throughput.

**Detail.** Together: "Streaming latency = TTFT. Good target ≈ **200–300ms**" — start producing tokens to feed TTS ASAP — and "this budget dictates **model size sweet spot: 8–30B params**. Bigger → burns latency budget; smaller → loses intelligence + tool-calling" (together-talk). Customers fine-tune *smaller* models on use-case data to keep tool-calling quality while staying inside the small-model latency budget. Modal picks both the model and the engine on TTFT: LLM = **Qwen3-4B-Instruct** on vLLM, chosen "as small/fast as possible while producing quality answers," and they "used the LLM Engineer's Almanac to pick the inference engine with lowest TTFT," then tuned engine + CUDA-graph compilation to cut TTFT at the expense of cold-start (modal-v2v). Modal's takeaway is explicit: "**Pick LLM inference engine by P95 TTFT, not throughput.**" LiveKit clocks TTFT exactly as first-token-minus-request-start (`llm/llm.py:296-297`, see [[LAT-02-per-stage-metrics]]) so this target is directly observable.

**Prior-art divergence.** Together's 8–30B band assumes a hosted general model; Modal goes *below* it (4B) because RAG narrows the task — model size is a function of how constrained the task is. Both agree the selection axis is TTFT/P95, diverging from throughput-optimized serving (batch inference) that maximizes tokens/sec but can hurt first-token latency.

**Implication for Syrinx.** Set a TTFT SLO (~250ms) and benchmark candidate engines on P95 TTFT under concurrency, not tokens/sec. Favor the smallest model that clears the tool-calling bar; fine-tune to shrink it.

Links: [[LAT-04-turn-budget-split]] [[LAT-02-per-stage-metrics]] [[LAT-06-hedged-requests]] [[LAT-12-tail-latency]] [[wiki/lat-map]]
