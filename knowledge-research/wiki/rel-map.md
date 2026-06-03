# REL — Reliability & Failure Modes (speech path) · Map of Content

## Core problem
Voice interactions are **long-lived and streaming**, so transient failures — dropped sockets, idle-timeout reaps, silently-hung providers, scale-down evictions — are unavoidable, not edge cases. The job of the reliability layer is to make conversations **degrade gracefully rather than collapse**: stay state-aware, never fail silently, and recover the connection/provider/session without dropping the call. Deepgram's framing: *"The goal is not perfect uptime but resilient interaction"* (ebook 600).

## The narrative

**1. Keep the socket alive, and notice when it dies.**
A streaming socket dies two ways: the provider reaps it for going idle, or the network drops it. Defend the first with keepalive — [[REL-03-keepalive-idle-socket]] sends an explicit KeepAlive every 5 s (Deepgram reaps at 10 s), and proactively recycles sockets before a hard max-lifetime. [[XPORT-08-transport-keepalive]] adds continuous output silence as a wire heartbeat. Notice the second — and the silent-hang case that throws no error — with [[REL-05-stall-detection-audio-cadence]]: a 1 s pipeline heartbeat (10 s alarm) plus a 0.5 s input-audio gap watchdog. "Treat a stall as a failure."

**2. When it drops, reconnect — carefully.**
[[REL-01-reconnect-exponential-backoff]]: reconnect with bounded exponential backoff (Pipecat 4→10 s floor/cap) or linear capped (LiveKit `n*2`, ≤10 s), and ping-verify after. But backoff is a trap when the handshake keeps succeeding and the server immediately closes (bad key) — [[REL-02-rapid-failure-detection]]: count quick deaths (<5 s, 3 strikes) and stop. On reconnect, restore via **injected state**, not a cold restart — [[REL-04-state-restoration-injected]]: re-send the provider config handshake, replay the in-flight frame, keep timestamps monotonic; keep LLM history in the orchestrator.

**3. When a provider is bad, fail over.**
[[REL-08-fallback-adapter-availability]] is the centerpiece: LiveKit's `FallbackAdapter` for STT/TTS tries providers in priority order, marks a failed one *unavailable* (skips it on later turns), and runs a background recovery probe to bring it back — with `max_retry=0` inside (the adapter *is* the retry strategy). [[REL-06-graceful-degradation-layered]] sets the per-layer degradation rules: STT low-confidence ⇒ reprompt; TTS fail ⇒ fallback voice / canned audio; reasoning fail ⇒ verbal ack + escalate. The invariant across all of it: **never fail silently.**

**4. Isolate the fragile, hot-path components.**
[[REL-11-vad-separate-process-respawn]]: run the VAD in its own process over stdin/stdout and auto-respawn on crash, so one component's failure doesn't drop the call.

**5. Survive load and scale events.**
[[REL-09-backpressure-load]]: apply backpressure at the three chokepoints (WS concurrency, orchestrator throughput, LLM rate limits) via bounded queues, load-aware admission, and model-tiering. [[REL-07-connection-draining-scaledown]]: on scale-down / deploy / SIGTERM, **drain** — stop accepting new calls, then wait (LiveKit 30-min budget) for in-flight conversations to finish. Never kill a pod mid-call.

**6. Triage by layer.**
[[REL-10-failure-mode-catalog]] is the runbook: Deepgram's 13 common failure modes mapped to the five layers (capture · transcription · reasoning · synthesis · playback) with what-to-inspect. Classify the layer *first*, then jump to the fix. A particularly insidious layer-hopping failure is **sample-rate / encoding mismatch** [[REL-12-sample-rate-encoding-mismatch]] — audio mis-decoded at the wrong rate causes choppy/distorted playback that mimics a network or codec problem but is actually a configuration error at the transport↔STT/TTS boundary.

## Canonical implementations
- **WS reconnect + exponential backoff:** `pipecat/src/pipecat/services/websocket_service.py` (`_try_reconnect` :83, `_maybe_try_reconnect` quick-failure breaker :142), `pipecat/src/pipecat/utils/network.py:10` (`exponential_backoff_time`). LiveKit worker WS: `agents/livekit-agents/livekit/agents/worker.py:1085-1103`. Per-call retry opts: `agents/.../types.py:74-109`.
- **Keepalive:** `pipecat/src/pipecat/services/deepgram/stt.py:652` (`_keepalive_handler`, 5 s). Proactive recycle: `agents/.../utils/connection_pool.py:24` (`max_session_duration`).
- **Stall detection:** `pipecat/src/pipecat/pipeline/worker.py:1161-1188` (heartbeat push/monitor, `HEARTBEAT_SECS=1.0`, `HEARTBEAT_MONITOR_SECS=10.0`). Input watchdog: `pipecat/src/pipecat/transports/base_input.py:243` (`AUDIO_INPUT_TIMEOUT_SECS=0.5`).
- **State restoration:** `pipecat/.../websocket_service.py:122` (`send_with_retry` replay). Timestamp continuity: `agents/.../stt/stt.py:390`.
- **Provider FallbackAdapter (STT/TTS):** `agents/livekit-agents/livekit/agents/stt/fallback_adapter.py` (availability tracking :211, recovery probe :175), `.../tts/fallback_adapter.py:46`. JS: `agents-js/agents/src/stt/fallback_adapter.ts:91`.
- **Draining on scale-down:** `agents/.../worker.py:872` (`drain()`, `drain_timeout=1800`), `agents-js/agents/src/worker.ts:460` (`WS_FULL` + wait).
- **Backpressure:** bounded queues `pipecat/.../transports/base_input.py:226`; load reporting `agents/.../worker.py:778`.
- **Sample-rate / encoding mismatch:** deepgram-ebook ~2075–2079 (choppy/distorted audio failure mode); `pipecat/src/pipecat/audio/resamplers/soxr_stream_resampler.py:30` (soxr quality modes); `pipecat/src/pipecat/audio/utils.py:10` (factory). Rule: one resample boundary, stateful, matching declared rates.
- **VAD separate-process + respawn:** Vapi only (vapi-pipeline-2 §1) — no OSS clone isolates VAD per-process; closest primitive is `pipecat/src/pipecat/ipc/proc_pool.py` (job-level, not component-level).

## Open questions / gaps
- **No OSS clone isolates VAD in its own process w/ auto-respawn** (Vapi's pattern). Pipecat/LiveKit run VAD in-process. Worth prototyping a supervised VAD subprocess for Syrinx?
- **LLM conversation-history restoration after reconnect** is left to the orchestration layer in every clone — none persists dialogue on the speech socket. Confirm Syrinx's orchestrator owns this (maps to catalog row 10, "Loss of Context").
- **Backoff schedules diverge** (Pipecat exponential 4-10 s vs LiveKit linear `n*2`≤10 s vs flat 2 s per-call). No source benchmarks which is best for sub-second voice; needs measurement.
- **`max_session_duration` proactive-recycle** is unset by default in LiveKit's pool — which providers actually impose a hard socket lifetime, and what values? Unverified per-provider.
- **Watchdog timers:** Pipecat's older `WatchdogTimer` appears refactored into the heartbeat/idle-monitor model in this clone; the precise mid-stage watchdog cancellation path (frame_processor sentinel, `frame_processor.py:141`) is mentioned but not deeply traced here.

## Source spine
Deepgram ebook: "Reliability, Failover, and Session Recovery" (588-601), "Scaling and Concurrency" (759-770, 902-916), "Resilience and Graceful Degradation" (902-916), "Common Failure Modes" appendix (2023-2112). Together-talk (autoscale up/down-drain, 34). Vapi-pipeline-2 (VAD subprocess §1, multi-STT fallback §3). Vapi-latency (silent provider hangs + hedging).
