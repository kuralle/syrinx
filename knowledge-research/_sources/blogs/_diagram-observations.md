# Diagram observations (read from the actual images)
These capture specifics visible only in the images, not the prose.

## ElevenLabs — Voice Engine / Agent Orchestration split (el-voice-engine-split.webp) — DEFINES OUR SCOPE
Left box **"Voice Engine" (labeled AUDIO ORCHESTRATION)** contains 5 components arranged around a circle ("70+ languages, 11k+ voices"):
- **Turn Taking**, **Text to Speech**, **Speech to Text**, **Interruption Detection**, **Voice Activity Detection**.
Middle: **"Sends transcript →"** / **"← Sends response"**.
Right box **"Agent Orchestration"**: System prompt + (Knowledge Base/SOPs, RAG) → **LLM** ↔ **Workflows + routing**.
→ **Syrinx = the Voice Engine box.** The boundary is the transcript (out) and the response text (in). Everything we optimize lives in: VAD, turn-taking, interruption detection, STT, TTS.

## Vapi latency budget (vapi-latency-budget.png)
Hand-drawn: waveform → **ASR 300 ms** → **LLM 200–900 ms !!** → **TTS 400 ms** → waveform.
→ ASR/TTS are roughly fixed (~300/~400 ms); the LLM is the variable, dominant term (200–900 ms). Matches the prose: "the bottleneck is almost always the LLM."

## Vapi streaming timeline (vapi-streaming-timeline.png)
Mic → **AUDIO INPUT STREAM → VOICE ACTIVITY DETECTION → AUDIO PREPROCESSING**; feeds **TRANSCRIPTION STREAM** emitting growing partials ("I need to…" → "I need to schedule." → "I need to schedule an"); **RESPONSE GENERATION STREAM** emits "Got it, let's do Tuesday." The three streams run concurrently/overlapping.

## Vapi VAD state machine (vapi-vad-diagram.png)
**QUIET** →(200 ms detection)→ **STARTING** → **SPEAKING** →(>800 ms silence)→ **STOPPING**; **confidence < threshold** edge returns to QUIET. (Asymmetric start/stop thresholds = hysteresis.)

## Vapi partial-transcript confidence filter (vapi-partial-filter-chain.png)
Mic Input → **Streaming STT Engine** → **Partial Transcript** → **Confidence Filter** with 3 outputs:
- **Discard** (conf < X)
- **Keep** (X < conf < Y)
- **Interrupt** (conf > Y)  ← only high-confidence partials may barge-in on the agent.

## Vapi endpointing selector (vapi-conversational-context.png)
**Conversation Context → Endpointing Selector →** one of {**Rule-Based**, **ML Model**, **Regex-Based**} **→ Timeout Decision Sent.**

## Modal architecture (modal-architecture.webp) — TRANSPORT MAP
- **Client ↔ Frontend & Bot Servers** over **HTTP**.
- **Client ↔ Pipecat Pipeline (bot)** over **WebRTC**. Bot container holds **ChromaDB (in memory)**.
- **Frontend ↔ bot** share state via **modal.Dict**.
- **Bot ↔ GPU Services** (separate, independently autoscaled):
  - **STT Service** `nvidia/parakeet-tdt-0.6b-v3` over **WebSocket + modal.Tunnel**.
  - **LLM Service** `Qwen3-Instruct-4B-2507 + vLLM` over **HTTP + modal.Tunnel**.
  - **TTS Service** `KokoroTTS` over **WebSocket + modal.Tunnel**.
→ STT and TTS use **persistent WebSockets**; LLM uses HTTP. All bypass Modal's input plane via Tunnels for latency.
