---
id: REL-01
title: WebSocket reconnect with exponential backoff
domain: REL
tags: [reconnect, backoff, websocket, recovery, resilience]
sources: [deepgram-ebook]
code_refs: [pipecat/src/pipecat/services/websocket_service.py:83, pipecat/src/pipecat/utils/network.py:10, agents/livekit-agents/livekit/agents/worker.py:1096, agents/livekit-agents/livekit/agents/types.py:101]
---

**Claim (one line):** Long-lived streaming sockets fail transiently, so every WS-based service must reconnect on disconnect using a bounded, backed-off retry loop — never give up on the first drop, never hammer a dead endpoint.

**Detail.** Deepgram: "Streaming connections should implement reconnection logic with exponential backoff" (ebook line 592). Pipecat realizes this in a shared base class: `WebsocketService._try_reconnect` loops `for attempt in range(1, max_retries + 1)` (default `max_retries=3`), and between attempts sleeps `exponential_backoff_time(attempt)` (`websocket_service.py:96,110`). The backoff formula is `2**(attempt-1)*multiplier` clamped to `[min_wait=4, max_wait=10]` seconds (`network.py:25-27`). But `_try_reconnect` calls it with no `multiplier` argument, so `multiplier=1` (`network.py:11`): with the default `max_retries=3` the raw values are `2**0,2**1,2**2 = 1,2,4`, all below the 4 s floor — so the **default** per-attempt sleep is 4, 4, 4 s, never reaching 8 or 10 s (true exponential growth past the floor would require `multiplier>1`). After a successful `_reconnect_websocket` it verifies liveness with a WS `ping()` before declaring success (`websocket_service.py:79`, `_verify_connection` line 52-62). LiveKit's agent-worker WS to the LiveKit server uses a *different* schedule: `retry_delay = min(retry_count * 2, 10)` — **linear** growth capped at 10 s, with `max_retry=16` (`worker.py:1096`, WorkerOptions `worker.py:223`). LiveKit's per-API-call retry (`APIConnectOptions`) is flat: first retry at 0.1 s, then constant `retry_interval=2.0 s`, `max_retry=3` (`types.py:101-109`).

**Prior-art divergence.** Pipecat = exponential-backoff *formula* with floor 4 s / cap 10 s at the service-socket layer (though with the default `multiplier=1` and `max_retries=3` it sleeps a flat 4, 4, 4 s — exponential growth only kicks in above the floor with a larger multiplier). LiveKit = linear `n*2` capped at 10 s for the control-plane WS, and a *flat* interval for data-plane API retries — it deliberately leans on the [[REL-08-fallback-adapter-availability]] FallbackAdapter for resilience rather than aggressive in-place retry (note `DEFAULT_FALLBACK_API_CONNECT_OPTIONS` sets `max_retry=0`, `fallback_adapter.py:23`). So Pipecat backs off *in place*; LiveKit fails fast and *switches provider*.

**Implication for Syrinx.** Use exponential backoff with a floor (avoid a tight 0 s reconnect storm) and a ceiling (~10 s) on every provider socket, and ping-verify after reconnect. Pair in-place reconnect with provider failover so a permanently-dead endpoint is abandoned, not retried forever.

Links: [[REL-02-rapid-failure-detection]] [[REL-04-state-restoration-injected]] [[REL-08-fallback-adapter-availability]] [[XPORT-08-transport-keepalive]] [[REL-10-failure-mode-catalog]]
