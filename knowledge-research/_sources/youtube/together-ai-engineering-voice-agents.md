# Engineering Voice Agents at Scale — Rishabh, Together AI (voice AI lead)
Source: https://www.youtube.com/watch?v=N7b1PJc7SFc  (conference talk; raw transcript in N7b1PJc7SFc.raw.json)
Speaker: Rishabh (ex-cofounder/CEO of Refuel, acquired by Together AI). Together = "AI-native cloud" (training + inference at scale).

## Why voice is hard — it's an AND problem (solve all simultaneously)
1. **Real-time:** humans respond to each other's cues in ~**300ms**. If AI takes >**500ms** you notice; **1–2s → people hang up.**
2. **Smart enough:** complex workflows, ambiguous instructions, must be good at **tool calling** (how agents touch the real world). Baseline intelligence floor.
3. **Natural enough voice:** right language/accent, pronounce names, deliver appropriate emotion.
4. **Reliable at scale:** a 1-person demo ≠ 100/1k/10k concurrent calls.

## Dominant pattern: pipeline / cascading architecture
Audio chunks streamed from user → **agent orchestrator** (Pipecat / LiveKit / homegrown) → **STT** → **LLM** (tool call? output text) → **TTS** → audio chunks streamed back.

### STT ("ears")
- **Quality = Word Error Rate.** SOTA ~**6% WER** on open benchmarks. Errors are unrecoverable — LLM and TTS carry the mistake forward. Critical for names, drug names, keywords.
- **Latency = time to complete transcript** after the user stops speaking. Together runs models at **P90 ~100ms**.
- **Turn detection:** "still somewhat unsolved, could be a 20-min talk." A pause ≠ end of turn. Worst outcome = agent talks over the user.
- Language coverage matters.
- **Streaming-native STT trend:** evolution from batch → streaming. Whisper (canonical) trained on **30s clips** → too long → people build chunking/silence-padding/multi-call-stitching hacks. New NVIDIA-style models: encoder trained with **variable look-ahead (80ms up to ~1s)** instead of 30s, and **caches activations** so stepping through audio frames does the heavy compute once. → real streaming.

### LLM ("brains")
- **Streaming latency = TTFT.** Good target ≈ **200–300ms** (start producing tokens to feed TTS ASAP).
- This budget dictates **model size sweet spot: 8–30B params.** Bigger → burns latency budget; smaller → loses intelligence + tool-calling.

### TTS ("voice")
- **Time-to-first-audio (TTFA):** how long after transcript to produce first streamable audio chunk.
- **Real-time factor (RTF):** audio produced per second of processing. 10s audio in 5s = RTF 0.5. **Want RTF < 1** to avoid buffering.
- Quality: objective measures exist but nothing beats listening to samples for the voices you care about.
- Capabilities: naturalness, exact pronunciation (names/products), **emotion control via digital tags (happy/angry/sad)**, language coverage.

## System-level trade-offs
- **Latency + cost budget split (rough): LLM majority > TTS > STT** (both latency and cost).
- **Network latency is separate from engine latency.** Engine TTFT/TTFA 100–200ms is great, but models in different data centers add **~75ms network** (e.g. US-West→Europe). **Co-locating all models + orchestrator in the same DC/building drops 75ms → 5ms ≈ 30% reduction on an already-optimized setup.** "Every 10ms matters" → need deep observability.
- **Auto-scaling:** scale **up aggressively** (never let requests back up); scale **down carefully** — stateful long-lived connections mean you can't kill pods arbitrarily, must **drain conversations** to completion.
- **Global deployments** for proximity + data residency.

## Beyond the pipeline: speech-to-speech (S2S)
Single model does function-calling + instructions + audio↔audio (OpenAI Realtime API; NVIDIA "voice chat"). Benefits: simpler (no multi-model orchestration); **preserves tone/emotion/hesitation** (not lost to text); **full-duplex** (produce audio while receiving → backchannel "I see"/"aha"); natively better at **interruptions/barge-in** (pipeline needs complex engineering for this). **Not yet production-ready: weak instruction-following + tool-calling** → teams prompt-engineer then fall back to pipeline. Will improve.

## Q&A nuggets
- **Evals:** component-by-component. Tool-call **structure** near 100%; **correctness** is use-case dependent. Customers **fine-tune smaller LLMs** on use-case data to raise tool-calling quality while staying within the small-model latency budget.
- **More models in the mix (guardrails/classifiers):** classifier **before main LLM** (route refunds vs order-tracking); **guardrails after LLM generation, before TTS** — because **"you can't take back spoken words"** → must catch violations before TTS is invoked. Each added model pressures latency → clear SLAs + independent scaling.
- **Thinker–talker pattern:** small LLM handles the live conversation, emits filler ("let me think about it") + issues **one tool call to a much bigger model** (full tools, more guardrails) → cleaner response → TTS. Adds components → pushes harder on reliability + per-component observability.
- **Observability for S2S:** run a **transcription model alongside** the S2S model for auditability (see incoming/outgoing audio as text); evals shift to **full-duplex whole-conversation** metrics.

## Takeaways for Syrinx
- Hard latency ladder: 300ms human / 500ms noticeable / 1–2s hang-up. Total v2v budget is the constraint.
- STT errors are unrecoverable → keyword accuracy + keyterm boosting matters as much as WER.
- LLM 8–30B sweet spot; TTFT 200–300ms.
- TTS RTF < 1 + TTFA; stream first chunk.
- **Co-location of STT/TTS/LLM/orchestrator is a ~30% latency lever** — network latency is first-class.
- Drain stateful connections on scale-down.
- Guardrails MUST sit before TTS (irreversible speech).
