# One-second voice-to-voice latency with Modal, Pipecat, and open models
Source: https://modal.com/blog/low-latency-voice-bot
Author: Ben Shababo (Modal), 2025-11-04. Repo: github.com/modal-projects/open-source-av-ragbot

Voice AI = 3 inference steps: **STT → LLM → TTS**, coordinated by a conversational framework (not passing data directly).
> IMAGE (voice_ai_diagram.webp): person ↔ voice bot (STT/LLM/TTS services).

## Why a framework
- **Service Modularity:** swap models/APIs per step.
- **High-level Conversational Flow:** multi-turn + interruption needs **VAD + turn-taking inference** ("did they stop speaking or just pause?"). Frameworks provide hooks for these models + their output events.
- **Statefulness:** LLM/STT/TTS APIs are mostly RESTful/stateless; framework = long-running stateful process storing conversation history.
- **Networking:** abstracts WebRTC/WebSocket boilerplate between clients↔bots and bots↔services.
- **Frontend:** browser frontends for clients.

## Pipecat (by Daily)
Pipeline coordinates a series of **processors** handling real-time audio/text/video **frames** with ultra-low latency. Some processors call external AI services, others process local data (audio filters, text parsers). **Each pipeline starts and ends with a transport node** managing the real-time media connection.
- **SmallWebRTCTransport:** free OSS P2P WebRTC transport on `aiortc`, E2E encryption, low latency. Swap to a proprietary network (Daily global mesh) or Twilio in a few lines. **Vendor neutral.**
- **Custom Services:** remote service requires an `AIService` impl. Modal wrote a base service class to connect to STT/TTS on Modal over **WebSockets**.
- **Optimized VAD + Turn Detection:** Pipecat integrates **Silero VAD** (most common VAD choice) + their own turn model **SmartTurn**. Together they emit frames for start/stop of conversational turn with high accuracy + low latency, driving optimized interruption logic — bots yield to interruptions but don't respond prematurely during brief mid-sentence pauses.
- **Voice-UI-Kit:** React components for custom frontends.

## Why Modal + Pipecat
Modal autoscales functions with different hardware independently. With Pipecat as stateful orchestrator, heavy compute moves into separate GPU services that autoscale independently from the bot container and are shared by all active bots. **Even with Silero VAD + SmartTurn, Pipecat bots only need CPUs** → CPU-only container for the long-running stateful bot, GPU services for models.

## Voice-to-Voice Latency
Figure of merit = duration from user stops speaking to first hearing the bot. **Natural conversation v2v latency can be as short as 100ms.** Apps target ~**1 second or less**. Hard when computations are distributed across machines.

## Pipeline for Modal's docs (RAG bot)
Steps: receive audio over WebRTC → transcribe → query Modal docs with transcript → assemble query results + history into prompt → generate structured response (spoken response + code blocks + links) → TTS the spoken response → send audio + other data back over WebRTC.
> IMAGE (tmp9_5dtgqt.webp): architecture diagram.

### Model choices (open weights, independent Modal services)
- **STT: Parakeet-tdt-0.6b-v3 (NVIDIA).** Notably: **using Pipecat's local VAD + turn detection to segment audio and passing that to Parakeet was FASTER than the open-weights streaming STT implementations they tried.** No partial-transcript real-time feel, but **"the only thing that matters for total voice-to-voice latency is the final transcript time"** — Parakeet wins on final-transcript time + accuracy.
- **LLM: Qwen3-4B-Instruct-2507 + vLLM.** As small/fast as possible while producing quality answers. Used the LLM Engineer's Almanac to pick the inference engine with lowest **TTFT (time-to-first-token)**. Tuned engine + CUDA-graph compilation to reduce TTFT (at expense of cold-start).
- **TTS: KokoroTTS (82M).** Fast + **streaming output minimizes time-to-first-byte (TTFB) at the client**. Accepts **phonetic symbols** as input → domain words ("Modal") always pronounced correctly.
- **RAG: ChromaDB + all-MiniLM-L6-v2 with OpenVINO** → embed query + search in tens of ms.

## Minimizing Network Latency
Network transit is a major latency source — depends on protocol, transport layer, and physical distance between client, bot container, and inference servers.
- **Client ↔ Bot: WebRTC** (Pipecat JS client + Python SmallWebRTC).
- **Bot ↔ Inference Services: Modal Tunnels.** Requests to Modal apps normally go through Modal's **input plane** (enables autoscaling) → extra latency. **Tunnels bypass the input plane** for direct communication. Pattern: serve a FastAPI app with uvicorn, use the Tunnel to relay from a public URL to the uvicorn port. **Serve a WebSocket endpoint over a Tunnel for STT + TTS** → low-latency, bidirectional, persistent. vLLM served similarly (Tunnel forwards HTTP).
  - **Recovering autoscaling:** bypassing input plane loses autoscaling. Workaround: `spawn` a `FunctionCall` at conversation start, cancel at end → link function-call lifecycle to conversation lifecycle. Use a Modal Dict to share URL + lifecycle info.
- **Pinning regions:** still bound by speed of light → pin Modal services to a region to move host machines geographically closer. Single data center limits GPU pool/raises wait times → permit a small cluster of nearby data centers (Virginia `us-east`, Bay Area `us-west`) + several GPU types.

## Testing performance
Record conversation in the same space as the client → full end-to-end latency incl hardware. Use **Pyannote (Precision-2)** for speaker diarization to find start/end of each speaker's turns → compute/aggregate v2v latency.
> IMAGE (voice-ai-results.webp): v2v latency eCDFs across deployments.

Results:
- Client + Modal containers near each other → **median v2v latency of ~1 second**, on par with proprietary services.
- Regardless of client↔bot distance (covered by WebRTC), **bot and services must reside in proximal data centers** for latency reduction.
- Without Modal Tunnels, deploy bot + services near the input plane in `us-east`.

## Takeaways for Syrinx
- **Final-transcript time is what matters for v2v latency** — segment-then-transcribe (VAD-gated) can beat streaming STT on total latency. Re-examine whether streaming partials are worth it for our latency budget.
- **TTS streaming output (TTFB) > whole-utterance synthesis.** Phonetic input for domain-word pronunciation.
- **Pick LLM inference engine by P95 TTFT, not throughput.**
- **Geographic co-location of bot + STT/TTS services** matters even with WebRTC to the client.
- **Persistent WebSocket** to STT/TTS beats per-request HTTP; bypass extra proxy hops.
