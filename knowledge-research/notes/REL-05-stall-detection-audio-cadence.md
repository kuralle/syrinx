---
id: REL-05
title: Stall detection — monitor audio flow + message cadence, treat a stall as failure
domain: REL
tags: [stall-detection, watchdog, heartbeat, monitoring, recovery, hang]
sources: [deepgram-ebook, vapi-latency]
code_refs: [pipecat/src/pipecat/pipeline/worker.py:1170, pipecat/src/pipecat/pipeline/worker.py:87, pipecat/src/pipecat/transports/base_input.py:31, pipecat/src/pipecat/transports/base_input.py:243]
---

**Claim (one line):** A silently-hung provider produces no error and no timeout — so monitor the *cadence* of audio frames and pipeline messages, and treat a gap as a failure to recover from, rather than waiting for an exception that never comes.

**Detail.** Deepgram: "Backend components should monitor audio flow and message cadence. If input or output stalls, the system should treat it as a failure and initiate recovery" (ebook line 596-598). Vapi names the exact danger: *"sometimes a request to a provider just hangs — no error, no timeout, nothing"* (~5% of turns, up to 5000 ms "death spiral") — the cure is a hedged request fired on a per-endpoint dynamic timeout, not an error handler ([[LAT-06-hedged-requests]]). Pipecat implements cadence monitoring two ways: (1) a pipeline **heartbeat** — `_heartbeat_push_handler` injects a `HeartbeatFrame` every `HEARTBEAT_SECS = 1.0 s`, and `_heartbeat_monitor_handler` warns if no heartbeat traverses the pipeline within `HEARTBEAT_MONITOR_SECS = 10.0 s`, also logging each frame's end-to-end traversal time (`worker.py:1161-1188, 87-88`); (2) an **input-audio watchdog** — the input transport reads its audio queue with `asyncio.wait_for(..., timeout=AUDIO_INPUT_TIMEOUT_SECS = 0.5 s)`, but the `TimeoutError` branch currently only `continue`s once audio has started — a comment marks "timeout should warn if there's no audio" but no warning/recovery is implemented on a gap (`base_input.py:31, 243, 246, 263`).

**Prior-art divergence.** Pipecat's heartbeat measures *pipeline liveness + per-frame latency* (1 s push, 10 s alarm); its input watchdog measures *capture-layer flow* (0.5 s). Vapi's hang detection is at the *LLM-request* layer — a per-deployment `mean + k·σ` timeout that cancels a stalled request and hedges to the next-fastest. Deepgram frames all of these as one principle: "treat a stall as a failure and initiate recovery." None waits for an exception.

**Implication for Syrinx.** Don't rely on provider error events — run an active liveness probe: a 1 s pipeline heartbeat with a ~10 s alarm, a sub-second input-audio gap watchdog, and a per-endpoint dynamic timeout on outbound LLM/TTS requests that cancels-and-hedges on a stall. A stall is a failure; recover, don't wait.

Links: [[REL-03-keepalive-idle-socket]] [[LAT-06-hedged-requests]] [[REL-08-fallback-adapter-availability]] [[REL-10-failure-mode-catalog]] [[XPORT-08-transport-keepalive]]
